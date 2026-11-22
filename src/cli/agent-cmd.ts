import path from "path";
import { buildContext } from "../server/index";
import { prepareAgentRun, SequentialModelWorkflow } from "../agent/model-workflow";
import { openAgentSession, tryLockRepo, unlockRepo } from "../agent/session";
import { AgentStateStore } from "../agent/state";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

export async function runAgent(args: string[]): Promise<void> {
  const modelId = flag(args, "--model");
  if (args.includes("--model") && (!modelId || modelId.startsWith("--"))) {
    console.error("localcoder: --model requires an installed model ID. Run localcoder models list.");
    process.exitCode = 1;
    return;
  }
  const task = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!task) { console.log('Usage: localcoder agent "<task>" [--model <id>] [--session <id>] [--resume <task_id>] [--backend llama|mock]'); process.exitCode = 1; return; }
  const ctx = buildContext({ backend: flag(args, "--backend") as "llama" | "mock" | undefined });
  let prepared;
  try { prepared = await prepareAgentRun(ctx.repoRoot, { task, session_id: flag(args, "--session"), resume_task_id: flag(args, "--resume") }, ctx, modelId); }
  catch (error) { console.error(`localcoder: ${(error as Error).message}`); process.exitCode = 1; return; }
  const pre = prepared.preflight;
  if (!pre.ok) { console.error(`localcoder: ${pre.message} (${pre.reason})`); process.exitCode = 1; return; }
  if (!tryLockRepo(ctx.repoRoot)) { console.error("localcoder: an agent run is already active for this repository"); process.exitCode = 1; return; }
  let session;
  try {
    let backend;
    if (!prepared.models) {
      const loaded = await ctx.modelManager.ensure(pre.decision, pre.policy, 8);
      backend = ctx.modelManager.getBackend(loaded.model_id)!;
    }
    session = await openAgentSession({ root: ctx.repoRoot, backend,
      modelWorkflow: prepared.models ? new SequentialModelWorkflow(ctx, prepared.models) : undefined,
      config: prepared.config, policy: pre.policy, decision: pre.decision });
    console.log(`${prepared.models ? "workflow: planner → coder → reviewer" : `model: ${pre.decision.model_id}`}  power: ${pre.policy.power_mode}  repo: ${ctx.repoRoot}${session.indexedNow ? "  (indexed now, one-shot)" : ""}`);
    let failed = false;
    for await (const ev of session.agent.run(prepared.request)) {
      if (ev.type === "model") console.log(`model: ${ev.role} → ${ev.model_id}`);
      else if (ev.type === "plan") console.log(`plan:\n${ev.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
      else if (ev.type === "tool_call") console.log(`  → ${ev.name} ${JSON.stringify(ev.args).slice(0, 120)}`);
      else if (ev.type === "tool_result") {
        console.log(`  ← ${ev.name} ${ev.result.ok ? "ok" : "FAILED"} (${ev.result.size_bytes}B${ev.result.truncated ? ", truncated" : ""})`);
        const warning = (ev.result.data as { warning?: string } | undefined)?.warning;
        if (warning) console.warn(`  warning: ${warning}`);
      }
      else if (ev.type === "observation") console.log(`  observe: ${ev.content.split("\n")[0].slice(0, 140)}`);
      else if (ev.type === "diff") console.log(`\nfinal diff:\n${ev.patch}`);
      else if (ev.type === "done") { failed = !ev.success; console.log(`\n${ev.success ? "DONE" : "STOPPED"} (verification: ${ev.verification}, fix attempts: ${ev.fix_attempts}) task ${ev.task_id}\n${ev.summary}`); }
      else if (ev.type === "error") { failed = true; console.error(`\nerror in ${ev.phase}: ${ev.message}${ev.recoverable ? `\n(resumable: localcoder agent "continue" or --resume ${ev.task_id})` : ""}`); }
    }
    if (failed) process.exitCode = 1;
  } catch (e) {
    console.error(`localcoder: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    session?.close();
    unlockRepo(ctx.repoRoot);
    await ctx.modelManager.unload(pre.decision.model_id).catch(() => {});
  }
}

export async function runUndo(args: string[]): Promise<void> {
  const root = path.resolve(".");
  const store = new AgentStateStore(root);
  const taskId = args.find((a) => !a.startsWith("--")) ?? store.latestWithEdits()?.task_id;
  if (!taskId) { console.log("No agent task with edits to undo."); return; }
  const stub = { load: async () => {}, generate: async function* () {}, unload: async () => {}, tokenize: async () => [], countTokens: async () => 0 };
  const policy = { power_mode: "balanced" as const, memory_budget_gb: 0, max_context_tokens: 0, max_gpu_offload_fraction: 0, max_agent_wall_seconds: 60, max_tool_calls: 1, allow_background_indexing: false };
  const session = await openAgentSession({ root, backend: stub, policy, decision: { model_id: "none", ctx_window: 0, kv_cache_budget_mb: 0, kv_cache_dtype: "f16", max_output_tokens: 0, gpu_offload_fraction: 0 } });
  try {
    const r = await session.agent.undo(taskId, { force: args.includes("--force") });
    if (r.already_undone) console.log(`Task ${taskId} was already undone.`);
    else {
      console.log(`Undo ${taskId}: restored ${r.restored.length}, deleted ${r.deleted.length}, conflicts ${r.conflicts.length}`);
      for (const c of r.conflicts) console.log(`  conflict ${c.path}: ${c.reason}`);
      if (r.conflicts.length) process.exitCode = 1;
    }
  } finally { session.close(); }
}
