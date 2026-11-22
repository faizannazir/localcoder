import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONTROL_TOKEN_ENV } from "../../src/cli/background-server";

const cli = path.join(__dirname, "../../src/cli/index.ts");
const tsx = pathToFileURL(require.resolve("tsx")).href;

test("managed servers require private control and restart with the same port and workspace", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "localcoder-server-home-"));
  const workspace = mkdtempSync(path.join(os.tmpdir(), "localcoder-workspace-"));
  const env = { ...process.env, LOCALCODER_HOME: home, LOCALCODER_API_TOKEN: "test-api-token" };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], {
      cwd: args[0] === "start" && args.includes("--port") ? workspace : home, env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  try {
    const started = run("start", "--port", "0", "--backend", "mock");
    const [, port, pid] = /127\.0\.0\.1:(\d+) \(PID (\d+)\)/.exec(started) ?? [];
    assert.ok(port && pid, started);
    assert.match(run("status"), /Workspace: .*localcoder-workspace-/);
    const base = `http://127.0.0.1:${port}`;
    const ordinaryAuth = { Authorization: "Bearer test-api-token", "Content-Type": "application/json" };
    assert.equal((await fetch(base + "/internal/server", { method: "POST", headers: ordinaryAuth })).status, 401);
    assert.equal((await fetch(base + "/v1/models", { headers: ordinaryAuth })).status, 200);
    const restarted = run("restart");
    assert.match(restarted, new RegExp(`127\\.0\\.0\\.1:${port} \\(PID \\d+\\)`));
    assert.doesNotMatch(restarted, new RegExp(`PID ${pid}\\)`));
    assert.match(run("status"), /Workspace: .*localcoder-workspace-/);
    const statePath = path.join(home, "server.json");
    const savedState = readFileSync(statePath, "utf8");
    if (process.platform !== "win32") assert.equal(statSync(statePath).mode & 0o077, 0);
    assert.match(run("stop"), /LocalCoder stopped/);
    assert.match(run("status"), /No managed LocalCoder server/);
    await assert.rejects(fetch(base + "/v1/models", { headers: ordinaryAuth }));
    writeFileSync(statePath, savedState, { mode: 0o600 });
    const stale = spawnSync(process.execPath, ["--import", tsx, cli, "models", "ps"], { cwd: home, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /managed server did not respond.*--port explicitly/);
  } finally {
    spawnSync(process.execPath, ["--import", tsx, cli, "stop"], { env, cwd: home, timeout: 30_000 });
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a managed child exits if the launcher disconnects before registration", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "localcoder-unregistered-"));
  const child = fork(cli, ["serve", "--port", "0", "--backend", "mock"], {
    cwd: workspace, execArgv: ["--import", tsx],
    env: { ...process.env, [CONTROL_TOKEN_ENV]: "test-control-token" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const budget = AbortSignal.timeout(15_000);
    const exited = once(child, "exit", { signal: budget });
    const [message] = await once(child, "message", { signal: budget });
    assert.equal(typeof message.port, "number");
    child.disconnect();
    assert.deepEqual(await exited, [0, null]);
    await assert.rejects(fetch(`http://127.0.0.1:${message.port}/v1/models`));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(workspace, { recursive: true, force: true });
  }
});
