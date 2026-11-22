/**
 * REAL integration tests: a real llama-server process loads a real (random-weight) GGUF and serves real HTTP.
 * Nothing here is mocked or scripted. What these tests CANNOT show is model quality: the weights are random, so
 * generated text is gibberish by design. They are skipped (loudly) when no llama-server is available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "fs";
import { spawnSync, spawn } from "child_process";
import { exactKvCacheMb } from "../../src/router/router";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import type { AddressInfo } from "net";
import { LlamaCppBackend } from "../../src/inference/llama-cpp-backend";
import { entryFromGguf } from "../../src/inference/gguf";
import { readRssMb } from "../../src/inference/process-stats";
import { DefaultModelRouter } from "../../src/router/router";
import { HardwareProfiler } from "../../src/hardware/profiler";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import { buildContext, createServer } from "../../src/server/index";
import { isRejection, RoutingDecision } from "../../src/types/index";
import { writeTinyModel } from "../../scripts/tiny-model";
import { makeRepo, FAKE_PROFILE, POLICY, CALC_BUGGY } from "../agent/helpers";

function findEngine(): string | null {
  const env = process.env.LOCALCODER_LLAMA_SERVER_BIN;
  if (env && existsSync(env)) return env;
  for (const base of ["/home/claude/engine", path.join(__dirname, "../../engine")]) {
    try {
      for (const d of readdirSync(base)) { const p = path.join(base, d, "llama-server"); if (existsSync(p)) return p; }
      if (existsSync(path.join(base, "llama-server"))) return path.join(base, "llama-server");
    } catch { /* not there */ }
  }
  return null;
}
const ENGINE = findEngine();
const skip = ENGINE ? false : "no real llama-server available (set LOCALCODER_LLAMA_SERVER_BIN to run the real-engine tests)";

const dir = mkdtempSync(path.join(os.tmpdir(), "lc-real-"));
const MODEL = path.join(dir, "tiny-random-test-model.gguf");
writeTinyModel(MODEL);
const entry = entryFromGguf(MODEL);
const decision = (kv: "f16" | "q8_0" | "q4_0" = "f16"): RoutingDecision => ({ model_id: entry.model_id, ctx_window: 2048, kv_cache_budget_mb: 1, kv_cache_dtype: kv, max_output_tokens: 32, gpu_offload_fraction: 0 });

test("REAL: the tiny GGUF we wrote is read by our parser with the right architecture facts", { skip }, () => {
  assert.deepEqual([entry.layers, entry.attention_heads, entry.kv_heads, entry.head_dim, entry.context_limit], [2, 4, 2, 16, 2048]);
  assert.ok(entry.capabilities.includes("fim"), "FIM tokens detected from the real GGUF key layout");
});

