import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { runCommand } from "../../src/agent/command-runner";

test("command timeout kills descendants that inherit the captured output pipes", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-command-tree-"));
  const marker = path.join(root, "descendant.pid");
  let descendant: number | undefined;
  try {
    const childScript = "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 4000);";
    const parentScript = "require('child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: 'inherit' }); setInterval(() => {}, 1000);";
    const result = await runCommand([process.execPath, "-e", parentScript, childScript, marker], root, { timeout_ms: 1000, max_bytes: 1000 });
    assert.equal(result.timed_out, true);
    assert.ok(existsSync(marker), "the descendant must start before the timeout");
    descendant = Number(readFileSync(marker, "utf8"));
    assert.ok(result.duration_ms < 2500, `timeout returned after ${result.duration_ms}ms`);
    // Give the OS a moment to reap the killed descendant before checking its PID.
    for (let i = 0; i < 50; i++) {
      try { process.kill(descendant, 0); } catch { descendant = undefined; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(descendant, undefined, "the descendant must stop with the command");
  } finally {
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* already exited */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
