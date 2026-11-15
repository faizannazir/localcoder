import { openIndexStore } from "../index/open";

export async function runSearch(args: string[]): Promise<void> {
  const query = args.find((a) => !a.startsWith("--"));
  if (!query) {
    console.log('Usage: localcoder search "<query>"');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const store = openIndexStore(root);
  try {
    const results = await store.query(query, "text", 10);
    if (results.length === 0) {
      console.log(`No text matches for "${query}". Has this repo been indexed? Try: localcoder index .`);
      return;
    }
    for (const r of results) {
      console.log(`${r.path}:${r.line_start ?? "?"}  score=${r.score.toFixed(2)}`);
      if (r.snippet) console.log(`    ${r.snippet.split("\n").join("\n    ")}`);
    }
  } finally {
    store.close();
  }
}
