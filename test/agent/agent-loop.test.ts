import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import type { AgentEvent } from "../../src/types/index";
import { EstimatingTokenCounter } from "../../src/context/token-counter";
import { AgentStateStore, newState } from "../../src/agent/state";
import { hashText, storeBackup } from "../../src/agent/workdir";
import { ScriptedBackend, makeAgent, makeRepo, collect, fixScript, PLAN_JSON, CALC_BUGGY, CALC_FIXED, POLICY, DECISION } from "./helpers";

const types = (evs: AgentEvent[]) => evs.map((e) => e.type);
const calc = (root: string) => readFileSync(path.join(root, "calc.js"), "utf8");
const GOAL = "Fix the add function so the tests pass";

test("a single-model no-change answer still runs configured tests and repairs a failure", async () => {
  const repo = await makeRepo();
  try {
    const backend = new ScriptedBackend((_n, prompt) => {
      if (prompt.includes('"queries"')) return PLAN_JSON;
      if (prompt.includes("## validation_failure")) {
        assert.match(prompt, /return a - b;/, "the repair needs the previously read source");
        return JSON.stringify({ edits: [{ op: "replace", path: "calc.js", old_text: "return a - b;", new_text: "return a + b;" }] });
      }
      return JSON.stringify({ reasoning: "No change needed", no_change_needed: true, edits: [] });
    });
    const events = await collect(makeAgent(repo, backend).run({ task: GOAL }));
    assert.equal(events.find((e) => e.type === "done")?.verification, "full");
    assert.equal(calc(repo.root), CALC_FIXED);
    assert.ok(events.some((e) => e.type === "tool_result" && e.name === "run_tests" && !e.result.ok));
  } finally { repo.cleanup(); }
});

test("end-to-end: real edits, real subprocess tests, test→observe→fix loop, final diff, done(verified)", async () => {
  const repo = await makeRepo();
  try {
    const backend = new ScriptedBackend(fixScript(true));
    const agent = makeAgent(repo, backend);
    const evs = await collect(agent.run({ task: GOAL, session_id: "s1" }));

    assert.equal(calc(repo.root), CALC_FIXED);
    const done = evs[evs.length - 1] as Extract<AgentEvent, { type: "done" }>;
    assert.equal(done.type, "done");
    assert.equal(done.success, true);
    assert.equal(done.verification, "full");
    assert.equal(done.fix_attempts, 1, "the first (wrong) edit must have triggered exactly one fix");

    // observations show the real failure, then a pass
    const obs = evs.filter((e) => e.type === "observation") as Extract<AgentEvent, { type: "observation" }>[];
    assert.ok(obs.some((o) => /targeted test failed/.test(o.content)), "failure was observed");
    assert.ok(obs.some((o) => /targeted tests passed/.test(o.content)), "recovery was observed");

    const diff = evs.find((e) => e.type === "diff") as Extract<AgentEvent, { type: "diff" }>;
    assert.deepEqual(diff.files, ["calc.js"]);
    assert.match(diff.patch, /-  return a - b;/);
    assert.match(diff.patch, /\+  return a \+ b;/);
    assert.equal(backend.prompts.length, 3, "plan + reason + fix = 3 model calls");
  } finally { repo.cleanup(); }
});

