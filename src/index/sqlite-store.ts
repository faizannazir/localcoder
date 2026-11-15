import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { IndexStore, IndexedFile, SymbolRef, IndexStats, SearchResult, SymbolKind } from "../types/index";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,           -- extension beyond the spec's minimum column list: needed
                                    -- so text search and snippet extraction don't re-touch disk
                                    -- and reflect exactly what was indexed, not live disk state.
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  parent_id INTEGER,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  signature TEXT,
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
`;

function snippetAround(content: string, startLine: number, endLine: number, contextLines = 2): string {
  const lines = content.split("\n");
  const from = Math.max(0, startLine - 1 - contextLines);
  const to = Math.min(lines.length, endLine + contextLines);
  return lines.slice(from, to).join("\n");
}

export class SqliteIndexStore implements IndexStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    // WAL + synchronous=NORMAL: the standard durable-enough setting for a rebuildable local
    // index (a crash can lose the last few transactions, never corrupt the DB; worst case is
    // a re-index). Added after measurement showed per-statement fsync dominated indexing time.
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  async upsertFile(file: IndexedFile): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO files (path, language, size_bytes, mtime, content_hash, content, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           language=excluded.language, size_bytes=excluded.size_bytes, mtime=excluded.mtime,
           content_hash=excluded.content_hash, content=excluded.content, indexed_at=excluded.indexed_at`
      )
      .run(file.path, file.language, file.size_bytes, file.mtime, file.content_hash, file.content, new Date().toISOString());
  }

  async removeFile(filePath: string): Promise<void> {
    // ON DELETE CASCADE takes symbols with it.
    this.db.prepare(`DELETE FROM files WHERE path = ?`).run(filePath);
  }

  async upsertSymbols(filePath: string, symbols: SymbolRef[]): Promise<void> {
    const fileRow = this.db.prepare(`SELECT id FROM files WHERE path = ?`).get(filePath) as { id: number } | undefined;
    if (!fileRow) throw new Error(`upsertSymbols: file "${filePath}" is not indexed yet — call upsertFile() first.`);

    // Replace-all-for-file — Phase 1's incremental unit is "the whole file's symbol set",
    // matching the spec's "replace its symbols" step. Finer-grained per-symbol diffing is
    // future work, not required for the 500ms/single-file-change target.
    this.db.exec("BEGIN");
    try {
    this.db.prepare(`DELETE FROM symbols WHERE file_id = ?`).run(fileRow.id);

    const insert = this.db.prepare(
      `INSERT INTO symbols (file_id, name, kind, qualified_name, parent_id, start_line, end_line, start_byte, end_byte, signature, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of symbols) {
      insert.run(
        fileRow.id, s.name, s.kind, s.qualified_name, s.parent_id ?? null,
        s.start_line, s.end_line, s.start_byte, s.end_byte, s.signature ?? null, s.content_hash
      );
    }
    this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getFile(filePath: string): Promise<IndexedFile | null> {
    const row = this.db.prepare(`SELECT * FROM files WHERE path = ?`).get(filePath) as any;
    if (!row) return null;
    return { path: row.path, language: row.language, size_bytes: row.size_bytes, mtime: row.mtime, content_hash: row.content_hash, content: row.content };
  }

  async getSymbols(filePath: string): Promise<SymbolRef[]> {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.start_line ASC`
      )
      .all(filePath) as any[];
    return rows.map(rowToSymbolRef(filePath));
  }

  async query(q: string, kind: "symbol" | "text" | "semantic", k: number): Promise<SearchResult[]> {
    if (kind === "semantic") {
      // Phase 1 explicitly does not implement semantic search or keep an embedding model
      // resident. An empty result is the honest answer, not a silent BM25 substitute.
      return [];
    }
    if (kind === "symbol") return this.querySymbols(q, k);
    return this.queryText(q, k);
  }

  private querySymbols(q: string, k: number): SearchResult[] {
    const like = `%${q}%`;
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path as file_path FROM symbols s JOIN files f ON f.id = s.file_id
         WHERE s.name LIKE ? OR s.qualified_name LIKE ?
         ORDER BY (CASE WHEN s.name = ? THEN 0 WHEN s.name LIKE ? THEN 1 ELSE 2 END), s.name ASC
         LIMIT ?`
      )
      .all(like, like, q, `${q}%`, k) as any[];

    return rows.map((r) => ({
      path: r.file_path,
      kind: "symbol" as const,
      score: r.name === q ? 1.0 : r.name.startsWith(q) ? 0.7 : 0.4,
      line_start: r.start_line,
      line_end: r.end_line,
      symbol: r.qualified_name,
      reason: `symbol match: ${r.kind} "${r.name}"`,
    }));
  }

  /**
   * Fallback text search — see docs/USAGE.md's ripgrep note. This is the path actually
   * exercised in any environment without `rg` on PATH; a real project deployment with
   * ripgrep installed should prefer it for speed on very large repositories (wiring point
   * left for the IndexService layer, which owns the "prefer rg if present" decision — kept
   * out of the store itself so the store stays a pure, testable persistence layer).
   */
  private queryText(q: string, k: number): SearchResult[] {
    const needle = q.toLowerCase();
    const rows = this.db.prepare(`SELECT path, content FROM files`).all() as { path: string; content: string }[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const lines = row.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hay = lines[i].toLowerCase();
        if (hay.includes(needle)) {
          results.push({
            path: row.path,
            kind: "text",
            score: lines[i].trim().length > 0 ? 1 / (1 + Math.abs(lines[i].length - q.length)) : 0.1,
            line_start: i + 1,
            line_end: i + 1,
            snippet: snippetAround(row.content, i + 1, i + 1),
            reason: "text match (fallback scanner — ripgrep not on PATH)",
          });
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  async clear(): Promise<void> {
    this.db.exec(`DELETE FROM symbols; DELETE FROM files;`);
  }

  async stats(): Promise<IndexStats> {
    const fileCount = (this.db.prepare(`SELECT COUNT(*) as c FROM files`).get() as any).c as number;
    const symbolCount = (this.db.prepare(`SELECT COUNT(*) as c FROM symbols`).get() as any).c as number;
    const languages = (this.db.prepare(`SELECT DISTINCT language FROM files`).all() as any[]).map((r) => r.language);
    const last = (this.db.prepare(`SELECT MAX(indexed_at) as t FROM files`).get() as any).t as string | null;
    return { files: fileCount, symbols: symbolCount, languages, last_indexed_at: last };
  }

  close(): void {
    this.db.close();
  }
}

function rowToSymbolRef(filePath: string) {
  return (r: any): SymbolRef => ({
    file: filePath,
    name: r.name,
    kind: r.kind as SymbolKind,
    qualified_name: r.qualified_name,
    parent_id: r.parent_id ?? undefined,
    start_line: r.start_line,
    end_line: r.end_line,
    start_byte: r.start_byte,
    end_byte: r.end_byte,
    signature: r.signature ?? undefined,
    content_hash: r.content_hash,
  });
}
