/**
 * Phase 1 benchmark: full index of a ~50k-line synthetic repo + incremental re-index latency.
 * Everything printed here is MEASURED on the machine that runs this script — it says nothing
 * about other hardware (an 8GB PC, an M1 Air). Re-run on target hardware for those numbers.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { SqliteIndexStore } from "../src/index/sqlite-store";
import { IndexService } from "../src/index/index-service";

const FILES = 620;
const FUNCS_PER_FILE = 8;

function tsFile(i: number): string {
  const lines: string[] = [`export class Service${i} {`, `  private state = ${i};`];
  for (let f = 0; f < FUNCS_PER_FILE; f++) {
    lines.push(``, `  handle${f}(input: number): number {`, `    const x = input + ${f};`, `    // padding line to reach realistic file length`);
    for (let p = 0; p < 4; p++) lines.push(`    const v${p} = x * ${p + 1} + this.state;`);
    lines.push(`    return x;`, `  }`);
  }
  lines.push(`}`, ``);
  for (let f = 0; f < 3; f++) lines.push(`export function util${i}_${f}(a: number) {`, `  return a + ${f};`, `}`, ``);
  return lines.join("\n");
}

function pyFile(i: number): string {
  const lines: string[] = [`class Worker${i}:`, `    def __init__(self):`, `        self.n = ${i}`];
  for (let f = 0; f < FUNCS_PER_FILE; f++) {
    lines.push(``, `    def run${f}(self, x):`);
    for (let p = 0; p < 6; p++) lines.push(`        y${p} = x * ${p + 1} + self.n`);
    lines.push(`        return y0`);
  }
  lines.push(``, `def helper${i}(a):`, `    return a`, ``);
  return lines.join("\n");
}

function pct(sorted: number[], p: number) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; }

async function main() {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-bench-"));
  let totalLines = 0;
  for (let i = 0; i < FILES; i++) {
    const dir = path.join(root, `pkg${i % 25}`);
    mkdirSync(dir, { recursive: true });
    const content = i % 2 === 0 ? tsFile(i) : pyFile(i);
    totalLines += content.split("\n").length;
    writeFileSync(path.join(dir, i % 2 === 0 ? `mod${i}.ts` : `mod${i}.py`), content);
  }

  const store = new SqliteIndexStore(path.join(root, ".localcoder", "index.sqlite"));
  const service = new IndexService(root, store);

  const full = await service.indexAll();
  console.log(`machine: ${os.cpus().length} cpus, ${(os.totalmem() / 1024 ** 3).toFixed(1)}GB RAM, node ${process.version}   [measured environment]`);
  console.log(`repo: ${FILES} files, ${totalLines.toLocaleString()} lines (synthetic)`);
  console.log(`full index: ${full.files} files, ${full.symbols} symbols in ${full.duration_ms}ms   [measured]`);

  // Correctness: known-symbol lookups.
  const hit = await store.query("Service250", "symbol", 5);
  const hit2 = await store.query("Worker251", "symbol", 5);
  console.log(`symbol lookup Service250 -> ${hit[0]?.path}:${hit[0]?.line_start}  (correct: ${hit[0]?.path.endsWith("mod250.ts")})`);
  console.log(`symbol lookup Worker251  -> ${hit2[0]?.path}:${hit2[0]?.line_start}  (correct: ${hit2[0]?.path.endsWith("mod251.py")})`);

  // Incremental: modify one file, time handleEvent. 30 runs.
  const times: number[] = [];
  for (let n = 0; n < 30; n++) {
    const i = (n * 16) % FILES;
    const rel = `pkg${i % 25}/${i % 2 === 0 ? `mod${i}.ts` : `mod${i}.py`}`;
    const orig = i % 2 === 0 ? tsFile(i) : pyFile(i);
    writeFileSync(path.join(root, rel), orig + `\n// change ${n}\n`);
    const t0 = performance.now();
    await service.handleEvent({ type: "modified", path: rel });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`incremental single-file re-index (n=30): median ${pct(times, 0.5).toFixed(1)}ms, p95 ${pct(times, 0.95).toFixed(1)}ms, max ${times[times.length - 1].toFixed(1)}ms   [measured]`);
  console.log(`target < 500ms: ${pct(times, 0.95) < 500 ? "MET (p95)" : "NOT MET"}`);

  // Text search latency on the fallback scanner (no ripgrep in this environment).
  const t1 = performance.now();
  const textHits = await store.query("Service250", "text", 10);
  console.log(`text search (fallback scanner, full-repo scan): ${(performance.now() - t1).toFixed(1)}ms, ${textHits.length} hits   [measured]`);

  const st = await store.stats();
  console.log(`rss: ${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)}MB   [measured]`);
  console.log(`index stats: files=${st.files} symbols=${st.symbols}`);
  store.close();
  rmSync(root, { recursive: true, force: true });
}
main();
