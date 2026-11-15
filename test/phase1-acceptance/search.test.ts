import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { SqliteIndexStore } from "../../src/index/sqlite-store";
import { IndexService } from "../../src/index/index-service";

async function setupIndexed(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-searchtest-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  const store = new SqliteIndexStore(path.join(root, ".localcoder", "index.sqlite"));
  await new IndexService(root, store).indexAll();
  return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("symbol search finds an exact match and ranks it above a prefix match", async () => {
  const { store, cleanup } = await setupIndexed({
    "a.ts": "export function resolveTenant() {}\n",
    "b.ts": "export function resolveTenantAndCache() {}\n",
  });
  try {
    const results = await store.query("resolveTenant", "symbol", 10);
    assert.ok(results.length >= 2);
    assert.equal(results[0].symbol, "resolveTenant", "exact match should be ranked first");
  } finally {
    cleanup();
  }
});

test("text search finds a plain string match with a compact snippet, not the whole file", async () => {
  const bigFile = Array.from({ length: 100 }, (_, i) => `// line ${i}`).join("\n") + "\nconst NEEDLE = 42;\n" + Array.from({ length: 100 }, (_, i) => `// line ${100 + i}`).join("\n");
  const { store, cleanup } = await setupIndexed({ "big.ts": bigFile });
  try {
    const results = await store.query("NEEDLE", "text", 10);
    assert.equal(results.length, 1);
    assert.ok(results[0].snippet, "text results must include a snippet");
    assert.ok(results[0].snippet!.length < bigFile.length, "must never return the entire file as the snippet");
    assert.ok(results[0].snippet!.split("\n").length < 10, "snippet should be a small window around the match, not the whole file");
  } finally {
    cleanup();
  }
});

test("top-k limiting is respected for both symbol and text search", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`f${i}.ts`] = `export function target${i}() { return "target"; }\n`;
  const { store, cleanup } = await setupIndexed(files);
  try {
    const symbolResults = await store.query("target", "symbol", 2);
    assert.ok(symbolResults.length <= 2);

    const textResults = await store.query("target", "text", 3);
    assert.ok(textResults.length <= 3);
  } finally {
    cleanup();
  }
});

test("semantic search is gracefully unavailable — returns [] rather than silently substituting BM25/text results", async () => {
  const { store, cleanup } = await setupIndexed({ "a.ts": "export function foo() {}\n" });
  try {
    const results = await store.query("foo", "semantic", 10);
    assert.deepEqual(results, []);
  } finally {
    cleanup();
  }
});

test("a query with no matches returns an empty array, not an error", async () => {
  const { store, cleanup } = await setupIndexed({ "a.ts": "export function foo() {}\n" });
  try {
    assert.deepEqual(await store.query("DoesNotExistAnywhere", "symbol", 10), []);
    assert.deepEqual(await store.query("DoesNotExistAnywhere", "text", 10), []);
  } finally {
    cleanup();
  }
});
