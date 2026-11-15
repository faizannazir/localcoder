import type { InferenceBackend, ModelRegistryEntry, RoutingDecision, PromptPayload, GenParams, TokenEvent } from "../types/index";

/**
 * NOT a production backend. This exists so the full pipeline — classifier → policy →
 * router → manager → backend → streamed response — can be exercised end to end without
 * requiring a downloaded GGUF and a working llama-server binary. Selected via
 * LOCALCODER_BACKEND=mock (see src/cli/serve.ts). The real path is LlamaCppBackend.
 *
 * tokenize()/countTokens() here are a whitespace-split approximation — NOT the real
 * tokenizer, and must never be used as a stand-in for one outside of this mock (see
 * implementation-spec.md §2.7, "no estimates" once a real tokenizer is available).
 */
export class MockInferenceBackend implements InferenceBackend {
  private entry: ModelRegistryEntry | null = null;

  async load(entry: ModelRegistryEntry, _decision: RoutingDecision): Promise<void> {
    this.entry = entry;
  }

  async *generate(prompt: PromptPayload, params: GenParams): AsyncIterable<TokenEvent> {
    if (!this.entry) throw new Error("MockInferenceBackend.generate() called before load()");

    const summary =
      prompt.mode === "chat"
        ? `[mock:${this.entry.model_id}] received ${prompt.messages.length} message(s), last role="${
            prompt.messages.at(-1)?.role
          }". This is a stub response — connect a real llama-server (docs/MODELS.md) for actual completions.`
        : `[mock:${this.entry.model_id}] fim prefix(${prompt.prefix.length} chars) / suffix(${prompt.suffix.length} chars) — stub infill.`;

    const words = summary.split(" ");
    const max = Math.min(words.length, params.max_tokens);
    for (let i = 0; i < max; i++) {
      await new Promise((r) => setTimeout(r, 5)); // simulate streaming latency
      yield { token: words[i] + (i < max - 1 ? " " : ""), index: i, finish_reason: i === max - 1 ? "stop" : undefined };
    }
  }

  async unload(): Promise<void> {
    this.entry = null;
  }

  async tokenize(text: string): Promise<number[]> {
    return text.split(/\s+/).filter(Boolean).map((_, i) => i);
  }

  async countTokens(text: string): Promise<number> {
    return text.split(/\s+/).filter(Boolean).length;
  }
}
