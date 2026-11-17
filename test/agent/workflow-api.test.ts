import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";
import type { AddressInfo } from "net";
import type { ModelRegistryEntry, RoutingDecision } from "../../src/types/index";
import { buildContext, createServer } from "../../src/server/index";
import { AgentStateStore } from "../../src/agent/state";
import { ScriptedBackend, fixScript, makeRepo, FAKE_PROFILE, CALC_FIXED } from "./helpers";

const models = { planner: "plan", coder: "code", reviewer: "review" };

test("HTTP workflow switches three models, fixes real files, runs real tests and persists approval", async () => {
  const repo = await makeRepo({ config: { models, test: [process.execPath, "--test"], test_target: [process.execPath, "--test", "{file}"] } });
  const base = mkdtempSync(path.join(os.tmpdir(), "lc-workflow-api-"));
  const live = new Set<string>(); const loaded: string[] = []; let peak = 0;
  const registry: ModelRegistryEntry[] = Object.values(models).map((model_id) => ({ model_id, architecture: "dense", parameter_count: { total: 0.5 }, quantization: "Q4_K_M", file_path: "test-only.gguf", context_limit: 16384, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: [] }));
  mkdirSync(path.join(base, "registry")); writeFileSync(path.join(base, "registry/models.json"), JSON.stringify(registry));
  class RoleBackend extends ScriptedBackend {
    id = "";
    constructor() { super((_n, prompt) => this.id === "review" ? JSON.stringify({ approved: true, summary: "addition fixed; tests passed", findings: [] }) : fixScript(false)(_n, prompt)); }
    async load(entry?: ModelRegistryEntry, _decision?: RoutingDecision) { this.id = entry!.model_id; loaded.push(this.id); live.add(this.id); peak = Math.max(peak, live.size); }
    async unload() { live.delete(this.id); }
  }
  const ctx = buildContext({ baseDir: base, repoRoot: repo.root, backendFactory: () => new RoleBackend() });
  ctx.profiler = { sample: async () => FAKE_PROFILE, onChange: () => () => {} };
  const server = createServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/agent/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "Fix addition", session_id: "workflow-api" }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200);
    const events = (await response.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
    assert.deepEqual(events.filter((event) => event.type === "model").map((event) => event.role), ["planner", "coder", "reviewer"]);
    assert.deepEqual(loaded, ["plan", "code", "review"]);
    assert.equal(peak, 1); assert.equal(live.size, 0);
    const done = events.at(-1); assert.equal(done.type, "done"); assert.equal(done.success, true); assert.equal(done.verification, "full");
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_FIXED);
    const saved = new AgentStateStore(repo.root).load(done.task_id) as any;
    assert.deepEqual(saved.models, models); assert.equal(saved.review.approved, true);
    assert.ok(events.some((event) => event.type === "tool_result" && event.name === "run_tests" && event.result.ok));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.modelManager.unloadAll(); ctx.indexStore?.close?.(); repo.cleanup(); rmSync(base, { recursive: true, force: true });
  }
});


test("CLI reads role configuration and reports an honest constrained or invalid-response outcome", async () => {
  const id = "qwen2.5-coder-0.5b-q4";
  const repo = await makeRepo({ config: { models: { planner: id, coder: id, reviewer: id }, test: [process.execPath, "--test"] } });
  try {
    const cli = path.resolve(__dirname, "../../src/cli/index.ts");
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, cli, "agent", "Fix addition", "--backend", "mock"], {
      cwd: repo.root, env: { ...process.env, LOCALCODER_HOME: path.join(repo.root, "isolated-user-data") }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /planner/);
    assert.match(output, /did not return valid JSON|memory budget|too constrained/);
    assert.doesNotMatch(output, /DONE \(verification/);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8").includes("return a - b;"), true);
  } finally { repo.cleanup(); }
});
