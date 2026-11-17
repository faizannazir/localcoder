import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { CodingAgent, AgentDeps } from "../../src/agent/coding-agent";
import { AgentStateStore } from "../../src/agent/state";
import { loadAgentConfig, ModelRole } from "../../src/agent/config";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import type { AgentModelWorkflow } from "../../src/agent/model-workflow";
import { BackendTokenCounter } from "../../src/context/token-counter";
import { makeRepo, Repo, ScriptedBackend, POLICY, DECISION, PLAN_JSON, collect } from "./helpers";

const models = { planner: "plan", coder: "code", reviewer: "review" };
const edit = (old_text: string, new_text: string) => JSON.stringify({ reasoning: "Fix addition and document its behavior", edits: [{ op: "replace", path: "calc.js", old_text, new_text }] });
const approved = JSON.stringify({ approved: true, summary: "Goal implemented and tests passed", findings: [] });
const rejected = JSON.stringify({ approved: false, summary: "Missing requested documentation", findings: [{ path: "calc.js", line: 1, message: "Add a comment describing addition" }] });
function setup(repo: Repo, reply: (role: ModelRole, prompt: string) => string, opts: Partial<AgentDeps> = {}) {
  const roles: ModelRole[] = [];
  const prompts: { role: ModelRole; text: string }[] = [];
  let live = 0;
  const workflow: AgentModelWorkflow = {
    models,
    async withRole(role, operation) {
      roles.push(role); live++;
      const backend = new ScriptedBackend((_n, prompt) => { prompts.push({ role, text: prompt }); return reply(role, prompt); });
      try { return await operation({ backend, policy: POLICY, decision: { ...DECISION, model_id: models[role], ctx_window: role === "coder" ? 4096 : 8192 }, tokenCounter: new BackendTokenCounter(backend) }); }
      finally { live--; }
    },
  };
  const config = loadAgentConfig(repo.root);
  const agent = new CodingAgent({ root: repo.root, index: repo.store, memory: repo.memory, indexService: repo.indexService,
    tools: new DefaultToolRuntime({ root: repo.root, index: repo.store, indexService: repo.indexService, config }),
    policy: POLICY, decision: DECISION, stateStore: new AgentStateStore(repo.root), config, modelWorkflow: workflow, ...opts });
  return { agent, roles, prompts, live: () => live };
}

test("workflow plans, edits, runs real tests, reviews, repairs review findings and reviews again", async () => {
  const repo = await makeRepo();
  try {
    let reviews = 0;
    const s = setup(repo, (role, prompt) => {
      if (role === "planner") return PLAN_JSON;
      if (role === "reviewer") {
        assert.match(prompt, /Verification: full/);
        assert.match(prompt, /return a \+ b/);
        return ++reviews === 1 ? rejected : approved;
      }
      return prompt.includes("review rejected") ? edit("function add(a, b)", "// Add two numbers.\nfunction add(a, b)") : edit("return a - b;", "return a + b;");
    });
    const events = await collect(s.agent.run({ task: "Fix add and document it" }));
    const done = events.find((e) => e.type === "done");
    assert.ok(done?.success, JSON.stringify(events.at(-1)));
    assert.deepEqual(s.roles, ["planner", "coder", "reviewer", "coder", "reviewer"]);
    assert.match(readFileSync(path.join(repo.root, "calc.js"), "utf8"), /Add two numbers/);
    assert.equal(s.agent.currentState.fix_attempts, 1);
    assert.equal(s.agent.currentState.review?.approved, true);
    assert.equal(events.filter((e) => e.type === "tool_result" && e.name === "run_tests" && e.result.ok).length >= 4, true);
    assert.equal(s.live(), 0);
    assert.deepEqual(events.filter((e) => e.type === "model").map((e) => e.role), s.roles);
  } finally { repo.cleanup(); }
});

test("no-change workflow still runs the configured full suite and obtains review approval", async () => {
  const repo = await makeRepo({ buggy: false });
  try {
    const s = setup(repo, (role) => role === "planner" ? PLAN_JSON : role === "reviewer" ? approved : JSON.stringify({ reasoning: "Already correct", no_change_needed: true, edits: [] }));
    const events = await collect(s.agent.run({ task: "Check add" }));
    assert.ok(events.find((e) => e.type === "done")?.success);
    assert.deepEqual(s.roles, ["planner", "coder", "reviewer"]);
    assert.equal(s.agent.currentState.verification, "full");
    assert.equal(s.agent.currentState.edits.length, 0);
    assert.equal(s.live(), 0);
  } finally { repo.cleanup(); }
});

test("failing full suite cannot reach reviewer approval even when targeted tests pass", async () => {
  const repo = await makeRepo({ extra: { "unrelated.test.js": 'const test=require("node:test");test("fails",()=>{throw Error("unfixed issue")});' } });
  try {
    const s = setup(repo, (role, prompt) => role === "planner" ? PLAN_JSON : role === "reviewer" ? approved : prompt.includes("validation_failure") ? JSON.stringify({ reasoning: "No repair", edits: [] }) : edit("return a - b;", "return a + b;"), { limits: { max_fix_attempts: 1 } });
    const events = await collect(s.agent.run({ task: "Fix add" }));
    assert.equal(events.find((e) => e.type === "done")?.success, false);
    assert.equal(s.roles.includes("reviewer"), false);
    assert.match(s.agent.currentState.validation!.summary, /full test run failed/);
    assert.equal(s.live(), 0);
  } finally { repo.cleanup(); }
});

