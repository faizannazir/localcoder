import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import path from "path";
import { parseAgentModels } from "../../src/agent/config";
import { SequentialModelWorkflow, prepareAgentRun } from "../../src/agent/model-workflow";
import { DefaultModelManager } from "../../src/manager/model-manager";
import { DefaultModelRouter } from "../../src/router/router";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import { MockInferenceBackend } from "../../src/inference/mock-backend";
import { AgentStateStore, newState } from "../../src/agent/state";
import { FAKE_PROFILE, makeRepo } from "./helpers";
import type { ModelRegistryEntry } from "../../src/types/index";

const models = { planner: "plan", coder: "code", reviewer: "review" };
const registry: ModelRegistryEntry[] = Object.values(models).map((model_id) => ({ model_id, file_path: `${model_id}.gguf`, architecture: "dense", parameter_count: { total: 1 }, quantization: "Q4_K_M", context_limit: model_id === "code" ? 4096 : 8192, estimated_memory_gb: 1, backend_requirements: ["cpu"], capabilities: [] }));
function deps() {
  let samples = 0;
  return { profiler: { onChange: () => () => {}, sample: async () => { samples++; return FAKE_PROFILE; } }, policyEngine: new DefaultPolicyEngine(), router: new DefaultModelRouter(), registry,
    modelManager: new DefaultModelManager(registry, () => new MockInferenceBackend()), samples: () => samples };
}

test("role configuration requires exactly three nonempty IDs and accepts repeated IDs", () => {
  assert.deepEqual(parseAgentModels(models), models);
  assert.deepEqual(parseAgentModels({ planner: "a", coder: "a", reviewer: "a" }), { planner: "a", coder: "a", reviewer: "a" });
  for (const invalid of [null, [], {}, { ...models, coder: " " }, { ...models, extra: "id" }, { ...models, reviewer: 3 }]) assert.throws(() => parseAgentModels(invalid), /planner, coder, and reviewer/);
});

test("roles select exact IDs with their own contexts/tokenizers and release every backend", async () => {
  const d = deps();
  const workflow = new SequentialModelWorkflow(d, models);
  for (const role of ["planner", "coder", "reviewer"] as const) {
    await workflow.withRole(role, async (active) => {
      assert.equal(active.decision.model_id, models[role]);
      assert.equal(active.decision.ctx_window, role === "coder" ? 4096 : 8192);
      assert.equal((await active.tokenCounter.count("hello")).basis, "measured");
      assert.equal(d.modelManager.resident().length, 1);
    });
    assert.equal(d.modelManager.resident().length, 0);
  }
  assert.equal(d.samples(), 3);
  await assert.rejects(workflow.withRole("coder", async () => { throw new Error("bad prompt"); }), /bad prompt/);
  assert.equal(d.modelManager.resident().length, 0);
});

test("unknown models and cancellation fail before generation or resource leaks", async () => {
  const d = deps();
  await assert.rejects(new SequentialModelWorkflow(d, { ...models, coder: "missing" }).withRole("coder", async () => {}), /coder model "missing" is not installed/);
  const signal = AbortSignal.abort();
  await assert.rejects(new SequentialModelWorkflow(d, models, signal).withRole("planner", async () => { assert.fail("must not execute"); }), /aborted/);
  assert.equal(d.modelManager.resident().length, 0);
});

test("new tasks use configuration while resumed tasks use saved roles or legacy mode", async () => {
  const repo = await makeRepo({ config: { models } });
  try {
    const d = deps();
    assert.deepEqual((await prepareAgentRun(repo.root, { task: "fix" }, d)).models, models);
    const store = new AgentStateStore(repo.root);
    const legacy = newState("old", "s"); store.save(legacy);
    assert.equal((await prepareAgentRun(repo.root, { task: "continue", resume_task_id: legacy.task_id }, d)).models, undefined);
    const saved = { ...newState("new", "s"), models }; store.save(saved);
    writeFileSync(path.join(repo.root, ".localcoder/agent.json"), "{}");
    const prepared = await prepareAgentRun(repo.root, { task: "continue", resume_task_id: saved.task_id }, d);
    assert.deepEqual(prepared.models, models);
    assert.equal(prepared.request.resume_task_id, saved.task_id);
  } finally { repo.cleanup(); }
});

test("queued cancellation never loads a role; resource gates refresh after prior leases drain", async () => {
  const d = deps();
  const routed = d.router.route("hard_agent", d.policyEngine.derive(FAKE_PROFILE), registry);
  assert.ok(!("rejected" in routed));
  if ("rejected" in routed) return;
  const lease = await d.modelManager.acquire(routed, d.policyEngine.derive(FAKE_PROFILE));
  const controller = new AbortController();
  const workflow = new SequentialModelWorkflow(d, models, controller.signal);
  const pending = workflow.withRole("coder", async () => assert.fail("canceled role cannot execute"));
  const rejection = assert.rejects(pending, /aborted/);
  controller.abort(); lease.release(); await rejection;
  assert.equal(d.modelManager.resident().length, 0);
  d.profiler.sample = async () => ({ ...FAKE_PROFILE, memory_budget_gb: 0.5 });
  await assert.rejects(new SequentialModelWorkflow(d, models).withRole("reviewer", async () => assert.fail("unfit role cannot execute")), /reviewer model/);
  assert.equal(d.modelManager.resident().length, 0);
});
