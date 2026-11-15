import type {
  ModelRegistryEntry,
  ModelRouter as IModelRouter,
  ResourcePolicy,
  RoutingDecision,
  RouterRejection,
  TaskClass,
  KvCacheDtype,
} from "../types/index";

const RUNTIME_OVERHEAD_GB = 0.5; // measured default — replace with a real number after Phase 0 hardware runs
const SAFETY_MARGIN_GB = 0.5;

const MAX_OUTPUT_TOKENS: Record<TaskClass, number> = {
  autocomplete: 64,
  chat_simple: 512,
  normal_coding: 1024,
  hard_agent: 2048,
  code_review: 1024,
};

/**
 * implementation-spec.md §2.5 — the hard gate. If this returns false for every
 * candidate, the Router must reject rather than load-and-hope.
 */
export function fitsMemoryBudget(entry: ModelRegistryEntry, decision: RoutingDecision, policy: ResourcePolicy): boolean {
  const kv_gb = decision.kv_cache_budget_mb / 1024;
  return entry.estimated_memory_gb + kv_gb + RUNTIME_OVERHEAD_GB + SAFETY_MARGIN_GB <= policy.memory_budget_gb;
}

/**
 * Rough Phase-0 estimate only — see implementation-spec.md's own admission that
 * runtime_overhead_gb is a placeholder. A real calculation needs per-architecture
 * n_layers/n_kv_heads/head_dim, which ModelRegistryEntry deliberately doesn't carry yet
 * (that's more detail than Phase 0's static registry needs). Once llama-server reports
 * actual KV size via /props after a model is loaded once, prefer that measured value —
 * tracked as a Phase 1 follow-up, not solved here.
 */
const KV_BYTES_PER_ELEMENT: Record<KvCacheDtype, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

/** Exact when the registry carries real architecture facts (from the GGUF): 2 (K and V) x layers x kv_heads x head_dim x ctx x bytes/element. */
export function exactKvCacheMb(entry: ModelRegistryEntry, ctxWindow: number, dtype: KvCacheDtype): number | null {
  if (!entry.layers || !entry.kv_heads || !entry.head_dim) return null;
  return (2 * entry.layers * entry.kv_heads * entry.head_dim * ctxWindow * KV_BYTES_PER_ELEMENT[dtype]) / (1024 * 1024);
}

function estimateKvCacheMb(entry: ModelRegistryEntry, ctxWindow: number, dtype: KvCacheDtype = "f16"): number {
  const exact = exactKvCacheMb(entry, ctxWindow, dtype);
  if (exact !== null) return exact;
  const totalParamsB = entry.parameter_count.total;
  const mbPer1kTokensPerBillionParams = 0.25;
  return (ctxWindow / 1000) * totalParamsB * mbPer1kTokensPerBillionParams;
}

function kvDtypeFor(policy: ResourcePolicy): KvCacheDtype {
  if (policy.power_mode === "low_memory") return "q4_0";
  if (policy.power_mode === "battery" || policy.power_mode === "silent_cool") return "q8_0";
  return "f16";
}

/** Larger-is-better ordering for tasks that want the most capable model that still fits. */
function byTotalParamsDesc(a: ModelRegistryEntry, b: ModelRegistryEntry) {
  return b.parameter_count.total - a.parameter_count.total;
}
/** Smaller-is-better ordering for latency-sensitive tasks. */
function byTotalParamsAsc(a: ModelRegistryEntry, b: ModelRegistryEntry) {
  return a.parameter_count.total - b.parameter_count.total;
}

function candidatesFor(task: TaskClass, registry: ModelRegistryEntry[]): ModelRegistryEntry[] {
  switch (task) {
    case "autocomplete": {
      const withFim = registry.filter((e) => e.capabilities.includes("fim"));
      const pool = withFim.length > 0 ? withFim : registry;
      return [...pool].sort(byTotalParamsAsc);
    }
    case "chat_simple":
      return [...registry].sort(byTotalParamsAsc);
    case "normal_coding":
      // Middle of the road: neither the smallest nor the largest by default.
      return [...registry].sort(byTotalParamsAsc);
    case "hard_agent":
    case "code_review":
      return [...registry].sort(byTotalParamsDesc);
    default:
      return [...registry];
  }
}

export class DefaultModelRouter implements IModelRouter {
  route(task: TaskClass, policy: ResourcePolicy, registry: ModelRegistryEntry[]): RoutingDecision | RouterRejection {
    const candidates = candidatesFor(task, registry);

    if (candidates.length === 0) {
      return { rejected: true, reason: "no_model_for_task", attempted: [] };
    }

    const attempted: RouterRejection["attempted"] = [];

    const floorCtx = task === "hard_agent" || task === "code_review" ? 4096 : 2048;
    for (const entry of candidates) {
      const startCtx = Math.min(entry.context_limit, policy.max_context_tokens);
      // Fit by shrinking before rejecting (original spec section 9): keep the preferred setting if it fits,
      // else a q8_0 KV cache at the same context, then halve the context (never below the task's floor).
      const ctxs = [startCtx];
      while (Math.floor(ctxs[ctxs.length - 1] / 2) >= floorCtx) ctxs.push(Math.floor(ctxs[ctxs.length - 1] / 2));
      // Found by running the real llama-server: a quantized KV cache is refused unless its block size (32) divides the head
      // dimension ("K cache type q8_0 with block size 32 does not divide n_embd_head_k=16"). When the registry knows the
      // head dimension we never choose a quantized KV that the engine would reject; unknown head dims keep the old behaviour.
      const quantOk = !entry.head_dim || entry.head_dim % 32 === 0;
      const preferred = quantOk ? kvDtypeFor(policy) : "f16";
      const dtypes: KvCacheDtype[] = !quantOk ? ["f16"] : preferred === "f16" ? ["f16", "q8_0"] : [preferred];
      let lastRequired = 0;
      for (const ctx_window of ctxs) {
        for (const dtype of dtypes) {
          const kv_cache_budget_mb = estimateKvCacheMb(entry, ctx_window, dtype);
          const decision: RoutingDecision = {
            model_id: entry.model_id,
            ctx_window,
            kv_cache_budget_mb,
            kv_cache_dtype: dtype,
            max_output_tokens: Math.min(MAX_OUTPUT_TOKENS[task], Math.floor(ctx_window / 4)),
            gpu_offload_fraction: policy.max_gpu_offload_fraction,
          };
          if (fitsMemoryBudget(entry, decision, policy)) return decision;
          lastRequired = entry.estimated_memory_gb + kv_cache_budget_mb / 1024 + RUNTIME_OVERHEAD_GB + SAFETY_MARGIN_GB;
        }
      }
      attempted.push({ model_id: entry.model_id, required_gb: lastRequired, budget_gb: policy.memory_budget_gb }); // requirement at the smallest configuration tried
    }

    return { rejected: true, reason: "no_model_fits_budget", attempted };
  }
}
