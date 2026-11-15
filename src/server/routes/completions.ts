/**
 * implementation-spec.md §2.8: this endpoint IS the classification. It must not import
 * the TaskClassifier, ContextManager, IndexStore, CodingAgent, or ToolRuntime — none of
 * those modules exist in Phase 0 anyway, but the rule is enforced here by omission so it
 * stays true once they do exist. This file may only import router/manager/inference/types.
 */
import type { ServerResponse } from "http";
import type { AppContext } from "../context";
import { isRejection } from "../../types/index";
import { generationValidationError } from "../validation";

interface CompletionsRequestBody {
  prefix: string;
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
}

export async function handleCompletions(body: unknown, res: ServerResponse, ctx: AppContext, signal?: AbortSignal): Promise<void> {
  const validationError = generationValidationError(body, "fim");
  if (validationError) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: validationError } }));
    return;
  }
  const parsed = body as Partial<CompletionsRequestBody>;
  if (typeof parsed?.prefix !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: '"prefix" (string) is required.' } }));
    return;
  }

  const profile = await ctx.profiler.sample();
  const policy = ctx.policyEngine.derive(profile);
  const decision = ctx.router.route("autocomplete", policy, ctx.registry);

  if (isRejection(decision)) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: ctx.registry.length === 0
          ? "No models are installed. Run `localcoder models add <file.gguf>`."
          : decision.reason === "no_model_for_task"
            ? "No installed model supports fill-in-middle autocomplete. Add a FIM-capable model with `localcoder models add <file.gguf>`."
            : "No registered model fits the current memory budget for autocomplete.", reason: decision.reason, attempted: decision.attempted },
      })
    );
    return;
  }

  if (signal?.aborted) return;
  let lease;
  try {
    lease = await ctx.modelManager.acquire(decision, policy, /* priority */ 10); // autocomplete defaults to high residency priority
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Failed to load model "${decision.model_id}": ${(err as Error).message}` } }));
    return;
  }

  const backend = lease.backend;
  try {
    if (signal?.aborted) return;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

    try {
      for await (const tok of backend.generate(
        { mode: "fim", prefix: parsed.prefix, suffix: parsed.suffix ?? "" },
        { signal, max_tokens: Math.min(parsed.max_tokens ?? decision.max_output_tokens, decision.max_output_tokens), temperature: parsed.temperature ?? 0.2, stop: parsed.stop }
      )) {
        res.write(`data: ${JSON.stringify({ choices: [{ text: tok.token, finish_reason: tok.finish_reason ?? null }] })}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: (err as Error).message } })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } finally { lease.release(); }
}
