import type { ServerResponse } from "http";
import type { AppContext } from "../context";

export async function handleResource(_body: unknown, res: ServerResponse, ctx: AppContext): Promise<void> {
  const profile = await ctx.profiler.sample();
  const policy = ctx.policyEngine.derive(profile);

  const body: Record<string, unknown> = { profile, policy };

  // Additive only — Phase 0 clients that don't know about "repository" are unaffected.
  if (ctx.indexStore) {
    const stats = await ctx.indexStore.stats();
    body.repository = { indexed: stats.files > 0, files: stats.files, symbols: stats.symbols, languages: stats.languages };
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
