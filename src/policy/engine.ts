import type { HardwareProfile, ResourcePolicy, PolicyEngine as IPolicyEngine, PowerMode, ThermalState } from "../types/index";

/**
 * Phase 0 defaults. Every number here is a starting point, not a measured optimum —
 * implementation-spec.md §9 flags exactly this table as something Phase 6 hardware
 * testing should tune, not something to treat as final.
 */
const MODE_DEFAULTS: Record<PowerMode, Omit<ResourcePolicy, "power_mode" | "memory_budget_gb">> = {
  performance: { max_context_tokens: 32768, max_gpu_offload_fraction: 1.0, max_agent_wall_seconds: 600, max_tool_calls: 60, allow_background_indexing: true },
  balanced: { max_context_tokens: 16384, max_gpu_offload_fraction: 0.8, max_agent_wall_seconds: 300, max_tool_calls: 40, allow_background_indexing: true },
  battery: { max_context_tokens: 8192, max_gpu_offload_fraction: 0.5, max_agent_wall_seconds: 120, max_tool_calls: 20, allow_background_indexing: false },
  silent_cool: { max_context_tokens: 8192, max_gpu_offload_fraction: 0.3, max_agent_wall_seconds: 90, max_tool_calls: 15, allow_background_indexing: false },
  low_memory: { max_context_tokens: 4096, max_gpu_offload_fraction: 0.0, max_agent_wall_seconds: 60, max_tool_calls: 10, allow_background_indexing: false },
};

/** implementation-spec.md §2.2: thermal_state "unknown" is treated as "fair" for policy purposes — never assumed safe. */
function effectiveThermal(state: ThermalState): Exclude<ThermalState, "unknown"> {
  return state === "unknown" ? "fair" : state;
}

function choosePowerMode(profile: HardwareProfile, userOverride?: PowerMode): PowerMode {
  if (userOverride) return userOverride;

  const thermal = effectiveThermal(profile.thermal_state);

  if (!profile.battery.on_ac && profile.battery.percent !== undefined && profile.battery.percent < 20) {
    return "low_memory";
  }
  if (thermal === "serious" || thermal === "critical") {
    return "silent_cool";
  }
  if (!profile.battery.on_ac) {
    return "battery";
  }
  if (profile.memory_budget_gb < 2) {
    return "low_memory";
  }
  // Never auto-select "performance" — that's an explicit opt-in (spec §12 / original doc §12),
  // not a default even when plugged in, since it's the mode most likely to run the machine hot.
  return "balanced";
}

/**
 * "fair" gets a mild pre-emptive trim, applied on top of whatever mode was chosen —
 * a gentler first response than waiting for "serious" to trigger a full silent_cool
 * mode switch. This is also what makes the unknown-treated-as-fair rule in §2.2
 * observable/testable at all: without some real effect, "unknown → fair, not nominal"
 * would be a comment with no behavior behind it.
 */
const FAIR_CONTEXT_MULTIPLIER = 0.75;
const FAIR_GPU_MULTIPLIER = 0.85;

export class DefaultPolicyEngine implements IPolicyEngine {
  derive(profile: HardwareProfile, userOverride?: Partial<ResourcePolicy>): ResourcePolicy {
    const power_mode = choosePowerMode(profile, userOverride?.power_mode);
    const defaults = MODE_DEFAULTS[power_mode];
    const thermal = effectiveThermal(profile.thermal_state);

    // Modes already at their most conservative (silent_cool/low_memory) have nothing
    // further to trim for "fair" — the escalation already covers it.
    const applyFairTrim = thermal === "fair" && power_mode !== "silent_cool" && power_mode !== "low_memory";

    // low_memory gets an extra safety haircut on top of the profiler's own margin —
    // this is the mode where being wrong about available RAM hurts the most.
    const memory_budget_gb =
      power_mode === "low_memory" ? round2(profile.memory_budget_gb * 0.8) : profile.memory_budget_gb;

    const max_context_tokens =
      userOverride?.max_context_tokens ?? Math.floor(defaults.max_context_tokens * (applyFairTrim ? FAIR_CONTEXT_MULTIPLIER : 1));
    const max_gpu_offload_fraction =
      userOverride?.max_gpu_offload_fraction ?? round2(defaults.max_gpu_offload_fraction * (applyFairTrim ? FAIR_GPU_MULTIPLIER : 1));

    return {
      power_mode,
      memory_budget_gb,
      max_context_tokens,
      max_gpu_offload_fraction,
      max_agent_wall_seconds: userOverride?.max_agent_wall_seconds ?? defaults.max_agent_wall_seconds,
      max_tool_calls: userOverride?.max_tool_calls ?? defaults.max_tool_calls,
      allow_background_indexing: userOverride?.allow_background_indexing ?? defaults.allow_background_indexing,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
