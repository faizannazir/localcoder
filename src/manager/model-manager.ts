import type { InferenceBackend, LoadedModel, ModelManager as IModelManager, ModelRegistryEntry, ResourcePolicy, RoutingDecision } from "../types/index";

const LOW_MEMORY_RESIDENCY_CAP_GB = 12; // below this budget, AT-0.7 requires never exceeding 1 resident model

interface ResidentEntry {
  loaded: LoadedModel;
  backend: InferenceBackend;
  registryEntry: ModelRegistryEntry;
}

export class DefaultModelManager implements IModelManager {
  private residents = new Map<string, ResidentEntry>();

  constructor(
    private registry: ModelRegistryEntry[],
    private backendFactory: () => InferenceBackend
  ) {}

  private lookup(model_id: string): ModelRegistryEntry {
    const entry = this.registry.find((e) => e.model_id === model_id);
    if (!entry) throw new Error(`Routing decision referenced unknown model_id "${model_id}" — registry/router are out of sync.`);
    return entry;
  }

  private residentTotalGb(excluding?: string): number {
    let total = 0;
    for (const [id, r] of this.residents) {
      if (id === excluding) continue;
      total += r.registryEntry.estimated_memory_gb;
    }
    return total;
  }

  async ensure(decision: RoutingDecision, policy: ResourcePolicy, priority = 0): Promise<LoadedModel> {
    const existing = this.residents.get(decision.model_id);
    if (existing) {
      existing.loaded.last_used_at = new Date().toISOString();
      existing.loaded.priority = priority;
      return existing.loaded;
    }

    const entry = this.lookup(decision.model_id);
    await this.evictIfNeeded(entry.estimated_memory_gb, policy);

    const backend = this.backendFactory();
    await backend.load(entry, decision);

    const loaded: LoadedModel = {
      model_id: decision.model_id,
      process_handle: backend,
      loaded_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      priority,
    };
    this.residents.set(decision.model_id, { loaded, backend, registryEntry: entry });
    return loaded;
  }

  async unload(model_id: string): Promise<void> {
    const r = this.residents.get(model_id);
    if (!r) return;
    await r.backend.unload();
    this.residents.delete(model_id);
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.residents.keys()]) await this.unload(id);
  }

  resident(): LoadedModel[] {
    return [...this.residents.values()].map((r) => r.loaded);
  }

  /**
   * Priority- and recency-aware, not plain LRU (implementation-spec.md §2.5): a
   * rarely-used-but-cheap agent model is evicted before a frequently-hit autocomplete
   * model, even if the agent model happens to have a more recent last_used_at from a
   * single long session.
   */
  async evictIfNeeded(requiredGb: number, policy: ResourcePolicy): Promise<void> {
    const hardCapOne = policy.memory_budget_gb > 0 && policy.memory_budget_gb < LOW_MEMORY_RESIDENCY_CAP_GB;

    if (hardCapOne) {
      for (const id of [...this.residents.keys()]) await this.unload(id);
      return;
    }

    const rankedForEviction = () =>
      [...this.residents.values()].sort((a, b) => {
        if (a.loaded.priority !== b.loaded.priority) return a.loaded.priority - b.loaded.priority; // lowest priority evicted first
        return a.loaded.last_used_at.localeCompare(b.loaded.last_used_at); // then oldest
      });

    while (this.residentTotalGb() + requiredGb > policy.memory_budget_gb && this.residents.size > 0) {
      const [victim] = rankedForEviction();
      if (!victim) break;
      await this.unload(victim.loaded.model_id);
    }
  }

  /** Implementation detail beyond the strict interface: routes need the live backend to call .generate() on. */
  getBackend(model_id: string): InferenceBackend | undefined {
    return this.residents.get(model_id)?.backend;
  }
}
