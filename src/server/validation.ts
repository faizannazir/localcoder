/** Validate client input before routing or allocating a model. */
export function generationValidationError(body: unknown, mode: "chat" | "fim"): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Request body must be a JSON object.";
  const parsed = body as Record<string, unknown>;
  if (mode === "chat") {
    if (parsed.model !== undefined && (typeof parsed.model !== "string" || !parsed.model.trim())) return '"model" must be a non-empty string.';
    if (parsed.stream !== undefined && typeof parsed.stream !== "boolean") return '"stream" must be a boolean.';
    if (parsed.max_completion_tokens !== undefined && (typeof parsed.max_completion_tokens !== "number" ||
      !Number.isInteger(parsed.max_completion_tokens) || parsed.max_completion_tokens <= 0)) return '"max_completion_tokens" must be a positive integer.';
    if (parsed.tools !== undefined && (!Array.isArray(parsed.tools) || parsed.tools.length > 0) ||
        parsed.tool_choice !== undefined && parsed.tool_choice !== "none" && parsed.tool_choice !== "auto") {
      return "Native tool calls are unsupported on this chat endpoint. Use text chat or the LocalCoder agent endpoint.";
    }
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return '"messages" (non-empty array) is required.';
    for (const message of parsed.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return "Each message must be an object with a role and string content.";
      const { role, content, tool_calls, function_call } = message as Record<string, unknown>;
      if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") return "Unsupported chat message role.";
      if (tool_calls !== undefined || function_call !== undefined) return "Native tool calls are unsupported on this chat endpoint.";
      if (typeof content !== "string" && !(Array.isArray(content) && content.length && content.every(
        (part) => part && part.type === "text" && typeof part.text === "string"
      ))) return "Message content must be text or an array of text parts.";
    }
    if (parsed.review !== undefined && typeof parsed.review !== "boolean") return '"review" must be a boolean.';
  } else {
    if (typeof parsed.prefix !== "string") return '"prefix" (string) is required.';
    if (parsed.suffix !== undefined && typeof parsed.suffix !== "string") return '"suffix" must be a string.';
  }
  if (parsed.max_tokens !== undefined && (typeof parsed.max_tokens !== "number" || !Number.isFinite(parsed.max_tokens) || !Number.isInteger(parsed.max_tokens) || parsed.max_tokens <= 0)) {
    return '"max_tokens" must be a positive finite integer.';
  }
  if (parsed.temperature !== undefined && (typeof parsed.temperature !== "number" || !Number.isFinite(parsed.temperature) || parsed.temperature < 0 || parsed.temperature > 2)) {
    return '"temperature" must be a finite number between 0 and 2.';
  }
  if (parsed.stop !== undefined && (!Array.isArray(parsed.stop) || !parsed.stop.every((value) => typeof value === "string"))) return '"stop" must be an array of strings.';
  return null;
}
