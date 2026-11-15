import type { Parser, ParsedFile } from "../types/index";
import { HeuristicSymbolExtractor } from "./heuristic-extractor";

const extractorForLanguageCheck = new HeuristicSymbolExtractor();

/**
 * Satisfies the `Parser` interface from implementation-spec.md / the Phase 1 spec. Since
 * there's no real Tree-sitter AST step available (see heuristic-extractor.ts's header
 * comment for why), "parsing" here is just language detection + packaging — the actual
 * symbol structure is derived by HeuristicSymbolExtractor working on raw source lines.
 */
export class HeuristicParser implements Parser {
  supports(language: string): boolean {
    return extractorForLanguageCheck.supportsLanguage(language);
  }

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const { detectLanguage } = await import("./language");
    return { path: filePath, language: detectLanguage(filePath), source };
  }
}
