import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "fs";
import path from "path";
import { CodingAgent } from "../../src/agent/coding-agent";
import { newState, AgentStateStore } from "../../src/agent/state";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import { loadAgentConfig } from "../../src/agent/config";
import { BackendTokenCounter } from "../../src/context/token-counter";
import type { AgentModelWorkflow } from "../../src/agent/model-workflow";
import { hashText } from "../../src/agent/workdir";
import { makeRepo, CALC_FIXED, CALC_BUGGY, ScriptedBackend, POLICY, DECISION, collect } from "./helpers";

for (const kind of ["targeted", "lint"] as const) test(`resuming review reruns ${kind} validation after external edits`, async () => {
  const repo = await makeRepo({ buggy: false, config: kind === "targeted" ? { test_target: [process.execPath, "--test", "{file}"] } : {} });
  try {
    const models = { planner: "plan", coder: "code", reviewer: "review" };
    const store = new AgentStateStore(repo.root);
    const saved = newState("Fix addition", "resume");
    Object.assign(saved, { models, phase: "REVIEW", status: "interrupted", ran_targeted_ok: kind === "targeted", ran_lint_ok: true, verification: kind === "targeted" ? "targeted" : "syntax_only" });
    saved.edits.push({ path: "calc.js", op: "replace", before_hash: hashText(CALC_BUGGY), after_hash: hashText(CALC_FIXED), backup_ref: null, step: 1 });
    saved.files_read["calc.js"] = hashText(CALC_FIXED);
    store.save(saved);
    writeFileSync(path.join(repo.root, "calc.js"), kind === "targeted" ? CALC_BUGGY : "function broken( {\n");
    const roles: string[] = [];
    const backend = new ScriptedBackend(() => JSON.stringify({ approved: true, summary: "approved", findings: [] }));
    const workflow: AgentModelWorkflow = { models, withRole: async (role, operation) => { roles.push(role); return operation({ backend, tokenCounter: new BackendTokenCounter(backend), decision: DECISION, policy: POLICY }); } };
    const config = loadAgentConfig(repo.root);
    const agent = new CodingAgent({ root: repo.root, index: repo.store, memory: repo.memory, indexService: repo.indexService,
      tools: new DefaultToolRuntime({ root: repo.root, index: repo.store, indexService: repo.indexService, config }),
      modelWorkflow: workflow, policy: POLICY, decision: DECISION, config, stateStore: store, limits: { max_fix_attempts: 0 } });
    const events = await collect(agent.run({ task: "continue", resume_task_id: saved.task_id }));
    assert.equal(events.find((e) => e.type === "done")?.success, false, "stale checks cannot let reviewer approve external changes");
    assert.deepEqual(roles, [], "failed current validation must stop before review");
    assert.ok(events.some((e) => e.type === "tool_result" && !e.result.ok && e.name === (kind === "targeted" ? "run_tests" : "run_linter")));
  } finally { repo.cleanup(); }
});
