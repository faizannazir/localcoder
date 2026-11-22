import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { buildContext, createServer } from "../../src/server/index";
import type { AddressInfo } from "net";
import { FAKE_PROFILE } from "../agent/helpers";

function makeTempProjectWithTinyModel(extraModel = false): string {
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
        estimated_memory_gb: 0.1,
        capabilities: ["fim", "tool_calling"],
      },
      ...(extraModel ? [{ model_id: "explicit-test-model", architecture: "dense",
        parameter_count: { total: 1.5 }, quantization: "Q4_K_M", file_path: "explicit.gguf",
        context_limit: 4096, backend_requirements: ["cpu"], estimated_memory_gb: 0.2, capabilities: [] }] : []),
    ])
  );
  return tmp;
}

async function startTestServer(extraModel = false) {
  const tmp = makeTempProjectWithTinyModel(extraModel);
  const ctx = buildContext({ baseDir: tmp, backend: "mock" });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
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

test("GET /v1/models responds with the registry within budget", async () => {
  const { port, cleanup } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { model_id: string; id: string; object: string }[] };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].model_id, "tiny-test-model");
    assert.equal(body.data[0].id, "tiny-test-model");
    assert.equal(body.data[0].object, "model");
  } finally {
    await cleanup();
  }
});

test("model residency can be inspected, loaded, and unloaded over HTTP", async () => {
  const { port, cleanup } = await startTestServer();
  const url = `http://127.0.0.1:${port}/v1/models`;
  const model = "tiny-test-model";
  const change = (operation: string, id: string) => fetch(`${url}/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id }),
  });
  const resident = async () => {
    const payload = await (await fetch(url)).json() as { data: { resident: boolean }[] };
    return payload.data[0].resident;
  };
  try {
    assert.equal(await resident(), false);
    assert.equal((await change("load", "missing")).status, 404);
    assert.deepEqual(await (await change("load", model)).json(), { model, resident: true });
    assert.equal(await resident(), true);
    assert.deepEqual(await (await change("unload", model)).json(), { model, resident: false });
    assert.equal(await resident(), false);
  } finally { await cleanup(); }
});

test("POST /v1/chat/completions streams a successful OpenAI-compatible response end-to-end", async () => {
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

test("POST /v1/completions (FIM) responds successfully and independently of the chat path", async () => {
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

test("completions route file imports nothing from context/index-store/agent/tools (isolation rule)", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "../../src/server/routes/completions.ts"), "utf8");
  for (const forbidden of ["context/", "index-store/", "agent/", "tools/", "classifier"]) {
    assert.ok(!src.includes(`"../../${forbidden}`) && !src.includes(`'../../${forbidden}`), `completions.ts must not import from ${forbidden} — see implementation-spec.md §2.8`);
  }
});


test("IDE chat clients can select an exact model and request JSON or streaming replies", async () => {
  const { port, cleanup } = await startTestServer(true);
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const messages = [{ role: "developer", content: [{ type: "text", text: "Answer briefly." }] },
      { role: "user", content: [{ type: "text", text: "Review this function." }] }];
    const res = await post({ model: "explicit-test-model", messages, stream: false, max_completion_tokens: 5 });
    assert.equal(res.status, 200);
    const completion = await res.json() as any;
    assert.equal(completion.object, "chat.completion");
    assert.equal(completion.model, "explicit-test-model");
    assert.equal(completion.choices[0].message.role, "assistant");
    assert.match(completion.choices[0].message.content, /mock:explicit-test-model/);
    assert.ok(completion.choices[0].finish_reason);

    const stream = await post({ model: "localcoder-auto", messages, stream: true });
    const chunks = (await stream.text()).split("\n").filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)));
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks[0].model, "tiny-test-model");

    assert.equal((await post({ model: "missing", messages })).status, 404);
    assert.equal((await post({ model: "explicit-test-model", messages, tools: [{ type: "function" }] })).status, 400);
  } finally { await cleanup(); }
});
