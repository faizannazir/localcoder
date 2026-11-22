import type { HardwareProfile, HardwareProfiler, ModelRegistryEntry, PolicyEngine, ResourcePolicy, RoutingDecision } from "../types/index";
import { isRejection } from "../types/index";
import type { DefaultModelRouter } from "../router/router";

export type Preflight =
  | { ok: true; policy: ResourcePolicy; decision: RoutingDecision; profile: HardwareProfile }
  | { ok: false; reason: string; message: string; attempted?: unknown };

const MIN_AGENT_CONTEXT = 2048;

/**
 * Phase 0's resource policy gate, applied before any agent work: the hardware profile must yield
 * a policy that can hold a useful prompt, and the Router must find a model that fits the memory budget.
 */
export async function preflightAgent(
  deps: { profiler: HardwareProfiler; policyEngine: PolicyEngine; router: DefaultModelRouter; registry: ModelRegistryEntry[] },
  profileOverride?: HardwareProfile
): Promise<Preflight> {
  const profile = profileOverride ?? (await deps.profiler.sample());
  const policy = deps.policyEngine.derive(profile);
  if (policy.max_context_tokens < MIN_AGENT_CONTEXT || policy.max_tool_calls < 5) {
    return { ok: false, reason: "policy_too_constrained", message: `Current power/resource policy (${policy.power_mode}) is too constrained to run the coding agent (context ${policy.max_context_tokens}, tool calls ${policy.max_tool_calls}).` };
  }
  const decision = deps.router.route("hard_agent", policy, deps.registry);
  if (isRejection(decision)) {
    if (!deps.registry.length) {
      return { ok: false, reason: decision.reason, message: "No models are installed. Run `localcoder models add <file.gguf>`.", attempted: decision.attempted };
    }
    const smallest = decision.attempted.reduce<(typeof decision.attempted)[number] | undefined>(
      (best, attempt) => !best || attempt.required_gb < best.required_gb ? attempt : best, undefined);
    const requirement = smallest ? `; ${smallest.model_id} needs ${smallest.required_gb.toFixed(2)} GB at the smallest tried context and cache settings` : "";
    return { ok: false, reason: decision.reason, attempted: decision.attempted,
      message: `No registered model fits the current memory budget for an agent run (${policy.memory_budget_gb.toFixed(2)} GB available to LocalCoder${requirement}). Free some memory and retry.` };
  }
  return { ok: true, policy, decision, profile };
}
