import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultModelRouter, fitsMemoryBudget } from "../../src/router/router";
import { isRejection, ModelRegistryEntry, ResourcePolicy, RoutingDecision } from "../../src/types/index";

function fakePolicy(overrides: Partial<ResourcePolicy> = {}): ResourcePolicy {
  return {
    power_mode: "balanced",
    memory_budget_gb: 16,
    max_context_tokens: 16384,
    max_gpu_offload_fraction: 0.8,
    max_agent_wall_seconds: 300,
    max_tool_calls: 40,
    allow_background_indexing: true,
    ...overrides,
  };
}

function fakeEntry(overrides: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    model_id: "test-model-7b",
    architecture: "dense",
    parameter_count: { total: 7 },
    quantization: "Q4_K_M",
    file_path: "models/test-model-7b.gguf",
    context_limit: 32768,
    backend_requirements: ["cpu"],
    estimated_memory_gb: 5.0,
    capabilities: ["fim", "tool_calling"],
    ...overrides,
  };
}

test("rejects with no_model_fits_budget when every candidate exceeds the memory budget", () => {
  const router = new DefaultModelRouter();
  const registry = [fakeEntry({ model_id: "too-big", estimated_memory_gb: 50 })];
  const policy = fakePolicy({ memory_budget_gb: 2 });

  const decision = router.route("normal_coding", policy, registry);

  assert.ok(isRejection(decision), "expected a RouterRejection, got a RoutingDecision");
  if (isRejection(decision)) {
    assert.equal(decision.reason, "no_model_fits_budget");
    assert.equal(decision.attempted.length, 1);
    assert.equal(decision.attempted[0].model_id, "too-big");
    assert.ok(decision.attempted[0].required_gb > decision.attempted[0].budget_gb);
  }
});

test("rejects with no_model_for_task when the registry is empty", () => {
  const router = new DefaultModelRouter();
  const decision = router.route("hard_agent", fakePolicy(), []);

  assert.ok(isRejection(decision));
  if (isRejection(decision)) {
    assert.equal(decision.reason, "no_model_for_task");
  }
});

test("never returns a decision that fails its own fitsMemoryBudget check", () => {
  const router = new DefaultModelRouter();
  const registry = [fakeEntry({ estimated_memory_gb: 5 }), fakeEntry({ model_id: "test-model-14b", estimated_memory_gb: 9, parameter_count: { total: 14 } })];
  const policy = fakePolicy({ memory_budget_gb: 8 }); // fits the 5GB model, not the 9GB one

  const decision = router.route("normal_coding", policy, registry);

  assert.ok(!isRejection(decision), "expected a successful decision since one candidate fits");
  if (!isRejection(decision)) {
    const entry = registry.find((e) => e.model_id === decision.model_id)!;
    assert.ok(fitsMemoryBudget(entry, decision, policy), "Router returned a decision that fails its own memory-safety gate");
    assert.equal(decision.model_id, "test-model-7b", "should have picked the model that actually fits, not the oversized one");
  }
});

test("hard_agent prefers the largest model that still fits, not the smallest", () => {
  const router = new DefaultModelRouter();
  const registry = [
    fakeEntry({ model_id: "small", parameter_count: { total: 7 }, estimated_memory_gb: 5 }),
    fakeEntry({ model_id: "large", parameter_count: { total: 24 }, estimated_memory_gb: 13 }),
  ];
  const policy = fakePolicy({ memory_budget_gb: 20 }); // both fit — hard_agent should still pick the larger one

  const decision = router.route("hard_agent", policy, registry);
  assert.ok(!isRejection(decision));
  if (!isRejection(decision)) assert.equal(decision.model_id, "large");
});

test("autocomplete prefers the smallest model with fim capability", () => {
  const router = new DefaultModelRouter();
  const registry = [
    fakeEntry({ model_id: "small-no-fim", parameter_count: { total: 4 }, estimated_memory_gb: 3, capabilities: ["tool_calling"] }),
    fakeEntry({ model_id: "medium-fim", parameter_count: { total: 7 }, estimated_memory_gb: 5, capabilities: ["fim"] }),
  ];
  const policy = fakePolicy({ memory_budget_gb: 20 });

  const decision = router.route("autocomplete", policy, registry);
  assert.ok(!isRejection(decision));
  if (!isRejection(decision)) assert.equal(decision.model_id, "medium-fim", "should prefer the fim-capable model even though it's larger");
});

test("autocomplete rejects a registry without a fill-in-middle model", () => {
  const decision = new DefaultModelRouter().route("autocomplete", fakePolicy(), [fakeEntry({ capabilities: ["tool_calling"] })]);
  assert.ok(isRejection(decision));
  if (isRejection(decision)) assert.equal(decision.reason, "no_model_for_task");
});
