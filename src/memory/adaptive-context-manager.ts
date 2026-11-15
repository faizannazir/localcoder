import type {
  AdaptiveContextRequest,
  AdaptiveContextBundle,
  ContextLayer,
  ContextItemExplanation,
  ContextMetrics,
  TokenCounter,
  IndexStore,
} from "../types/index";
import { DefaultContextManager } from "../context/context-manager";
import { MemoryStore } from "./memory-store";
import { getOrCreateSummary } from "./summarizer";

const CONTINUATION_PATTERN = /^\s*(continue|keep going|finish (this|it)|resume|carry on)\b/i;
const COMPRESS_ABOVE_CHARS = 800; // whole-file snippets longer than this get run through the summarizer before being charged to budget

export class AdaptiveContextManager {
  private repoLayer: DefaultContextManager;

  constructor(private index: IndexStore, private memory: MemoryStore, private tokenCounter: TokenCounter) {
    this.repoLayer = new DefaultContextManager(index, tokenCounter);
  }

  async assemble(request: AdaptiveContextRequest): Promise<AdaptiveContextBundle> {
    const startedAt = Date.now();
    const budgetMax = Math.max(0, Math.min(request.tokenBudget, request.contextWindow - request.reservedOutputTokens - request.reservedSystemTokens));

    const explanations: ContextItemExplanation[] = [];
    const layersIncluded: ContextLayer[] = [];
    const files: AdaptiveContextBundle["files"] = [];
    const symbolsOut: AdaptiveContextBundle["symbols"] = [];
    const seenContent = new Set<string>(); // outer-level dedup, across every layer, by exact content

    let used = 0;
    let rawEstimate = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let staleSkipped = 0;
    let sawMeasured = false;
    let sawEstimated = false;

    const chargeAndAdd = async (path: string, content: string, why: string, layer: ContextLayer): Promise<boolean> => {
      if (seenContent.has(content)) {
        explanations.push({ layer, path, why, included: false, tokens: 0, reason_excluded: "duplicate of already-included content" });
        return false;
      }
      const { count, basis } = await this.tokenCounter.count(content);
      if (basis === "measured") sawMeasured = true;
      else sawEstimated = true;
      rawEstimate += count;

      if (used + count > budgetMax) {
        explanations.push({ layer, path, why, included: false, tokens: count, reason_excluded: "over budget" });
        return false;
      }
      used += count;
      seenContent.add(content);
      files.push({ path, snippet: content, why });
      explanations.push({ layer, path, why, included: true, tokens: count });
      if (!layersIncluded.includes(layer)) layersIncluded.push(layer);
      return true;
    };

    // --- Layer: system (bookkeeping only — the actual system prompt is assembled by the caller) ---
    layersIncluded.push("system");

    // --- Task continuity short-circuit: "continue" / "finish this" etc. -------------
    const isContinuation = CONTINUATION_PATTERN.test(request.query);
    const activeTask = this.memory.getActiveTask();

    if (isContinuation && activeTask) {
      await chargeAndAdd(`task:${activeTask.id}`, activeTask.summary, `active task: "${activeTask.title}"`, "task");
      if (activeTask.decisions.length > 0) {
        await chargeAndAdd(`task:${activeTask.id}:decisions`, activeTask.decisions.join("\n"), "decisions made so far on this task", "task");
      }
      // Re-fetch related files/symbols fresh from the live index, never from a cached snapshot —
      // current-state precedence: the task remembers *what* mattered, the index says what it *is now*.
      for (const relPath of activeTask.related_files) {
        const file = await this.index.getFile(relPath);
        if (!file) continue;
        const { snippet } = this.compress(file.content, "file");
        await chargeAndAdd(relPath, snippet, "related to active task (live content)", "task");
      }
    }

    // --- Layer: project memory (non-stale only — current-state precedence) -----------
    const memoryEntries = this.memory.listMemory({ includeStale: false });
    const staleCount = this.memory.listMemory({ includeStale: true }).length - memoryEntries.length;
    staleSkipped += staleCount;
    for (const entry of memoryEntries) {
      const { snippet } = this.compress(entry.content, "conversation");
      await chargeAndAdd(`memory:${entry.id}`, snippet, `project memory: ${entry.category}`, "project");
    }

    // --- Layer: conversation (compact cross-chat summary, never a full transcript) ---
    if (request.sessionId) {
      const chat = this.memory.getChatSummary(request.sessionId);
      if (chat) {
        await chargeAndAdd(`chat:${chat.session_id}`, chat.summary, "prior conversation summary", "conversation");
      }
    }

    // --- Layer: task (only if not already handled by the continuation short-circuit) ---
    if (!isContinuation && activeTask) {
      await chargeAndAdd(`task:${activeTask.id}`, activeTask.summary, `active task: "${activeTask.title}"`, "task");
    }

    // --- Layer: repository — delegate to the existing, already-tested 6-stage manager ---
    const remainingForRepo = budgetMax - used;
    if (remainingForRepo > 0) {
      const repoBundle = await this.repoLayer.assemble({ ...request, tokenBudget: remainingForRepo });
      rawEstimate += repoBundle.budget_tokens_used; // repoLayer's own internal accounting, folded into the outer raw estimate
      if (repoBundle.token_basis === "measured") sawMeasured = true;
      else sawEstimated = true;

      for (const f of repoBundle.files) {
        const knownHash = request.knownFileHashes?.[f.path];
        const liveFile = await this.index.getFile(f.path);

        // --- Delta mode: if the caller already has this exact file content, don't resend it. ---
        if (knownHash && liveFile && liveFile.content_hash === knownHash) {
          await chargeAndAdd(f.path, `(unchanged since your last message — content_hash ${knownHash.slice(0, 12)})`, `${f.why} — delta: unchanged`, "repository");
          continue;
        }

        const { snippet, cacheHit } = this.compress(f.snippet, "file");
        if (f.snippet.length > COMPRESS_ABOVE_CHARS) (cacheHit ? cacheHits++ : cacheMisses++);
        await chargeAndAdd(f.path, snippet, f.why, "repository");
      }
      symbolsOut.push(...repoBundle.symbols);
    } else {
      explanations.push({ layer: "repository", why: "no budget remaining after project/conversation/task layers", included: false, tokens: 0, reason_excluded: "over budget" });
    }

    // --- Layer: tools — Phase 2 territory; tracked honestly as not-yet-populated ---
    // (no entries — CodingAgent/ToolRuntime don't exist yet, see implementation-spec.md §7)

    // --- Layer: current_request — the query itself, not retrieved context, charged separately by the caller ---
    layersIncluded.push("current_request");

    const latency = Date.now() - startedAt;
    const metrics: ContextMetrics = {
      raw_tokens_estimate: rawEstimate,
      optimized_tokens_used: used,
      reduction_pct: rawEstimate > 0 ? Math.round((1 - used / rawEstimate) * 1000) / 10 : 0,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      cache_hit_rate: cacheHits + cacheMisses > 0 ? Math.round((cacheHits / (cacheHits + cacheMisses)) * 1000) / 10 : 0,
      assembly_latency_ms: latency,
      stale_memory_skipped: staleSkipped,
      basis: sawEstimated ? "estimated" : sawMeasured ? "measured" : "estimated",
    };

    return {
      files,
      symbols: symbolsOut,
      budget_tokens_used: used,
      budget_tokens_max: budgetMax,
      token_basis: metrics.basis,
      stage_reached: 6,
      metrics,
      explanations,
      layers_included: layersIncluded,
    };
  }

  private compress(content: string, kind: "file" | "conversation"): { snippet: string; cacheHit: boolean } {
    if (content.length <= COMPRESS_ABOVE_CHARS) return { snippet: content, cacheHit: false };
    const { entry, cacheHit } = getOrCreateSummary(this.memory, content, kind);
    return { snippet: entry.summary, cacheHit };
  }
}
