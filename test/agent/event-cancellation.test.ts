import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { makeRepo, makeAgent, ScriptedBackend, fixScript, CALC_BUGGY } from "./helpers";

test("canceling at a tool event boundary prevents the announced edit from executing", async () => {
  const repo = await makeRepo();
  let canceled = false;
  try {
    const agent = makeAgent(repo, new ScriptedBackend(fixScript(false)), { aborted: () => canceled });
    const events = [];
    for await (const event of agent.run({ task: "Fix addition" })) {
      events.push(event);
      if (event.type === "tool_call" && event.name === "apply_patch") canceled = true;
    }
    assert.equal(canceled, true, "test must reach the proposed edit boundary");
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(agent.currentState.status, "interrupted");
    assert.equal(agent.currentState.edits.length, 0);
  } finally { repo.cleanup(); }
});
