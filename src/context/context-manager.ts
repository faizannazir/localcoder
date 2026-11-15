import type {
  ContextManager as IContextManager,
  ContextRequest,
  ContextBundle,
  IndexStore,
  TokenCounter,
  SymbolRef,
} from "../types/index";

interface Candidate {
  path: string;
  snippet: string;
  why: string;
  range?: [number, number]; // [start_line, end_line]; absent means "whole file"
  symbol?: SymbolRef;
}

const TEST_PATH_PATTERNS = [/\.test\./, /\.spec\./, /(^|\/)tests?\//, /(^|\/)test_/, /_test\.\w+$/];

function snippetFromContent(content: string, startLine: number, endLine: number): string {
  const lines = content.split("\n");
  return lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n");
}

function extractImportPaths(content: string, language: string): string[] {
  const paths: string[] = [];
  if (language === "typescript" || language === "javascript") {
    for (const m of content.matchAll(/import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g)) paths.push(m[1]);
    for (const m of content.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) paths.push(m[1]);
  } else if (language === "python") {
    for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) paths.push(m[1].replace(/\./g, "/"));
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) paths.push(m[1].replace(/\./g, "/"));
  }
  return paths.filter((p) => p.startsWith(".") || language === "python"); // only relative/local imports are resolvable within the repo; package imports (e.g. "react") have no local file to attach
}

export class DefaultContextManager implements IContextManager {
  constructor(private index: IndexStore, private tokenCounter: TokenCounter) {}

