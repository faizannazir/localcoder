import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { Verification } from "../types/index";
import { agentDir } from "./workdir";

export type AgentPhase = "PLAN" | "SEARCH" | "READ" | "REASON" | "EDIT" | "TEST" | "OBSERVE" | "FIX" | "VERIFY" | "DONE" | "FAILED";
export type AgentStatus = "running" | "interrupted" | "done" | "failed";

export const TRANSITIONS: Record<AgentPhase, AgentPhase[]> = {
  PLAN: ["SEARCH", "FAILED"],
  SEARCH: ["READ", "FAILED"],
  READ: ["REASON", "FAILED"],
  REASON: ["EDIT", "VERIFY", "FAILED"],
  EDIT: ["TEST", "REASON", "FAILED"],
  TEST: ["OBSERVE", "FAILED"],
  OBSERVE: ["FIX", "VERIFY", "FAILED"],
  FIX: ["TEST", "FIX", "FAILED"],
  VERIFY: ["DONE", "FIX", "FAILED"],
  DONE: [],
  FAILED: [],
};

export interface EditRecord {
  path: string;
  op: "patch" | "replace" | "write" | "format";
  before_hash: string | null;
  after_hash: string;
  backup_ref: string | null;
  step: number;
}

export interface ProposedEdit {
  op: "patch" | "replace" | "write";
  path: string;
  patch?: string;
  old_text?: string;
  new_text?: string;
  content?: string;
  status: "pending" | "applied" | "failed";
  error?: string;
}

export interface Observation { id: number; tool: string; ok: boolean; summary: string; ref?: string; repeat_of?: number }

export interface ValidationResult { stage: "lint" | "targeted"; ok: boolean; summary: string; ref?: string; skipped: string[] }

export interface AgentState {
  version: 1;
  task_id: string;
  session_id: string;
  goal: string;
  phase: AgentPhase;
  status: AgentStatus;
  iteration: number;
  plan: string[];
  queries: string[];
  candidate_files: string[];
  search_hits: { path: string; line?: number; symbol?: string }[];
  files_read: Record<string, string>;
  proposed_edits: ProposedEdit[];
  edits: EditRecord[];
  observations: Observation[];
  failed_targeted_edit_paths: string[];
  fix_attempts: number;
  reason_retries: number;
  no_progress: number;
  tool_calls: number;
  model_calls: number;
  prompt_tokens_total: number;
  token_basis: "measured" | "estimated";
  validation: ValidationResult | null;
  ran_targeted_ok: boolean;
  ran_lint_ok: boolean;
  verification: Verification;
  memory_task_id: number | null;
  reasoning: string;
  summary: string;
  error?: string;
  warnings: string[];
  undone: boolean;
  created_at: string;
  updated_at: string;
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function newState(goal: string, sessionId: string): AgentState {
  const now = new Date().toISOString();
  return {
    version: 1, task_id: newTaskId(), session_id: sessionId, goal, phase: "PLAN", status: "running", iteration: 0,
    plan: [], queries: [], candidate_files: [], search_hits: [], files_read: {}, proposed_edits: [], edits: [], observations: [],
    failed_targeted_edit_paths: [], fix_attempts: 0, reason_retries: 0, no_progress: 0, tool_calls: 0, model_calls: 0,
    prompt_tokens_total: 0, token_basis: "measured", validation: null, ran_targeted_ok: false, ran_lint_ok: false,
    verification: "none", memory_task_id: null, reasoning: "", summary: "", warnings: [], undone: false, created_at: now, updated_at: now,
  };
}

export function isTerminal(p: AgentPhase): boolean { return p === "DONE" || p === "FAILED"; }

export function transition(state: AgentState, next: AgentPhase): void {
  if (!TRANSITIONS[state.phase].includes(next)) throw new Error(`Illegal agent transition ${state.phase} -> ${next}`);
  state.phase = next;
  state.updated_at = new Date().toISOString();
}

export class AgentStateStore {
  private dir: string;
  constructor(root: string) { this.dir = path.join(agentDir(root), "state"); }

  private file(id: string): string {
    if (!/^t_[A-Za-z0-9_]+$/.test(id)) throw new Error("invalid task id");
    return path.join(this.dir, `${id}.json`);
  }

  save(state: AgentState): void {
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(state.task_id);
    state.updated_at = new Date().toISOString();
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, f); // atomic: a crash leaves either the old or the new state, never a torn file
  }

  load(id: string): AgentState {
    const f = this.file(id);
    if (!existsSync(f)) throw new Error(`no saved agent state for task ${id}`);
    const s = JSON.parse(readFileSync(f, "utf8"));
    if (s.version !== 1) throw new Error(`unsupported agent state version ${s.version}`);
    return s as AgentState;
  }

  list(): AgentState[] {
    if (!existsSync(this.dir)) return [];
    const out: AgentState[] = [];
    for (const n of readdirSync(this.dir)) {
      if (!n.endsWith(".json")) continue;
      try { out.push(this.load(n.slice(0, -5))); } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }

  latestResumable(): AgentState | null {
    const r = this.list().filter((s) => (s.status === "running" || s.status === "interrupted") && !s.undone);
    return r.length ? r[r.length - 1] : null;
  }

  latestWithEdits(): AgentState | null {
    const r = this.list().filter((s) => s.edits.length > 0 && !s.undone);
    return r.length ? r[r.length - 1] : null;
  }
}
