import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { applyUnifiedPatch, unifiedDiff, diffStats } from "../../src/agent/unified-diff";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import { loadAgentConfig } from "../../src/agent/config";
import { loadBackup, loadBackupBytes, hashBytes, hashText } from "../../src/agent/workdir";
import { makeRepo, makeAgent, ScriptedBackend, collect, CALC_BUGGY } from "./helpers";

const A = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

test("unified patch: applies by content (wrong line numbers are fine), preserves CRLF", () => {
  const patch = "--- a/f\n+++ b/f\n@@ -99,3 +99,3 @@\n three\n-four\n+FOUR\n five\n";
  const r = applyUnifiedPatch(A, patch);
  assert.ok(r.ok && r.content === A.replace("four", "FOUR"));
  const crlf = applyUnifiedPatch(A.replace(/\n/g, "\r\n"), patch);
  assert.ok(crlf.ok && crlf.content === A.replace("four", "FOUR").replace(/\n/g, "\r\n"));
});

test("unified patch: refuses mismatched, ambiguous, empty and malformed patches", () => {
  const mismatch = applyUnifiedPatch(A, "@@ -1,1 +1,1 @@\n-nothere\n+x\n");
  assert.ok(!mismatch.ok && /does not match/.test(mismatch.error));
  const amb = applyUnifiedPatch("x\ny\nx\ny\n", "@@ -1,2 +1,2 @@\n-y\n+z\n");
  assert.ok(!amb.ok && /matches 2 places/.test(amb.error));
  assert.ok(!applyUnifiedPatch(A, "just words").ok);
  assert.ok(!applyUnifiedPatch(A, "@@ -1 +1 @@\n+only an insertion\n").ok);
  assert.ok(!applyUnifiedPatch(A, "@@ -1 +1 @@\n?weird\n").ok);
});

test("unifiedDiff output round-trips through applyUnifiedPatch for varied edits", () => {
  const cases: [string, string][] = [
    [A, A.replace("three", "3")],
    [A, A + "eight\n"],
    [A, A.split("\n").filter((l) => l !== "five").join("\n")],
    [A, "completely\ndifferent\n"],
    ["a\n", "a\nb\nc\n"],
  ];
  for (const [a, b] of cases) {
    const r = applyUnifiedPatch(a, unifiedDiff(a, b, "f.txt"));
    assert.ok(r.ok && r.content === b, `round trip failed for ${JSON.stringify(b)}`);
  }
  assert.equal(unifiedDiff(A, A, "f"), "");
  assert.deepEqual(diffStats(unifiedDiff(A, A.replace("two", "2"), "f")), { added: 1, removed: 1 });
});

test("apply_patch: exact-once replacement, ambiguity/missing/no-op refusals, stale-hash protection, journal + index refresh", async () => {
  const repo = await makeRepo({ extra: { "dup.js": "x();\nx();\n" } });
  try {
    const config = loadAgentConfig(repo.root);
    const tools = new DefaultToolRuntime({ root: repo.root, index: repo.store, indexService: repo.indexService, config });
    const call = (a: Record<string, unknown>) => tools.invoke("apply_patch", a, { workspaceRoot: repo.root });

    assert.match((await call({ path: "dup.js", old_text: "x();", new_text: "y();" })).error!, /matches 2 places/);
    assert.match((await call({ path: "calc.js", old_text: "nonexistent", new_text: "y" })).error!, /not found/);
    assert.match((await call({ path: "calc.js", old_text: "return a - b;", new_text: "return a - b;" })).error!, /no change/);
    assert.match((await call({ path: "missing.js", old_text: "a", new_text: "b" })).error!, /does not exist/);
    assert.match((await call({ path: "calc.js" })).error!, /provide either/);
    assert.match((await call({ path: "calc.js", old_text: "return a - b;", new_text: "return a + b;", expected_hash: "0".repeat(64) })).error!, /changed on disk/);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_BUGGY, "refused edits leave the file untouched");

    const ok = await call({ path: "calc.js", old_text: "return a - b;", new_text: "return a + b;", expected_hash: hashText(CALC_BUGGY) });
    assert.ok(ok.ok);
    const d = ok.data as any;
    assert.equal(d.lines_added, 1); assert.equal(d.lines_removed, 1);
    assert.equal(loadBackup(repo.root, d.backup_ref), CALC_BUGGY, "backup holds the pre-edit content");
    assert.equal((await repo.store.getFile("calc.js"))!.content_hash, d.after_hash, "index refreshed after the edit");
    assert.ok(!existsSync(path.join(repo.root, "calc.js.lc-tmp-" + process.pid)), "no temp file left behind");

    const viaPatch = await call({ path: "calc.js", patch: "@@ -1,3 +1,3 @@\n function add(a, b) {\n-  return a + b;\n+  return b + a;\n }\n" });
    assert.ok(viaPatch.ok);
    assert.match(readFileSync(path.join(repo.root, "calc.js"), "utf8"), /return b \+ a;/);
  } finally { repo.cleanup(); }
});

