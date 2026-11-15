import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { MemoryStore } from "../../src/memory/memory-store";

function tempStore(): { store: MemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "localcoder-memtest-"));
  const store = new MemoryStore(path.join(dir, "index.sqlite"));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("MemoryStore: add and list project memory, excludes stale by default", async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.addMemory("architecture", "Uses a hexagonal architecture with ports/adapters.", ["src/core.ts"]);
    await store.addMemory("convention", "All dates are stored as ISO 8601 strings.");

    const all = store.listMemory();
    assert.equal(all.length, 2);
    assert.ok(all.every((m) => m.stale === false));
  } finally {
    cleanup();
  }
});

test("MemoryStore: markStaleByFile marks only entries referencing that file, and listMemory excludes them by default", async () => {
  const { store, cleanup } = tempStore();
  try {
    const a = await store.addMemory("important_file", "core.ts owns the request lifecycle.", ["src/core.ts"]);
    await store.addMemory("convention", "Unrelated convention note.", ["src/other.ts"]);

    const marked = store.markStaleByFile("src/core.ts");
    assert.equal(marked, 1);

    const fresh = store.listMemory();
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].id, a.id);

    const withStale = store.listMemory({ includeStale: true });
    assert.equal(withStale.length, 2);
    assert.ok(withStale.find((m) => m.id === a.id)?.stale);
  } finally {
    cleanup();
  }
});

test("MemoryStore: updateMemory clears staleness (a human/agent re-confirming a fact makes it fresh again)", async () => {
  const { store, cleanup } = tempStore();
  try {
    const entry = await store.addMemory("decision", "We use REST, not GraphQL.", ["docs/adr-1.md"]);
    store.markStaleByFile("docs/adr-1.md");
    assert.ok(store.getMemory(entry.id)!.stale);

    await store.updateMemory(entry.id, "We use REST, not GraphQL (reconfirmed).", ["docs/adr-1.md"]);
    assert.equal(store.getMemory(entry.id)!.stale, false);
  } finally {
    cleanup();
  }
});

test("MemoryStore: refuses to persist memory referencing a secret path", async () => {
  const { store, cleanup } = tempStore();
  try {
    await assert.rejects(() => store.addMemory("constraint", "Deploy key is here.", [".env"]));
    await assert.rejects(() => store.addMemory("constraint", "SSH config", [".ssh/config"]));
  } finally {
    cleanup();
  }
});

test("MemoryStore: refuses to persist content that looks like a credential, even with a clean related_files list", async () => {
  const { store, cleanup } = tempStore();
  try {
    await assert.rejects(() => store.addMemory("decision", 'The api_key: "sk-abcdefghijklmnopqrstuvwx" should be rotated.', []));
  } finally {
    cleanup();
  }
});

test("MemoryStore: chat summaries store compact summaries, never full transcripts, keyed by session", async () => {
  const { store, cleanup } = tempStore();
  try {
    await store.upsertChatSummary("session-1", "User is refactoring the auth module; agreed to extract TokenValidator.", null, ["src/auth.ts"], ["TokenValidator"]);
    const summary = store.getChatSummary("session-1");
    assert.ok(summary);
    assert.equal(summary!.referenced_symbols[0], "TokenValidator");

    // Upserting again for the same session updates in place rather than accumulating history.
    await store.upsertChatSummary("session-1", "Extraction done; now adding tests.", null, ["src/auth.ts", "test/auth.test.ts"], ["TokenValidator"]);
    const updated = store.getChatSummary("session-1");
    assert.equal(updated!.referenced_files.length, 2);
  } finally {
    cleanup();
  }
});

test("MemoryStore: task continuity — create, fetch active, append decisions, mark done", async () => {
  const { store, cleanup } = tempStore();
  try {
    const task = store.createTask("Extract TokenValidator", "Pulling validation logic out of auth.ts into its own class.", ["src/auth.ts"], ["TokenValidator"]);
    assert.equal(store.getActiveTask()?.id, task.id);

    store.appendTaskDecision(task.id, "Keep TokenValidator synchronous for now.");
    assert.deepEqual(store.getTask(task.id)!.decisions, ["Keep TokenValidator synchronous for now."]);

    store.updateTaskStatus(task.id, "done");
    assert.equal(store.getActiveTask(), null, "a done task must not still be returned as the active task");
  } finally {
    cleanup();
  }
});

test("MemoryStore: cache get/set round-trips and is keyed by content hash", async () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(store.cacheGet("nonexistent-hash"), null);
    store.cacheSet({ content_hash: "abc123", kind: "file", summary: "short summary", basis: "heuristic", original_size_bytes: 5000 });
    const hit = store.cacheGet("abc123");
    assert.equal(hit?.summary, "short summary");
    assert.equal(hit?.basis, "heuristic");
  } finally {
    cleanup();
  }
});
