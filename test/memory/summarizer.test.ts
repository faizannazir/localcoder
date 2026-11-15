import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { MemoryStore } from "../../src/memory/memory-store";
import { getOrCreateSummary } from "../../src/memory/summarizer";

function tempStore(): { store: MemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "localcoder-sumtest-"));
  const store = new MemoryStore(path.join(dir, "index.sqlite"));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("summarizer: short content is returned verbatim, not compressed", () => {
  const { store, cleanup } = tempStore();
  try {
    const short = "a short tool result";
    const { entry, cacheHit } = getOrCreateSummary(store, short, "tool_result");
    assert.equal(entry.summary, short);
    assert.equal(cacheHit, false);
  } finally {
    cleanup();
  }
});

test("summarizer: long content is compressed and never labeled as model-generated", () => {
  const { store, cleanup } = tempStore();
  try {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}: some log output here`).join("\n");
    const { entry } = getOrCreateSummary(store, long, "tool_result");
    assert.ok(entry.summary.length < long.length, "summary must actually be shorter than the original");
    assert.equal(entry.basis, "heuristic", "must never claim model-generated when no model was called");
    assert.ok(entry.summary.includes("omitted"));
  } finally {
    cleanup();
  }
});

test("summarizer: identical content is a cache hit the second time, and reports tokens saved", () => {
  const { store, cleanup } = tempStore();
  try {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}: repeated content`).join("\n");
    const first = getOrCreateSummary(store, long, "file");
    assert.equal(first.cacheHit, false);

    const second = getOrCreateSummary(store, long, "file");
    assert.equal(second.cacheHit, true);
    assert.equal(second.entry.summary, first.entry.summary);
    assert.ok(second.tokensSavedEstimate > 0);
  } finally {
    cleanup();
  }
});
