import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { applyUnifiedPatch, unifiedDiff, diffStats } from "../../src/agent/unified-diff";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import { loadAgentConfig } from "../../src/agent/config";
import { loadBackup, hashText } from "../../src/agent/workdir";
import { makeRepo, CALC_BUGGY } from "./helpers";

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
