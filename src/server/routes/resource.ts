import type { ServerResponse } from "http";
import type { AppContext } from "../context";
import { isRejection } from "../../types/index";

export async function handleResource(_body: unknown, res: ServerResponse, ctx: AppContext): Promise<void> {
  const profile = await ctx.profiler.sample();
  const policy = ctx.policyEngine.derive(profile);

  const model_contexts = Object.fromEntries(ctx.registry.flatMap((entry) => {
    const decision = ctx.router.route("normal_coding", policy, [entry]);
    return isRejection(decision) ? [] : [[entry.model_id, {
      context_window: Math.min(decision.ctx_window, ctx.modelManager.residentContext(entry.model_id) ?? Infinity),
      max_output_tokens: decision.max_output_tokens,
    }]];
  }));
  const body: Record<string, unknown> = { profile, policy, model_contexts };

  // Additive only — Phase 0 clients that don't know about "repository" are unaffected.
  if (ctx.indexStore) {
    const stats = await ctx.indexStore.stats();
    body.repository = { indexed: stats.files > 0, files: stats.files, symbols: stats.symbols, languages: stats.languages };
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
