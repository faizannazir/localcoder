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
    return { ok: false, reason: decision.reason, message: deps.registry.length === 0 ? "No models are installed. Run `localcoder setup` (or `localcoder models add <file.gguf>`)." : "No registered model fits the current memory budget for an agent run.", attempted: decision.attempted };
  }
  return { ok: true, policy, decision, profile };
}
