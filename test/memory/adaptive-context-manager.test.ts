import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { SqliteIndexStore } from "../../src/index/sqlite-store";
import { IndexService } from "../../src/index/index-service";
import { MemoryStore } from "../../src/memory/memory-store";
import { AdaptiveContextManager } from "../../src/memory/adaptive-context-manager";
import { EstimatingTokenCounter } from "../../src/context/token-counter";

function tempRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "localcoder-actest-"));
  writeFileSync(
    path.join(dir, "auth.ts"),
    ["export class TokenValidator {", "  validate(token: string): boolean {", "    return token.length > 0;", "  }", "}"].join("\n")
  );
  return dir;
}

async function setup() {
  const root = tempRepo();
  const store = new SqliteIndexStore(path.join(root, ".localcoder", "index.sqlite"));
  const memory = new MemoryStore(path.join(root, ".localcoder", "index.sqlite"));
  const indexService = new IndexService(root, store, memory);
  await indexService.indexAll();
  const manager = new AdaptiveContextManager(store, memory, new EstimatingTokenCounter());
  return {
    root,
    store,
    memory,
    manager,
    cleanup: () => {
      store.close();
      memory.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseRequest(query: string) {
  return { query, tokenBudget: 4096, contextWindow: 8192, reservedOutputTokens: 512, reservedSystemTokens: 256 };
}

test("AdaptiveContextManager: includes non-stale project memory as its own layer", async () => {
  const { memory, manager, cleanup } = await setup();
  try {
    await memory.addMemory("architecture", "This project uses a layered architecture.", []);
    const bundle = await manager.assemble(baseRequest("how does auth work"));

    assert.ok(bundle.layers_included.includes("project"));
    assert.ok(bundle.files.some((f) => f.why.includes("project memory")));
  } finally {
    cleanup();
  }
});

test("AdaptiveContextManager: current-state precedence — stale memory is excluded, not just deprioritized", async () => {
  const { memory, manager, cleanup } = await setup();
  try {
    await memory.addMemory("important_file", "auth.ts previously only had a stub.", ["auth.ts"]);
    memory.markStaleByFile("auth.ts");

    const bundle = await manager.assemble(baseRequest("tell me about auth.ts"));
    assert.ok(!bundle.files.some((f) => f.snippet.includes("previously only had a stub")));
    assert.ok(bundle.metrics.stale_memory_skipped >= 1);
  } finally {
    cleanup();
  }
});

test("AdaptiveContextManager: task continuity — 'continue' resolves the active task without any conversation replay", async () => {
  const { memory, manager, cleanup } = await setup();
  try {
    memory.createTask("Harden TokenValidator", "Adding length and charset checks to TokenValidator.validate().", ["auth.ts"], ["TokenValidator"]);

    const bundle = await manager.assemble(baseRequest("continue"));
    assert.ok(bundle.layers_included.includes("task"));
    assert.ok(bundle.files.some((f) => f.why.includes("active task")));
    // The live file content should be pulled fresh, not a stale snapshot.
    assert.ok(bundle.files.some((f) => f.path === "auth.ts"));
  } finally {
    cleanup();
  }
});

test("AdaptiveContextManager: delta mode — a file the caller already has (matching content hash) is not resent in full", async () => {
  const { store, manager, cleanup } = await setup();
  try {
    const file = await store.getFile("auth.ts");
    assert.ok(file);

    const bundle = await manager.assemble({
      ...baseRequest("TokenValidator"),
      currentFile: "auth.ts",
      knownFileHashes: { "auth.ts": file!.content_hash },
    });

    const authEntry = bundle.files.find((f) => f.path === "auth.ts");
    assert.ok(authEntry, "auth.ts should still appear as an entry");
    assert.ok(authEntry!.snippet.includes("unchanged"), "should be replaced with a short delta marker, not the full file");
    assert.ok(authEntry!.snippet.length < file!.content.length);
  } finally {
    cleanup();
  }
});

test("AdaptiveContextManager: metrics report a real reduction percentage and are internally consistent", async () => {
  const { memory, manager, cleanup } = await setup();
  try {
    await memory.addMemory("convention", "All public methods must have JSDoc.", []);
    const bundle = await manager.assemble({ ...baseRequest("TokenValidator"), currentFile: "auth.ts" });

    assert.ok(bundle.metrics.optimized_tokens_used <= bundle.metrics.raw_tokens_estimate);
    assert.equal(bundle.metrics.optimized_tokens_used, bundle.budget_tokens_used);
    assert.ok(bundle.metrics.assembly_latency_ms >= 0);
    assert.equal(bundle.metrics.basis, "estimated", "no real model backend was given, so this must never claim measured");
  } finally {
    cleanup();
  }
});

test("AdaptiveContextManager: a zero token budget yields an empty, honest bundle rather than an error", async () => {
  const { manager, cleanup } = await setup();
  try {
    const bundle = await manager.assemble({ ...baseRequest("anything"), tokenBudget: 0 });
    assert.equal(bundle.files.length, 0);
    assert.equal(bundle.budget_tokens_used, 0);
  } finally {
    cleanup();
  }
});
