import { openIndexStore } from "../index/open";

export async function runSymbols(args: string[]): Promise<void> {
  const query = args.find((a) => !a.startsWith("--"));
  if (!query) {
    console.log('Usage: localcoder symbols "<query>"');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const store = openIndexStore(root);
  try {
    const results = await store.query(query, "symbol", 10);
    if (results.length === 0) {
      console.log(`No symbol matches for "${query}". Has this repo been indexed? Try: localcoder index .`);
      return;
    }
    for (const r of results) {
      console.log(`${r.symbol ?? "?"}  ${r.path}:${r.line_start ?? "?"}-${r.line_end ?? "?"}  score=${r.score.toFixed(2)}  (${r.reason ?? ""})`);
    }
  } finally {
    store.close();
  }
}