test("REAL: LlamaCppBackend loads, honours the context size, tokenizes with the real tokenizer, streams chat + FIM, and unloads cleanly", { skip }, async () => {
  const backend = new LlamaCppBackend({ binary: ENGINE! });
  try {
    await backend.load(entry, decision());
    assert.ok(backend.pid && backend.port);
    const rss = readRssMb(backend.pid);
    assert.ok(rss !== null && rss > 5, `real llama-server RSS should be measurable, got ${rss}`);

    const props = await (await fetch(`http://127.0.0.1:${backend.port}/props`)).json() as any;
    assert.equal(props.default_generation_settings.n_ctx, 2048, "--parallel 1 keeps the full requested context in one slot");

    const text = "function add(a, b) { return a + b; }";
    const toks = await backend.tokenize(text);
    assert.ok(toks.length > 0);
    assert.equal(await backend.countTokens(text), toks.length);
    assert.notEqual(toks.length, Math.ceil(text.length / 4), "the real tokenizer disagrees with the chars/4 estimate");

    let finish: string | undefined;
    for await (const t of backend.generate({ mode: "chat", messages: [{ role: "user", content: "hi" }] }, { max_tokens: 8 })) { finish = t.finish_reason ?? finish; }
    assert.ok(finish === "length" || finish === "stop", "chat generation terminates normally");
    const chatSlot = (await (await fetch(`http://127.0.0.1:${backend.port}/slots`)).json() as any[])[0];
    assert.equal(chatSlot.params.n_predict, 8, "the backend forwards the requested chat token limit");
    // Random byte tokens may produce no visible text, or split into several text chunks.
    // Measure generated tokens through the engine's usage instead of counting SSE fragments.
    const completion = await (await fetch(`http://127.0.0.1:${backend.port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 8, ignore_eos: true, stream: false }),
    })).json() as any;
    assert.equal(completion.usage.completion_tokens, 8);

    let fimFinished = false;
    for await (const t of backend.generate({ mode: "fim", prefix: "def add(a, b):\n    return ", suffix: "\n" }, { max_tokens: 6 })) {
      if (t.finish_reason) fimFinished = true;
    }
    assert.equal(fimFinished, true, "the real infill stream terminates");
    const fimSlot = (await (await fetch(`http://127.0.0.1:${backend.port}/slots`)).json() as any[])[0];
    assert.equal(fimSlot.params.n_predict, 6, "the backend forwards the requested infill token limit");
    const infill = await (await fetch(`http://127.0.0.1:${backend.port}/infill`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_prefix: "def add(a, b):\n    return ", input_suffix: "\n", prompt: "", n_predict: 6, ignore_eos: true, stream: false }),
    })).json() as any;
    assert.equal(infill.tokens_predicted, 6);

    const pid = backend.pid!, port = backend.port!;
    await backend.unload();
    assert.equal(readRssMb(pid), null, "llama-server process is gone after unload");
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`), "its port is closed");
  } finally { await backend.unload(); }
});

test("REAL: concurrent backend loads own distinct ports and verify their child instance", { skip }, async () => {
  const backends = [1024, 1536, 2048].map(() => new LlamaCppBackend({ binary: ENGINE! }));
  try {
    await Promise.all(backends.map((backend, i) => backend.load(entry, { ...decision(), ctx_window: [1024, 1536, 2048][i] })));
    assert.equal(new Set(backends.map((backend) => backend.port)).size, 3);
    const props = await Promise.all(backends.map(async (backend) => (await fetch(`http://127.0.0.1:${backend.port}/props`)).json() as Promise<any>));
    assert.equal(new Set(props.map((p) => p.model_alias)).size, 3, "readiness must identify the child, even for identical model files");
    props.forEach((p, i) => {
      assert.match(p.model_alias, /^localcoder-/);
      assert.equal(p.default_generation_settings.n_ctx, [1024, 1536, 2048][i]);
    });
  } finally { await Promise.all(backends.map((backend) => backend.unload())); }
});

test("REAL finding: this llama-server refuses a quantized KV cache when the block size (32) does not divide head_dim — and the router never picks one for such a model", { skip }, async () => {
  assert.equal(entry.head_dim, 16);
  const b1 = new LlamaCppBackend({ binary: ENGINE! });
  try { await assert.rejects(() => b1.load(entry, decision("q8_0")), /does not divide n_embd_head_k=16/); }
  finally { await b1.unload(); }

  // even when the policy asks for a q4_0 KV cache (low_memory) and the budget is tight, the router stays on f16 for head_dim 16
  const lowMem = { ...POLICY, power_mode: "low_memory" as const, memory_budget_gb: 3, max_context_tokens: 2048 };
  const d = new DefaultModelRouter().route("hard_agent", lowMem, [entry]);
  assert.ok(!isRejection(d));
  if (!isRejection(d)) {
    assert.equal(d.kv_cache_dtype, "f16");
    const b2 = new LlamaCppBackend({ binary: ENGINE! });
    try { await b2.load(entry, d); assert.ok(b2.pid); } finally { await b2.unload(); }
  }
});

