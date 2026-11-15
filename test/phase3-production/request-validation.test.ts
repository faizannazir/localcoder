import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { buildContext, createServer } from "../../src/server/index";
import { MockInferenceBackend } from "../../src/inference/mock-backend";
import type { GenParams, PromptPayload } from "../../src/types/index";
import { FAKE_PROFILE } from "../phase2-acceptance/helpers";

async function start() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-validation-"));
  mkdirSync(path.join(root, "registry"));
  writeFileSync(path.join(root, "registry", "models.json"), JSON.stringify([{
    model_id: "validation-model", architecture: "dense", parameter_count: { total: 0.1 }, quantization: "Q4_K_M",
    file_path: "fixture.gguf", context_limit: 4096, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: ["fim"],
  }]));
  let loads = 0;
  const generated: { prompt: PromptPayload; params: GenParams }[] = [];
  class CaptureBackend extends MockInferenceBackend {
    async load(...args: Parameters<MockInferenceBackend["load"]>) { loads++; await super.load(...args); }
    async *generate(prompt: PromptPayload, params: GenParams) {
      generated.push({ prompt, params });
      yield { token: "ok", index: 0, finish_reason: "stop" as const };
    }
  }
  const ctx = buildContext({ baseDir: root, repoRoot: root, backendFactory: () => new CaptureBackend() });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
  const server = createServer(ctx, { allowedOrigins: [], extraHosts: [] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const postRaw = (endpoint: string, chunks: Buffer[], declaredBytes?: number) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (declaredBytes !== undefined) headers["Content-Length"] = String(declaredBytes);
    const request = http.request({ host: "127.0.0.1", port, path: endpoint, method: "POST", agent: false, headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
      response.on("error", reject);
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
  const post = (endpoint: string, body: unknown) => postRaw(endpoint, [Buffer.from(JSON.stringify(body))]);
  return {
    post, postRaw, generated, loads: () => loads,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.modelManager.unloadAll();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const chat = { messages: [{ role: "user", content: "hi" }] };

test("HTTP validation returns 400 for malformed JSON and invalid messages before loading a model", async () => {
  const server = await start();
  try {
    assert.equal((await server.postRaw("/v1/chat/completions", [Buffer.from("{")])).status, 400);
    for (const body of [null, [], {}, { messages: [] }, { messages: [null] }, { messages: [{ role: "tool", content: "x" }] }, { messages: [{ role: "user", content: 5 }] }]) {
      assert.equal((await server.post("/v1/chat/completions", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(server.loads(), 0);
    assert.equal(server.generated.length, 0);
  } finally { await server.close(); }
});

test("HTTP validation rejects invalid generation parameters on chat and FIM before loading a model", async () => {
  const server = await start();
  try {
    const invalidOptions = [
      { max_tokens: 0 }, { max_tokens: -1 }, { max_tokens: 1.5 }, { max_tokens: "8" }, { max_tokens: null },
      { temperature: -0.1 }, { temperature: 2.1 }, { temperature: "0.5" }, { temperature: null },
      { stop: "end" }, { stop: [null] }, { stop: [1] },
    ];
    for (const [endpoint, required] of [["/v1/chat/completions", chat], ["/v1/completions", { prefix: "a" }]] as const) {
      for (const invalid of invalidOptions) {
        assert.equal((await server.post(endpoint, { ...required, ...invalid })).status, 400, `${endpoint} ${JSON.stringify(invalid)}`);
      }
      assert.equal((await server.postRaw(endpoint, [Buffer.from(JSON.stringify(required).replace(/}$/, ',"temperature":1e999}'))])).status, 400);
    }
    assert.equal((await server.post("/v1/chat/completions", { ...chat, review: "yes" })).status, 400);
    assert.equal((await server.post("/v1/completions", { prefix: "a", suffix: 5 })).status, 400);
    assert.equal(server.loads(), 0);
  } finally { await server.close(); }
});

test("HTTP generation caps requested tokens to routing policy and preserves smaller limits", async () => {
  const server = await start();
  try {
    assert.equal((await server.post("/v1/chat/completions", { ...chat, max_tokens: 900000 })).status, 200);
    assert.equal(server.generated.at(-1)!.params.max_tokens, 512);
    assert.equal((await server.post("/v1/completions", { prefix: "a", max_tokens: 900000 })).status, 200);
    assert.equal(server.generated.at(-1)!.params.max_tokens, 64);
    assert.equal((await server.post("/v1/chat/completions", { ...chat, max_tokens: 8, temperature: 0, stop: ["end"] })).status, 200);
    assert.deepEqual(server.generated.at(-1)!.params, { max_tokens: 8, temperature: 0, stop: ["end"] });
  } finally { await server.close(); }
});

test("HTTP request bodies enforce a one MiB byte limit with declared and streamed lengths", async () => {
  const server = await start();
  try {
    const oversized = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "é".repeat(530000) }] }));
    assert.ok(oversized.length > 1024 * 1024);
    assert.equal((await server.postRaw("/v1/chat/completions", [oversized], oversized.length)).status, 413);
    const chunks = Array.from({ length: Math.ceil(oversized.length / 4096) }, (_, i) => oversized.subarray(i * 4096, (i + 1) * 4096));
    assert.equal((await server.postRaw("/v1/chat/completions", chunks)).status, 413);
    assert.equal(server.loads(), 0);
    assert.equal((await server.post("/v1/chat/completions", chat)).status, 200, "server remains available after rejecting oversized requests");
  } finally { await server.close(); }
});

test("HTTP JSON decoding preserves multibyte text split across request chunks", async () => {
  const server = await start();
  try {
    const content = "你好é";
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content }] }));
    assert.equal((await server.postRaw("/v1/chat/completions", Array.from(body, (byte) => Buffer.from([byte])))).status, 200);
    const prompt = server.generated[0].prompt;
    assert.equal(prompt.mode, "chat");
    if (prompt.mode === "chat") assert.equal(prompt.messages[0].content, content);
  } finally { await server.close(); }
});