  async assemble(request: ContextRequest): Promise<ContextBundle> {
    const budgetMax = Math.max(
      0,
      Math.min(request.tokenBudget, request.contextWindow - request.reservedOutputTokens - request.reservedSystemTokens)
    );

    const bundle: ContextBundle = {
      files: [],
      symbols: [],
      budget_tokens_used: 0,
      budget_tokens_max: budgetMax,
      token_basis: "estimated",
      stage_reached: 1,
    };

    if (budgetMax <= 0) return bundle; // nothing to spend — stage_reached stays 1, files empty, honest about it

    const fullyIncludedFiles = new Set<string>();
    const includedRanges = new Map<string, Set<string>>();
    let basisSeenMeasured = false;
    let basisSeenEstimated = false;

    const tryAdd = async (c: Candidate): Promise<boolean> => {
      if (fullyIncludedFiles.has(c.path)) return false; // whole file already in — any narrower slice of it is redundant
      const rangeKey = c.range ? `${c.range[0]}-${c.range[1]}` : "*";
      const seen = includedRanges.get(c.path);
      if (seen?.has(rangeKey)) return false;

      const { count, basis } = await this.tokenCounter.count(c.snippet);
      if (basis === "measured") basisSeenMeasured = true;
      else basisSeenEstimated = true;

      if (bundle.budget_tokens_used + count > budgetMax) return false; // does not fit — caller decides whether to stop the stage

      bundle.budget_tokens_used += count;
      bundle.files.push({ path: c.path, snippet: c.snippet, why: c.why });
      if (c.symbol) bundle.symbols.push(c.symbol);

      if (!c.range) fullyIncludedFiles.add(c.path);
      else {
        if (!seen) includedRanges.set(c.path, new Set());
        includedRanges.get(c.path)!.add(rangeKey);
      }
      return true;
    };

    const remaining = () => budgetMax - bundle.budget_tokens_used;

    // --- Stage 1: current file -------------------------------------------------
    let currentFileRecord = request.currentFile ? await this.index.getFile(request.currentFile) : null;
    if (currentFileRecord) {
      await tryAdd({ path: currentFileRecord.path, snippet: currentFileRecord.content, why: "current file" });
    }
    bundle.stage_reached = 1;
    if (remaining() <= 0) return this.finish(bundle, basisSeenMeasured, basisSeenEstimated);

    // --- Stage 2: relevant function/class --------------------------------------
    if (request.currentFile) {
      const symbols = await this.index.getSymbols(request.currentFile);
      const target =
        (request.currentSymbol && symbols.find((s) => s.name === request.currentSymbol || s.qualified_name === request.currentSymbol)) ||
        null;
      if (target && currentFileRecord) {
        await tryAdd({
          path: target.file,
          snippet: snippetFromContent(currentFileRecord.content, target.start_line, target.end_line),
          why: `current symbol: ${target.qualified_name}`,
          range: [target.start_line, target.end_line],
          symbol: target,
        });
      }
    }
    bundle.stage_reached = 2;
    if (remaining() <= 0) return this.finish(bundle, basisSeenMeasured, basisSeenEstimated);

    // --- Stage 3: related symbols (broader symbol search on the query) ---------
    const symbolHits = await this.index.query(request.query, "symbol", 8);
    for (const hit of symbolHits) {
      if (remaining() <= 0) break;
      if (!hit.path || hit.line_start === undefined || hit.line_end === undefined) continue;
      const file = await this.index.getFile(hit.path);
      if (!file) continue;
      await tryAdd({
        path: hit.path,
        snippet: snippetFromContent(file.content, hit.line_start, hit.line_end),
        why: `related symbol: ${hit.symbol ?? hit.reason ?? "match"}`,
        range: [hit.line_start, hit.line_end],
      });
    }
    bundle.stage_reached = 3;
    if (remaining() <= 0) return this.finish(bundle, basisSeenMeasured, basisSeenEstimated);

    // --- Stage 4: imports / dependencies of the current file --------------------
    if (currentFileRecord) {
      const importPaths = extractImportPaths(currentFileRecord.content, currentFileRecord.language);
      for (const imp of importPaths) {
        if (remaining() <= 0) break;
        const resolved = await this.resolveImportToIndexedPath(imp, currentFileRecord.path);
        if (!resolved) continue;
        const file = await this.index.getFile(resolved);
        if (!file) continue;
        await tryAdd({ path: file.path, snippet: file.content, why: `import of current file` });
      }
    }
    bundle.stage_reached = 4;
    if (remaining() <= 0) return this.finish(bundle, basisSeenMeasured, basisSeenEstimated);

    // --- Stage 5: relevant tests -------------------------------------------------
    const textHitsForTests = await this.index.query(request.query, "text", 15);
    for (const hit of textHitsForTests) {
      if (remaining() <= 0) break;
      if (!TEST_PATH_PATTERNS.some((re) => re.test(hit.path))) continue;
      if (!hit.snippet) continue;
      await tryAdd({ path: hit.path, snippet: hit.snippet, why: "relevant test", range: hit.line_start && hit.line_end ? [hit.line_start, hit.line_end] : undefined });
    }
    bundle.stage_reached = 5;
    if (remaining() <= 0) return this.finish(bundle, basisSeenMeasured, basisSeenEstimated);

    // --- Stage 6: other related repository files (broad text search) -----------
    const textHits = await this.index.query(request.query, "text", 15);
    for (const hit of textHits) {
      if (remaining() <= 0) break;
      if (!hit.snippet) continue;
      await tryAdd({ path: hit.path, snippet: hit.snippet, why: "related file (text match)", range: hit.line_start && hit.line_end ? [hit.line_start, hit.line_end] : undefined });
    }
    bundle.stage_reached = 6;

    return this.finish(bundle, basisSeenMeasured, basisSeenEstimated);
  }

  private finish(bundle: ContextBundle, sawMeasured: boolean, sawEstimated: boolean): ContextBundle {
    // Report "measured" only if every count that contributed was measured — mixing them
    // silently is exactly what the spec says not to do, so a mixed bundle is reported as
    // "estimated" overall (the more conservative, honest label) even if some counts were real.
    bundle.token_basis = sawEstimated ? "estimated" : sawMeasured ? "measured" : "estimated";
    return bundle;
  }

  private async resolveImportToIndexedPath(importSpecifier: string, fromFile: string): Promise<string | null> {
    const path = await import("path");
    const dir = path.dirname(fromFile);
    const candidates = [importSpecifier, `${importSpecifier}.ts`, `${importSpecifier}.tsx`, `${importSpecifier}.js`, `${importSpecifier}.py`, `${importSpecifier}/index.ts`];
    for (const c of candidates) {
      const joined = path.normalize(path.join(dir, c)).split(path.sep).join("/");
      if (await this.index.getFile(joined)) return joined;
    }
    return null;
  }
}
