import type { HardwareProfiler, ModelRegistryEntry, PolicyEngine, TaskClassifier, IndexStore, ContextManager } from "../types/index";
import type { DefaultModelManager } from "../manager/model-manager";
import type { DefaultModelRouter } from "../router/router";

export interface AppContext {
  profiler: HardwareProfiler;
  policyEngine: PolicyEngine;
  classifier: TaskClassifier;
  router: DefaultModelRouter;
  modelManager: DefaultModelManager;
  registry: ModelRegistryEntry[];
  baseDir: string;
  /** The workspace the agent operates on (isolated per repository). */
  repoRoot: string;
  /**
   * Phase 1 integration point — present only if this workspace has been indexed
   * (see `localcoder index`). Deliberately NOT wired into /v1/chat/completions yet;
   * that connection is Phase 2's job (CodingAgent). Phase 1 only proves the pipeline
   * (query → IndexStore → ContextManager → ContextBundle) works and exposes read-only
   * repository stats via /v1/resource.
   */
  indexStore?: IndexStore;
  contextManager?: ContextManager;
}
