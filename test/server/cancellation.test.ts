import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { buildContext, createServer } from "../../src/server/index";
import { LlamaCppBackend } from "../../src/inference/llama-cpp-backend";
import { FAKE_PROFILE } from "../agent/helpers";

test("disconnecting stalled chat and FIM streams releases their backend leases for shutdown", { skip: process.platform === "win32" ? "POSIX executable fixture" : false, timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-cancel-"));
  const binary = path.join(root, "test-server");
  writeFileSync(binary, `#!${process.execPath}
const http = require('http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = req.url === '/infill' ? { content: 'start' } : { choices: [{ delta: { content: 'start' } }] };
  res.write('data: ' + JSON.stringify(chunk) + '\\n\\n');
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });
  mkdirSync(path.join(root, "registry"));
  const model = path.join(root, "model.gguf");
  writeFileSync(model, "fixture");
  writeFileSync(path.join(root, "registry", "models.json"), JSON.stringify([{
    model_id: "cancel-test", architecture: "dense", parameter_count: { total: 0.1 }, quantization: "F32",
    file_path: model, context_limit: 4096, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: ["fim"],
  }]));
  const backend = new LlamaCppBackend({ binary });
  const ctx = buildContext({ baseDir: root, repoRoot: root, backendFactory: () => backend });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
  const server = createServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    for (const [endpoint, body] of [["chat/completions", { messages: [{ role: "user", content: "hello" }] }], ["completions", { prefix: "function add() {" }]] as const) {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      assert.equal((await reader.read()).done, false);
      controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ctx.modelManager.unloadAll(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("disconnected inference retained its model lease")), 2000); }),
        ]);
      } finally { clearTimeout(timer); }
      assert.equal(backend.pid, undefined);
      await reader.cancel().catch(() => {});
    }
  } finally {
    await backend.unload();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent disconnected while queued never opens its workspace session", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-queued-agent-"));
  mkdirSync(path.join(root, "registry"));
  writeFileSync(path.join(root, "registry", "models.json"), JSON.stringify([{
    model_id: "queue-test", architecture: "dense", parameter_count: { total: 0.1 }, quantization: "F32",
    file_path: "fixture.gguf", context_limit: 4096, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: ["fim"],
  }]));
  let releaseLoad!: () => void;
  const loading = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const { MockInferenceBackend } = await import("../../src/inference/mock-backend");
  class WaitingBackend extends MockInferenceBackend {
    async load(...args: Parameters<MockInferenceBackend["load"]>) { await loading; await super.load(...args); }
  }
  const ctx = buildContext({ baseDir: root, repoRoot: root, backendFactory: () => new WaitingBackend() });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
  let started!: () => void, queued!: () => void;
  const firstAcquire = new Promise<void>((resolve) => { started = resolve; });
  const secondAcquire = new Promise<void>((resolve) => { queued = resolve; });
  const acquire = ctx.modelManager.acquire.bind(ctx.modelManager);
  let requests = 0;
  ctx.modelManager.acquire = (...args) => {
    if (++requests === 1) started(); else queued();
    return acquire(...args);
  };
  const server = createServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const controller = new AbortController();
  let chat: Promise<Response> | undefined;
  try {
    chat = fetch(`${url}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    await firstAcquire;
    const agent = fetch(`${url}/agent/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "Edit calc.js" }), signal: controller.signal });
    await secondAcquire;
    controller.abort();
    await assert.rejects(agent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseLoad();
    await (await chat).text();
    await ctx.modelManager.unloadAll();
    const { existsSync } = await import("fs");
    assert.equal(existsSync(path.join(root, ".localcoder")), false, "an abandoned queued request must leave the workspace untouched");
  } finally {
    releaseLoad();
    controller.abort();
    server.closeAllConnections();
    await chat?.catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.modelManager.unloadAll();
    rmSync(root, { recursive: true, force: true });
  }
});
