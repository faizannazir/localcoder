import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { SqliteIndexStore } from "../../src/index/sqlite-store";
import { IndexService } from "../../src/index/index-service";
import { DefaultContextManager } from "../../src/context/context-manager";
import { EstimatingTokenCounter } from "../../src/context/token-counter";

async function setupIndexed(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-ctxtest-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    require("fs").mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const store = new SqliteIndexStore(path.join(root, ".localcoder", "index.sqlite"));
  await new IndexService(root, store).indexAll();
  const manager = new DefaultContextManager(store, new EstimatingTokenCounter());
  return { store, manager, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function req(overrides: Partial<Parameters<DefaultContextManager["assemble"]>[0]> = {}) {
  return { query: "test", tokenBudget: 4096, contextWindow: 8192, reservedOutputTokens: 512, reservedSystemTokens: 256, ...overrides };
}

test("Stage 1: current file is included when a generous budget is given", async () => {
  const { manager, cleanup } = await setupIndexed({ "a.ts": "export function foo() { return 1; }\n" });
  try {
    const bundle = await manager.assemble(req({ currentFile: "a.ts" }));
    assert.ok(bundle.files.some((f) => f.path === "a.ts" && f.why === "current file"));
    assert.ok(bundle.stage_reached >= 1);
  } finally {
    cleanup();
  }
});

test("Stage 2: a named current symbol is included as its own focused snippet when the whole file doesn't fit the budget", async () => {
  const { manager, cleanup } = await setupIndexed({
    "a.ts": ["export function foo() {", "  return 1;", "}", "", "export function bar() {", "  return 2;", "}"].join("\n"),
  });
  try {
    // Deliberately tiny budget: too small for the whole file (stage 1), just enough for
    // the "bar" symbol's own few-line snippet (stage 2) — otherwise stage 1 would already
    // cover the file and stage 2's identical slice would be correctly deduped away (see
    // the "does not duplicate" test below), which would make this test pass for the wrong reason.
    const bundle = await manager.assemble(req({ currentFile: "a.ts", currentSymbol: "bar", tokenBudget: 15 }));
    assert.ok(bundle.files.some((f) => f.why.includes("current symbol: bar")));
  } finally {
    cleanup();
  }
});

test("stops at the token budget rather than collecting all six stages and truncating afterward", async () => {
  const files: Record<string, string> = { "main.ts": "export function entry() { return callHelper(); }\n" };
  for (let i = 0; i < 20; i++) files[`related${i}.ts`] = `export function helper${i}() {\n  // padding to use up budget\n  return ${i};\n}\n`;
  const { manager, cleanup } = await setupIndexed(files);
  try {
    const tinyBudget = await manager.assemble(req({ currentFile: "main.ts", query: "helper", tokenBudget: 20 }));
    assert.ok(tinyBudget.budget_tokens_used <= tinyBudget.budget_tokens_max, "must never exceed the requested budget");
    assert.ok(tinyBudget.stage_reached <= 6);

    const roomyBudget = await manager.assemble(req({ currentFile: "main.ts", query: "helper", tokenBudget: 4096 }));
    assert.ok(roomyBudget.files.length >= tinyBudget.files.length, "more budget should never result in strictly less context");
  } finally {
    cleanup();
  }
});

test("does not duplicate the current file's content when a symbol from that same file is also included", async () => {
  const { manager, cleanup } = await setupIndexed({
    "a.ts": ["export function foo() {", "  return 1;", "}"].join("\n"),
  });
  try {
    const bundle = await manager.assemble(req({ currentFile: "a.ts", currentSymbol: "foo" }));
    // The whole file is already included in stage 1 — stage 2's identical symbol-only
    // slice of the same file must be treated as redundant, not appended a second time.
    const aEntries = bundle.files.filter((f) => f.path === "a.ts");
    assert.equal(aEntries.length, 1, "current file must not be duplicated by a redundant symbol slice");
  } finally {
    cleanup();
  }
});

test("handles a missing current file gracefully (no crash, falls through to later stages)", async () => {
  const { manager, cleanup } = await setupIndexed({ "real.ts": "export function findMe() {}\n" });
  try {
    const bundle = await manager.assemble(req({ currentFile: "does-not-exist.ts", query: "findMe" }));
    assert.ok(bundle.stage_reached >= 1);
    assert.ok(!bundle.files.some((f) => f.path === "does-not-exist.ts"));
  } finally {
    cleanup();
  }
});

test("handles an empty repository gracefully — an empty bundle, not an error", async () => {
  const { manager, cleanup } = await setupIndexed({});
  try {
    const bundle = await manager.assemble(req({ query: "anything" }));
    assert.equal(bundle.files.length, 0);
    assert.equal(bundle.budget_tokens_used, 0);
  } finally {
    cleanup();
  }
});

test("handles a file in an unsupported language (symbols empty) without breaking text-based stages", async () => {
  const { manager, cleanup } = await setupIndexed({ "main.rs": "fn main() {\n  println!(\"hello\");\n}\n" });
  try {
    const bundle = await manager.assemble(req({ currentFile: "main.rs", query: "hello" }));
    assert.ok(bundle.files.some((f) => f.path === "main.rs")); // whole file still includable via stage 1, just no symbol-level precision
  } finally {
    cleanup();
  }
});

test("a zero-budget request returns an honest empty bundle rather than an error", async () => {
  const { manager, cleanup } = await setupIndexed({ "a.ts": "export function foo() {}\n" });
  try {
    const bundle = await manager.assemble(req({ currentFile: "a.ts", tokenBudget: 0 }));
    assert.equal(bundle.files.length, 0);
  } finally {
    cleanup();
  }
});
