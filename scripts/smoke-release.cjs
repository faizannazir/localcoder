const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cli = path.resolve(process.argv[2], "dist/cli/index.js");
const workspace = mkdtempSync(path.join(os.tmpdir(), "localcoder-smoke-"));
const run = (...args) => execFileSync(process.execPath, [cli, ...args], {
  cwd: workspace,
  env: { ...process.env, LOCALCODER_HOME: path.join(workspace, ".localcoder", "home") },
  encoding: "utf8",
});

try {
  const filename = path.join(workspace, "fixture.txt");
  const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("LocalCoder Café\r\n", "utf16le")]);
  writeFileSync(filename, original);
  assert.match(run("models", "list"), /qwen2\.5-coder-0\.5b-q4/);
  run("index");
  assert.match(run("search", "Café"), /fixture\.txt/);
  const task = run("files", "delete", "fixture.txt").match(/t_[a-z0-9_]+/)?.[0];
  assert.ok(task);
  assert.equal(existsSync(filename), false);
  assert.match(run("undo", task), /restored 1/);
  assert.deepEqual(readFileSync(filename), original);
  console.log("Packaged CLI indexed a workspace and restored the original file bytes.");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
