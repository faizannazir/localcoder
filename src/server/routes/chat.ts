import type { ServerResponse } from "http";
import type { AppContext } from "../context";
import { isRejection } from "../../types/index";

interface ChatRequestBody {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  review?: boolean;
}

export async function handleChatCompletions(body: unknown, res: ServerResponse, ctx: AppContext): Promise<void> {
  const parsed = body as Partial<ChatRequestBody>;
  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: '"messages" (non-empty array) is required.' } }));
    return;
  }

  const task = ctx.classifier.classify({ endpoint: "chat_completions", messages: parsed.messages, review: parsed.review });
  const profile = await ctx.profiler.sample();
  const policy = ctx.policyEngine.derive(profile);
  const decision = ctx.router.route(task, policy, ctx.registry);

  if (isRejection(decision)) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            decision.reason === "no_model_fits_budget"
              ? "No registered model fits the current memory budget. Try closing other applications, switching to a lower power mode, or downloading a smaller model."
              : `No registered model supports task class "${task}".`,
          reason: decision.reason,
          attempted: decision.attempted,
        },
      })
    );
    return;
  }

  let lease;
  try {
    lease = await ctx.modelManager.acquire(decision, policy, task === "autocomplete" ? 10 : 5);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Failed to load model "${decision.model_id}": ${(err as Error).message}` } }));
    return;
  }

  const backend = lease.backend;
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });

    const created = Math.floor(Date.now() / 1000);
    try {
      for await (const tok of backend.generate(
        { mode: "chat", messages: parsed.messages },
        { max_tokens: parsed.max_tokens ?? decision.max_output_tokens, temperature: parsed.temperature, stop: parsed.stop }
      )) {
        const chunk = {
          id: `chatcmpl-${created}`,
          object: "chat.completion.chunk",
          created,
          model: decision.model_id,
          choices: [{ index: 0, delta: tok.token ? { content: tok.token } : {}, finish_reason: tok.finish_reason ?? null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: (err as Error).message } })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } finally { lease.release(); }
}
