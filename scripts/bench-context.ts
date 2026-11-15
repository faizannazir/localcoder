/** Measured token-efficiency scenario: 3 consecutive turns on the same 620-file synthetic repo. Token counts are ESTIMATED (chars/4) — no model loaded. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os"; import path from "path";
import { SqliteIndexStore } from "../src/index/sqlite-store";
import { IndexService } from "../src/index/index-service";
import { MemoryStore } from "../src/memory/memory-store";
import { AdaptiveContextManager } from "../src/memory/adaptive-context-manager";
import { EstimatingTokenCounter } from "../src/context/token-counter";

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-ctxbench-"));
  const body = (i: number) => `export class Service${i} {\n` + Array.from({ length: 40 }, (_, k) => `  m${k}(x: number) {\n    return x * ${k} + ${i};\n  }\n`).join("\n") + `}\n`;
  for (let i = 0; i < 620; i++) { mkdirSync(path.join(root, `p${i % 20}`), { recursive: true }); writeFileSync(path.join(root, `p${i % 20}`, `s${i}.ts`), body(i)); }
  const db = path.join(root, ".localcoder", "index.sqlite");
  const store = new SqliteIndexStore(db), memory = new MemoryStore(db);
  await new IndexService(root, store, memory).indexAll();
  await memory.addMemory("architecture", "Services are plain classes; no DI container.", []);
  const t = memory.createTask("Refactor Service7", "Extract shared arithmetic from Service7 methods.", ["p7/s7.ts"], ["Service7"]);
  const mgr = new AdaptiveContextManager(store, memory, new EstimatingTokenCounter());
  const base = { tokenBudget: 6000, contextWindow: 8192, reservedOutputTokens: 512, reservedSystemTokens: 256 };
  const f = (await store.getFile("p7/s7.ts"))!;
  const naive = Math.ceil(f.content.length / 4);
  console.log(`naive "send the current file" cost: ~${naive} tokens [estimated]`);
  const turns: [string, any][] = [
    ["turn 1 (fresh)", { ...base, query: "Service7 m3", currentFile: "p7/s7.ts", currentSymbol: "Service7" }],
    ["turn 2 (same file, caller already holds it)", { ...base, query: "Service7 m3", currentFile: "p7/s7.ts", knownFileHashes: { "p7/s7.ts": f.content_hash } }],
    ["turn 3 ('continue')", { ...base, query: "continue" }],
  ];
  for (const [name, r] of turns) {
    const b = await mgr.assemble(r); const m = b.metrics;
    console.log(`${name}: used ${m.optimized_tokens_used}/${b.budget_tokens_max} tok, raw ${m.raw_tokens_estimate}, reduction ${m.reduction_pct}%, cache ${m.cache_hits}h/${m.cache_misses}m, ${m.assembly_latency_ms}ms, rss ${(process.memoryUsage().rss/1048576).toFixed(0)}MB [tokens estimated; latency/rss measured]`);
  }
  store.close(); memory.close(); rmSync(root, { recursive: true, force: true });
}
main();
