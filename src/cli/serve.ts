import { serve } from "../server/index";

export async function runServe(args: string[]): Promise<void> {
  const portFlagIndex = args.indexOf("--port");
  const port = portFlagIndex !== -1 ? parseInt(args[portFlagIndex + 1], 10) : 8080;
  const backendFlagIndex = args.indexOf("--backend");
  const backend = backendFlagIndex !== -1 ? (args[backendFlagIndex + 1] as "llama" | "mock") : undefined;

  const handle = await serve({ port, backend });
  const boundPort = handle.port;
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`\nreceived ${sig}; unloading models and shutting down`);
    try { await handle.close(); } catch { /* exiting anyway */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // eslint-disable-next-line no-console
  console.log(`localcoder serving on http://127.0.0.1:${boundPort}`);
  console.log(`  GET  /v1/models`);
  console.log(`  GET  /v1/resource`);
  console.log(`  POST /v1/chat/completions`);
  console.log(`  POST /v1/completions`);
  if ((backend ?? process.env.LOCALCODER_BACKEND) === "mock") {
    console.log(`\n  Running with the MOCK backend (LOCALCODER_BACKEND=mock) — responses are stubs, not real inference.`);
    console.log(`  Drop --backend mock to use a real llama-server once you've downloaded a model (see docs/MODELS.md).`);
  }
}
