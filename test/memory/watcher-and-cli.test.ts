import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import { SqliteIndexStore } from "../../src/index/sqlite-store";
import { MemoryStore } from "../../src/memory/memory-store";
import { IndexService } from "../../src/index/index-service";

const CLI = path.join(__dirname, "../../src/cli/index.ts");
const run = (cwd: string, ...args: string[]) =>
  execFileSync("npx", ["tsx", CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

test("real fs.watch: creating and modifying a file updates the index, and modifying marks referencing memory STALE", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-watch-"));
  const dbPath = path.join(root, ".localcoder", "index.sqlite");
  const store = new SqliteIndexStore(dbPath);
  const memory = new MemoryStore(dbPath);
  const service = new IndexService(root, store, memory);
  try {
    writeFileSync(path.join(root, "a.ts"), "export function one() {}\n");
    await service.indexAll();
    await memory.addMemory("important_file", "a.ts holds one().", ["a.ts"]);

    await service.startWatching();
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(path.join(root, "b.ts"), "export function two() {}\n");
    writeFileSync(path.join(root, "a.ts"), "export function one() {}\nexport function extra() {}\n");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const b = await store.getFile("b.ts");
      const syms = await store.getSymbols("a.ts");
      if (b && syms.length === 2 && memory.listMemory({ includeStale: true })[0].stale) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(await store.getFile("b.ts"), "watcher should have indexed the newly created file");
    assert.equal((await store.getSymbols("a.ts")).length, 2, "watcher should have re-indexed the modified file");
    assert.equal(memory.listMemory({ includeStale: true })[0].stale, true, "memory referencing a changed file must be marked STALE");
  } finally {
    await service.stopWatching();
    store.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI end-to-end: index, symbols, search, memory add, context --explain, secret memory rejected", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-cli-"));
  try {
    writeFileSync(path.join(root, "tenant.ts"), "export class TenantResolver {\n  resolve(id: string) {\n    return id;\n  }\n}\n");
    assert.match(run(root, "index", "."), /files: 1/);
    assert.match(run(root, "symbols", "TenantResolver"), /TenantResolver/);
    assert.match(run(root, "search", "resolve"), /tenant\.ts/);
    assert.match(run(root, "memory", "add", "architecture", "Tenants resolved per request", "tenant.ts"), /Added memory/);
    const ctx = run(root, "context", "TenantResolver", "--file", "tenant.ts", "--explain");
    assert.match(ctx, /layers:/);
    assert.match(ctx, /reduction/);
    assert.match(ctx, /\[project\]/);
    assert.match(run(root, "memory", "status"), /1 entries/);
    // Secret protection through the CLI path: exits non-zero / adds nothing.
    let failed = false;
    try { execFileSync("npx", ["tsx", CLI, "memory", "add", "constraint", "deploy key", ".env"], { cwd: root, stdio: "ignore" }); } catch { failed = true; }
    assert.ok(failed, "adding memory that references .env must fail");
    assert.match(run(root, "memory", "status"), /1 entries/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
