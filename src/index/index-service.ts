import { readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import type { IndexStore, FileEvent, IndexStats } from "../types/index";
import { HeuristicParser } from "./heuristic-parser";
import { HeuristicSymbolExtractor } from "./heuristic-extractor";
import { detectLanguage } from "./language";
import { IgnoreRules } from "./ignore";
import { FsWatcher } from "./watcher";
import { resolveWithinRoot } from "./workspace-jail";
import type { MemoryStore } from "../memory/memory-store";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface IndexRunResult {
  files: number;
  symbols: number;
  languages: string[];
  duration_ms: number;
}

export class IndexService {
  private parser = new HeuristicParser();
  private extractor = new HeuristicSymbolExtractor();
  private ignore: IgnoreRules;
  private watcher: FsWatcher | null = null;

  constructor(private root: string, private store: IndexStore, private memory?: MemoryStore) {
    this.ignore = new IgnoreRules(root);
  }

  /** Full initial index — the only time Phase 1 walks the entire tree. Every later change is incremental. */
  async indexAll(): Promise<IndexRunResult> {
    const start = Date.now();
    await this.store.clear();

    const files = this.walk(this.root);
    let symbolCount = 0;
    const languages = new Set<string>();

    for (const relativePath of files) {
      const count = await this.indexOneFile(relativePath);
      if (count !== null) {
        symbolCount += count.symbols;
        languages.add(count.language);
      }
    }

    return { files: files.length, symbols: symbolCount, languages: [...languages], duration_ms: Date.now() - start };
  }

  /** The incremental path — Phase 1's actual point. Never re-walks or re-parses the whole tree. */
  async handleEvent(event: FileEvent): Promise<void> {
    switch (event.type) {
      case "created":
        await this.indexOneFile(event.path);
        return;
      case "modified": {
        const result = await this.indexOneFile(event.path);
        if (result?.changed) this.memory?.markStaleByFile(event.path);
        return;
      }
      case "deleted":
        await this.store.removeFile(event.path);
        this.memory?.markStaleByFile(event.path);
        return;
      case "renamed":
        await this.store.removeFile(event.oldPath);
        this.memory?.markStaleByFile(event.oldPath);
        await this.indexOneFile(event.newPath);
        return;
    }
  }

  async startWatching(): Promise<void> {
    this.watcher = new FsWatcher();
    this.watcher.onEvent((e) => {
      this.handleEvent(e).catch((err) => {
        // A single bad file must never take down the watcher — log and keep indexing everything else.
        // eslint-disable-next-line no-console
        console.error(`localcoder: failed to index event ${JSON.stringify(e)}: ${(err as Error).message}`);
      });
    });
    await this.watcher.start(this.root);
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.stop();
    this.watcher = null;
  }

  async stats(): Promise<IndexStats> {
    return this.store.stats();
  }

  /** Indexes exactly one file — reads, hashes, checks skip-if-unchanged, parses, extracts, upserts. Returns null if skipped (ignored/escapes workspace/unreadable); otherwise reports whether content actually changed. */
  private async indexOneFile(relativePath: string): Promise<{ symbols: number; language: string; changed: boolean } | null> {
    if (this.ignore.shouldIgnore(relativePath)) return null;

    const resolved = resolveWithinRoot(this.root, relativePath);
    if (!resolved) return null; // workspace-escape attempt (e.g. via a symlink) — silently refused, not indexed

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      return null; // file vanished between the event firing and us reading it — not an error
    }
    if (!stat.isFile()) return null;

    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch {
      return null; // binary/unreadable file — not indexed, not a crash
    }

    const content_hash = hashContent(content);
    const existing = await this.store.getFile(relativePath);
    const language = detectLanguage(relativePath);

    if (existing && existing.content_hash === content_hash) {
      return { symbols: (await this.store.getSymbols(relativePath)).length, language, changed: false }; // unchanged — skip re-parse entirely
    }

    await this.store.upsertFile({ path: relativePath, language, size_bytes: stat.size, mtime: stat.mtimeMs, content_hash, content });

    if (!this.parser.supports(language)) {
      await this.store.upsertSymbols(relativePath, []); // language detected but no extractor — indexed for text search only, symbols honestly empty
      return { symbols: 0, language, changed: true };
    }

    const parsed = await this.parser.parse(relativePath, content);
    const symbols = this.extractor.extract(parsed);
    await this.store.upsertSymbols(relativePath, symbols);
    return { symbols: symbols.length, language, changed: true };
  }

  private walk(dir: string, base = dir, out: string[] = []): string[] {
    let entries;
    try {
      entries = require("fs").readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relative = path.relative(base, abs).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue; // never follow symlinks while walking (security §)
      if (this.ignore.shouldIgnore(relative, entry.isDirectory())) continue;
      if (entry.isDirectory()) this.walk(abs, base, out);
      else if (entry.isFile()) out.push(relative);
    }
    return out;
  }
}
