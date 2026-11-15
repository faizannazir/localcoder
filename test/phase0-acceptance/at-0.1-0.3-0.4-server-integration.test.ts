import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { buildContext, createServer } from "../../src/server/index";
import type { AddressInfo } from "net";

function makeTempProjectWithTinyModel(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "localcoder-test-"));
  mkdirSync(path.join(tmp, "registry"), { recursive: true });
  writeFileSync(
    path.join(tmp, "registry", "models.json"),
    JSON.stringify([
      {
        model_id: "tiny-test-model",
        architecture: "dense",
        parameter_count: { total: 0.5 },
        quantization: "Q4_K_M",
        file_path: "does-not-need-to-exist-for-the-mock-backend.gguf",
        context_limit: 4096,
        backend_requirements: ["cpu"],
        estimated_memory_gb: 0.1, // deliberately tiny so it fits any real machine's budget
        capabilities: ["fim", "tool_calling"],
      },
    ])
  );
  return tmp;
}

async function startTestServer() {
  const tmp = makeTempProjectWithTinyModel();
  const ctx = buildContext({ baseDir: tmp, backend: "mock" });
  const server = createServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("AT-0.1: GET /v1/models responds with the registry within budget", async () => {
  const { port, cleanup } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { model_id: string }[] };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].model_id, "tiny-test-model");
  } finally {
    await cleanup();
  }
});

test("AT-0.3: POST /v1/chat/completions streams a successful OpenAI-compatible response end-to-end", async () => {
  const { port, cleanup } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "write a hello world function" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const text = await res.text();
    assert.ok(text.includes("tiny-test-model"), "streamed chunks should reference the routed model");
    assert.ok(text.includes("mock:tiny-test-model"), "mock backend's stub content should appear in the stream");
    assert.ok(text.trim().endsWith("data: [DONE]"), "stream must terminate with the OpenAI-style [DONE] sentinel");
  } finally {
    await cleanup();
  }
});

test("AT-0.4: POST /v1/completions (FIM) responds successfully and independently of the chat path", async () => {
  const { port, cleanup } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "function add(a, b) {\n  return ", suffix: "\n}" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('"fim'), "mock backend should report it received a fim-mode prompt");
    assert.ok(text.includes("prefix(30"), "mock backend should report the actual prefix length it received");
    assert.ok(text.trim().endsWith("data: [DONE]"));
  } finally {
    await cleanup();
  }
});

test("AT-0.1/0.4: completions route file imports nothing from context/index-store/agent/tools (isolation rule)", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "../../src/server/routes/completions.ts"), "utf8");
  for (const forbidden of ["context/", "index-store/", "agent/", "tools/", "classifier"]) {
    assert.ok(!src.includes(`"../../${forbidden}`) && !src.includes(`'../../${forbidden}`), `completions.ts must not import from ${forbidden} — see implementation-spec.md §2.8`);
  }
});
