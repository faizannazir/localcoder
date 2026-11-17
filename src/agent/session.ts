import path from "path";
import type { InferenceBackend, ResourcePolicy, RoutingDecision } from "../types/index";
import { SqliteIndexStore } from "../index/sqlite-store";
import { IndexService } from "../index/index-service";
import { MemoryStore } from "../memory/memory-store";
import { indexDbPath } from "../index/open";
import { FallbackTokenCounter } from "../context/token-counter";
import { DefaultToolRuntime } from "./tool-runtime";
import { loadAgentConfig, AgentConfig } from "./config";
import type { AgentModelWorkflow } from "./model-workflow";
import { AgentStateStore } from "./state";
import { CodingAgent } from "./coding-agent";

export interface AgentSession {
  agent: CodingAgent;
  close: () => void;
  indexedNow: boolean;
}

const activeRepos = new Set<string>();

/** One agent run per repository per process (a cross-process lock is not implemented — see docs/TECHNICAL-NOTES.md). */
export function tryLockRepo(root: string): boolean {
  const k = path.resolve(root);
  if (activeRepos.has(k)) return false;
  activeRepos.add(k);
  return true;
}
export function unlockRepo(root: string) { activeRepos.delete(path.resolve(root)); }

/** Opens the repo's own index/memory (per-repo SQLite — isolation by construction) and builds a legacy or role-based agent. */
export async function openAgentSession(opts: {
  root: string; backend?: InferenceBackend; modelWorkflow?: AgentModelWorkflow; config?: AgentConfig; policy: ResourcePolicy; decision: RoutingDecision; aborted?: () => boolean; signal?: AbortSignal;
}): Promise<AgentSession> {
  const db = indexDbPath(opts.root);
  const index = new SqliteIndexStore(db);
  const memory = new MemoryStore(db);
  try {
    const indexService = new IndexService(opts.root, index, memory);
    let indexedNow = false;
    if ((await index.stats()).files === 0) { await indexService.indexAll(); indexedNow = true; } // one explicit, one-shot index; not a background scan
    const config = opts.config ?? loadAgentConfig(opts.root);
    const agent = new CodingAgent({
      root: opts.root, index, memory, indexService,
      tools: new DefaultToolRuntime({ root: opts.root, index, indexService, config }),
      backend: opts.backend, modelWorkflow: opts.modelWorkflow, tokenCounter: new FallbackTokenCounter(opts.backend),
      policy: opts.policy, decision: opts.decision, stateStore: new AgentStateStore(opts.root), config, aborted: opts.aborted, signal: opts.signal,
    });
    return { agent, indexedNow, close: () => { index.close(); memory.close(); } };
  } catch (error) { index.close(); memory.close(); throw error; }
}
