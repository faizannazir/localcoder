import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync, mkdtempSync, rmSync, statSync, lstatSync, chmodSync } from "fs";
import os from "os";
import path from "path";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import { loadAgentConfig } from "../../src/agent/config";
import { makeRepo, CALC_BUGGY, Repo } from "./helpers";

function rt(repo: Repo, cfg?: object) {
  if (cfg) writeFileSync(path.join(repo.root, ".localcoder", "agent.json"), JSON.stringify(cfg));
  const config = loadAgentConfig(repo.root);
  const tools = new DefaultToolRuntime({ root: repo.root, index: repo.store, indexService: repo.indexService, config });
  const call = (n: string, a: Record<string, unknown> = {}) => tools.invoke(n, a, { workspaceRoot: repo.root });
  return { tools, call };
}

test("read_file returns exact content + hash, supports windows, and is size-bounded", async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line number ${i} with some padding text`).join("\n");
  const repo = await makeRepo({ extra: { "big.txt": big } });
  try {
    const { call } = rt(repo);
    const r = await call("read_file", { path: "calc.js" });
    assert.ok(r.ok);
    assert.equal((r.data as any).content, CALC_BUGGY);
    assert.equal((r.data as any).partial, false);
    const w = await call("read_file", { path: "calc.js", start_line: 2, end_line: 2 });
    assert.equal((w.data as any).content, "  return a - b;");
    assert.equal((w.data as any).partial, true);
    const b = await call("read_file", { path: "big.txt" });
    assert.ok(Buffer.byteLength((b.data as any).content) <= 16_000, "read must be bounded");
    assert.equal(b.truncated, true);
    assert.ok((b.data as any).end_line < (b.data as any).total_lines);
  } finally { repo.cleanup(); }
});

test("list_files, search and find_symbol return compact, bounded, ignore-aware results", async () => {
  const repo = await makeRepo({ extra: { ".env": "SECRET=1\n", "node_modules/x.js": "x", "src/deep.js": "function deepFn() {}\n" } });
  try {
    const { call } = rt(repo);
    const l = await call("list_files", {});
    const files = (l.data as any).files as string[];
    assert.ok(files.includes("calc.js") && files.includes("src/deep.js"));
    assert.ok(!files.some((f) => f.includes(".env") || f.includes("node_modules") || f.includes(".localcoder")));
    assert.ok(l.size_bytes <= 4200);
    const s = await call("search", { query: "return", kind: "text", k: 50 });
    assert.ok((s.data as any).hits.length <= 10, "k is capped");
    assert.ok((s.data as any).hits.every((h: any) => !h.snippet || h.snippet.length <= 240));
    const f = await call("find_symbol", { name: "deepFn" });
    assert.equal((f.data as any).hits[0].path, "src/deep.js");
  } finally { repo.cleanup(); }
});

test("unknown tools and a mismatched sandbox root are refused", async () => {
  const repo = await makeRepo();
  try {
    const { tools } = rt(repo);
    assert.match((await tools.invoke("run_shell", { cmd: "ls" }, { workspaceRoot: repo.root })).error!, /not in the allowlist/);
    assert.match((await tools.invoke("read_file", { path: "calc.js" }, { workspaceRoot: os.tmpdir() })).error!, /does not match/);
  } finally { repo.cleanup(); }
});

test("sandbox: traversal, absolute paths, symlink escapes, secrets, .git and .localcoder are all refused", async () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "lc-outside-"));
  const repo = await makeRepo({ extra: { ".env": "TOKEN=abc\n", ".git/config": "[core]\n", "key.pem": "x" } });
  try {
    writeFileSync(path.join(outside, "loot.txt"), "outside");
    let linked = true;
    try {
      symlinkSync(path.join(outside, "loot.txt"), path.join(repo.root, "link.txt"));
      symlinkSync(outside, path.join(repo.root, "linkdir"));
      symlinkSync(path.join(repo.root, ".env"), path.join(repo.root, "innocent.txt"));
    } catch { linked = false; }
    const { call } = rt(repo);
    for (const p of ["../escape.txt", path.join(outside, "loot.txt"), ".env", "key.pem", ".git/config"]) {
      const r = await call("read_file", { path: p });
      assert.equal(r.ok, false, `read of ${p} must be refused`);
    }
    for (const p of ["../escape.txt", ".env", ".git/hooks/pre-commit", ".localcoder/agent.json", "node_modules/pkg.js"]) {
      const r = await call("write_file", { path: p, content: "x" });
      assert.equal(r.ok, false, `write to ${p} must be refused`);
    }
    assert.ok(!existsSync(path.join(outside, "escape.txt")));
    assert.ok(!existsSync(path.join(repo.root, ".env.new")));
    if (linked) {
      assert.equal((await call("read_file", { path: "link.txt" })).ok, false, "symlink to outside file");
      assert.equal((await call("read_file", { path: "innocent.txt" })).ok, false, "symlink named innocently pointing at .env");
      assert.equal((await call("write_file", { path: "linkdir/new.txt", content: "x" })).ok, false, "new file through symlinked dir");
      assert.ok(!existsSync(path.join(outside, "new.txt")));
    }
    assert.equal(readFileSync(path.join(repo.root, ".env"), "utf8"), "TOKEN=abc\n");
  } finally { repo.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("protected paths reject case variants in tools and repository indexing", async () => {
  const protectedFiles = [".ENV", "SECRET.KEY", "Credentials.JSON", "Secrets.YAML", ".SSH/id_rsa", ".GIT/config", ".LOCALCODER/private.js"];
  const repo = await makeRepo({ extra: Object.fromEntries(protectedFiles.map((file) => [file, "sensitive placeholder"])) });
  try {
    const { call } = rt(repo);
    for (const file of protectedFiles) {
      assert.equal((await call("read_file", { path: file })).ok, false, `read of ${file} must be refused`);
      assert.equal((await call("write_file", { path: file, content: "overwritten", allow_overwrite: true })).ok, false, `write to ${file} must be refused`);
    }
    const files = ((await call("list_files")).data as { files: string[] }).files;
    assert.ok(!files.some((file) => protectedFiles.includes(file)), "listing excludes protected case variants");
    const search = await call("search", { query: "sensitive placeholder" });
    assert.equal((search.data as { count: number }).count, 0, "index excludes protected case variants");
  } finally { repo.cleanup(); }
});

test("write_file creates new files but refuses overwrite without the last-resort flag", async () => {
  const repo = await makeRepo();
  try {
    const { call } = rt(repo);
    assert.ok((await call("write_file", { path: "new/dir/a.js", content: "var a = 1;\n" })).ok);
    const refused = await call("write_file", { path: "calc.js", content: "// rewritten\n" });
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /apply_patch/);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY);
    chmodSync(path.join(repo.root, "calc.js"), 0o755);
    assert.ok((await call("write_file", { path: "calc.js", content: "// rewritten\n", allow_overwrite: true })).ok);
    if (process.platform !== "win32") assert.equal(statSync(path.join(repo.root, "calc.js")).mode & 0o777, 0o755);
    assert.equal((await call("write_file", { path: "huge.txt", content: "x".repeat(600_000) })).ok, false);
  } finally { repo.cleanup(); }
});

test("write_file ignores a pre-existing temporary symlink", async (t) => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "lc-write-outside-"));
  const repo = await makeRepo();
  try {
    const target = path.join(repo.root, "calc.js");
    const outsideFile = path.join(outside, "outside.txt");
    writeFileSync(outsideFile, "outside content");
    try { symlinkSync(outsideFile, `${target}.lc-tmp-${process.pid}`); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
        t.skip("Windows requires Developer Mode or elevated permission to create symlinks");
        return;
      }
      throw error;
    }
    const { call } = rt(repo);
    const result = await call("write_file", { path: "calc.js", content: "// updated\n", allow_overwrite: true });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside content");
    assert.equal(readFileSync(target, "utf8"), "// updated\n");
    assert.equal(lstatSync(target).isSymbolicLink(), false);
  } finally { repo.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("run_tests runs the REAL configured command: reports failure compactly, supports targets, stores output by reference", async () => {
  const repo = await makeRepo();
  try {
    const { call } = rt(repo);
    const full = await call("run_tests", {});
    assert.equal(full.ok, false);
    const d = full.data as any;
    assert.equal(d.passed, false);
    assert.equal(d.exit_code, 1);
    assert.ok(d.summary.length <= 3000 && /not ok|fail/i.test(d.summary));
    assert.ok(existsSync(path.join(repo.root, ".localcoder", "agent", "outputs", `${d.output_ref}.txt`)));
    const targeted = await call("run_tests", { target: "calc.test.js" });
    assert.equal((targeted.data as any).exit_code, 1);
    assert.equal((await call("run_tests", { target: "../outside.test.js" })).ok, false);
    assert.equal((await call("run_tests", { target: "nope.test.js" })).ok, false);
    writeFileSync(path.join(repo.root, "calc.js"), "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
    assert.equal((await call("run_tests", {})).ok, true);
  } finally { repo.cleanup(); }
});

test("run_linter built-in syntax check catches broken JS; unconfigured commands fail cleanly", async () => {
  const repo = await makeRepo({ extra: { "broken.js": "function (\n" } });
  try {
    const { call } = rt(repo, {});
    assert.equal((await call("run_linter", { target: "calc.js" })).ok, true);
    const bad = await call("run_linter", { target: "broken.js" });
    assert.equal(bad.ok, false);
    assert.notEqual((bad.data as any).exit_code, 0);
    assert.match((await call("run_tests", {})).error!, /no test command configured/);
    assert.match((await call("run_build", {})).error!, /no build command configured/);
    assert.match((await call("run_formatter", { target: "calc.js" })).error!, /no formatter configured/);
  } finally { repo.cleanup(); }
});

test("commands run with a stripped environment, redacted output, and a hard timeout", async () => {
  process.env.MY_SECRET_TOKEN = "super-secret-value";
  const repo = await makeRepo();
  try {
    let { call } = rt(repo, { test: ["node", "-e", "console.log('SECRET=' + (process.env.MY_SECRET_TOKEN || 'unset')); console.log('api_key = \"abcdefghijklmnop1234\"')"] });
    const r = await call("run_tests", {});
    const s = (r.data as any).summary as string;
    assert.ok(s.includes("SECRET=unset"), "parent env must not leak into child");
    assert.ok(!s.includes("abcdefghijklmnop1234"), "credential-looking output is redacted");
    ({ call } = rt(repo, { test: ["node", "-e", "setTimeout(() => {}, 20000)"], timeout_ms: 400 }));
    const t = await call("run_tests", {});
    assert.equal(t.ok, false);
    assert.equal((t.data as any).timed_out, true);
  } finally { delete process.env.MY_SECRET_TOKEN; repo.cleanup(); }
});

test("run_formatter edits only the target file and reports journal info; git tools fail cleanly outside a repo", async () => {
  const fmt = "const fs=require('fs');const f=process.argv[2];fs.writeFileSync(f, fs.readFileSync(f,'utf8').replace(/[ \\t]+$/gm,''));";
  const repo = await makeRepo({ extra: { "fmt.js": fmt, "messy.js": "var a = 1;   \nvar b = 2;\t\n" } });
  try {
    const { call } = rt(repo, { format_target: ["node", "fmt.js", "{file}"] });
    const r = await call("run_formatter", { target: "messy.js" });
    assert.ok(r.ok);
    assert.equal(readFileSync(path.join(repo.root, "messy.js"), "utf8"), "var a = 1;\nvar b = 2;\n");
    assert.ok((r.data as any).edit.backup_ref);
    const g = await call("git_status", {});
    assert.equal(g.ok, false);
    assert.equal((await call("git_diff", { path: "../x" })).ok, false);
  } finally { repo.cleanup(); }
});
