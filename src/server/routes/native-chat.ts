import type { ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

export function chatError(res: ServerResponse, status: number, message: string, code?: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, code } }));
}

/** Convert text-only parts and forward the standard tool protocol, without backend-specific options. */
export function nativeChatRequest(body: Record<string, unknown>, maxTokens?: number): Record<string, unknown> {
  const messages = (body.messages as Record<string, unknown>[]).map((message) => ({
    role: message.role === "developer" ? "system" : message.role,
    content: Array.isArray(message.content) ? message.content.map((part) => part.text).join("") : message.content,
    ...(message.role === "assistant" && message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
    ...(message.role === "tool" ? { tool_call_id: message.tool_call_id } : {}),
  }));
  const limit = Math.min(maxTokens ?? Infinity, (body.max_tokens as number | undefined) ?? Infinity,
    (body.max_completion_tokens as number | undefined) ?? Infinity);
  return {
    messages, stream: body.stream ?? true,
    ...(Number.isFinite(limit) ? { max_tokens: limit } : {}),
    temperature: body.temperature, stop: body.stop, tools: body.tools, tool_choice: body.tool_choice,
    ...(typeof body.parallel_tool_calls === "boolean" ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
  };
}

export async function relayNativeChat(upstream: Response, res: ServerResponse, signal?: AbortSignal, contextWindow?: number): Promise<void> {
  const media = upstream.headers.get("content-type")?.split(";")[0].trim();
  if ((media !== "application/json" && media !== "text/event-stream") || !upstream.body) {
    await upstream.body?.cancel();
    chatError(res, 502, `The inference service returned an unexpected response (HTTP ${upstream.status}).`);
    return;
  }
  if ((upstream.status === 400 || upstream.status === 413) && media === "application/json") {
    const payload = await upstream.json() as { error?: { code?: string; type?: string; message?: string } };
    const error = payload?.error;
    if (error?.code === "context_length_exceeded" || error?.type === "exceed_context_size_error" ||
        (typeof error?.message === "string" && /exceed.*context|context.*(?:length|window|size).*exceed/i.test(error.message))) {
      const limit = contextWindow === undefined ? "" : ` The current context budget is ${contextWindow} tokens.`;
      return chatError(res, 400, "The prompt, chat history, and tool definitions exceed the model context." + limit +
        " Start a fresh chat, remove attachments or unused tools, or select a model with a larger context.", "context_length_exceeded");
    }
    res.writeHead(upstream.status, { "Content-Type": media, "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(upstream.status, { "Content-Type": media, "Cache-Control": "no-store" });
  await pipeline(upstream.body, res, { signal });
}
