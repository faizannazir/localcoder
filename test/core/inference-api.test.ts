import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { buildContext, createServer } from "../../src/server/index";
import type { AddressInfo } from "net";
import { createServer as createFixtureServer } from "node:http";
import { once } from "node:events";
import { FAKE_PROFILE } from "../agent/helpers";
import { MockInferenceBackend } from "../../src/inference/mock-backend";
import { FoundryLocal } from "../../src/inference/foundry-local";
import { runVscode } from "../../src/cli/vscode";

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

async function startTestServer(extraModel = false, options: Parameters<typeof buildContext>[0] = {}) {
  const tmp = makeTempProjectWithTinyModel(extraModel);
  const ctx = buildContext({ baseDir: tmp, backend: "mock", ...options });
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

const tools = [{ type: "function", function: { name: "lookup_temperature", parameters: { type: "object" } } }];
const toolCalls = [{ id: "call_1", type: "function", function: { name: "lookup_temperature", arguments: "{}" } }];
const history = [
  { role: "developer", content: [{ type: "text", text: "Use the supplied function when needed." }] },
  { role: "user", content: "What is the temperature?" },
  { role: "assistant", content: null, tool_calls: toolCalls },
  { role: "tool", tool_call_id: "call_1", content: "18 degrees" },
];
function requestChat(port: number, body: object) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

test("editor setup uses the model's routed context and emits both client formats", async (t) => {
  const { port, cleanup } = await startTestServer(true);
  const log = t.mock.method(console, "log", () => {});
  try {
    await runVscode(["tiny-test-model", "--port", String(port), "--tools"]);
    const vscode = JSON.parse(log.mock.calls.at(-1)!.arguments[0]);
    assert.equal(vscode[0].models[0].toolCalling, true);
    assert.equal(vscode[0].models[0].maxInputTokens + vscode[0].models[0].maxOutputTokens, 4096 - 256);
    await runVscode(["tiny-test-model", "--port", String(port), "--continue", "--tools"]);
    const config = JSON.parse(log.mock.calls.at(-1)!.arguments[0]);
    assert.deepEqual(config.models[0].capabilities, ["tool_use"]);
    assert.equal(config.models[0].defaultCompletionOptions.contextLength, 4096 - 256);
    await runVscode(["tiny-test-model", "--port", String(port)]);
    assert.equal(JSON.parse(log.mock.calls.at(-1)!.arguments[0])[0].models[0].toolCalling, false);
    await assert.rejects(runVscode(["tiny-test-model", "--port", String(port), "--input-tokens", "32000"]), /--input-tokens must be from 1/);
    await runVscode(["tiny-test-model", "explicit-test-model", "--port", String(port), "--tools"]);
    assert.deepEqual(JSON.parse(log.mock.calls.at(-1)!.arguments[0])[0].models.map((model: { toolCalling: boolean }) => model.toolCalling), [true, false]);
  } finally { await cleanup(); }
});

test("editor configs reference authentication without including the token", async (t) => {
  const prior = process.env.LOCALCODER_API_TOKEN;
  process.env.LOCALCODER_API_TOKEN = "fixture-local-token";
  const log = t.mock.method(console, "log", () => {});
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const server = await startTestServer();
    cleanup = server.cleanup;
    await runVscode(["tiny-test-model", "--port", String(server.port)]);
    await runVscode(["tiny-test-model", "--port", String(server.port), "--continue"]);
    const [vscode, continuation] = log.mock.calls.map((call) => call.arguments[0]);
    assert.match(vscode, /input:localcoderApiKey/);
    assert.match(continuation, /secrets.LOCALCODER_API_TOKEN/);
    assert.doesNotMatch(vscode + continuation, /fixture-local-token/);
  } finally {
    if (prior === undefined) delete process.env.LOCALCODER_API_TOKEN;
    else process.env.LOCALCODER_API_TOKEN = prior;
    await cleanup?.();
  }
});

test("tool-capable backend preserves tool history, streaming deltas, and actionable context errors", async () => {
  const received: Record<string, unknown>[] = [];
  const backend = Object.assign(new MockInferenceBackend(), {
    async chatCompletion(request: Record<string, unknown>) {
      received.push(request);
      if (!request.stream) return Response.json({ error: { type: "exceed_context_size_error" } }, { status: 400 });
      return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2"}]}}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  const { port, cleanup } = await startTestServer(true, { backendFactory: () => backend });
  try {
    const reply = await requestChat(port, { model: "tiny-test-model", messages: history, tools, max_completion_tokens: 5000 });
    assert.equal(reply.status, 200);
    assert.match(await reply.text(), /call_2[\s\S]*\[DONE\]/);
    assert.deepEqual((received[0].messages as object[]).slice(2), history.slice(2));
    assert.equal(received[0].max_tokens, 1024);
    assert.equal((await requestChat(port, { model: "explicit-test-model", messages: history, tools })).status, 400);
    const rejected = await requestChat(port, { model: "tiny-test-model", messages: history, tools, stream: false });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /context_length_exceeded/);
  } finally { await cleanup(); }
});

test("Foundry Local cached models and tool calls are forwarded to one configured loopback service", async () => {
  let upstreamBody = "";
  let redirected = false;
  const upstream = createFixtureServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/openai/models") { res.end(JSON.stringify(["fixture-cpu"])); return; }
    if (req.url === "/unexpected") { redirected = true; res.end("{}"); return; }
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, undefined);
    upstreamBody = "";
    for await (const chunk of req) upstreamBody += chunk;
    if (JSON.parse(upstreamBody).model === "redirect") {
      res.writeHead(307, { Location: "/unexpected" });
      res.end();
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls }, finish_reason: "tool_calls" }] }));
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const endpoint = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const { port, cleanup } = await startTestServer(false, { foundryEndpoint: endpoint });
  try {
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).text();
    assert.match(models, /foundry\/fixture-cpu/);
    const result = await requestChat(port, { model: "foundry/fixture-cpu", messages: history, tools, stream: false });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /tool_calls/);
    assert.equal(JSON.parse(upstreamBody).model, "fixture-cpu");
    assert.deepEqual(JSON.parse(upstreamBody).messages.at(-1), history.at(-1));
    assert.equal((await requestChat(port, { model: "foundry/redirect", messages: history, tools })).status, 502);
    assert.equal(redirected, false);
    assert.throws(() => new FoundryLocal("http://192.0.2.10:5272"), /127\.0\.0\.1/);
    assert.throws(() => new FoundryLocal(endpoint + "/redirect"), /127\.0\.0\.1/);
  } finally {
    await cleanup();
    upstream.close();
    await once(upstream, "close");
  }
});

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
