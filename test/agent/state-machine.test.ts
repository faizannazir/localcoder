import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "fs";
import os from "os";
import path from "path";
import { AgentPhase, AgentStateStore, TRANSITIONS, newState, transition, isTerminal } from "../../src/agent/state";

test("the happy path PLAN→SEARCH→READ→REASON→EDIT→TEST→OBSERVE→VERIFY→DONE is legal", () => {
  const s = newState("g", "sess");
  for (const p of ["SEARCH", "READ", "REASON", "EDIT", "TEST", "OBSERVE", "VERIFY", "DONE"] as AgentPhase[]) transition(s, p);
  assert.equal(s.phase, "DONE");
  assert.ok(isTerminal(s.phase));
});

test("the fix loop OBSERVE→FIX→TEST→OBSERVE and VERIFY→FIX are legal; skipping steps is not", () => {
  const s = newState("g", "sess");
  for (const p of ["SEARCH", "READ", "REASON", "EDIT", "TEST", "OBSERVE", "FIX", "TEST", "OBSERVE", "VERIFY", "FIX"] as AgentPhase[]) transition(s, p);
  assert.equal(s.phase, "FIX");
  assert.throws(() => transition(newState("g", "s"), "EDIT"), /Illegal agent transition PLAN -> EDIT/);
  const t = newState("g", "s"); transition(t, "SEARCH"); transition(t, "READ"); transition(t, "REASON");
  assert.throws(() => transition(t, "TEST"), /Illegal/);
});

test("every non-terminal phase may fail; terminal phases accept nothing", () => {
  for (const [phase, next] of Object.entries(TRANSITIONS) as [AgentPhase, AgentPhase[]][]) {
    if (phase === "DONE" || phase === "FAILED") assert.deepEqual(next, []);
    else assert.ok(next.includes("FAILED"), `${phase} must be able to fail`);
  }
  const s = newState("g", "s"); transition(s, "FAILED");
  assert.throws(() => transition(s, "PLAN"), /Illegal/);
});

test("state serializes atomically, round-trips, rejects bad ids, and finds resumable tasks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-state-"));
  try {
    const store = new AgentStateStore(root);
    const s = newState("goal", "sess");
    transition(s, "SEARCH");
    s.edits.push({ path: "a.js", op: "replace", before_hash: "x", after_hash: "y", backup_ref: null, step: 1 });
    store.save(s);
    assert.deepEqual(store.load(s.task_id), JSON.parse(JSON.stringify(s)));
    assert.ok(readdirSync(path.join(root, ".localcoder", "agent", "state")).every((n) => !n.endsWith(".tmp")), "no torn temp file left behind");
    assert.throws(() => store.load("../../etc/passwd"), /invalid task id/);
    assert.equal(store.latestResumable()?.task_id, s.task_id);
    s.status = "done"; store.save(s);
    assert.equal(store.latestResumable(), null);
    assert.equal(store.latestWithEdits()?.task_id, s.task_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
