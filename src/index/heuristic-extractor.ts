import { createHash } from "crypto";
import type { ParsedFile, SymbolRef, SymbolKind } from "../types/index";

/**
 * NOT Tree-sitter. The Phase 1 spec calls for real AST-based extraction via Tree-sitter
 * grammars, but those are native addons that need `npm install` against the network to
 * fetch prebuilt bindings — unavailable in this build environment (no bash_tool network
 * egress; verified, not assumed, before writing this file). Rather than claim Tree-sitter
 * support that doesn't actually run, this ships a regex/indentation-based heuristic
 * extractor behind the exact same `Parser`/`SymbolExtractor` interfaces the spec defines.
 *
 * It is deliberately conservative: it under-extracts (misses some valid syntax, especially
 * decorators, generics-heavy signatures, and multi-line signatures) rather than
 * over-claiming structure it can't verify. Swapping in a real `TreeSitterParser` later is a
 * drop-in replacement — nothing outside this file and language.ts needs to change.
 */

const HEURISTIC_LANGUAGES = new Set(["typescript", "javascript", "python"]);

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function findMatchingBraceEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seenOpen = true;
      } else if (ch === "}") {
        depth--;
        if (seenOpen && depth === 0) return i + 1;
      }
    }
  }
  return startIdx + 1; // no brace body found (e.g. an arrow one-liner) — treat as single line
}

function findPythonBlockEnd(lines: string[], startIdx: number): number {
  const startIndent = lines[startIdx].match(/^(\s*)/)?.[1].length ?? 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= startIndent) return i; // first line back at or above the def/class's own indent
  }
  return lines.length;
}

function byteOffsetOfLine(lines: string[], lineIdx: number): number {
  return lines.slice(0, lineIdx).reduce((sum, l) => sum + l.length + 1, 0);
}

function extractTsJs(lines: string[]): SymbolRef[] {
  const symbols: SymbolRef[] = [];
  const patterns: { re: RegExp; kind: SymbolKind }[] = [
    { re: /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^\s*class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^\s*interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
    { re: /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
    { re: /^\s*enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
    { re: /^\s*export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { re: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/, kind: "function" },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/, kind: "constant" },
    { re: /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/, kind: "variable" },
    { re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/, kind: "method" },
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of patterns) {
      const m = lines[i].match(re);
      if (!m) continue;
      const name = m[1];
      // Guard against control-flow keywords the method pattern can false-positive on.
      if (["if", "for", "while", "switch", "catch"].includes(name)) continue;

      const isBraceBody = kind === "class" || kind === "interface" || kind === "enum" || kind === "function" || kind === "method";
      const endLine = isBraceBody ? findMatchingBraceEnd(lines, i) : i + 1;

      symbols.push({
        file: "", // filled in by caller
        name,
        kind,
        qualified_name: name,
        start_line: i + 1,
        end_line: endLine,
        start_byte: byteOffsetOfLine(lines, i),
        end_byte: byteOffsetOfLine(lines, Math.min(endLine, lines.length)),
        signature: lines[i].trim().slice(0, 200),
        content_hash: hash(lines.slice(i, endLine).join("\n")),
      });
      break; // one match per line is enough — avoids double-counting an already-matched declaration
    }
  }
  return symbols;
}

function extractPython(lines: string[]): SymbolRef[] {
  const symbols: SymbolRef[] = [];
  const classStack: { name: string; indent: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // Blank/comment lines have no real indentation signal (an empty string measures as
    // indent 0) — using them to decide "we've dedented out of the class" was a real bug,
    // caught by a test with a blank line between two methods.
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
        classStack.pop();
      }
    }

    const classMatch = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
    const defMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);

    if (classMatch) {
      const name = classMatch[1];
      const endLine = findPythonBlockEnd(lines, i);
      symbols.push({
        file: "",
        name,
        kind: "class",
        qualified_name: name,
        start_line: i + 1,
        end_line: endLine,
        start_byte: byteOffsetOfLine(lines, i),
        end_byte: byteOffsetOfLine(lines, endLine),
        signature: line.trim().slice(0, 200),
        content_hash: hash(lines.slice(i, endLine).join("\n")),
      });
      classStack.push({ name, indent });
    } else if (defMatch) {
      const name = defMatch[1];
      const endLine = findPythonBlockEnd(lines, i);
      const inClass = classStack.length > 0;
      const qualified = inClass ? `${classStack.map((c) => c.name).join(".")}.${name}` : name;
      symbols.push({
        file: "",
        name,
        kind: inClass ? "method" : "function",
        qualified_name: qualified,
        parent_id: undefined,
        start_line: i + 1,
        end_line: endLine,
        start_byte: byteOffsetOfLine(lines, i),
        end_byte: byteOffsetOfLine(lines, endLine),
        signature: line.trim().slice(0, 200),
        content_hash: hash(lines.slice(i, endLine).join("\n")),
      });
    }
  }
  return symbols;
}

export class HeuristicSymbolExtractor {
  supportsLanguage(language: string): boolean {
    return HEURISTIC_LANGUAGES.has(language);
  }

  extract(parsed: ParsedFile): SymbolRef[] {
    if (!this.supportsLanguage(parsed.language)) return []; // honest: no extraction claimed for unsupported languages

    const lines = parsed.source.split("\n");
    const raw = parsed.language === "python" ? extractPython(lines) : extractTsJs(lines);
    return raw.map((s) => ({ ...s, file: parsed.path }));
  }
}
