import type { TokenCounter, TokenCountResult, InferenceBackend } from "../types/index";

/** Real counts from the model's own tokenizer — see Phase 0's InferenceBackend.countTokens (llama-server's /tokenize). */
export class BackendTokenCounter implements TokenCounter {
  constructor(private backend: InferenceBackend, private signal?: AbortSignal) {}

  async count(text: string, _model?: string): Promise<TokenCountResult> {
    const count = await this.backend.countTokens(text, this.signal);
    return { count, basis: "measured" };
  }
}

/**
 * Used only when no loaded model/backend is available to ask (e.g. before any request has
 * routed to a model yet, or the Router rejected everything). A plain chars/4 heuristic —
 * deliberately never presented as "measured" anywhere downstream (implementation-spec.md §2.7
 * and the Phase 1 spec's "do not silently mix them" rule).
 */
export class EstimatingTokenCounter implements TokenCounter {
  async count(text: string, _model?: string): Promise<TokenCountResult> {
    return { count: Math.ceil(text.length / 4), basis: "estimated" };
  }
}

/** Prefers a real backend if one is given and reachable; falls back to the estimate on any failure, but always reports which basis was actually used. */
export class FallbackTokenCounter implements TokenCounter {
  private estimator = new EstimatingTokenCounter();
  constructor(private backend?: InferenceBackend) {}

  async count(text: string, model?: string): Promise<TokenCountResult> {
    if (!this.backend) return this.estimator.count(text, model);
    try {
      return await new BackendTokenCounter(this.backend).count(text, model);
    } catch {
      return this.estimator.count(text, model);
    }
  }
}
