import path from "path";
import { openIndexStore } from "../index/open";
import { IndexService } from "../index/index-service";
import { MemoryStore } from "../memory/memory-store";
import { indexDbPath } from "../index/open";

export async function runIndex(args: string[]): Promise<void> {
  const status = args.includes("--status");
  const clear = args.includes("--clear");
  const watch = args.includes("--watch");
  const positional = args.find((a) => !a.startsWith("--"));
  const root = path.resolve(positional ?? ".");

  const store = openIndexStore(root);

  if (clear) {
    await store.clear();
    // eslint-disable-next-line no-console
    console.log(`Cleared index for ${root}`);
    store.close();
    return;
  }

  if (status) {
    const stats = await store.stats();
    printStats(stats);
    store.close();
    return;
  }

  const memory = new MemoryStore(indexDbPath(root)); // enables STALE-marking of project memory on file changes during --watch
  const service = new IndexService(root, store, memory);
  const result = await service.indexAll();

  // eslint-disable-next-line no-console
  console.log(`Indexed:`);
  console.log(`  files: ${result.files.toLocaleString()}`);
  console.log(`  symbols: ${result.symbols.toLocaleString()}`);
  console.log(`  languages: ${result.languages.length} (${result.languages.join(", ") || "none detected"})`);
  console.log(`  duration: ${(result.duration_ms / 1000).toFixed(2)}s  [measured, this run]`);
  console.log(``);

  if (watch) {
    console.log(`Incremental watcher: enabled — watching ${root} for changes. Ctrl+C to stop.`);
    await service.startWatching();
    process.on("SIGINT", async () => {
      await service.stopWatching();
      store.close();
      process.exit(0);
    });
    await new Promise(() => {}); // block forever until SIGINT
  } else {
    console.log(`Incremental watcher: enabled (run with --watch to keep it running, or start "localcoder serve" against this repo)`);
    store.close();
  }
}

function printStats(stats: Awaited<ReturnType<typeof import("../index/sqlite-store").SqliteIndexStore.prototype.stats>>) {
  // eslint-disable-next-line no-console
  console.log(`Index status:`);
  console.log(`  files: ${stats.files.toLocaleString()}`);
  console.log(`  symbols: ${stats.symbols.toLocaleString()}`);
  console.log(`  languages: ${stats.languages.join(", ") || "none"}`);
  console.log(`  last indexed: ${stats.last_indexed_at ?? "never"}`);
}
