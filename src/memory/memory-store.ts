import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { MemoryEntry, MemoryCategory, ChatSummary, Task, TaskStatus, SummaryCacheEntry } from "../types/index";
import { isSecretPath } from "../index/ignore";
import { containsLikelySecret } from "./secret-guard";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  related_files TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  active_task_id INTEGER,
  referenced_files TEXT NOT NULL DEFAULT '[]',
  referenced_symbols TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL,
  related_files TEXT NOT NULL DEFAULT '[]',
  related_symbols TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_cache (
  content_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  basis TEXT NOT NULL,
  original_size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_stale ON project_memory(stale);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assertNoSecrets(content: string, relatedFiles: string[]): void {
  for (const f of relatedFiles) {
    if (isSecretPath(f)) throw new Error(`Refusing to persist memory referencing a secret path: "${f}"`);
  }
  if (containsLikelySecret(content)) {
    throw new Error("Refusing to persist memory content that looks like it contains a credential or key.");
  }
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  // --- Project memory ---------------------------------------------------------

  async addMemory(category: MemoryCategory, content: string, relatedFiles: string[] = []): Promise<MemoryEntry> {
    assertNoSecrets(content, relatedFiles);
    const now = new Date().toISOString();
    const content_hash = hash(content);
    const result = this.db
      .prepare(
        `INSERT INTO project_memory (category, content, related_files, content_hash, stale, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(category, content, JSON.stringify(relatedFiles), content_hash, now, now);
    return this.getMemory(Number(result.lastInsertRowid))!;
  }

  getMemory(id: number): MemoryEntry | null {
    const row = this.db.prepare(`SELECT * FROM project_memory WHERE id = ?`).get(id) as any;
    return row ? rowToMemory(row) : null;
  }

  listMemory(opts: { category?: MemoryCategory; includeStale?: boolean } = {}): MemoryEntry[] {
    let sql = `SELECT * FROM project_memory WHERE 1=1`;
    const params: unknown[] = [];
    if (opts.category) {
      sql += ` AND category = ?`;
      params.push(opts.category);
    }
    if (!opts.includeStale) sql += ` AND stale = 0`;
    sql += ` ORDER BY updated_at DESC`;
    return (this.db.prepare(sql).all(...(params as [])) as any[]).map(rowToMemory);
  }

  async updateMemory(id: number, content: string, relatedFiles?: string[]): Promise<void> {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`No memory entry with id ${id}`);
    const files = relatedFiles ?? existing.related_files;
    assertNoSecrets(content, files);
    this.db
      .prepare(`UPDATE project_memory SET content = ?, related_files = ?, content_hash = ?, stale = 0, updated_at = ? WHERE id = ?`)
      .run(content, JSON.stringify(files), hash(content), new Date().toISOString(), id);
  }

  deleteMemory(id: number): void {
    this.db.prepare(`DELETE FROM project_memory WHERE id = ?`).run(id);
  }

  /**
   * Called when a file changes (wired from IndexService). Marks — never deletes or
   * silently rebuilds — every memory entry that referenced that file. A stale entry is
   * still readable (callers can inspect why it might be wrong) but AdaptiveContextManager
   * deprioritizes it in favor of live repository state ("current-state precedence").
   */
  markStaleByFile(filePath: string): number {
    const rows = this.db.prepare(`SELECT id, related_files FROM project_memory WHERE stale = 0`).all() as any[];
    let count = 0;
    for (const row of rows) {
      const files: string[] = JSON.parse(row.related_files);
      if (files.includes(filePath)) {
        this.db.prepare(`UPDATE project_memory SET stale = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), row.id);
        count++;
      }
    }
    return count;
  }

  // --- Chat summaries (cross-chat memory) --------------------------------------

  async upsertChatSummary(sessionId: string, summary: string, activeTaskId: number | null, referencedFiles: string[], referencedSymbols: string[]): Promise<ChatSummary> {
    assertNoSecrets(summary, referencedFiles);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO chat_summaries (session_id, summary, active_task_id, referenced_files, referenced_symbols, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           summary=excluded.summary, active_task_id=excluded.active_task_id,
           referenced_files=excluded.referenced_files, referenced_symbols=excluded.referenced_symbols, updated_at=excluded.updated_at`
      )
      .run(sessionId, summary, activeTaskId, JSON.stringify(referencedFiles), JSON.stringify(referencedSymbols), now, now);
    return this.getChatSummary(sessionId)!;
  }

  getChatSummary(sessionId: string): ChatSummary | null {
    const row = this.db.prepare(`SELECT * FROM chat_summaries WHERE session_id = ?`).get(sessionId) as any;
    return row ? rowToChatSummary(row) : null;
  }

  // --- Tasks (task continuity) --------------------------------------------------

  createTask(title: string, summary: string, relatedFiles: string[] = [], relatedSymbols: string[] = []): Task {
    assertNoSecrets(`${title}\n${summary}`, relatedFiles);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO tasks (title, status, summary, related_files, related_symbols, decisions, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, '[]', ?, ?)`
      )
      .run(title, summary, JSON.stringify(relatedFiles), JSON.stringify(relatedSymbols), now, now);
    return this.getTask(Number(result.lastInsertRowid))!;
  }

  getTask(id: number): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return row ? rowToTask(row) : null;
  }

  /** The task continuity entry point: "continue" / "finish this" resolve through here, not through replaying any conversation. */
  getActiveTask(): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`).get() as any;
    return row ? rowToTask(row) : null;
  }

  updateTaskStatus(id: number, status: TaskStatus): void {
    this.db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`).run(status, new Date().toISOString(), id);
  }

  updateTaskRelations(id: number, files: string[], symbols: string[]): void {
    assertNoSecrets("", files);
    this.db
      .prepare(`UPDATE tasks SET related_files = ?, related_symbols = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(files), JSON.stringify(symbols), new Date().toISOString(), id);
  }

  appendTaskDecision(id: number, decision: string): void {
    const task = this.getTask(id);
    if (!task) throw new Error(`No task with id ${id}`);
    assertNoSecrets(decision, []);
    const decisions = [...task.decisions, decision];
    this.db.prepare(`UPDATE tasks SET decisions = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(decisions), new Date().toISOString(), id);
  }

  // --- Content-hash cache (files/symbols/tool-results/conversation summaries) --

  cacheGet(contentHash: string): SummaryCacheEntry | null {
    const row = this.db.prepare(`SELECT * FROM summary_cache WHERE content_hash = ?`).get(contentHash) as any;
    return row
      ? { content_hash: row.content_hash, kind: row.kind, summary: row.summary, basis: row.basis, original_size_bytes: row.original_size_bytes, created_at: row.created_at }
      : null;
  }

  cacheSet(entry: Omit<SummaryCacheEntry, "created_at">): void {
    this.db
      .prepare(
        `INSERT INTO summary_cache (content_hash, kind, summary, basis, original_size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET summary=excluded.summary, basis=excluded.basis`
      )
      .run(entry.content_hash, entry.kind, entry.summary, entry.basis, entry.original_size_bytes, new Date().toISOString());
  }

  pruneSummaryCache(keep: number): number {
    if (!Number.isSafeInteger(keep) || keep < 0) throw new Error("The cache retention count must be a non-negative integer.");
    const removed = this.db.prepare(`DELETE FROM summary_cache WHERE rowid IN (
      SELECT rowid FROM summary_cache ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(keep).changes;
    return Number(removed);
  }

  close(): void {
    this.db.close();
  }
}

function rowToMemory(row: any): MemoryEntry {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    related_files: JSON.parse(row.related_files),
    content_hash: row.content_hash,
    stale: !!row.stale,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToChatSummary(row: any): ChatSummary {
  return {
    id: row.id,
    session_id: row.session_id,
    summary: row.summary,
    active_task_id: row.active_task_id,
    referenced_files: JSON.parse(row.referenced_files),
    referenced_symbols: JSON.parse(row.referenced_symbols),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    related_files: JSON.parse(row.related_files),
    related_symbols: JSON.parse(row.related_symbols),
    decisions: JSON.parse(row.decisions),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export { hash as hashContentForCache };