test("REAL: with head_dim 32 the quantized KV caches (q8_0, q4_0) load AND generate on the real server, and the router chooses q4_0 in low_memory mode", { skip }, async () => {
  const m32 = path.join(dir, "tiny-hd32.gguf");
  writeTinyModel(m32, { headDim: 32 });
  const e32 = entryFromGguf(m32);
  assert.equal(e32.head_dim, 32);
  for (const kv of ["q8_0", "q4_0"] as const) {
    const b = new LlamaCppBackend({ binary: ENGINE! });
    try {
      await b.load(e32, { ...decision(kv), model_id: e32.model_id });
      let finish: string | undefined;
      for await (const token of b.generate({ mode: "chat", messages: [{ role: "user", content: "hi" }] }, { max_tokens: 4 })) finish = token.finish_reason ?? finish;
      assert.ok(finish === "length" || finish === "stop", `${kv} KV cache completed generation`);
      const completion = await (await fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 4, ignore_eos: true, stream: false }),
      })).json() as any;
      assert.equal(completion.usage.completion_tokens, 4, `${kv} KV cache generated actual tokens`);
    } finally { await b.unload(); }
  }
  const d = new DefaultModelRouter().route("hard_agent", { ...POLICY, power_mode: "low_memory", memory_budget_gb: 3, max_context_tokens: 2048 }, [e32]);
  assert.ok(!isRejection(d));
  if (!isRejection(d)) assert.equal(d.kv_cache_dtype, "q4_0");
});

test("REAL: load failures surface the server's own error (invalid GGUF) or a clear message (missing file) — never a hang", { skip }, async () => {
  const bad = path.join(dir, "not-a-model.gguf");
  writeFileSync(bad, "this is not a gguf file at all, just text");
  const b = new LlamaCppBackend({ binary: ENGINE! });
  const t0 = Date.now();
  await assert.rejects(() => b.load({ ...entry, file_path: bad }, decision()), /exited early|did not become healthy/);
  assert.ok(Date.now() - t0 < 30_000, "fails fast");
  await assert.rejects(() => b.load({ ...entry, file_path: path.join(dir, "missing.gguf") }, decision()), /Model file not found/);
  await assert.rejects(() => new LlamaCppBackend({ binary: path.join(dir, "no-such-binary") }).load(entry, decision()), /Failed to start|exited early/);
});

test("REAL: our exact KV-cache formula matches the KV buffer the real llama-server allocates (f16, q8_0, q4_0)", { skip }, async () => {
  const m32 = path.join(dir, "tiny-kv.gguf");
  writeTinyModel(m32, { headDim: 32 });
  const e32 = entryFromGguf(m32);
  for (const kv of ["f16", "q8_0", "q4_0"] as const) {
    const port = 8300 + Math.floor(Math.random() * 400);
    const proc = spawn(ENGINE!, ["--model", m32, "--port", String(port), "--host", "127.0.0.1", "--ctx-size", "2048", "--parallel", "1", "--cache-ram", "0", "--cache-type-k", kv, "--cache-type-v", kv, "-lv", "4"], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    proc.stdout!.on("data", (d) => (log += d)); proc.stderr!.on("data", (d) => (log += d));
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !/llama_kv_cache: size =/.test(log)) await new Promise((r) => setTimeout(r, 100));
      const m = log.match(/llama_kv_cache: size =\s+([\d.]+) MiB \(\s*(\d+) cells,\s+(\d+) layers/);
      assert.ok(m, `server did not report its KV size:\n${log.slice(-600)}`);
      assert.equal(Number(m[2]), 2048); assert.equal(Number(m[3]), e32.layers);
      assert.ok(Math.abs(Number(m[1]) - exactKvCacheMb(e32, 2048, kv)!) <= 0.006, `${kv}: real ${m[1]} MiB vs formula ${exactKvCacheMb(e32, 2048, kv)!.toFixed(4)} MiB`);
    } finally { proc.kill("SIGKILL"); await new Promise((r) => proc.once("exit", r)); }
  }
});

async function startRealServer(extraRepo?: { root: string }) {
  process.env.LOCALCODER_LLAMA_SERVER_BIN = ENGINE!;
  const base = mkdtempSync(path.join(os.tmpdir(), "lc-realbase-"));
  mkdirSync(path.join(base, "registry"), { recursive: true });
  writeFileSync(path.join(base, "registry", "models.json"), JSON.stringify([entry]));
  const ctx = buildContext({ baseDir: base, backend: "llama", repoRoot: extraRepo?.root });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
  const server = createServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, cleanup: async () => { await ctx.modelManager.unload(entry.model_id); await new Promise<void>((r) => server.close(() => r())); rmSync(base, { recursive: true, force: true }); } };
}

