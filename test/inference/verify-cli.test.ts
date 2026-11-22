import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { buildGguf, qwenLikeKvs } from "./gguf-fixture";

const CLI = path.join(__dirname, "../../src/cli/index.ts");
const TSX = pathToFileURL(require.resolve("tsx")).href;
function run(args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.LOCALCODER_LLAMA_SERVER_BIN;
  env.LOCALCODER_HOME = path.join(cwd, ".localcoder");
  env.PATH = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter); // hermetic: no llama-server on PATH
  return spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
}

test("verify with no llama-server: refuses to pretend — exit code 2, lists exactly what is missing with download names, writes a report", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "lc-verify-"));
  try {
    const report = path.join(d, "r.json");
    const r = run(["verify", "--report", report], d);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /\[MISSING\] llama-server/);
    assert.match(r.stdout, /llama-b<NNNN>-bin-ubuntu-x64\.tar\.gz/);
    assert.match(r.stdout, /CANNOT COMPLETE/);
    const j = JSON.parse(readFileSync(report, "utf8"));
    assert.ok(j.missing.length >= 1);
    assert.ok(j.steps.some((s: any) => s.name === "hardware" && s.status === "pass"));
    assert.ok(!j.steps.some((s: any) => s.name === "chat generation"), "no inference step may be reported without a real server");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("verify --model: a junk file is rejected as not-GGUF; a valid GGUF header is read through the real CLI path", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "lc-verify-"));
  try {
    const junk = path.join(d, "junk.gguf");
    writeFileSync(junk, "this is not a gguf file, it is plain text padding");
    let r = run(["verify", "--model", junk, "--report", path.join(d, "a.json")], d);
    assert.match(r.stdout, /\[FAIL {3}\] model: not a readable GGUF: not a GGUF file/);

    const good = path.join(d, "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf");
    writeFileSync(good, buildGguf(qwenLikeKvs(), { trailing: 2048 }));
    r = run(["verify", "--model", good, "--report", path.join(d, "b.json")], d);
    assert.match(r.stdout, /\[PASS {3}\] model: qwen2\.5-coder-1\.5b-instruct-q4-k-m: 1\.5B Q4_K_M, GGUF v3/);
    assert.match(r.stdout, /layers 28, kv heads 2, head dim 128/);
    assert.equal(r.status, 2, "still cannot complete without llama-server");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("`models add` on a non-GGUF fails cleanly (non-zero, clear message) and `models` still lists the registry", () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "lc-verify-"));
  try {
    const junk = path.join(d, "junk.gguf");
    writeFileSync(junk, "plain text, not a model, padding padding padding");
    const r = run(["models", "add", junk], d);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a GGUF file/);
    const l = run(["models"], d);
    assert.match(l.stdout, /qwen2\.5-coder-1\.5b-q4/);
    assert.doesNotMatch(l.stdout, /qwen3\.5-coder/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
