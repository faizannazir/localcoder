import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cli = path.join(__dirname, "../../src/cli/index.ts");
const tsx = pathToFileURL(require.resolve("tsx")).href;

test("config commands preserve other project settings and reject invalid values", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-config-"));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, "config", ...args],
    { cwd: root, encoding: "utf8", timeout: 15_000 });
  const file = path.join(root, ".localcoder", "agent.json");
  try {
    mkdirSync(path.dirname(file));
    writeFileSync(file, '{"project_note":"keep me"}');
    writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
    assert.equal(run("path").stdout.trim(), realpathSync(file));
    assert.deepEqual(JSON.parse(run("get", "test").stdout), ["npm", "test", "--silent"]);
    const models = { planner: "small", coder: "large", reviewer: "small" };
    for (const [key, value] of [["models", models], ["timeout_ms", 12000], ["test", ["node", "--test"]]]) {
      const result = run("set", String(key), JSON.stringify(value));
      assert.equal(result.status, 0, result.stderr);
    }
    const snapshot = readFileSync(file, "utf8");
    assert.equal(JSON.parse(snapshot).project_note, "keep me");
    assert.deepEqual(JSON.parse(run("list").stdout), { models, test: ["node", "--test"], timeout_ms: 12000 });
    assert.equal(run("set", "timeout_ms", "-1").status, 1);
    assert.equal(run("set", "models", "{}").status, 1);
    assert.equal(readFileSync(file, "utf8"), snapshot);
    assert.equal(run("unset", "test").status, 0);
    assert.deepEqual(JSON.parse(run("get", "test").stdout), ["npm", "test", "--silent"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
