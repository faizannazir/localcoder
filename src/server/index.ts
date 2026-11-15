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
import { handleModels } from "./routes/models";
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
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
      if (method === "GET" && url === "/v1/resource") {
        return await handleResource(undefined, res, ctx);
      }
      if (method === "POST" && url === "/v1/chat/completions") {
        const body = await readJsonBody(req);
        return await handleChatCompletions(body, res, ctx);
      }
      if (method === "POST" && url === "/v1/completions") {
        const body = await readJsonBody(req);
        return await handleCompletions(body, res, ctx);
      }

      if (method === "POST" && url === "/v1/agent/run") {
        const body = await readJsonBody(req);
        return await handleAgentRun(body, res, ctx, req);
      }
      if (method === "POST" && url === "/v1/agent/undo") {
        const body = await readJsonBody(req);
        return await handleAgentUndo(body, res, ctx);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `No route for ${method} ${url}` } }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: (err as Error).message ?? "Internal error" } }));
    }
  });
}

export async function serve(opts: ServeOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const ctx = buildContext(opts);
  const server = createServer(ctx);
  const port = opts.port ?? 8080;

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    port,
    close: async () => {
      await ctx.modelManager.unloadAll(); // never leave llama-server children behind
      (server as any).closeAllConnections?.();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
