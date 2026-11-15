import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

export const FIXTURE_GOAL = "Fix the add function in calc.js so that the tests pass";

/** A tiny REAL repository (buggy add(), a real node:test file) used by `localcoder verify` for the end-to-end agent check. */
export function createFixtureRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-verify-"));
  writeFileSync(path.join(root, "calc.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  writeFileSync(path.join(root, "calc.test.js"),
    'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("./calc");\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n');
  writeFileSync(path.join(root, "README.md"), "# Calculator\n\nTiny demo library.\n");
  mkdirSync(path.join(root, ".localcoder"), { recursive: true });
  writeFileSync(path.join(root, ".localcoder", "agent.json"), JSON.stringify({ test: ["node", "--test"], test_target: ["node", "--test", "{file}"] }));
  return root;
}
