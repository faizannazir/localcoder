import { existsSync } from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { HardwareProfiler } from "../hardware/profiler";
import { DefaultPolicyEngine } from "../policy/engine";
import { HeuristicTaskClassifier } from "../router/classifier";
import { DefaultModelRouter } from "../router/router";
import { loadRegistry, loadFullRegistry, installedOnly } from "../router/registry";
import { checkRequest, securityFromEnv, SecurityOptions } from "./security";
import { DefaultModelManager } from "../manager/model-manager";
import { LlamaCppBackend } from "../inference/llama-cpp-backend";
import { MockInferenceBackend } from "../inference/mock-backend";
import { indexDbPath, openIndexStore } from "../index/open";
import { DefaultContextManager } from "../context/context-manager";
import { EstimatingTokenCounter } from "../context/token-counter";
import type { AppContext } from "./context";
import { handleModelResidency, handleModels } from "./routes/models";
import { handleResource } from "./routes/resource";
import { handleChatCompletions } from "./routes/chat";
import { handleCompletions } from "./routes/completions";
import { handleAgentRun, handleAgentUndo } from "./routes/agent";

export interface ServeOptions {
  port?: number;
  baseDir?: string;
  backend?: "llama" | "mock";
  repoRoot?: string;
  /** Test seam: supply a specific InferenceBackend (e.g. a scripted one in unit tests). */
  backendFactory?: () => import("../types/index").InferenceBackend;
}

const MAX_BODY_BYTES = 1024 * 1024;

class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) { super(message); }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    req.once("error", reject);
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      req.resume();
      reject(new RequestBodyError(413, "Request body exceeds the 1 MiB limit."));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        chunks.length = 0;
        req.removeListener("data", onData);
        req.resume();
        reject(new RequestBodyError(413, "Request body exceeds the 1 MiB limit."));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("aborted", () => {
      chunks.length = 0;
      reject(new RequestBodyError(400, "Request body was interrupted."));
    });
    req.once("end", () => {
      if (bytes > MAX_BODY_BYTES) return;
      if (bytes === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
      } catch {
        reject(new RequestBodyError(400, "Invalid JSON body"));
      }
    });
  });
}

export function buildContext(opts: ServeOptions = {}): AppContext {
  const baseDir = opts.baseDir ?? path.join(__dirname, "..", "..");
  const backendChoice = opts.backend ?? (process.env.LOCALCODER_BACKEND === "mock" ? "mock" : "llama");

  // Explicit baseDir = hermetic (tests); otherwise shipped registry + the user's own models (~/.localcoder).
  let registry = opts.baseDir !== undefined ? loadRegistry(path.join(baseDir, "registry", "models.json")) : loadFullRegistry();
  // With the real engine, only INSTALLED models may be routed to — never offer a model whose file does not exist.
  if (!opts.backendFactory && backendChoice === "llama") registry = installedOnly(registry);
  const backendFactory = opts.backendFactory ?? (() => (backendChoice === "mock" ? new MockInferenceBackend() : new LlamaCppBackend()));

  const repoRoot = opts.repoRoot ?? process.cwd();
  const hasIndex = existsSync(indexDbPath(repoRoot));
  const indexStore = hasIndex ? openIndexStore(repoRoot) : undefined;
  const contextManager = indexStore ? new DefaultContextManager(indexStore, new EstimatingTokenCounter()) : undefined;

  return {
    profiler: new HardwareProfiler(),
    policyEngine: new DefaultPolicyEngine(),
    classifier: new HeuristicTaskClassifier(),
    router: new DefaultModelRouter(),
    modelManager: new DefaultModelManager(registry, backendFactory),
    registry,
    baseDir,
    repoRoot,
    indexStore,
    contextManager,
  };
}

export function createServer(ctx: AppContext, security: SecurityOptions = securityFromEnv()) {
  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    res.once("close", abort);
    try {
      const denied = checkRequest(req, security);
      if (denied) {
        res.writeHead(denied.status, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: denied.message } }));
      }
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/v1/models") {
        return await handleModels(undefined, res, ctx);
      }
      if (method === "POST" && (url === "/v1/models/load" || url === "/v1/models/unload")) {
        return await handleModelResidency(await readJsonBody(req), res, ctx, url.endsWith("/unload") ? "unload" : "load");
      }
      if (method === "GET" && url === "/v1/resource") {
        return await handleResource(undefined, res, ctx);
      }
      if (method === "POST" && url === "/v1/chat/completions") {
        const body = await readJsonBody(req);
        return await handleChatCompletions(body, res, ctx, cancellation.signal);
      }
      if (method === "POST" && url === "/v1/completions") {
        const body = await readJsonBody(req);
        return await handleCompletions(body, res, ctx, cancellation.signal);
      }

      if (method === "POST" && url === "/v1/agent/run") {
        const body = await readJsonBody(req);
        return await handleAgentRun(body, res, ctx, req, cancellation.signal);
      }
      if (method === "POST" && url === "/v1/agent/undo") {
        const body = await readJsonBody(req);
        return await handleAgentUndo(body, res, ctx);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `No route for ${method} ${url}` } }));
    } catch (err) {
      if (!res.headersSent) {
        const status = err instanceof RequestBodyError ? err.status : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: (err as Error).message ?? "Internal error" } }));
    } finally { res.removeListener("close", abort); }
  });
}

export async function serve(opts: ServeOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const ctx = buildContext(opts);
  const server = createServer(ctx);
  const port = opts.port ?? 8080;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });

  return {
    port: (server.address() as import("net").AddressInfo).port,
    close: async () => {
      const stopped = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      server.closeAllConnections();
      try { await ctx.modelManager.unloadAll(); }
      finally { await stopped; ctx.indexStore?.close(); }
    },
  };
}
