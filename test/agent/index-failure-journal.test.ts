import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { makeRepo, makeAgent, ScriptedBackend, fixScript, CALC_BUGGY, collect } from "./helpers";

for (const formatting of [false, true]) test(`index refresh failure preserves ${formatting ? "formatter and edit" : "edit"} journal and undo`, async () => {
  const repo = await makeRepo({ config: {
    test: [process.execPath, "--test"], test_target: [process.execPath, "--test", "{file}"],
    ...(formatting ? { format_target: [process.execPath, "-e", "const fs=require('fs'),p=process.argv[1];fs.appendFileSync(p,'// formatted\\n');", "{file}"] } : {}),
  } });
  const refresh = repo.indexService.handleEvent.bind(repo.indexService);
  try {
    repo.indexService.handleEvent = async () => { throw new Error("index temporarily unavailable"); };
    const agent = makeAgent(repo, new ScriptedBackend(fixScript(false)));
    const events = await collect(agent.run({ task: "Fix addition" }));
    assert.equal(agent.currentState.edits.length, formatting ? 2 : 1, "successful disk changes must retain rollback metadata");
    assert.equal(events.find((e) => e.type === "done")?.success, true);
    assert.ok(agent.currentState.warnings.some((warning) => /index.*failed/i.test(warning)));
    repo.indexService.handleEvent = refresh;
    const undo = await agent.undo(agent.currentState.task_id);
    assert.deepEqual(undo.conflicts, []);
    assert.deepEqual(undo.restored, ["calc.js"]);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY);
  } finally { repo.cleanup(); }
});
