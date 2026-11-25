export const FOUNDRY_MODEL_PREFIX = "foundry/";

/** The administrator chooses one fixed loopback service. Requests cannot supply URLs or headers. */
export class FoundryLocal {
  private readonly origin: string;
  readonly port: number;

  constructor(endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
      throw new Error("LOCALCODER_FOUNDRY_ENDPOINT must be http://127.0.0.1:<port> (optionally ending in /v1).");
    }
    this.origin = url.origin;
    this.port = Number(url.port);
  }

  async models(signal?: AbortSignal): Promise<string[]> {
    const timeout = AbortSignal.timeout(3000);
    const response = await fetch(this.origin + "/openai/models", {
      redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Foundry Local model discovery returned HTTP ${response.status}.`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body) || body.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Foundry Local returned an invalid model list.");
    }
    return [...new Set(body as string[])];
  }

  chatCompletion(request: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(300_000);
    return fetch(this.origin + "/v1/chat/completions", {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
}