test("event ordering: plan first, every tool_call immediately followed by its tool_result, diff before done, done last", async () => {
  const repo = await makeRepo();
  try {
    const evs = await collect(makeAgent(repo, new ScriptedBackend(fixScript(true))).run({ task: GOAL }));
    // Layout/git-status tool calls (phase PLAN) legitimately precede the plan event itself.
    const firstOther = evs.find((e) => e.type !== "tool_call" && e.type !== "tool_result")!;
    assert.equal(firstOther.type, "plan");
    assert.ok(evs.slice(0, evs.indexOf(firstOther)).every((e: any) => e.phase === "PLAN"));
    assert.equal(evs[evs.length - 1].type, "done");
    assert.ok(!types(evs).includes("error"));
    evs.forEach((e, i) => {
      if (e.type === "tool_call") {
        const next = evs[i + 1];
        assert.ok(next && next.type === "tool_result" && next.id === e.id && next.name === e.name, `tool_call ${e.id} not followed by its result`);
      }
    });
    assert.ok(types(evs).indexOf("diff") < types(evs).indexOf("done"));
    assert.deepEqual(new Set(types(evs)), new Set(["plan", "tool_call", "tool_result", "observation", "diff", "done"]));
    // phases appear in state-machine order
    const phases = evs.filter((e) => "phase" in e).map((e: any) => e.phase);
    const firstSeen = ["PLAN", "SEARCH", "READ", "EDIT", "TEST", "OBSERVE", "FIX", "VERIFY"].map((p) => phases.indexOf(p));
    assert.ok(firstSeen.every((i) => i >= 0), `a phase never emitted events: ${firstSeen}`);
    assert.deepEqual([...firstSeen].sort((a, b) => a - b), firstSeen, "phases first appear in state-machine order");
  } finally { repo.cleanup(); }
});

test("smallest validation first: syntax check and the targeted test run before the full suite", async () => {
  const repo = await makeRepo();
  try {
    const evs = await collect(makeAgent(repo, new ScriptedBackend(fixScript(false))).run({ task: GOAL }));
    const calls = evs.filter((e) => e.type === "tool_call") as Extract<AgentEvent, { type: "tool_call" }>[];
    const names = calls.map((c) => `${c.name}${(c.args as any).target ? ":" + (c.args as any).target : ""}`);
    const iLint = names.indexOf("run_linter:calc.js");
    const iTarget = names.indexOf("run_tests:calc.test.js");
    const iFull = names.lastIndexOf("run_tests");
    assert.ok(iLint !== -1 && iTarget > iLint && iFull > iTarget, `unexpected order: ${names.join(", ")}`);
    assert.equal(calls[iFull].args && (calls[iFull].args as any).target, undefined, "the last run_tests is the broad one");
    assert.equal((evs[evs.length - 1] as any).fix_attempts, 0);
  } finally { repo.cleanup(); }
});

