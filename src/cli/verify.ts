import { spawnSync } from "child_process";
import { accessSync, constants, existsSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { HardwareProfiler } from "../hardware/profiler";
import { DefaultPolicyEngine } from "../policy/engine";
import { DefaultModelRouter } from "../router/router";
import { loadRegistry, isDownloaded } from "../router/registry";
import { locateLlamaServer } from "../util/paths";
import { loadFullRegistry } from "../router/registry";
import { MISSING_LLAMA, MISSING_MODEL } from "./missing";
import { LlamaCppBackend } from "../inference/llama-cpp-backend";
import { entryFromGguf, readGgufMeta } from "../inference/gguf";
import { readRssMb } from "../inference/process-stats";
import { extractJson } from "../agent/json-extract";
import { PLAN_SYS } from "../agent/coding-agent";
import { openAgentSession } from "../agent/session";
import { createFixtureRepo, FIXTURE_GOAL } from "./verify-fixture";
import { isRejection } from "../types/index";
import type { ModelRegistryEntry, PromptPayload } from "../types/index";

type Status = "pass" | "fail" | "skip" | "missing";
interface Step { name: string; status: Status; detail: string; data?: Record<string, unknown> }

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

export async function runVerify(args: string[]): Promise<void> {
  const steps: Step[] = [];
  const missing: string[] = [];
  const add = (name: string, status: Status, detail: string, data?: Record<string, unknown>) => {
    steps.push({ name, status, detail, data });
    const icon = { pass: "PASS   ", fail: "FAIL   ", skip: "SKIP   ", missing: "MISSING" }[status];
    console.log(`[${icon}] ${name}: ${detail}`);
  };
  const reportPath = path.resolve(flag(args, "--report") ?? "verify-report.json");
  const cleanup: (() => Promise<void> | void)[] = [];
  let decisionForReport: unknown = null;

  console.log("localcoder verify — real end-to-end check (no mocks, no stubs)\n");

  try {
    // 1. hardware + policy
    const profile = await new HardwareProfiler().sample();
    const policy = new DefaultPolicyEngine().derive(profile);
    add("hardware", "pass", `${os.platform()}/${os.arch()}, ${profile.ram_total_gb}GB RAM, safe memory budget ${profile.memory_budget_gb}GB, power mode ${policy.power_mode}`, { profile, policy });

    // 2. llama-server
    const found = locateLlamaServer(flag(args, "--llama-server"));
    let bin: string | null = found.path;
    if (!bin) {
      add("llama-server", "missing", `not found (looked in: ${found.searched.join(", ") || "PATH only"})`);
      missing.push(MISSING_LLAMA);
    } else {
      const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 });
      const out = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim();
      if (v.error || v.status !== 0) { add("llama-server", "fail", `could not run ${bin}: ${v.error?.message ?? out.slice(0, 300)} (shared libraries must stay next to the binary)`); bin = null; }
      else add("llama-server", "pass", `${bin} — ${out.split("\n").find((l) => /version|build/i.test(l)) ?? out.split("\n")[0]}`);
    }

    // 3. model
    let candidates: ModelRegistryEntry[] = [];
    const modelFlag = flag(args, "--model");
    if (modelFlag) {
      if (!existsSync(modelFlag)) { add("model", "missing", `file not found: ${modelFlag}`); missing.push(MISSING_MODEL); }
      else {
        try {
          const meta = readGgufMeta(modelFlag);
          const e = entryFromGguf(modelFlag, meta);
          candidates = [e];
          add("model", "pass", `${e.model_id}: ${e.parameter_count.total}B ${e.quantization}, GGUF v${meta.version}, ${(meta.file_size / 1024 ** 3).toFixed(2)}GB, ctx ${e.context_limit}, layers ${e.layers}, kv heads ${e.kv_heads}, head dim ${e.head_dim}, caps [${e.capabilities.join(",")}]`, { entry: e });
        } catch (err) { add("model", "fail", `not a readable GGUF: ${(err as Error).message}`); }
      }
    } else {
      candidates = loadFullRegistry().filter((e) => isDownloaded(e));
      if (candidates.length === 0) { add("model", "missing", "no downloaded model found in the registry and no --model given"); missing.push(MISSING_MODEL); }
      else add("model", "pass", `${candidates.length} downloaded registry model(s): ${candidates.map((c) => c.model_id).join(", ")}`);
    }

    if (!bin || candidates.length === 0) return;

    // 4. memory-safety gate (never bypassed)
    const decision = new DefaultModelRouter().route("hard_agent", policy, candidates);
    if (isRejection(decision)) {
      add("memory gate", "fail", `no candidate fits the safe memory budget (${policy.memory_budget_gb}GB): ${decision.attempted.map((a) => `${a.model_id} needs ~${a.required_gb.toFixed(1)}GB`).join("; ")}. Use a smaller model or a lower-bit quantization; the gate is not bypassed.`);
      return;
    }
    const entry = candidates.find((c) => c.model_id === decision.model_id)!;
    decisionForReport = decision;
    add("memory gate", "pass", `${entry.model_id} fits: context ${decision.ctx_window}, KV ${decision.kv_cache_dtype} (${decision.kv_cache_budget_mb.toFixed(0)}MB ${entry.layers ? "exact" : "heuristic"}), max output ${decision.max_output_tokens}`);

    // 5. load the real model
    const backend = new LlamaCppBackend({ binary: bin });
    cleanup.push(() => backend.unload());
    const t0 = Date.now();
    try { await backend.load(entry, decision); }
    catch (err) { add("load model", "fail", (err as Error).message.slice(0, 900)); return; }
    const rssLoaded = readRssMb(backend.pid);
    add("load model", "pass", `ready in ${((Date.now() - t0) / 1000).toFixed(1)}s; llama-server RSS ${rssLoaded ?? "n/a"}MB (registry estimate ${(entry.estimated_memory_gb * 1024).toFixed(0)}MB weights + KV ${decision.kv_cache_budget_mb.toFixed(0)}MB)`, { rss_mb: rssLoaded });

    // 6. real tokenizer
    try {
      const sample = "function add(a, b) { return a + b; }";
      const toks = await backend.tokenize(sample);
      const n = await backend.countTokens(sample);
      add("tokenizer", toks.length > 0 && toks.length === n ? "pass" : "fail", `real /tokenize: ${n} tokens for ${sample.length} chars (chars/4 estimate would be ${Math.ceil(sample.length / 4)})`);
    } catch (err) { add("tokenizer", "fail", (err as Error).message); }

    // helper: stream a generation and time it
    const gen = async (prompt: PromptPayload, maxTokens: number) => {
      const start = Date.now();
      let first = 0, chunks = 0, text = "";
      for await (const t of backend.generate(prompt, { max_tokens: maxTokens, temperature: 0.2 })) {
        if (!first && t.token) first = Date.now();
        if (t.token) { chunks++; text += t.token; }
      }
      const end = Date.now();
      return { text, chunks, ttft_ms: first ? first - start : null, chunks_per_s: first && end > first ? Math.round((chunks / ((end - first) / 1000)) * 10) / 10 : null, total_ms: end - start };
    };

    // 7. chat
    let chatOk = false;
    try {
      const r = await gen({ mode: "chat", messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "Reply with exactly one word: pong" }] }, 16);
      chatOk = r.text.trim().length > 0;
      add("chat generation", chatOk ? "pass" : "fail", `${JSON.stringify(r.text.trim().slice(0, 60))}; first token ${r.ttft_ms ?? "n/a"}ms, ~${r.chunks_per_s ?? "n/a"} chunks/s (≈ tokens/s), ${r.total_ms}ms total`, r as any);
    } catch (err) { add("chat generation", "fail", (err as Error).message); }

    // 8. fill-in-middle
    if (entry.capabilities.includes("fim")) {
      try {
        const r = await gen({ mode: "fim", prefix: "def add(a, b):\n    return ", suffix: "\n\nprint(add(1, 2))\n" }, 24);
        add("fim /infill", r.text.trim() ? "pass" : "fail", `${JSON.stringify(r.text.slice(0, 60))}; first token ${r.ttft_ms ?? "n/a"}ms`);
      } catch (err) { add("fim /infill", "fail", (err as Error).message); }
    } else add("fim /infill", "skip", "this model's GGUF has no fill-in-middle tokens (autocomplete needs a FIM-capable model)");

    // 9. can this model follow the agent's JSON contract?
    if (chatOk) {
      const trials = Math.max(1, parseInt(flag(args, "--json-trials") ?? "2", 10));
      let ok = 0; const samples: string[] = [];
      for (let i = 0; i < trials; i++) {
        const r = await gen({ mode: "chat", messages: [{ role: "system", content: PLAN_SYS }, { role: "user", content: `## goal\n${FIXTURE_GOAL}\n\n## files\ncalc.js\ncalc.test.js\nREADME.md` }] }, Math.min(decision.max_output_tokens, 400));
        const j = extractJson(r.text) as any;
        const good = !!j && Array.isArray(j.plan) && j.plan.length > 0;
        if (good) ok++; else samples.push(r.text.slice(0, 200));
      }
      add("agent JSON contract", ok === trials ? "pass" : ok > 0 ? "fail" : "fail", `${ok}/${trials} plan replies parsed as valid agent JSON${samples.length ? `; bad sample: ${JSON.stringify(samples[0])}` : ""}`, { ok, trials });
    }
    const rssAfter = readRssMb(backend.pid);
    if (rssAfter !== null) add("memory after generation", "pass", `llama-server RSS ${rssAfter}MB (a post-generation reading, not a guaranteed peak)`, { rss_mb: rssAfter });

    // 10. the agent, end to end, on a tiny real repo
    if (args.includes("--skip-agent")) add("agent task", "skip", "--skip-agent given");
    else if (!chatOk) add("agent task", "skip", "chat generation failed, so the agent cannot run");
    else {
      const root = createFixtureRepo();
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const wall = parseInt(flag(args, "--agent-seconds") ?? "900", 10);
      const session = await openAgentSession({ root, backend, policy: { ...policy, max_agent_wall_seconds: wall }, decision });
      cleanup.push(() => session.close());
      console.log(`\n--- agent task: "${FIXTURE_GOAL}" (wall limit ${wall}s; verify raises the policy default) ---`);
      const started = Date.now();
      let done: any = null, error: any = null, toolCalls = 0;
      for await (const ev of session.agent.run({ task: FIXTURE_GOAL })) {
        if (ev.type === "plan") console.log(`  plan: ${ev.steps.join(" | ")}`);
        else if (ev.type === "tool_call") { toolCalls++; console.log(`  -> ${ev.name} ${JSON.stringify(ev.args).slice(0, 100)}`); }
        else if (ev.type === "tool_result") console.log(`  <- ${ev.name} ${ev.result.ok ? "ok" : "FAILED"}`);
        else if (ev.type === "observation") console.log(`  observe: ${ev.content.split("\n")[0].slice(0, 120)}`);
        else if (ev.type === "diff") console.log(`  diff:\n${ev.patch.split("\n").map((l) => "    " + l).join("\n")}`);
        else if (ev.type === "done") done = ev;
        else if (ev.type === "error") error = ev;
      }
      const independent = spawnSync("node", ["--test"], { cwd: root, encoding: "utf8", timeout: 60_000 });
      const testsPass = independent.status === 0;
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const st = session.agent.currentState;
      const stats = { seconds, tool_calls: toolCalls, model_calls: st.model_calls, fix_attempts: st.fix_attempts, prompt_tokens: st.prompt_tokens_total, token_basis: st.token_basis, agent_reported_success: done?.success ?? false, independent_tests_pass: testsPass };
      if (error) add("agent task", "fail", `agent stopped with an error in ${error.phase}: ${error.message}`, stats);
      else if (done?.success && testsPass) add("agent task", "pass", `fixed the bug; tests pass when re-run independently (${seconds}s, ${st.model_calls} model calls, ${st.fix_attempts} fix attempts, ${st.prompt_tokens_total} prompt tokens ${st.token_basis})`, stats);
      else add("agent task", "fail", `${done?.summary ?? "no result"} | independent test run: ${testsPass ? "pass" : "FAIL"} — plumbing worked; the model did not complete the task (see events above)`, stats);
    }
  } finally {
    for (const c of cleanup.reverse()) { try { await c(); } catch { /* best effort */ } }
    const failed = steps.filter((s) => s.status === "fail");
    writeFileSync(reportPath, JSON.stringify({ when: new Date().toISOString(), node: process.version, platform: `${os.platform()}/${os.arch()}`, decision: decisionForReport, steps, missing }, null, 2));
    console.log(`\nreport written to ${reportPath}`);
    if (missing.length) {
      console.log(`\nCANNOT COMPLETE — missing component(s):`);
      missing.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
      process.exitCode = 2;
    } else if (failed.length) {
      console.log(`\n${failed.length} step(s) FAILED: ${failed.map((f) => f.name).join(", ")}`);
      process.exitCode = 1;
    } else console.log("\nAll verification steps passed.");
  }
}