test("REAL: the HTTP API serves real chat and FIM through the real router, manager and llama-server", { skip }, async () => {
  const s = await startRealServer();
  try {
    const chat = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], max_tokens: 6 }) });
    assert.equal(chat.status, 200);
    const body = await chat.text();
    assert.ok(body.includes(entry.model_id), "chunks name the routed model");
    assert.ok(body.trim().endsWith("data: [DONE]"));
    assert.match(body, /"finish_reason":"(?:length|stop)"/, "the real generation terminates normally even when byte tokens yield no visible text");

    const fim = await fetch(`http://127.0.0.1:${s.port}/v1/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefix: "def f():\n    return ", suffix: "\n", max_tokens: 5 }) });
    assert.equal(fim.status, 200);
    assert.ok((await fim.text()).trim().endsWith("data: [DONE]"));

    const models = await (await fetch(`http://127.0.0.1:${s.port}/v1/models`)).json() as any;
    assert.equal(models.data[0].resident, true, "the manager reports the real model as resident");
  } finally { await s.cleanup(); }
});

test("REAL: the agent endpoint with a real (random-weight) model fails HONESTLY — an error/done(false) event, no edits, no crash", { skip }, async () => {
  const repo = await makeRepo();
  const s = await startRealServer({ root: repo.root });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/agent/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "Fix the add function so the tests pass" }) });
    assert.equal(res.status, 200);
    const events = (await res.text()).split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
    const last = events[events.length - 1];
    assert.ok(["error", "done"].includes(last.type), `ended with ${last.type}`);
    if (last.type === "done") assert.equal(last.success, false);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY, "gibberish output must never edit the repo");
  } finally { await s.cleanup(); repo.cleanup(); }
});

test("REAL: `localcoder verify` against the real server + tiny model distinguishes completed generation from unusable random output (exit 1)", { skip }, async (t) => {
  const profile = await new HardwareProfiler().sample();
  const policy = new DefaultPolicyEngine().derive(profile);
  const routed = new DefaultModelRouter().route("hard_agent", policy, [entry]);
  if (isRejection(routed)) {
    t.skip(`the live hardware policy cannot fit the fixture (${policy.memory_budget_gb}GB safe budget)`);
    return;
  }
  const report = path.join(dir, "verify.json");
  const env = { ...process.env }; delete env.LOCALCODER_LLAMA_SERVER_BIN;
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, path.join(__dirname, "../../src/cli/index.ts"), "verify", "--llama-server", ENGINE!, "--model", MODEL, "--json-trials", "1", "--agent-seconds", "120", "--report", report], { cwd: dir, env, encoding: "utf8", timeout: 240_000 });
  const j = JSON.parse(readFileSync(report, "utf8"));
  const status = (n: string) => j.steps.find((s: any) => s.name === n)?.status;
  for (const n of ["hardware", "llama-server", "model", "memory gate", "load model", "tokenizer"]) assert.equal(status(n), "pass", `${n}: ${r.stdout}`);
  for (const name of ["chat generation", "fim /infill"]) {
    const step = j.steps.find((item: any) => item.name === name);
    assert.ok(step?.data?.finish_reason, `${name} must complete its transport protocol: ${r.stdout}`);
    assert.equal(step.status, step.data.text.trim() ? "pass" : "fail", "empty model output is a quality failure even after a valid completion");
    assert.ok(!step.detail.includes("tokens/s"), "text fragments must not be reported as generated-token throughput");
  }
  if (status("chat generation") === "pass") {
    assert.equal(status("agent JSON contract"), "fail", "random weights cannot follow the agent JSON contract — and verify says so");
    assert.equal(status("agent task"), "fail");
  } else {
    assert.equal(status("agent JSON contract"), undefined);
    assert.equal(status("agent task"), "skip", "the agent is not attempted after unusable chat output");
  }
  assert.equal(r.status, 1, "failed model-quality steps => exit code 1 (not 0, not the missing-component code 2)");
  assert.equal(j.missing.length, 0);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
