import type { AgentRequest, HardwareProfiler, InferenceBackend, ModelRegistryEntry, PolicyEngine, ResourcePolicy, RoutingDecision, TokenCounter } from "../types/index";
import { BackendTokenCounter } from "../context/token-counter";
import type { DefaultModelManager } from "../manager/model-manager";
import type { DefaultModelRouter } from "../router/router";
import { AgentStateStore } from "./state";
import { AgentConfig, AgentModels, MODEL_ROLES, ModelRole, loadAgentConfig, parseAgentModels } from "./config";
import { preflightAgent, Preflight } from "./preflight";

export interface RoleModel {
  backend: InferenceBackend;
  tokenCounter: TokenCounter;
  decision: RoutingDecision;
  policy: ResourcePolicy;
}
export interface AgentModelWorkflow {
  readonly models: AgentModels;
  withRole<T>(role: ModelRole, operation: (model: RoleModel) => Promise<T>): Promise<T>;
}
export interface WorkflowDependencies {
  profiler: HardwareProfiler;
  policyEngine: PolicyEngine;
  router: DefaultModelRouter;
  registry: ModelRegistryEntry[];
  modelManager: DefaultModelManager;
}

async function routeRole(deps: WorkflowDependencies, models: AgentModels, role: ModelRole): Promise<Preflight> {
  const registry = deps.registry.filter((entry) => entry.model_id === models[role]);
  if (!registry.length) return { ok: false, reason: "unknown_role_model", message: `${role} model "${models[role]}" is not installed. Use localcoder models list and update .localcoder/agent.json.` };
  const result = await preflightAgent({ ...deps, registry });
  return result.ok ? result : { ...result, message: `${role} model "${models[role]}": ${result.message}` };
}

export class SequentialModelWorkflow implements AgentModelWorkflow {
  readonly models: AgentModels;
  constructor(private deps: WorkflowDependencies, models: AgentModels, private signal?: AbortSignal) {
    this.models = parseAgentModels(models);
  }
  async withRole<T>(role: ModelRole, operation: (model: RoleModel) => Promise<T>): Promise<T> {
    const checkAbort = () => { if (this.signal?.aborted) throw new Error("run aborted (client disconnected)"); };
    let selected!: { decision: RoutingDecision; policy: ResourcePolicy };
    return this.deps.modelManager.withExclusiveModel(async () => {
      checkAbort();
      // Sample after previous leases/processes have drained, immediately before loading.
      const result = await routeRole(this.deps, this.models, role);
      if (!result.ok) throw new Error(result.message);
      checkAbort();
      selected = { decision: result.decision, policy: result.policy };
      return selected;
    }, async ({ backend }) => {
      checkAbort();
      // The selection is captured below so the active backend and prompt share one decision.
      return operation({ backend, ...selected, tokenCounter: new BackendTokenCounter(backend) });
    });
  }
}

/** Resolve saved assignments before generic routing, including implicit "continue" requests. */
export async function prepareAgentRun(root: string, request: AgentRequest, deps: WorkflowDependencies): Promise<{
  request: AgentRequest; config: AgentConfig; models?: AgentModels; preflight: Preflight;
}> {
  const config = loadAgentConfig(root);
  const store = new AgentStateStore(root);
  const resumeId = request.resume_task_id ?? (/^\s*(continue|keep going|finish (this|it)|resume|carry on)\b/i.test(request.task) ? store.latestResumable()?.task_id : undefined);
  const saved = resumeId ? store.load(resumeId) : undefined;
  const storedModels = saved ? (saved as { models?: AgentModels }).models : config.models;
  const models = storedModels === undefined ? undefined : parseAgentModels(storedModels);
  const resolved = { ...request, resume_task_id: resumeId };
  if (!models) return { request: resolved, config, preflight: await preflightAgent(deps) };
  let first: Preflight | undefined;
  for (const role of MODEL_ROLES) {
    const result = await routeRole(deps, models, role);
    if (!result.ok) return { request: resolved, config, models, preflight: result };
    first ??= result;
  }
  return { request: resolved, config, models, preflight: first! };
}
