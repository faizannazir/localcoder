import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { execFileSync, spawnSync } from "child_process";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { buildContext, createServer } from "../../src/server/index";
import { preflightAgent } from "../../src/agent/preflight";
import { tryLockRepo, unlockRepo } from "../../src/agent/session";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import { DefaultModelRouter } from "../../src/router/router";
import { AgentStateStore } from "../../src/agent/state";
import { ScriptedBackend, fixScript, makeAgent, makeRepo, collect, FAKE_PROFILE, CALC_BUGGY, CALC_FIXED, Repo } from "./helpers";

function registry(estGb: number) {
  return [{ model_id: "tiny", architecture: "dense", parameter_count: { total: 0.5 }, quantization: "Q4_K_M", file_path: "x.gguf", context_limit: 16384, backend_requirements: ["cpu"], estimated_memory_gb: estGb, capabilities: ["tool_calling"] }];
}

async function startServer(repo: Repo, estGb = 0.1) {
  const base = mkdtempSync(path.join(os.tmpdir(), "lc-base-"));
  mkdirSync(path.join(base, "registry"), { recursive: true });
  writeFileSync(path.join(base, "registry", "models.json"), JSON.stringify(registry(estGb)));
  const scripted = new ScriptedBackend(fixScript(true));
  const ctx = buildContext({ baseDir: base, repoRoot: repo.root, backend: "mock", backendFactory: () => scripted });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} }; // hardware-independent policy
  const server = createServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, scripted, cleanup: async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(base, { recursive: true, force: true }); } };
}

function parseSse(text: string): { event: string; data: any }[] {
  return text.split("\n\n").filter(Boolean).map((blk) => {
    const ev = blk.split("\n").find((l) => l.startsWith("event: "))!.slice(7);
    const data = JSON.parse(blk.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    return { event: ev, data };
  });
}

const post = (port: number, url: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("POST /v1/agent/run streams ordered SSE events and really fixes the repo; POST /v1/agent/undo reverts it", async () => {
  const repo = await makeRepo();
  const srv = await startServer(repo);
  try {
    const res = await post(srv.port, "/v1/agent/run", { task: "Fix the add function so the tests pass", session_id: "api" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const evs = parseSse(await res.text());

    assert.ok(evs.every((e) => e.event === e.data.type), "SSE event name matches payload type");
    const names = evs.map((e) => e.event);
    assert.ok(names.includes("plan") && names.includes("diff"));
    assert.equal(names[names.length - 1], "done");
    assert.ok(names.indexOf("plan") < names.indexOf("observation"));
    assert.ok(names.indexOf("diff") < names.indexOf("done"));
    assert.ok(!names.includes("error"));
    evs.forEach((e, i) => { if (e.event === "tool_call") assert.equal(evs[i + 1].data.id, e.data.id); });
    assert.equal(evs[evs.length - 1].data.success, true);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_FIXED);
    assert.match(evs.find((e) => e.event === "diff")!.data.patch, /\+  return a \+ b;/);
    const taskId = evs[evs.length - 1].data.task_id;

    const undo = await post(srv.port, "/v1/agent/undo", { task_id: taskId });
    assert.equal(undo.status, 200);
    assert.deepEqual((await undo.json() as any).restored, ["calc.js"]);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY);
    assert.equal((await (await post(srv.port, "/v1/agent/undo", { task_id: taskId })).json() as any).already_undone, true);
  } finally { await srv.cleanup(); repo.cleanup(); }
});

test("agent endpoint validation, resource gate (503 before any work), per-repo lock (409), and no-task undo (404)", async () => {
  const repo = await makeRepo();
  const srv = await startServer(repo);
  try {
    assert.equal((await post(srv.port, "/v1/agent/run", {})).status, 400);
    assert.equal((await post(srv.port, "/v1/agent/undo", {})).status, 404);
    assert.ok(tryLockRepo(repo.root));
    assert.equal((await post(srv.port, "/v1/agent/run", { task: "x" })).status, 409);
    unlockRepo(repo.root);
    assert.equal(srv.scripted.prompts.length, 0);
  } finally { await srv.cleanup(); }
  const srv2 = await startServer(repo, 60); // model needs 60GB, fake budget is 20GB
  try {
    const res = await post(srv2.port, "/v1/agent/run", { task: "Fix the add function" });
    assert.equal(res.status, 503);
    const body = await res.json() as any;
    assert.equal(body.error.reason, "no_model_fits_budget");
    assert.equal(srv2.scripted.prompts.length, 0, "no inference starts when the resource policy rejects");
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY);
  } finally { await srv2.cleanup(); repo.cleanup(); }
});

test("preflightAgent: accepts a fitting machine, rejects non-fitting ones, and rejects policies too constrained for an agent", async () => {
  const base = { profiler: { sample: async () => FAKE_PROFILE, onChange: () => () => {} }, policyEngine: new DefaultPolicyEngine(), router: new DefaultModelRouter(), registry: registry(0.1) as any };
  const ok = await preflightAgent(base);
  assert.ok(ok.ok && ok.decision.model_id === "tiny");
  const tight = await preflightAgent({ ...base, registry: registry(30) as any });
  assert.ok(!tight.ok && tight.reason === "no_model_fits_budget");
  const strangled = await preflightAgent({ ...base, policyEngine: { derive: (p: any) => ({ ...new DefaultPolicyEngine().derive(p), max_context_tokens: 1024 }) } });
  assert.ok(!strangled.ok && strangled.reason === "policy_too_constrained");
});

test("client disconnect (aborted) stops the run with a recoverable error and a resumable state", async () => {
  const repo = await makeRepo();
  try {
    let calls = 0;
    const backend = new ScriptedBackend((n, p) => { calls++; return fixScript(true)(n, p); });
    const evs = await collect(makeAgent(repo, backend, { aborted: () => calls >= 1 }).run({ task: "Fix the add function" }));
    const last = evs[evs.length - 1] as any;
    assert.equal(last.type, "error");
    assert.equal(last.recoverable, true);
    assert.match(last.message, /aborted/);
    assert.equal(new AgentStateStore(repo.root).load(last.task_id).status, "interrupted");
  } finally { repo.cleanup(); }
});

test("CLI: `localcoder undo` reverts an agent task across processes; `localcoder agent` fails cleanly (non-zero, message) when it cannot run", async () => {
  const repo = await makeRepo();
  try {
    const done = (await collect(makeAgent(repo, new ScriptedBackend(fixScript(true))).run({ task: "Fix the add function" }))).pop() as any;
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_FIXED);
    const CLI = path.join(__dirname, "../../src/cli/index.ts");
    const out = execFileSync("npx", ["tsx", CLI, "undo"], { cwd: repo.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.match(out, new RegExp(`Undo ${done.task_id}: restored 1`));
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY);

    const r = spawnSync("npx", ["tsx", CLI, "agent", "Fix the add function", "--backend", "mock"], { cwd: repo.root, encoding: "utf8" });
    assert.notEqual(r.status, 0, "mock backend cannot produce agent JSON (or the machine cannot fit a model): must fail, not crash silently");
    assert.ok(r.stderr.includes("localcoder") || r.stderr.includes("error"), `expected a clear message, got: ${r.stderr.slice(0, 300)}`);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY, "failed run made no edits");
  } finally { repo.cleanup(); }
});
