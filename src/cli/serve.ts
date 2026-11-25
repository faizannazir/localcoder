import { serve } from "../server/index";
import { CONTROL_TOKEN_ENV, startBackgroundServer } from "./background-server";
import { parseServerPort } from "./server-client";

export async function runServe(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: localcoder serve [--background] [--port <port>] [--backend llama|mock]");
    return;
  }
  const portFlagIndex = args.indexOf("--port");
  const port = portFlagIndex !== -1 ? parseServerPort(args[portFlagIndex + 1], true) : 8080;
  const backendFlagIndex = args.indexOf("--backend");
  const requestedBackend = backendFlagIndex !== -1 ? args[backendFlagIndex + 1] : process.env.LOCALCODER_BACKEND;
  if (backendFlagIndex !== -1 && requestedBackend !== "mock" && requestedBackend !== "llama") {
    throw new Error("--backend must be llama or mock.");
  }
  const backend = requestedBackend === "mock" ? "mock" : "llama";
  if (args.includes("--background")) {
    await startBackgroundServer(port, backend);
    return;
  }

  const token = process.send ? process.env[CONTROL_TOKEN_ENV] : undefined;
  delete process.env[CONTROL_TOKEN_ENV];
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`\nreceived ${sig}; unloading models and shutting down`);
    try { await handle?.close(); } catch { /* exiting anyway */ }
    process.exit(0);
  };
  if (token) {
    let registered = false;
    process.once("message", (message: unknown) => {
      registered = (message as { registered?: boolean } | null)?.registered === true;
    });
    process.once("disconnect", () => {
      if (!registered) void shutdown("launcher disconnected");
    });
    if (!process.connected) return await shutdown("launcher disconnected");
  }
  handle = await serve({ port, backend, foundryEndpoint: process.env.LOCALCODER_FOUNDRY_ENDPOINT,
    control: token ? { token, shutdown: () => void shutdown("stop") } : undefined });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (token) process.send?.({ port: handle.port });

  // eslint-disable-next-line no-console
  console.log(`localcoder serving on http://127.0.0.1:${handle.port}`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /v1/resource`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  POST /v1/completions`);
  if (backend === "mock") {
    console.log(`\n  Running with the MOCK backend (LOCALCODER_BACKEND=mock) — responses are stubs, not real inference.`);
    console.log(`  Drop --backend mock to use a real llama-server once you've downloaded a model (see docs/MODELS.md).`);
  }
}