test("workspace edits and deletion preserve BOM, UTF-16 byte order, line endings, and exact undo bytes", async () => {
  const repo = await makeRepo({ buggy: false });
  const root = repo.root;
  const encode = [
    (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]),
  ];
  try {
    const tools = new DefaultToolRuntime({ root, index: repo.store, indexService: repo.indexService, config: {} });
    for (const [i, encoding] of encode.entries()) {
      const name = `note-${i}.txt`;
      const abs = path.join(root, name);
      const before = encoding("café 😀\r\nold\r\n");
      const after = encoding("café 😀\r\nnew\r\nvalue\r\n");
      writeFileSync(abs, before);
      const view = await tools.invoke("read_file", { path: name }, { workspaceRoot: root });
      assert.ok(view.ok);
      assert.equal((view.data as { hash: string }).hash, hashBytes(before));

      const backend = new ScriptedBackend((_n, p) => p.includes('"queries"')
        ? JSON.stringify({ plan: ["Update the note"], files: [name], queries: [] })
        : JSON.stringify({ edits: [{ op: "replace", path: name, old_text: "old\n", new_text: "new\nvalue\n" }] }));
      const agent = makeAgent(repo, backend);
      assert.ok((await collect(agent.run({ task: `Update ${name}` }))).find((e) => e.type === "done")?.success);
      assert.deepEqual(readFileSync(abs), after);
      const task = agent.currentState;
      assert.deepEqual(loadBackupBytes(root, task.edits[0].backup_ref!), before);
      assert.equal((await repo.store.getFile(name))?.content_hash, hashBytes(after));

      writeFileSync(abs, "café 😀\r\nnew\r\nvalue\r\n"); // identical text with different bytes
      assert.equal((await agent.undo(task.task_id)).conflicts.length, 1);
      assert.deepEqual((await agent.undo(task.task_id, { force: true })).restored, [name]);
      assert.deepEqual(readFileSync(abs), before);

      const deletion = await agent.deleteFile(name);
      assert.deepEqual((await agent.undo(deletion.taskId)).restored, [name]);
      assert.deepEqual(readFileSync(abs), before);
    }
  } finally { repo.cleanup(); }
});

test("unknown encodings are refused and mixed-line-ending files permit only preserving edits", async () => {
  const repo = await makeRepo();
  try {
    const root = repo.root;
    const tools = new DefaultToolRuntime({ root, index: repo.store, config: {} });
    const encoded = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]); // Windows-1252
    writeFileSync(path.join(root, "unknown.txt"), encoded);
    const invoke = (tool: string, args: Record<string, unknown>) => tools.invoke(tool, args, { workspaceRoot: root });
    assert.match((await invoke("apply_patch", { path: "unknown.txt", old_text: "caf", new_text: "tea" })).error!, /invalid file encoding/);
    assert.deepEqual(readFileSync(path.join(root, "unknown.txt")), encoded);

    const mixed = path.join(root, "mixed.txt");
    writeFileSync(mixed, "one\r\ntwo\nthree\r");
    assert.equal((await invoke("apply_patch", { path: "mixed.txt", old_text: "two", new_text: "second" })).ok, true);
    assert.match((await invoke("apply_patch", { path: "mixed.txt", old_text: "second", new_text: "second\nextra" })).error!, /mixed line endings/);
    assert.equal(readFileSync(mixed, "utf8"), "one\r\nsecond\nthree\r");
    writeFileSync(mixed, "one\rtwo\nthree");
    const view = await invoke("read_file", { path: "mixed.txt", start_line: 2, end_line: 2 });
    assert.equal((view.data as { content: string }).content, "two");
    assert.match((await invoke("apply_patch", { path: "mixed.txt", old_text: "two", new_text: "" })).error!, /mixed line endings/);
    assert.equal(readFileSync(mixed, "utf8"), "one\rtwo\nthree");

    writeFileSync(mixed, "x".repeat(15_999) + "😀\r\nnext\n");
    const bounded = await invoke("read_file", { path: "mixed.txt" });
    assert.ok(bounded.truncated);
    assert.equal((bounded.data as { content: string }).content, "x".repeat(15_999));
  } finally { repo.cleanup(); }
});

test("a formatter that emits UTF-8 with LF keeps the target's original encoding and CRLF", async () => {
  const repo = await makeRepo();
  try {
    const root = repo.root;
    const original = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("unformatted\r\n", "utf16le")]);
    const expected = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("formatted\r\n", "utf16le")]);
    const abs = path.join(root, "note.txt");
    writeFileSync(abs, original);
    const tools = new DefaultToolRuntime({ root, index: repo.store, config: {
      format_target: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], "formatted\\n")', "{file}"],
    } });
    const result = await tools.invoke("run_formatter", { target: "note.txt" }, { workspaceRoot: root });
    assert.ok(result.ok, result.error);
    assert.deepEqual(readFileSync(abs), expected);
  } finally { repo.cleanup(); }
});