test("context reuse/delta: unchanged files are not replayed into the fix prompt; changed files and the diff are", async () => {
  const repo = await makeRepo();
  try {
    const backend = new ScriptedBackend(fixScript(true));
    await collect(makeAgent(repo, backend).run({ task: GOAL }));
    const [plan, reason, fix] = backend.prompts;
    assert.ok(plan.includes("calc.js"), "plan prompt lists the repo layout");
    assert.ok(reason.includes("UTIL_MARKER_LINE"), "util.js was in the reasoning prompt");
    assert.equal(reason.split("return a - b;").length - 1, 1, "the file appears once: bundle delta marker replaces the duplicate");
    assert.ok(!fix.includes("UTIL_MARKER_LINE"), "unchanged util.js must NOT be replayed into the fix prompt");
    assert.match(fix, /util\.js \(unchanged since read/, "but it is listed by reference");
    assert.ok(fix.includes("return a + a;"), "the changed file is re-sent with its new content");
    assert.match(fix, /## changes_so_far[\s\S]*\+  return a \+ a;/, "the delta (diff) is included");
    assert.ok(!fix.includes("## goal\n" + PLAN_JSON), "no earlier model output is replayed");
    assert.ok(fix.split("not ok 1").length <= 2, "failure output appears at most once, as a summary");
  } finally { repo.cleanup(); }
});

test("token budget: every prompt fits the budget (measured with the same counter), large files are truncated not dropped", async () => {
  const bigLines = Array.from({ length: 400 }, (_, i) => `const filler_${i} = "padding padding padding";`).join("\n");
  const repo = await makeRepo({ extra: { "big.js": bigLines } });
  try {
    const backend = new ScriptedBackend((n, p) =>
      p.includes('"queries"') ? JSON.stringify({ plan: ["fix"], queries: ["add"], files: ["calc.js", "calc.test.js", "big.js"] }) : fixScript(true)(n, p));
    const maxCtx = 900, maxOut = 128;
    const agent = makeAgent(repo, backend, { policy: { max_context_tokens: maxCtx }, decision: { max_output_tokens: maxOut } });
    const evs = await collect(agent.run({ task: GOAL }));
    const budget = maxCtx - maxOut - 64;
    const counter = new EstimatingTokenCounter();
    for (const p of backend.prompts) assert.ok((await counter.count(p)).count <= budget, `prompt exceeds budget ${budget}`);
    assert.ok(backend.prompts.some((p) => p.includes("truncated to fit the token budget")), "oversized context is truncated explicitly");
    assert.equal((evs[evs.length - 1] as any).success, true, "agent still completes within a tight budget");
    assert.equal(agent.currentState.token_basis, "estimated");
    assert.ok(agent.currentState.prompt_tokens_total > 0);
  } finally { repo.cleanup(); }
});

test("token budget: a budget too small for even the system prompt + goal stops cleanly with a clear reason", async () => {
  const repo = await makeRepo();
  try {
    for (const maxCtx of [150, 220]) {
      const backend = new ScriptedBackend(fixScript());
      const evs = await collect(makeAgent(repo, backend, { policy: { max_context_tokens: maxCtx }, decision: { max_output_tokens: 128 } }).run({ task: GOAL }));
      const done = evs[evs.length - 1] as any;
      assert.equal(done.type, "done");
      assert.equal(done.success, false);
      assert.match(done.summary, /budget/);
      assert.equal(backend.prompts.length, 0, "no prompt may be sent when it cannot fit");
      assert.equal(calc(repo.root), CALC_BUGGY);
    }
  } finally { repo.cleanup(); }
});

test("resource limits: tool-call cap and wall-clock cap stop the run with done(success=false)", async () => {
  const repo = await makeRepo();
  try {
    let evs = await collect(makeAgent(repo, new ScriptedBackend(fixScript()), { policy: { max_tool_calls: 4 } }).run({ task: GOAL }));
    assert.match((evs[evs.length - 1] as any).summary, /tool call limit reached \(4\)/);
    assert.equal((evs[evs.length - 1] as any).success, false);

    let t = 0;
    evs = await collect(makeAgent(repo, new ScriptedBackend(fixScript()), { policy: { max_agent_wall_seconds: 150 }, now: () => (t += 100_000) }).run({ task: GOAL }));
    assert.match((evs[evs.length - 1] as any).summary, /wall-clock limit/);
  } finally { repo.cleanup(); }
});

test("fix loop is bounded: exhausted attempts and repeated identical failures both stop the run", async () => {
  const repo = await makeRepo();
  try {
    // keeps "fixing" with edits that still fail with the same assertion
    const stuck = (_n: number, p: string) => {
      if (p.includes('"queries"')) return PLAN_JSON;
      const m = calc(repo.root).match(/return (.*);/)![1];
      const next = m === "a - b" ? "a + a" : m + " - 0";
      return JSON.stringify({ reasoning: "try", edits: [{ op: "replace", path: "calc.js", old_text: `return ${m};`, new_text: `return ${next};` }] });
    };
    let evs = await collect(makeAgent(repo, new ScriptedBackend(stuck)).run({ task: GOAL }));
    let done = evs[evs.length - 1] as any;
    assert.equal(done.success, false);
    assert.match(done.summary, /no progress/);
    assert.ok(evs.some((e) => e.type === "observation" && /same failure as observation/.test((e as any).content)));
    assert.ok(done.fix_attempts <= 3);
    assert.ok(evs.some((e) => e.type === "diff"), "changes made so far are reported even on failure");
  } finally { repo.cleanup(); }

  const repo2 = await makeRepo();
  try {
    let k = 0;
    const varied = (_n: number, p: string) => {
      if (p.includes('"queries"')) return PLAN_JSON;
      const m = calc(repo2.root).match(/return (.*);/)![1];
      return JSON.stringify({ reasoning: "try", edits: [{ op: "replace", path: "calc.js", old_text: `return ${m};`, new_text: `return a * ${++k};` }] });
    };
    const evs = await collect(makeAgent(repo2, new ScriptedBackend(varied), { limits: { max_fix_attempts: 1 } }).run({ task: GOAL }));
    assert.match((evs[evs.length - 1] as any).summary, /fix attempts exhausted \(1\)|no progress/);
  } finally { repo2.cleanup(); }
});

test("precision ladder: overwriting an existing file is refused until a targeted edit for it has failed", async () => {
  const repo = await makeRepo();
  try {
    let reasonCalls = 0;
    const script = (_n: number, p: string) => {
      if (p.includes('"queries"')) return PLAN_JSON;
      if (p.includes("## validation_failure")) return JSON.stringify({ reasoning: "x", edits: [] });
      reasonCalls++;
      if (reasonCalls === 1) return JSON.stringify({ reasoning: "rewrite", edits: [{ op: "write", path: "calc.js", content: CALC_FIXED }] });
      return JSON.stringify({ reasoning: "targeted", edits: [{ op: "replace", path: "calc.js", old_text: "return a - b;", new_text: "return a + b;" }] });
    };
    const backend = new ScriptedBackend(script);
    const evs = await collect(makeAgent(repo, backend).run({ task: GOAL }));
    const obs = evs.filter((e) => e.type === "observation").map((e: any) => e.content as string);
    assert.ok(obs.some((o) => /edit rejected for calc\.js: file already exists/.test(o)), "full rewrite of an existing file was rejected first");
    assert.ok(backend.prompts.some((p) => p.includes("## previous_edit_errors") && p.includes("file already exists")), "the model is told why");
    assert.equal(calc(repo.root), CALC_FIXED);
    assert.equal((evs[evs.length - 1] as any).success, true);
  } finally { repo.cleanup(); }

  // last resort: after a failed targeted edit, a full rewrite IS allowed
  const repo2 = await makeRepo();
  try {
    let n = 0;
    const script = (_i: number, p: string) => {
      if (p.includes('"queries"')) return PLAN_JSON;
      n++;
      if (n === 1) return JSON.stringify({ reasoning: "bad anchor", edits: [{ op: "replace", path: "calc.js", old_text: "return a * b;", new_text: "return a + b;" }] });
      return JSON.stringify({ reasoning: "last resort", edits: [{ op: "write", path: "calc.js", content: CALC_FIXED }] });
    };
    const evs = await collect(makeAgent(repo2, new ScriptedBackend(script)).run({ task: GOAL }));
    assert.equal(calc(repo2.root), CALC_FIXED);
    assert.equal((evs[evs.length - 1] as any).success, true);
    const st = new AgentStateStore(repo2.root).latestWithEdits()!;
    assert.equal(st.edits[0].op, "write");
    assert.ok(st.failed_targeted_edit_paths.includes("calc.js"));
  } finally { repo2.cleanup(); }
});

test("model output handling: fenced JSON is accepted; garbage twice yields a recoverable error and a resumable state", async () => {
  const repo = await makeRepo();
  try {
    const fenced = new ScriptedBackend((n, p) => "Sure!\n```json\n" + fixScript(false)(n, p) + "\n```\nDone.");
    assert.equal(((await collect(makeAgent(repo, fenced).run({ task: GOAL }))).pop() as any).success, true);
  } finally { repo.cleanup(); }
  const repo2 = await makeRepo();
  try {
    const garbage = new ScriptedBackend(() => "I think you should just fix it.");
    const evs = await collect(makeAgent(repo2, garbage).run({ task: GOAL }));
    const err = evs[evs.length - 1] as any;
    assert.equal(err.type, "error");
    assert.equal(err.recoverable, true);
    assert.match(err.message, /valid JSON/);
    assert.equal(garbage.prompts.length, 2, "one nudge retry, then stop");
    assert.equal(new AgentStateStore(repo2.root).load(err.task_id).status, "interrupted");
  } finally { repo2.cleanup(); }
});

test("crash recovery: a backend failure mid-task leaves persisted state; a fresh agent resumes (also via 'continue') without redoing edits", async () => {
  const repo = await makeRepo();
  try {
    let crash = true;
    const flaky = new ScriptedBackend((n, p) => {
      if (crash && !p.includes('"queries"')) throw new Error("backend crashed");
      return fixScript(true)(n, p);
    });
    const first = await collect(makeAgent(repo, flaky).run({ task: GOAL, session_id: "rs" }));
    const err = first[first.length - 1] as any;
    assert.equal(err.type, "error");
    assert.equal(err.phase, "REASON");
    const store = new AgentStateStore(repo.root);
    const saved = store.load(err.task_id);
    assert.equal(saved.status, "interrupted");
    assert.equal(saved.phase, "REASON");
    assert.equal(saved.plan.length, 3, "the completed PLAN step survived the crash");
    assert.equal(calc(repo.root), CALC_BUGGY);

    crash = false;
    const resumedBackend = new ScriptedBackend(fixScript(true));
    const second = await collect(makeAgent(repo, resumedBackend).run({ task: "continue" })); // no id: found via latestResumable
    const done = second[second.length - 1] as any;
    assert.equal(done.type, "done");
    assert.equal(done.success, true);
    assert.equal(done.task_id, err.task_id, "same task resumed, not a new one");
    assert.ok(!second.some((e) => e.type === "plan"), "PLAN is not repeated on resume");
    assert.equal(resumedBackend.prompts.length, 2, "only reason + fix were needed after resuming");
    assert.equal(store.load(err.task_id).edits.length, 2);
    assert.equal(calc(repo.root), CALC_FIXED);

    const again = await collect(makeAgent(repo, new ScriptedBackend(fixScript())).run({ task: "x", resume_task_id: err.task_id }));
    assert.match((again[0] as any).message, /already finished/);
  } finally { repo.cleanup(); }
});

test("undo: restores the original content, refreshes the index, is idempotent, and refuses to clobber later user edits", async () => {
  const repo = await makeRepo();
  try {
    const agent = makeAgent(repo, new ScriptedBackend(fixScript(true)));
    const done = (await collect(agent.run({ task: GOAL }))).pop() as any;
    assert.equal(calc(repo.root), CALC_FIXED);

    // user edits the file afterwards -> undo must refuse without force
    writeFileSync(path.join(repo.root, "calc.js"), CALC_FIXED + "// user change\n");
    const conflict = await makeAgent(repo, new ScriptedBackend(() => "")).undo(done.task_id);
    assert.ok(conflict.conflicts.length >= 1);
    assert.match(calc(repo.root), /user change/);

    const forced = await makeAgent(repo, new ScriptedBackend(() => "")).undo(done.task_id, { force: true });
    assert.deepEqual(forced.restored.filter((p) => p === "calc.js").length >= 1, true);
    assert.equal(calc(repo.root), CALC_BUGGY, "force walks the whole journal back to the original");
    assert.equal((await repo.store.getFile("calc.js"))!.content, CALC_BUGGY, "index reflects the undo");
    assert.equal((await makeAgent(repo, new ScriptedBackend(() => "")).undo(done.task_id)).already_undone, true);
  } finally { repo.cleanup(); }

  const repo2 = await makeRepo({ buggy: false });
  try {
    const script = (_n: number, p: string) =>
      p.includes('"queries"') ? PLAN_JSON : JSON.stringify({ reasoning: "add doc", edits: [{ op: "write", path: "docs/NOTE.md", content: "# note\n" }] });
    const done = (await collect(makeAgent(repo2, new ScriptedBackend(script)).run({ task: "add a note" }))).pop() as any;
    assert.equal(done.success, true);
    assert.ok(existsSync(path.join(repo2.root, "docs", "NOTE.md")));
    const u = await makeAgent(repo2, new ScriptedBackend(() => "")).undo(done.task_id);
    assert.deepEqual(u.deleted, ["docs/NOTE.md"]);
    assert.ok(!existsSync(path.join(repo2.root, "docs", "NOTE.md")));
    assert.equal(await repo2.store.getFile("docs/NOTE.md"), null);
  } finally { repo2.cleanup(); }
});

test("undo: retries a partial rollback without conflicting with files already restored or touching later user changes", async () => {
  const repo = await makeRepo();
  try {
    const store = new AgentStateStore(repo.root);
    const state = newState("partial undo", "undo-test");
    for (const name of ["calc.js", "util.js"]) {
      const original = readFileSync(path.join(repo.root, name), "utf8");
      state.edits.push({ path: name, op: "replace", before_hash: hashText(original), after_hash: hashText("agent edit"), backup_ref: storeBackup(repo.root, original), step: state.edits.length });
      writeFileSync(path.join(repo.root, name), "agent edit");
    }
    store.save(state); // an older state has no per-edit undo progress
    writeFileSync(path.join(repo.root, "calc.js"), "user conflict");
    const undo = () => makeAgent(repo, new ScriptedBackend(() => "")).undo(state.task_id);
    const first = await undo();
    assert.deepEqual(first.restored, ["util.js"]);
    assert.deepEqual(first.conflicts.map((c) => c.path), ["calc.js"]);
    writeFileSync(path.join(repo.root, "util.js"), "user change after rollback");
    writeFileSync(path.join(repo.root, "calc.js"), "agent edit");
    const retry = await undo();
    assert.deepEqual(retry.conflicts, []);
    assert.deepEqual(retry.restored, ["calc.js"]);
    assert.equal(calc(repo.root), CALC_BUGGY);
    assert.equal(readFileSync(path.join(repo.root, "util.js"), "utf8"), "user change after rollback");
    assert.equal((await undo()).already_undone, true);
  } finally { repo.cleanup(); }
});

test("undo: a conflict in the newest edit prevents older edits to the same file from running", async () => {
  const repo = await makeRepo();
  try {
    const store = new AgentStateStore(repo.root);
    const state = newState("same file undo", "undo-test");
    const middle = "intermediate edit";
    state.edits = [
      { path: "calc.js", op: "replace", before_hash: hashText(CALC_BUGGY), after_hash: hashText(middle), backup_ref: storeBackup(repo.root, CALC_BUGGY), step: 1 },
      { path: "calc.js", op: "replace", before_hash: hashText(middle), after_hash: hashText(CALC_FIXED), backup_ref: storeBackup(repo.root, middle), step: 2 },
    ];
    store.save(state);
    // This matches the older record's after hash, but the newer edit still conflicts.
    writeFileSync(path.join(repo.root, "calc.js"), middle);
    const first = await makeAgent(repo, new ScriptedBackend(() => "")).undo(state.task_id);
    assert.equal(first.conflicts.length, 1);
    assert.equal(calc(repo.root), middle);
    writeFileSync(path.join(repo.root, "calc.js"), CALC_FIXED);
    const retry = await makeAgent(repo, new ScriptedBackend(() => "")).undo(state.task_id);
    assert.deepEqual(retry.conflicts, []);
    assert.equal(calc(repo.root), CALC_BUGGY);
  } finally { repo.cleanup(); }
});

test("undo: resumes index refresh after a restored file without repeating its disk edit", async () => {
  const repo = await makeRepo();
  try {
    const store = new AgentStateStore(repo.root);
    const state = newState("index failure undo", "undo-test");
    state.edits = [{ path: "calc.js", op: "replace", before_hash: hashText(CALC_BUGGY), after_hash: hashText(CALC_FIXED), backup_ref: storeBackup(repo.root, CALC_BUGGY), step: 1 }];
    store.save(state);
    writeFileSync(path.join(repo.root, "calc.js"), CALC_FIXED);
    const original = repo.indexService.handleEvent.bind(repo.indexService);
    repo.indexService.handleEvent = async () => { throw new Error("index temporarily unavailable"); };
    const first = await makeAgent(repo, new ScriptedBackend(() => "")).undo(state.task_id);
    assert.equal(first.conflicts.length, 1);
    assert.equal(calc(repo.root), CALC_BUGGY);
    repo.indexService.handleEvent = original;
    const retry = await makeAgent(repo, new ScriptedBackend(() => "")).undo(state.task_id);
    assert.deepEqual(retry.conflicts, []);
    assert.equal((await repo.store.getFile("calc.js"))!.content, CALC_BUGGY);
    assert.equal(store.load(state.task_id).undone, true);
  } finally { repo.cleanup(); }
});

test("memory persistence: completion writes a compact session summary + task record (never transcripts or file contents)", async () => {
  const repo = await makeRepo();
  try {
    const agent = makeAgent(repo, new ScriptedBackend(fixScript(true)));
    await collect(agent.run({ task: GOAL, session_id: "sess-1" }));
    const chat = repo.memory.getChatSummary("sess-1")!;
    assert.ok(chat, "cross-chat memory is now actually written");
    assert.ok(chat.summary.includes("Fix the add function"));
    assert.ok(chat.referenced_files.includes("calc.js"));
    assert.ok(chat.summary.length <= 1200);
    assert.ok(!chat.summary.includes("module.exports"), "no file contents in the summary");
    assert.equal(repo.memory.getActiveTask(), null, "the completed task is no longer active");
    const task = repo.memory.getTask(agent.currentState.memory_task_id!)!;
    assert.equal(task.status, "done");
    assert.ok(task.decisions.length >= 2);
    assert.ok(task.related_files.includes("calc.js"));

    // a later task in the same session appends rather than replaces, and sees prior memory in its plan prompt
    const b2 = new ScriptedBackend((n, p) => (p.includes('"queries"') ? PLAN_JSON : JSON.stringify({ reasoning: "nothing to do", no_change_needed: true, edits: [] })));
    const evs = await collect(makeAgent(repo, b2).run({ task: "Explain add()", session_id: "sess-1" }));
    assert.equal((evs[evs.length - 1] as any).success, true);
    assert.ok(b2.prompts[0].includes("prior conversation summary") || b2.prompts[0].includes("Fix the add function"), "plan prompt reuses the stored summary instead of replaying a chat");
    assert.match(repo.memory.getChatSummary("sess-1")!.summary, /Fix the add function[\s\S]*Explain add/);
  } finally { repo.cleanup(); }
});

test("a failed run still reports its diff and marks the task abandoned; secrets in goals are never persisted to memory", async () => {
  const repo = await makeRepo();
  try {
    const agent = makeAgent(repo, new ScriptedBackend(fixScript()), { policy: { max_tool_calls: 12 } });
    const evs = await collect(agent.run({ task: GOAL + ' with api_key = "sk-abcdefghijklmnopqrstuvwxyz1234"', session_id: "sec" }));
    assert.equal(agent.currentState.memory_task_id, null, "secret-looking goal must not be written to memory");
    assert.ok(agent.currentState.warnings.some((w) => /memory/.test(w)));
    assert.ok(!JSON.stringify(repo.memory.listMemory({ includeStale: true })).includes("sk-abcdefghijkl"));
    assert.ok(evs.length > 0);
  } finally { repo.cleanup(); }
});
