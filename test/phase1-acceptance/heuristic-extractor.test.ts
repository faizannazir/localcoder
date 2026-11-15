import { test } from "node:test";
import assert from "node:assert/strict";
import { HeuristicSymbolExtractor } from "../../src/index/heuristic-extractor";

const extractor = new HeuristicSymbolExtractor();

test("extracts a top-level TypeScript function with correct line range", () => {
  const source = ["export function add(a: number, b: number) {", "  return a + b;", "}", ""].join("\n");
  const symbols = extractor.extract({ path: "math.ts", language: "typescript", source });

  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, "add");
  assert.equal(symbols[0].kind, "function");
  assert.equal(symbols[0].start_line, 1);
  assert.equal(symbols[0].end_line, 3);
});

test("extracts a TypeScript class and its methods, with methods nested under the class", () => {
  const source = [
    "export class Calculator {",
    "  private total = 0;",
    "",
    "  add(x: number) {",
    "    this.total += x;",
    "  }",
    "",
    "  reset() {",
    "    this.total = 0;",
    "  }",
    "}",
  ].join("\n");
  const symbols = extractor.extract({ path: "calc.ts", language: "typescript", source });

  const cls = symbols.find((s) => s.kind === "class");
  const methods = symbols.filter((s) => s.kind === "method");
  assert.ok(cls, "class should be extracted");
  assert.equal(cls!.name, "Calculator");
  assert.equal(methods.length, 2, "both add() and reset() methods should be extracted");
  assert.ok(methods.some((m) => m.name === "add"));
  assert.ok(methods.some((m) => m.name === "reset"));
});

test("extracts a Python class and nested methods with qualified names", () => {
  const source = [
    "class TokenValidator:",
    "    def __init__(self):",
    "        self.cache = {}",
    "",
    "    def validate(self, token):",
    "        return len(token) > 0",
    "",
    "def standalone_function():",
    "    return True",
  ].join("\n");
  const symbols = extractor.extract({ path: "auth.py", language: "python", source });

  const cls = symbols.find((s) => s.kind === "class" && s.name === "TokenValidator");
  const validate = symbols.find((s) => s.name === "validate");
  const standalone = symbols.find((s) => s.name === "standalone_function");

  assert.ok(cls);
  assert.ok(validate);
  assert.equal(validate!.kind, "method");
  assert.equal(validate!.qualified_name, "TokenValidator.validate");
  assert.ok(standalone);
  assert.equal(standalone!.kind, "function");
  assert.equal(standalone!.qualified_name, "standalone_function");
});

test("preserves line ranges precisely enough that a snippet extracted from them is syntactically sensible", () => {
  const source = ["function outer() {", "  return 1;", "}", "", "function other() {", "  return 2;", "}"].join("\n");
  const symbols = extractor.extract({ path: "f.ts", language: "typescript", source });
  const outer = symbols.find((s) => s.name === "outer")!;
  const lines = source.split("\n");
  const snippet = lines.slice(outer.start_line - 1, outer.end_line).join("\n");
  assert.ok(snippet.includes("function outer"));
  assert.ok(snippet.includes("return 1"));
  assert.ok(!snippet.includes("other"), "the extracted range must not bleed into the next function");
});

test("an unsupported language yields no symbols, honestly — not a guess", () => {
  const symbols = extractor.extract({ path: "main.rs", language: "rust", source: "fn main() {}" });
  assert.equal(symbols.length, 0);
});

test("supportsLanguage correctly reports only the languages this heuristic extractor actually handles", () => {
  assert.equal(extractor.supportsLanguage("typescript"), true);
  assert.equal(extractor.supportsLanguage("python"), true);
  assert.equal(extractor.supportsLanguage("rust"), false);
  assert.equal(extractor.supportsLanguage("csharp"), false);
});
