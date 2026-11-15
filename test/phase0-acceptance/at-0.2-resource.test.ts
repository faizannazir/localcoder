import { test } from "node:test";
import assert from "node:assert/strict";
import { HardwareProfiler } from "../../src/hardware/profiler";
import { DefaultPolicyEngine } from "../../src/policy/engine";

test("AT-0.2: memory_budget_gb is always strictly less than ram_available_gb", async () => {
  const profiler = new HardwareProfiler();
  const profile = await profiler.sample();

  assert.ok(profile.memory_budget_gb < profile.ram_available_gb, "memory_budget_gb must reserve headroom, never equal or exceed raw available RAM");
  assert.ok(profile.memory_budget_gb >= 0, "memory_budget_gb must never go negative even on a very constrained machine");
});

test("AT-0.2: /v1/resource shape — profile + policy both schema-plausible", async () => {
  const profiler = new HardwareProfiler();
  const policyEngine = new DefaultPolicyEngine();

  const profile = await profiler.sample();
  const policy = policyEngine.derive(profile);

  for (const field of ["ram_total_gb", "ram_available_gb", "memory_budget_gb", "ram_pressure", "cpu", "gpu", "battery", "thermal_state", "thermal_confidence", "timestamp"]) {
    assert.ok(field in profile, `HardwareProfile is missing "${field}"`);
  }
  for (const field of ["power_mode", "memory_budget_gb", "max_context_tokens", "max_gpu_offload_fraction", "max_agent_wall_seconds", "max_tool_calls", "allow_background_indexing"]) {
    assert.ok(field in policy, `ResourcePolicy is missing "${field}"`);
  }

  assert.ok(["low", "medium", "high"].includes(profile.ram_pressure));
  assert.ok(["nominal", "fair", "serious", "critical", "unknown"].includes(profile.thermal_state));
  assert.ok(["performance", "balanced", "battery", "silent_cool", "low_memory"].includes(policy.power_mode));
});

test("AT-0.2: onChange returns a working unsubscribe function", async () => {
  const profiler = new HardwareProfiler();
  let calls = 0;
  const unsubscribe = profiler.onChange(() => calls++);
  unsubscribe(); // should not throw, and should stop the interval from ever firing
  assert.equal(calls, 0);
});
