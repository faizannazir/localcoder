import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { locateLlamaServer } from "../util/paths";
import type { InferenceBackend, ModelRegistryEntry, RoutingDecision, PromptPayload, GenParams, TokenEvent } from "../types/index";

const HEALTH_POLL_INTERVAL_MS = 300;
const HEALTH_TIMEOUT_MS = 60_000;
/** Every llama-server we spawned. If this process exits for any reason we can still run code for, they are killed — no orphans. */
const liveProcs = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => { for (const p of liveProcs) { try { p.kill("SIGKILL"); } catch { /* already gone */ } } });
}

/**
 * Simplification, documented rather than hidden: ModelRegistryEntry doesn't carry a
 * model's real total layer count (Phase 0's registry is deliberately minimal), so we
 * can't compute a precise partial-offload layer number. Phase 0 only distinguishes
 * "mostly offload" vs "mostly CPU" — a real per-layer figure is a Phase 1 registry
 * addition (`total_layers`), not solved here.
 */
function gpuLayersFor(fraction: number): number {
  if (fraction <= 0.01) return 0;
  if (fraction >= 0.5) return 999; // llama.cpp convention: a large number offloads every layer
  return Math.round(fraction * 40); // coarse guess for the partial-offload middle ground
}

async function waitForHealth(port: () => number | null, alias: string, deadline: number, signal: AbortSignal): Promise<number> {
  while (Date.now() < deadline && !signal.aborted) {
    const candidate = port();
    if (candidate) {
      try {
        const res = await fetch(`http://127.0.0.1:${candidate}/health`, { signal });
        if (res.ok && (await res.json() as { status?: string }).status === "ok") {
          const props = await fetch(`http://127.0.0.1:${candidate}/props`, { signal });
          if (props.ok && (await props.json() as { model_alias?: string }).model_alias === alias) return candidate;
        }
      } catch { /* the owned server may still be starting */ }
    }
    if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(`llama-server did not become healthy within ${HEALTH_TIMEOUT_MS}ms.`);
}

/** Shared parser for llama.cpp's SSE-ish "data: {...}\n\n" stream framing. */
async function* readSseObjects(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          /* partial/non-JSON chunk — skip rather than crash the stream */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class LlamaCppBackend implements InferenceBackend {
  private proc: ChildProcess | null = null;
  private port_: number | null = null;
  private binary: string;

  get pid(): number | undefined { return this.proc?.pid; }
  get port(): number | null { return this.port_ ?? null; }

  constructor(opts?: { binary?: string }) {
    this.binary = opts?.binary ?? locateLlamaServer().path ?? "llama-server";
  }

  async load(entry: ModelRegistryEntry, decision: RoutingDecision): Promise<void> {
    if (!existsSync(entry.file_path)) {
      throw new Error(
        `Model file not found: ${entry.file_path}. Registry entries are placeholders until you download the ` +
          `actual GGUF — see docs/MODELS.md.`
      );
    }

    const alias = `localcoder-${randomUUID()}`;
    let listeningPort: number | null = null;
    const args = [
      "--model", entry.file_path,
      "--port", "0", // the OS reserves an ephemeral port atomically; no cross-process check/spawn race
      "--alias", alias,
      "--host", "127.0.0.1",
      "--ctx-size", String(decision.ctx_window),
      "--cache-ram", "0", // llama-server's default prompt cache may use up to 8192 MiB of host RAM, silently outside the memory budget the router enforced
      "--parallel", "1", // llama-server splits --ctx-size across parallel slots; one slot keeps the full context (and the KV memory the router budgeted)
      "--n-gpu-layers", String(gpuLayersFor(decision.gpu_offload_fraction)),
      "--cache-type-k", decision.kv_cache_dtype,
      "--cache-type-v", decision.kv_cache_dtype,
    ];

    const proc = spawn(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    liveProcs.add(proc);
    installExitHook();
    proc.once("exit", () => liveProcs.delete(proc));
    let startupLog = "";
    const keepTail = (d: Buffer) => {
      startupLog = (startupLog + d.toString()).slice(-64_000);
      const listening = startupLog.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (listening) listeningPort = Number(listening[1]);
    }; // pipes must keep draining; cap what is retained
    proc.stdout?.on("data", keepTail);
    proc.stderr?.on("data", keepTail);

    const exitedEarly = new Promise<never>((_, reject) => {
      proc.once("exit", (code) => reject(new Error(`llama-server exited early (code ${code}). Log:\n${startupLog}`)));
      proc.once("error", (err) =>
        reject(
          new Error(
            `Failed to start "${this.binary}": ${err.message}. Is llama-server installed and on PATH? See docs/MODELS.md.`
          )
        )
      );
    });

    this.proc = proc;
    const polling = new AbortController();
    const readinessSignal = AbortSignal.any([polling.signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]);
    try {
      this.port_ = await Promise.race([waitForHealth(() => listeningPort, alias, Date.now() + HEALTH_TIMEOUT_MS, readinessSignal), exitedEarly]);
    } catch (err) {
      await this.unload();
      throw err;
    } finally { polling.abort(); }
  }

  async *generate(prompt: PromptPayload, params: GenParams): AsyncIterable<TokenEvent> {
    if (!this.port_) throw new Error("LlamaCppBackend.generate() called before load()");

    if (prompt.mode === "chat") {
      const res = await fetch(`http://127.0.0.1:${this.port_}/v1/chat/completions`, {
        method: "POST",
        signal: params.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: prompt.messages,
          max_tokens: params.max_tokens,
          temperature: params.temperature ?? 0.7,
          stop: params.stop,
          stream: true,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`llama-server chat request failed: ${res.status} ${res.statusText}`);

      let index = 0;
      for await (const obj of readSseObjects(res.body)) {
        const delta = obj?.choices?.[0]?.delta?.content;
        const finish = obj?.choices?.[0]?.finish_reason;
        if (delta) yield { token: delta, index: index++, finish_reason: finish ?? undefined };
        else if (finish) yield { token: "", index: index++, finish_reason: finish };
      }
      return;
    }

    // FIM mode — llama.cpp-native /infill, no OpenAI equivalent.
    const res = await fetch(`http://127.0.0.1:${this.port_}/infill`, {
      method: "POST",
      signal: params.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_prefix: prompt.prefix,
        input_suffix: prompt.suffix,
        prompt: "",
        n_predict: params.max_tokens,
        temperature: params.temperature ?? 0.2,
        stop: params.stop,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`llama-server infill request failed: ${res.status} ${res.statusText}`);

    let index = 0;
    for await (const obj of readSseObjects(res.body)) {
      if (typeof obj?.content === "string" && obj.content.length > 0) {
        yield { token: obj.content, index: index++, finish_reason: obj.stop ? "stop" : undefined };
      } else if (obj?.stop) {
        yield { token: "", index: index++, finish_reason: "stop" };
      }
    }
  }

  async unload(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.port_ = null;

    if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  async tokenize(text: string): Promise<number[]> {
    if (!this.port_) throw new Error("LlamaCppBackend.tokenize() called before load()");
    const res = await fetch(`http://127.0.0.1:${this.port_}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`llama-server tokenize request failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { tokens: number[] };
    return body.tokens;
  }

  async countTokens(text: string): Promise<number> {
    return (await this.tokenize(text)).length;
  }
}
