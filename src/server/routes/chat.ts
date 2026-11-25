import { randomUUID } from "node:crypto";
import type { ServerResponse } from "http";
import type { AppContext } from "../context";
import { isRejection } from "../../types/index";
import { generationValidationError } from "../validation";
import { FOUNDRY_MODEL_PREFIX } from "../../inference/foundry-local";
import { chatError, nativeChatRequest, relayNativeChat } from "./native-chat";

interface ChatRequestBody {
  messages: { role: "system" | "developer" | "user" | "assistant"; content: string | { type: "text"; text: string }[] }[];
  model?: string;
  stream?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  review?: boolean;
}

export async function handleChatCompletions(body: unknown, res: ServerResponse, ctx: AppContext, signal?: AbortSignal): Promise<void> {
  const input = body as Record<string, unknown> | null;
  const requestedModel = typeof input?.model === "string" ? input.model.trim() : undefined;
  const foundryModel = requestedModel?.startsWith(FOUNDRY_MODEL_PREFIX)
    ? requestedModel.slice(FOUNDRY_MODEL_PREFIX.length) : undefined;
  const nativeTools = Boolean(input && (
    (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 0)) ||
    (input.tool_choice !== undefined && input.tool_choice !== "auto" && input.tool_choice !== "none") ||
    (Array.isArray(input.messages) && input.messages.some((message) => message?.role === "tool" || message?.tool_calls !== undefined))
  ));
  const validationError = generationValidationError(body, "chat", nativeTools || foundryModel !== undefined);
  if (validationError) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: validationError } }));
    return;
  }
  if (foundryModel !== undefined) {
    if (!foundryModel || !ctx.foundry) {
      return chatError(res, 404, "Foundry Local models require a model ID and LOCALCODER_FOUNDRY_ENDPOINT on the server.");
    }
    try {
      const request = nativeChatRequest(input!);
      await relayNativeChat(await ctx.foundry.chatCompletion({ ...request, model: foundryModel }, signal), res, signal);
    } catch {
      if (!res.headersSent && !signal?.aborted) chatError(res, 502, "Unable to contact Foundry Local. Check the server endpoint and model.");
    }
    return;
  }
  const parsed = body as ChatRequestBody;
  const messages = nativeTools ? [] : parsed.messages.map(({ role, content }) => ({
    role: role === "developer" ? "system" as const : role,
    content: typeof content === "string" ? content : content.map((part) => part.text).join(""),
  }));
  let registry = requestedModel && requestedModel !== "localcoder-auto"
    ? ctx.registry.filter((entry) => entry.model_id === requestedModel)
    : ctx.registry;
  if (requestedModel && requestedModel !== "localcoder-auto" && registry.length === 0) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Model "${requestedModel}" is not installed. See GET /v1/models.`, code: "model_not_found" } }));
    return;
  }
  if (nativeTools) {
    registry = registry.filter((entry) => entry.capabilities.includes("tool_calling"));
    if (!registry.length) return chatError(res, 400, "Tool calling requires a model registered with a tool-capable chat template.");
  }
  const task = nativeTools ? "normal_coding" : ctx.classifier.classify({ endpoint: "chat_completions", messages, review: parsed.review });
  const profile = await ctx.profiler.sample();
  const policy = ctx.policyEngine.derive(profile);
  const decision = ctx.router.route(task, policy, registry);

  if (isRejection(decision)) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            ctx.registry.length === 0
              ? "No models are installed. Run `localcoder models add <file.gguf>`."
              : decision.reason === "no_model_fits_budget"
              ? "No registered model fits the current memory budget. Try closing other applications, switching to a lower power mode, or downloading a smaller model."
              : `No registered model supports task class "${task}".`,
          reason: decision.reason,
          attempted: decision.attempted,
        },
      })
    );
    return;
  }

  if (signal?.aborted) return;
  let lease;
  try {
    lease = await ctx.modelManager.acquire(decision, policy, task === "autocomplete" ? 10 : 5, signal);
  } catch (err) {
    if (signal?.aborted) return;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Failed to load model "${decision.model_id}": ${(err as Error).message}` } }));
    return;
  }

  if (nativeTools) {
    try {
      if (signal?.aborted) return;
      if (!lease.backend.chatCompletion) return chatError(res, 400, "This inference backend does not support native tool calling.");
      const request = nativeChatRequest(input!, decision.max_output_tokens);
      await relayNativeChat(await lease.backend.chatCompletion(request, signal), res, signal, lease.decision.ctx_window);
    } catch {
      if (!res.headersSent && !signal?.aborted) chatError(res, 502, "The inference engine could not complete the tool call request.");
    } finally { lease.release(); }
    return;
  }

  const streaming = parsed.stream ?? true; // preserve the streaming default for existing LocalCoder clients
  const response = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: decision.model_id };
  const chunk = (delta: object, finishReason: string | null) => {
    res.write(`data: ${JSON.stringify({ ...response, object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  };
  try {
    if (signal?.aborted) return;
    if (streaming) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      chunk({ role: "assistant" }, null);
    }
    let content = "";
    let finishReason: string | null = null;
    const outputLimit = Math.min(parsed.max_completion_tokens ?? Infinity, parsed.max_tokens ?? Infinity, decision.max_output_tokens);
    for await (const token of lease.backend.generate({ mode: "chat", messages }, {
      signal, max_tokens: outputLimit, temperature: parsed.temperature, stop: parsed.stop,
    })) {
      if (token.finish_reason) finishReason = token.finish_reason;
      if (streaming) {
        if (token.token) chunk({ content: token.token }, null);
      } else {
        content += token.token;
      }
    }
    if (signal?.aborted) return;
    if (!finishReason) throw new Error("The inference engine closed before reporting completion.");
    if (streaming) {
      chunk({}, finishReason);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...response, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }] }));
    }
  } catch (err) {
    if (signal?.aborted) return;
    const error = { error: { message: (err as Error).message } };
    if (streaming) res.end(`data: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`);
    else {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify(error));
    }
  } finally { lease.release(); }
}
