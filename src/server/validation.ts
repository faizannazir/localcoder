/** Validate client input before routing or allocating a model. */
export function generationValidationError(body: unknown, mode: "chat" | "fim"): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Request body must be a JSON object.";
  const parsed = body as Record<string, unknown>;
  if (mode === "chat") {
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return '"messages" (non-empty array) is required.';
    for (const message of parsed.messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return "Each message must be an object with a role and string content.";
      const { role, content } = message as Record<string, unknown>;
      if (role !== "system" && role !== "user" && role !== "assistant") return 'Message role must be "system", "user", or "assistant".';
      if (typeof content !== "string") return "Message content must be a string.";
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
