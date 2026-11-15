import { createHash } from "crypto";
import type { SummaryCacheEntry } from "../types/index";
import { MemoryStore } from "./memory-store";

/**
 * Deliberately heuristic, not model-generated: a real semantic summary would need an LLM
 * call through Phase 0's InferenceBackend, which means burning the exact token budget this
 * whole feature exists to protect, on every cache miss. Truncation-with-context (head + tail
 * + omission count) is what git/most log viewers already do for the same reason, and it's
 * honest about being mechanical rather than dressed up as understanding the content.
 * `basis: "heuristic"` on every entry this file produces reflects that; nothing in this file
 * ever writes `basis: "model"`.
 */
const HEAD_LINES = 6;
const TAIL_LINES = 4;
const NO_COMPRESSION_THRESHOLD = 600; // chars — short content is returned verbatim, compressing it would waste effort for no savings

export function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function heuristicSummary(content: string): string {
  if (content.length <= NO_COMPRESSION_THRESHOLD) return content;
  const lines = content.split("\n");
  if (lines.length <= HEAD_LINES + TAIL_LINES + 1) return content;

  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return [...head, `... (${omitted} lines omitted, ${content.length.toLocaleString()} chars total — see full content by hash if needed) ...`, ...tail].join("\n");
}

export interface SummarizeResult {
  entry: SummaryCacheEntry;
  cacheHit: boolean;
  tokensSavedEstimate: number; // (original chars - summary chars) / 4, the same estimation basis EstimatingTokenCounter uses
}

export function getOrCreateSummary(store: MemoryStore, content: string, kind: SummaryCacheEntry["kind"]): SummarizeResult {
  const content_hash = hashOf(content);
  const cached = store.cacheGet(content_hash);
  if (cached) {
    return { entry: cached, cacheHit: true, tokensSavedEstimate: Math.max(0, Math.ceil((content.length - cached.summary.length) / 4)) };
  }

  const summary = heuristicSummary(content);
  const entry: SummaryCacheEntry = {
    content_hash,
    kind,
    summary,
    basis: "heuristic",
    original_size_bytes: Buffer.byteLength(content, "utf8"),
    created_at: new Date().toISOString(),
  };
  store.cacheSet(entry);
  return { entry, cacheHit: false, tokensSavedEstimate: Math.max(0, Math.ceil((content.length - summary.length) / 4)) };
}
