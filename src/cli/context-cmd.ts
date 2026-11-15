import { openIndexStore } from "../index/open";
import { AdaptiveContextManager } from "../memory/adaptive-context-manager";
import { MemoryStore } from "../memory/memory-store";
import { indexDbPath } from "../index/open";
import { EstimatingTokenCounter } from "../context/token-counter";

export async function runContext(args: string[]): Promise<void> {
  const query = args.find((a) => !a.startsWith("--"));
  if (!query) {
    console.log('Usage: localcoder context "<query>" [--file <path>] [--symbol <name>] [--budget N]');
    process.exitCode = 1;
    return;
  }
  const fileFlag = args.indexOf("--file");
  const symbolFlag = args.indexOf("--symbol");
  const budgetFlag = args.indexOf("--budget");

  const root = process.cwd();
  const store = openIndexStore(root);
  try {
    // CLI usage has no loaded model to ask, so token counts here are always the
    // estimated fallback — printed explicitly below, never presented as measured.
    const memory = new MemoryStore(indexDbPath(root));
    process.once("exit", () => memory.close());
    const manager = new AdaptiveContextManager(store, memory, new EstimatingTokenCounter());

    const bundle = await manager.assemble({
      query,
      currentFile: fileFlag !== -1 ? args[fileFlag + 1] : undefined,
      currentSymbol: symbolFlag !== -1 ? args[symbolFlag + 1] : undefined,
      tokenBudget: budgetFlag !== -1 ? parseInt(args[budgetFlag + 1], 10) : 4096,
      contextWindow: 8192,
      reservedOutputTokens: 512,
      reservedSystemTokens: 256,
    });

    console.log(`Context bundle (${bundle.token_basis} tokens, layers: ${bundle.layers_included.join(" > ")}):`);
    console.log(`  budget: ${bundle.budget_tokens_used}/${bundle.budget_tokens_max} tokens`);
    const m = bundle.metrics;
    console.log(`  raw ${m.raw_tokens_estimate} -> optimized ${m.optimized_tokens_used} tokens (${m.reduction_pct}% reduction, ${m.basis}); cache hit rate ${m.cache_hit_rate}%; stale memory skipped ${m.stale_memory_skipped}; assembled in ${m.assembly_latency_ms}ms [measured]\n`);
    if (args.includes("--explain")) {
      for (const e of bundle.explanations) console.log(`  ${e.included ? "+" : "-"} [${e.layer}] ${e.path ?? ""} ${e.tokens}tok — ${e.why}${e.reason_excluded ? ` (excluded: ${e.reason_excluded})` : ""}`);
      console.log();
    }
    for (const f of bundle.files) {
      console.log(`--- ${f.path}  (${f.why}) ---`);
      console.log(f.snippet.split("\n").slice(0, 8).join("\n") + (f.snippet.split("\n").length > 8 ? "\n    ..." : ""));
      console.log();
    }
    if (bundle.files.length === 0) {
      console.log("(no context assembled — empty repository, no budget, or no matches)");
    }
  } finally {
    store.close();
  }
}
