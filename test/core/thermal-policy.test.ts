import { test } from "node:test";
import assert from "node:assert/strict";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import type { HardwareProfile } from "../../src/types/index";

function fakeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    ram_total_gb: 16,
    ram_available_gb: 10,
    memory_budget_gb: 8,
    ram_pressure: "low",
    cpu: { cores: 8, arch: "arm64", isa: ["neon"] },
    gpu: { backend: "metal", unified_memory: true },
    battery: { present: true, on_ac: true, percent: 100 },
    thermal_state: "nominal",
    thermal_confidence: "high",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("unknown thermal state produces the same policy as fair, not nominal", () => {
  const engine = new DefaultPolicyEngine();

  const nominalPolicy = engine.derive(fakeProfile({ thermal_state: "nominal", thermal_confidence: "high" }));
  const fairPolicy = engine.derive(fakeProfile({ thermal_state: "fair", thermal_confidence: "high" }));
  const unknownPolicy = engine.derive(fakeProfile({ thermal_state: "unknown", thermal_confidence: "low" }));

  // The whole point of the rule: unknown must match fair's (more conservative) numbers...
  assert.deepEqual(unknownPolicy, fairPolicy, 'thermal_state "unknown" must be treated exactly like "fair"');

  // ...and fair must actually be more conservative than nominal, or this test would be
  // vacuously true (see implementation notes: this was a real bug caught during Phase 0).
  assert.ok(
    fairPolicy.max_context_tokens < nominalPolicy.max_context_tokens,
    '"fair" must be measurably more conservative than "nominal", otherwise "unknown treated as fair" has no real effect'
  );
});

test("serious/critical thermal still escalates to silent_cool regardless of confidence", () => {
  const engine = new DefaultPolicyEngine();
  const serious = engine.derive(fakeProfile({ thermal_state: "serious", thermal_confidence: "high" }));
  const critical = engine.derive(fakeProfile({ thermal_state: "critical", thermal_confidence: "high" }));

  assert.equal(serious.power_mode, "silent_cool");
  assert.equal(critical.power_mode, "silent_cool");
});

test("an explicit user override always wins over the derived power mode", () => {
  const engine = new DefaultPolicyEngine();
  const policy = engine.derive(fakeProfile({ thermal_state: "critical" }), { power_mode: "performance" });
  assert.equal(policy.power_mode, "performance");
});
