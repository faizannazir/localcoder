import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultModelManager } from "../../src/manager/model-manager";
import { MockInferenceBackend } from "../../src/inference/mock-backend";
import type { ModelRegistryEntry, ResourcePolicy, RoutingDecision } from "../../src/types/index";

const registry: ModelRegistryEntry[] = [
  { model_id: "a", architecture: "dense", parameter_count: { total: 4 }, quantization: "Q4_K_M", file_path: "a.gguf", context_limit: 8192, backend_requirements: ["cpu"], estimated_memory_gb: 3, capabilities: ["fim"] },
  { model_id: "b", architecture: "dense", parameter_count: { total: 7 }, quantization: "Q4_K_M", file_path: "b.gguf", context_limit: 8192, backend_requirements: ["cpu"], estimated_memory_gb: 5, capabilities: ["tool_calling"] },
];

function decisionFor(model_id: string): RoutingDecision {
  return { model_id, ctx_window: 4096, kv_cache_budget_mb: 64, kv_cache_dtype: "q4_0", max_output_tokens: 256, gpu_offload_fraction: 0 };
}

function lowMemPolicy(): ResourcePolicy {
  return {
    power_mode: "low_memory",
    memory_budget_gb: 6, // < LOW_MEMORY_RESIDENCY_CAP_GB (12) — triggers the hard cap
    max_context_tokens: 4096,
    max_gpu_offload_fraction: 0,
    max_agent_wall_seconds: 60,
    max_tool_calls: 10,
    allow_background_indexing: false,
  };
}

test("resident() never exceeds length 1 when memory_budget_gb is below the low-memory cap", async () => {
  const manager = new DefaultModelManager(registry, () => new MockInferenceBackend());
  const policy = lowMemPolicy();

  await manager.ensure(decisionFor("a"), policy);
  assert.equal(manager.resident().length, 1);

  await manager.ensure(decisionFor("b"), policy); // should evict "a" before loading "b"
  assert.equal(manager.resident().length, 1, "must never exceed 1 resident model under a <12GB budget");
  assert.equal(manager.resident()[0].model_id, "b");

  await manager.ensure(decisionFor("a"), policy); // switch back
  assert.equal(manager.resident().length, 1);
  assert.equal(manager.resident()[0].model_id, "a");
});

test("re-ensuring an already-resident model does not evict or duplicate it", async () => {
  const manager = new DefaultModelManager(registry, () => new MockInferenceBackend());
  const policy = lowMemPolicy();

  const first = await manager.ensure(decisionFor("a"), policy, 5);
  const second = await manager.ensure(decisionFor("a"), policy, 5);

  assert.equal(manager.resident().length, 1);
  assert.equal(first.model_id, second.model_id);
  assert.ok(new Date(second.last_used_at).getTime() >= new Date(first.loaded_at).getTime());
});

test("eviction ranks by priority first, not by recency (i.e. it is not plain LRU)", async () => {
  const manager = new DefaultModelManager(registry, () => new MockInferenceBackend());
  // Budget must stay >= 12 (LOW_MEMORY_RESIDENCY_CAP_GB) — below that the hard single-model
  // cap applies unconditionally and would mask the priority-ranking logic being tested here.
  const roomyPolicy: ResourcePolicy = { ...lowMemPolicy(), memory_budget_gb: 12 };

  // Load the HIGH-priority model (e.g. autocomplete) first...
  await manager.ensure(decisionFor("b"), roomyPolicy, /* priority */ 10);
  // ...then the LOW-priority model (e.g. a one-off agent task) second, so it's the more
  // recently used of the two. A plain-LRU policy would evict "b" here (touched longest
  // ago); priority-aware eviction must evict "a" instead, despite it being newer.
  await manager.ensure(decisionFor("a"), roomyPolicy, /* priority */ 1);
  assert.equal(manager.resident().length, 2, "both fit comfortably (3GB + 5GB <= 12GB) — no eviction should have happened yet");

  // Now force a squeeze: ask for 6 more GB of headroom, which the current 8GB resident
  // total can't accommodate under a 12GB budget.
  await manager.evictIfNeeded(6, roomyPolicy);

  const survivors = manager.resident().map((m) => m.model_id);
  assert.deepEqual(survivors, ["b"], 'the low-priority, more-recently-used "a" should be evicted before the high-priority "b" — proves this is priority-ranked, not LRU');
});

