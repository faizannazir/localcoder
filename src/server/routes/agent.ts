import type { IncomingMessage, ServerResponse } from "http";
import type { AppContext } from "../context";
import { preflightAgent } from "../../agent/preflight";
import { openAgentSession, tryLockRepo, unlockRepo } from "../../agent/session";
import { AgentStateStore } from "../../agent/state";

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function handleAgentRun(body: unknown, res: ServerResponse, ctx: AppContext, req?: IncomingMessage): Promise<void> {
  const b = (body ?? {}) as { task?: unknown; session_id?: unknown; resume_task_id?: unknown };
  if (typeof b.task !== "string" || b.task.trim() === "") return json(res, 400, { error: { message: '"task" (non-empty string) is required.' } });

  // Resource/hardware policy gate BEFORE any expensive work.
  const pre = await preflightAgent(ctx);
  if (!pre.ok) return json(res, 503, { error: { message: pre.message, reason: pre.reason, attempted: pre.attempted } });

  if (!tryLockRepo(ctx.repoRoot)) return json(res, 409, { error: { message: "an agent run is already active for this repository" } });
  let session: Awaited<ReturnType<typeof openAgentSession>> | null = null;
  let aborted = false;
  let lease: Awaited<ReturnType<AppContext["modelManager"]["acquire"]>> | undefined;
  try {
    try { lease = await ctx.modelManager.acquire(pre.decision, pre.policy, 8); }
    catch (err) { return json(res, 502, { error: { message: `Failed to load model "${pre.decision.model_id}": ${(err as Error).message}` } }); }
    const backend = lease.backend;

    res.on("close", () => { aborted = true; });
    session = await openAgentSession({ root: ctx.repoRoot, backend, policy: pre.policy, decision: pre.decision, aborted: () => aborted });

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for await (const ev of session.agent.run({
      task: b.task, session_id: typeof b.session_id === "string" ? b.session_id : undefined,
      resume_task_id: typeof b.resume_task_id === "string" ? b.resume_task_id : undefined,
    })) {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: { message: (err as Error).message } });
    else { res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message: (err as Error).message, recoverable: false })}\n\n`); res.end(); }
  } finally {
    session?.close();
    lease?.release();
    unlockRepo(ctx.repoRoot);
  }
}

export async function handleAgentUndo(body: unknown, res: ServerResponse, ctx: AppContext): Promise<void> {
  const b = (body ?? {}) as { task_id?: unknown; force?: unknown };
  const store = new AgentStateStore(ctx.repoRoot);
  const taskId = typeof b.task_id === "string" ? b.task_id : store.latestWithEdits()?.task_id;
  if (!taskId) return json(res, 404, { error: { message: "no agent task with edits to undo" } });
  if (!tryLockRepo(ctx.repoRoot)) return json(res, 409, { error: { message: "an agent run is already active for this repository" } });
  let session;
  try {
    // Undo needs no model: a stub backend is never called.
    const stub = { load: async () => {}, generate: async function* () {}, unload: async () => {}, tokenize: async () => [], countTokens: async () => 0 };
    const pol = ctx.policyEngine.derive(await ctx.profiler.sample());
    session = await openAgentSession({ root: ctx.repoRoot, backend: stub, policy: pol, decision: { model_id: "none", ctx_window: 0, kv_cache_budget_mb: 0, kv_cache_dtype: "f16", max_output_tokens: 0, gpu_offload_fraction: 0 } });
    json(res, 200, await session.agent.undo(taskId, { force: b.force === true }));
  } catch (err) {
    json(res, 400, { error: { message: (err as Error).message } });
  } finally {
    session?.close();
    unlockRepo(ctx.repoRoot);
  }
}