test("contradictory review interrupts after bounded retries and resumes saved review roles", async () => {
  const repo = await makeRepo();
  try {
    const s = setup(repo, (role) => role === "planner" ? PLAN_JSON : role === "reviewer" ? JSON.stringify({ approved: true, summary: "Contradiction", findings: [{ path: "calc.js", message: "Still broken" }] }) : edit("return a - b;", "return a + b;"));
    const events = await collect(s.agent.run({ task: "Fix add" }));
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(s.agent.currentState.phase, "REVIEW");
    assert.equal(s.agent.currentState.status, "interrupted");
    assert.equal(s.prompts.filter((p) => p.role === "reviewer").length, 2);
    assert.equal(s.live(), 0);
    const taskId = s.agent.currentState.task_id;
    const resumed = setup(repo, (role) => { assert.equal(role, "reviewer"); return approved; });
    const resumedEvents = await collect(resumed.agent.run({ task: "continue", resume_task_id: taskId }));
    assert.ok(resumedEvents.find((e) => e.type === "done")?.success);
    assert.deepEqual(resumed.roles, ["reviewer"]);
    assert.equal(resumedEvents.filter((e) => e.type === "tool_result" && e.name === "run_tests").length, 1, "review resume reruns the full suite against the current workspace");
    assert.deepEqual(resumed.agent.currentState.models, models);
    assert.equal(resumed.agent.currentState.edits.length, 1, "does not repeat applied edits");
  } finally { repo.cleanup(); }
});

test("canceling review releases its role backend and preserves resumable REVIEW state", async () => {
  const repo = await makeRepo();
  try {
    const abort = new AbortController();
    const s = setup(repo, (role) => {
      if (role === "planner") return PLAN_JSON;
      if (role === "reviewer") { abort.abort(); return approved; }
      return edit("return a - b;", "return a + b;");
    }, { signal: abort.signal });
    const events = await collect(s.agent.run({ task: "Fix add" }));
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(s.agent.currentState.phase, "REVIEW");
    assert.equal(s.agent.currentState.status, "interrupted");
    assert.equal(s.agent.currentState.review, undefined);
    assert.equal(s.live(), 0);
  } finally { repo.cleanup(); }
});

test("review rejection consumes the repair limit and cannot approve by skipping findings", async () => {
  const repo = await makeRepo();
  try {
    const s = setup(repo, (role) => role === "planner" ? PLAN_JSON : role === "reviewer" ? rejected : edit("return a - b;", "return a + b;"), { limits: { max_fix_attempts: 0 } });
    const events = await collect(s.agent.run({ task: "Fix add and document it" }));
    assert.equal(events.find((e) => e.type === "done")?.success, false);
    assert.equal(s.agent.currentState.review?.approved, false);
    assert.match(s.agent.currentState.error!, /fix attempts exhausted/);
  } finally { repo.cleanup(); }
});

test("saved workflow cannot silently resume without its model provider", async () => {
  const repo = await makeRepo();
  try {
    const s = setup(repo, (role) => role === "planner" ? PLAN_JSON : role === "reviewer" ? "invalid" : edit("return a - b;", "return a + b;"));
    await collect(s.agent.run({ task: "Fix add" }));
    const backend = new ScriptedBackend(() => approved);
    const { agent: legacy } = setup(repo, () => approved, { modelWorkflow: undefined, backend, tokenCounter: new BackendTokenCounter(backend) });
    const events = await collect(legacy.run({ task: "continue", resume_task_id: s.agent.currentState.task_id }));
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(legacy.currentState.status, "interrupted");
    assert.match(legacy.currentState.error!, /saved model workflow does not match/);
    assert.equal(backend.prompts.length, 0);
  } finally { repo.cleanup(); }
});

test("role prompt fitting uses each loaded tokenizer and context without using an unloaded backend", async () => {
  const repo = await makeRepo({ buggy: false });
  try {
    const checked: ModelRole[] = [];
    const workflow: AgentModelWorkflow = {
      models,
      async withRole(role, operation) {
        let active = true;
        const divisor = role === "coder" ? 1 : role === "reviewer" ? 2 : 4;
        const ctx = role === "coder" ? 2048 : 8192;
        const backend = new ScriptedBackend((_n, prompt) => {
          assert.ok(Math.ceil(prompt.length / divisor) <= ctx - DECISION.max_output_tokens - 64, `${role} prompt must fit its own tokenizer/context`);
          checked.push(role);
          return role === "planner" ? PLAN_JSON : role === "reviewer" ? approved : JSON.stringify({ reasoning: "Already correct", no_change_needed: true, edits: [] });
        });
        backend.countTokens = async (text) => { assert.equal(active, true, "tokenizer cannot be used after role release"); return Math.ceil(text.length / divisor); };
        try { return await operation({ backend, tokenCounter: new BackendTokenCounter(backend), policy: POLICY, decision: { ...DECISION, model_id: models[role], ctx_window: ctx } }); }
        finally { active = false; }
      },
    };
    const s = setup(repo, () => { throw new Error("legacy backend must not run"); }, { modelWorkflow: workflow });
    const events = await collect(s.agent.run({ task: "Check add" }));
    assert.ok(events.find((e) => e.type === "done")?.success, JSON.stringify(events.at(-1)));
    assert.deepEqual(checked, ["planner", "coder", "reviewer"]);
    assert.equal(s.agent.currentState.token_basis, "measured");
  } finally { repo.cleanup(); }
});
