/* Run the compiled agent on a disposable repository using real trained weights. */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const path = require("node:path");

const project = path.resolve(__dirname, "..");
const cli = path.join(project, "dist/cli/index.js");
const model = path.join(project, "models/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf");
const engine = process.env.LOCALCODER_LLAMA_SERVER_BIN ||
  path.join(project, "engine/llama-b12241/llama-server");

function runDemo() {
  for (const file of [cli, model, engine]) {
    if (!existsSync(file)) {
      throw new Error(`Missing ${file}. On Apple Silicon, run bash scripts/setup-macos.sh first.`);
    }
  }

  const { createFixtureRepo, FIXTURE_GOAL } = require("../dist/cli/verify-fixture");
  const { AgentStateStore } = require("../dist/agent/state");
  const { entryFromGguf } = require("../dist/inference/gguf");
  const root = createFixtureRepo();
  try {
    const env = { ...process.env, LOCALCODER_HOME: path.join(root, ".localcoder"),
      LOCALCODER_LLAMA_SERVER_BIN: engine, LOCALCODER_BACKEND: "llama" };
    const run = (args) => {
      const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.signal) throw new Error(`Child terminated by ${result.signal}`);
      return result.status;
    };
    const calc = path.join(root, "calc.js");
    const testFile = path.join(root, "calc.test.js");
    const originalCode = readFileSync(calc, "utf8");
    const originalTest = readFileSync(testFile, "utf8");
    const id = entryFromGguf(model).model_id;
    assert.equal(run([cli, "models", "add", model]), 0);
    const checks = ["--test", "calc.test.js"];
    writeFileSync(path.join(root, ".localcoder/agent.json"), JSON.stringify({
      models: { planner: id, coder: id, reviewer: id },
      test: [process.execPath, ...checks],
      test_target: [process.execPath, "--test", "{file}"],
    }));

    console.log("\nBefore the fix, the fixture test should fail.");
    assert.equal(run(checks), 1);
    console.log("\nRun the planner, coder, and reviewer with the live memory gate.");
    assert.equal(run([cli, "agent", FIXTURE_GOAL, "--backend", "llama"]), 0, "Agent task failed");
    const task = new AgentStateStore(root).list().at(-1);
    assert.equal(task?.status, "done");
    assert.equal(task.verification, "full");
    assert.equal(task.review?.approved, true);
    assert.ok(task.edits.length > 0 && task.edits.every((edit) => edit.path === "calc.js"));
    assert.equal(readFileSync(testFile, "utf8"), originalTest, "The model changed the test");
    assert.notEqual(readFileSync(calc, "utf8"), originalCode);
    console.log("\nIndependently rerun the original test.");
    assert.equal(run(checks), 0);
    console.log("\nUndo the task and verify the original files were restored.");
    assert.equal(run([cli, "undo", task.task_id]), 0);
    assert.equal(readFileSync(calc, "utf8"), originalCode);
    assert.equal(readFileSync(testFile, "utf8"), originalTest);
    console.log("\nDemo passed. The trained model fixed the bug, passed review and tests, and undo restored the fixture.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  runDemo();
} catch (error) {
  console.error(`Demo failed. ${error.message}`);
  process.exitCode = 1;
}
