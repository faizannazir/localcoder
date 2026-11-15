import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, renameSync } from "fs";
import path from "path";
import os from "os";
import { SqliteIndexStore } from "../../src/index/sqlite-store";
import { IndexService } from "../../src/index/index-service";

function tempRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), "localcoder-idxtest-"));
}

function setup(root: string) {
  const store = new SqliteIndexStore(path.join(root, ".localcoder", "index.sqlite"));
  const service = new IndexService(root, store);
  return { store, service, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("index a small repository and retrieve a known file + symbol", async () => {
  const root = tempRepo();
  const { store, service, cleanup } = setup(root);
  try {
    writeFileSync(path.join(root, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    const result = await service.indexAll();

    assert.equal(result.files, 1);
    assert.equal(result.symbols, 1);
    assert.ok(result.languages.includes("typescript"));

    const file = await store.getFile("math.ts");
    assert.ok(file);
    assert.match(file!.content, /export function add/);

    const symbols = await store.getSymbols("math.ts");
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "add");
    assert.equal(symbols[0].kind, "function");
  } finally {
    cleanup();
  }
});

test("delete a file removes it and its symbols from the index", async () => {
  const root = tempRepo();
  const { store, service, cleanup } = setup(root);
  try {
    writeFileSync(path.join(root, "a.ts"), "export function foo() {}\n");
    await service.indexAll();
    assert.ok(await store.getFile("a.ts"));

    await service.handleEvent({ type: "deleted", path: "a.ts" });
    assert.equal(await store.getFile("a.ts"), null);
    assert.equal((await store.getSymbols("a.ts")).length, 0);
  } finally {
    cleanup();
  }
});

test("modifying a file re-indexes only that file, and unchanged content is skipped entirely", async () => {
  const root = tempRepo();
  const { store, service, cleanup } = setup(root);
  try {
    const filePath = path.join(root, "a.ts");
    writeFileSync(filePath, "export function foo() {}\n");
    await service.indexAll();
    const before = await store.getFile("a.ts");

    // Re-indexing identical content must be a true no-op (same content_hash).
    await service.handleEvent({ type: "modified", path: "a.ts" });
    const stillSame = await store.getFile("a.ts");
    assert.equal(stillSame!.content_hash, before!.content_hash);

    // Real change updates content and symbols.
    writeFileSync(filePath, "export function foo() {}\nexport function bar() {}\n");
    await service.handleEvent({ type: "modified", path: "a.ts" });
    const symbols = await store.getSymbols("a.ts");
    assert.equal(symbols.length, 2);
  } finally {
    cleanup();
  }
});

test("renaming a file (as a delete+create pair) results in correct final state under the new path only", async () => {
  const root = tempRepo();
  const { store, service, cleanup } = setup(root);
  try {
    writeFileSync(path.join(root, "old.ts"), "export function foo() {}\n");
    await service.indexAll();

    renameSync(path.join(root, "old.ts"), path.join(root, "new.ts"));
    await service.handleEvent({ type: "renamed", oldPath: "old.ts", newPath: "new.ts" });

    assert.equal(await store.getFile("old.ts"), null);
    const newFile = await store.getFile("new.ts");
    assert.ok(newFile);
    assert.equal((await store.getSymbols("new.ts")).length, 1);
  } finally {
    cleanup();
  }
});

test("ignore rules: default directories and .gitignore entries are never indexed", async () => {
  const root = tempRepo();
  try {
    // .gitignore must exist BEFORE IgnoreRules is constructed (IndexService reads it once,
    // at construction) — this ordering matters and is deliberately exercised here.
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "dep.js"), "export function shouldNotBeIndexed() {}\n");
    writeFileSync(path.join(root, ".gitignore"), "ignored-dir/\n*.generated.ts\n");
    mkdirSync(path.join(root, "ignored-dir"), { recursive: true });
    writeFileSync(path.join(root, "ignored-dir", "x.ts"), "export function alsoIgnored() {}\n");
    writeFileSync(path.join(root, "thing.generated.ts"), "export function generatedIgnored() {}\n");
    writeFileSync(path.join(root, "real.ts"), "export function realOne() {}\n");

    const { store, service, cleanup } = setup(root);
    try {
      const result = await service.indexAll();
      // real.ts + .gitignore itself (a plain, legitimately indexable text file — nothing
      // requires excluding it) = 2. node_modules/, ignored-dir/, and *.generated.ts must not appear.
      assert.equal(result.files, 2);
      assert.ok(await store.getFile("real.ts"));
      assert.equal(await store.getFile("node_modules/dep.js"), null);
      assert.equal(await store.getFile("ignored-dir/x.ts"), null);
      assert.equal(await store.getFile("thing.generated.ts"), null);
    } finally {
      cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignore rules: secret files are never indexed even without a .gitignore entry", async () => {
  const root = tempRepo();
  const { store, service, cleanup } = setup(root);
  try {
    writeFileSync(path.join(root, ".env"), "SECRET_KEY=abc123\n");
    writeFileSync(path.join(root, "real.ts"), "export function realOne() {}\n");

    await service.indexAll();
    assert.equal(await store.getFile(".env"), null);
    assert.ok(await store.getFile("real.ts"));
  } finally {
    cleanup();
  }
});

test("workspace jail: a symlink pointing outside the workspace root is never indexed", async () => {
  const root = tempRepo();
  const outside = mkdtempSync(path.join(os.tmpdir(), "localcoder-outside-"));
  const { store, service, cleanup } = setup(root);
  try {
    writeFileSync(path.join(outside, "secret-outside.ts"), "export function escaped() {}\n");
    try {
      symlinkSync(path.join(outside, "secret-outside.ts"), path.join(root, "escape-link.ts"));
    } catch {
      return; // symlink creation unsupported in this environment (e.g. restrictive container) — nothing to assert
    }

    const result = await service.indexAll();
    // The walk itself skips symlinks outright (see IndexService.walk), so it should never
    // even attempt to index the linked path.
    assert.equal(await store.getFile("escape-link.ts"), null);
    assert.equal(result.files, 0);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("full re-index (indexAll) is idempotent and clears stale entries from a previous run", async () => {
  const root = tempRepo();
  const { store, service, cleanup } = setup(root);
  try {
    writeFileSync(path.join(root, "a.ts"), "export function a() {}\n");
    await service.indexAll();
    unlinkSync(path.join(root, "a.ts"));
    writeFileSync(path.join(root, "b.ts"), "export function b() {}\n");

    const result = await service.indexAll();
    assert.equal(result.files, 1);
    assert.equal(await store.getFile("a.ts"), null, "indexAll must clear entries for files that no longer exist");
    assert.ok(await store.getFile("b.ts"));
  } finally {
    cleanup();
  }
});