test("concurrent loads preserve the single-model cap and unload every backend", async () => {
  const live = new Set<MockInferenceBackend>();
  let loads = 0;
  class SlowBackend extends MockInferenceBackend {
    async load(entry: ModelRegistryEntry, decision: RoutingDecision) {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      await super.load(entry, decision);
      live.add(this);
    }
    async unload() { live.delete(this); await super.unload(); }
  }
  const manager = new DefaultModelManager(registry, () => new SlowBackend());
  await Promise.all([manager.ensure(decisionFor("a"), lowMemPolicy()), manager.ensure(decisionFor("a"), lowMemPolicy())]);
  assert.equal(loads, 1, "same-model requests share a single resident backend");
  await Promise.all([manager.ensure(decisionFor("a"), lowMemPolicy()), manager.ensure(decisionFor("b"), lowMemPolicy())]);
  assert.equal(live.size, 1);
  assert.equal(manager.resident().length, 1);
  await manager.unloadAll();
  assert.equal(live.size, 0);
});

test("an active model lease prevents eviction until the request releases it", async () => {
  const manager = new DefaultModelManager(registry, () => new MockInferenceBackend());
  const first = await manager.acquire(decisionFor("a"), lowMemPolicy());
  let acquired = false;
  const second = manager.acquire(decisionFor("b"), lowMemPolicy()).then((lease) => { acquired = true; return lease; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(acquired, false);
  assert.equal(manager.getBackend("a"), first.backend);
  first.release();
  first.release(); // releasing twice cannot decrement another request's lease
  const next = await second;
  assert.equal(manager.resident()[0].model_id, "b");
  next.release();
  await manager.unloadAll();
});

test("exclusive model work blocks ordinary acquisitions at roomy budgets and unloads on failure", async () => {
  const manager = new DefaultModelManager(registry, () => new MockInferenceBackend());
  const roomy = { ...lowMemPolicy(), memory_budget_gb: 32 };
  await manager.ensure(decisionFor("b"), roomy);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const work = manager.withExclusiveModel(async () => ({ decision: decisionFor("a"), policy: roomy }), async ({ backend }) => {
    assert.equal(manager.resident().length, 1);
    assert.equal(manager.getBackend("b"), undefined);
    assert.equal(manager.getBackend("a"), backend);
    entered();
    await gate;
    throw new Error("generation failed");
  });
  const failure = assert.rejects(work, /generation failed/);
  await started;
  let acquired = false;
  const pending = manager.acquire(decisionFor("b"), roomy).then((lease) => { acquired = true; return lease; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acquired, false);
  assert.deepEqual(manager.resident().map((r) => r.model_id), ["a"]);
  finish();
  await failure;
  const lease = await pending;
  assert.deepEqual(manager.resident().map((r) => r.model_id), ["b"]);
  lease.release();
  await manager.unloadAll();
  assert.equal(manager.resident().length, 0);
});

test("exclusive work waits for leases and reloads the same ID with its requested settings", async () => {
  const decisions: RoutingDecision[] = [];
  class RecordedBackend extends MockInferenceBackend {
    async load(entry: ModelRegistryEntry, decision: RoutingDecision) { decisions.push(decision); await super.load(entry, decision); }
  }
  const manager = new DefaultModelManager(registry, () => new RecordedBackend());
  const first = await manager.acquire(decisionFor("a"), lowMemPolicy());
  const next = { ...decisionFor("a"), ctx_window: 2048, kv_cache_dtype: "f16" as const };
  let entered = false;
  const work = manager.withExclusiveModel(async () => ({ decision: next, policy: lowMemPolicy() }), async () => { entered = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(entered, false);
  first.release();
  await work;
  assert.deepEqual(decisions, [decisionFor("a"), next]);
  assert.equal(manager.resident().length, 0);
});
