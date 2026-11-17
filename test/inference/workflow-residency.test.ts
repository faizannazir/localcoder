/** Real process lifecycle evidence with random-weight fixtures; no model quality claims. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { writeTinyModel } from "../../scripts/tiny-model";
import { entryFromGguf } from "../../src/inference/gguf";
import { LlamaCppBackend } from "../../src/inference/llama-cpp-backend";
import { readRssMb } from "../../src/inference/process-stats";
import { DefaultModelManager } from "../../src/manager/model-manager";
import { DefaultModelRouter } from "../../src/router/router";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import { SequentialModelWorkflow } from "../../src/agent/model-workflow";
import { FAKE_PROFILE } from "../agent/helpers";

const binary = process.env.LOCALCODER_LLAMA_SERVER_BIN;
test("REAL: sequential roles tokenize/generate with one live llama-server and release each process", {
  skip: !binary || !existsSync(binary) ? "set LOCALCODER_LLAMA_SERVER_BIN for real workflow process tests" : false,
}, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lc-workflow-real-"));
  const backends: LlamaCppBackend[] = [];
  const models = { planner: "planner-fixture", coder: "coder-fixture", reviewer: "reviewer-fixture" };
  const records: { role: string; pid: number; rss_mb: number; ready_ms: number }[] = [];
  class ObservedBackend extends LlamaCppBackend {
    async load(...args: Parameters<LlamaCppBackend["load"]>) {
      for (const record of records) assert.equal(readRssMb(record.pid), null, "previous process must exit before the next spawn starts");
      await super.load(...args);
    }
  }
  try {
    const registry = Object.values(models).map((model_id) => {
      const file = path.join(dir, `${model_id}.gguf`);
      writeTinyModel(file);
      return { ...entryFromGguf(file), model_id };
    });
    const manager = new DefaultModelManager(registry, () => {
      const backend = new ObservedBackend({ binary }); backends.push(backend); return backend;
    });
    const workflow = new SequentialModelWorkflow({
      registry, modelManager: manager, router: new DefaultModelRouter(), policyEngine: new DefaultPolicyEngine(),
      // Fixed policy isolates process switching from fluctuating host resource availability.
      profiler: { sample: async () => FAKE_PROFILE, onChange: () => () => {} },
    }, models);
    let peak = 0;
    for (const role of ["planner", "coder", "reviewer"] as const) {
      const started = Date.now();
      await workflow.withRole(role, async ({ backend, tokenCounter, decision }) => {
        const readyMs = Date.now() - started;
        const active = backend as LlamaCppBackend;
        const live = backends.filter((b) => b.pid !== undefined);
        peak = Math.max(peak, live.length);
        assert.equal(live.length, 1);
        assert.equal(manager.resident().length, 1);
        for (const record of records) assert.equal(readRssMb(record.pid), null, "earlier role process must be gone before generation");
        const counted = await tokenCounter.count("function add(a,b) { return a+b; }");
        assert.equal(counted.basis, "measured"); assert.ok(counted.count > 0);
        const props = await (await fetch(`http://127.0.0.1:${active.port}/props`)).json() as any;
        assert.equal(props.default_generation_settings.n_ctx, decision.ctx_window);
        let finish: string | undefined;
        for await (const token of backend.generate({ mode: "chat", messages: [{ role: "user", content: "hello" }] }, { max_tokens: 4 })) finish = token.finish_reason ?? finish;
        assert.ok(finish, "backend must deliver a terminal generation event");
        const completion = await (await fetch(`http://127.0.0.1:${active.port}/v1/chat/completions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], max_tokens: 4, stream: false }),
        })).json() as any;
        assert.ok(completion.usage.completion_tokens > 0 && completion.usage.completion_tokens <= 4);
        const rss = readRssMb(active.pid); assert.ok(rss && rss > 0);
        records.push({ role, pid: active.pid!, rss_mb: rss, ready_ms: readyMs });
      });
      assert.equal(manager.resident().length, 0);
      assert.equal(readRssMb(records.at(-1)!.pid), null);
    }
    assert.equal(peak, 1);
    t.diagnostic(JSON.stringify({ fixture: "random weights", peak_live_models: peak, roles: records }));
    await assert.rejects(workflow.withRole("coder", async () => { throw new Error("prompt construction failed"); }), /prompt construction failed/);
    assert.ok(backends.every((b) => b.pid === undefined));
    assert.equal(manager.resident().length, 0);
  } finally {
    for (const backend of backends) await backend.unload();
    rmSync(dir, { recursive: true, force: true });
  }
});
