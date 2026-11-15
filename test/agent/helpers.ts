import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { InferenceBackend, PromptPayload, ResourcePolicy, RoutingDecision, TokenEvent, HardwareProfile } from "../../src/types/index";
import { SqliteIndexStore } from "../../src/index/sqlite-store";
import { IndexService } from "../../src/index/index-service";
import { MemoryStore } from "../../src/memory/memory-store";
import { EstimatingTokenCounter } from "../../src/context/token-counter";
import { CodingAgent, AgentDeps } from "../../src/agent/coding-agent";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import { loadAgentConfig } from "../../src/agent/config";
import { AgentStateStore } from "../../src/agent/state";

export const CALC_BUGGY = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n";
export const CALC_FIXED = CALC_BUGGY.replace("a - b", "a + b");
export const CALC_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("./calc");\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n';
export const UTIL = "// UTIL_MARKER_LINE\n" + Array.from({ length: 30 }, (_, i) => `function helper${i}(x) { return x + ${i}; }`).join("\n") + "\n";

export interface Repo {
  root: string;
  store: SqliteIndexStore;
  memory: MemoryStore;
  indexService: IndexService;
  cleanup: () => void;
}

export async function makeRepo(opts: { buggy?: boolean; extra?: Record<string, string>; config?: object } = {}): Promise<Repo> {
  const root = mkdtempSync(path.join(os.tmpdir(), "localcoder-p2-"));
  const files: Record<string, string> = {
    "calc.js": opts.buggy === false ? CALC_FIXED : CALC_BUGGY,
    "calc.test.js": CALC_TEST,
    "util.js": UTIL,
    ...(opts.extra ?? {}),
  };
  for (const [n, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, n)), { recursive: true });
    writeFileSync(path.join(root, n), c);
  }
  mkdirSync(path.join(root, ".localcoder"), { recursive: true });
  writeFileSync(
    path.join(root, ".localcoder", "agent.json"),
    JSON.stringify(opts.config ?? { test: ["node", "--test"], test_target: ["node", "--test", "{file}"] })
  );
  const db = path.join(root, ".localcoder", "index.sqlite");
  const store = new SqliteIndexStore(db);
  const memory = new MemoryStore(db);
  const indexService = new IndexService(root, store, memory);
  await indexService.indexAll();
  return { root, store, memory, indexService, cleanup: () => { store.close(); memory.close(); rmSync(root, { recursive: true, force: true }); } };
}

export const POLICY: ResourcePolicy = {
  power_mode: "balanced", memory_budget_gb: 16, max_context_tokens: 16384, max_gpu_offload_fraction: 0.8,
  max_agent_wall_seconds: 300, max_tool_calls: 80, allow_background_indexing: true,
};
export const DECISION: RoutingDecision = {
  model_id: "scripted", ctx_window: 16384, kv_cache_budget_mb: 0, kv_cache_dtype: "f16", max_output_tokens: 256, gpu_offload_fraction: 0,
};
export const FAKE_PROFILE: HardwareProfile = {
  ram_total_gb: 32, ram_available_gb: 24, memory_budget_gb: 20, ram_pressure: "low",
  cpu: { cores: 8, arch: "arm64", isa: ["neon"] }, gpu: { backend: "metal", unified_memory: true },
  battery: { present: false, on_ac: true }, thermal_state: "nominal", thermal_confidence: "high", timestamp: new Date().toISOString(),
};

/** TEST-ONLY deterministic backend: replies come from a function of (call index, full prompt text). */
export class ScriptedBackend implements InferenceBackend {
  prompts: string[] = [];
  constructor(private responder: (n: number, prompt: string) => string) {}
  async load() {}
  async unload() {}
  async *generate(p: PromptPayload): AsyncIterable<TokenEvent> {
    if (p.mode !== "chat") throw new Error("scripted backend only supports chat");
    const text = p.messages.map((m) => m.content).join("\n");
    const n = this.prompts.length;
    this.prompts.push(text);
    yield { token: this.responder(n, text), index: 0, finish_reason: "stop" };
  }
  async tokenize(t: string) { return t.split(/\s+/).map((_, i) => i); }
  async countTokens(t: string) { return Math.ceil(t.length / 4); }
}

export const PLAN_JSON = JSON.stringify({ plan: ["Inspect add()", "Fix the operator", "Run the tests"], queries: ["add"], files: ["calc.js", "calc.test.js", "util.js"] });
const replace = (path_: string, old_text: string, new_text: string, reasoning: string) =>
  JSON.stringify({ reasoning, edits: [{ op: "replace", path: path_, old_text, new_text }] });

/** First edit is deliberately wrong (a + a), forcing a real test -> observe -> fix cycle. */
export function fixScript(wrongFirst = true) {
  return (_n: number, p: string): string => {
    if (p.includes('"queries"')) return PLAN_JSON;
    if (!p.includes("## validation_failure")) return replace("calc.js", "return a - b;", wrongFirst ? "return a + a;" : "return a + b;", "add subtracts instead of adding");
    return replace("calc.js", "return a + a;", "return a + b;", "use both operands");
  };
}

export function makeAgent(
  repo: Repo, backend: InferenceBackend,
  over: { policy?: Partial<ResourcePolicy>; decision?: Partial<RoutingDecision>; limits?: AgentDeps["limits"]; now?: () => number; aborted?: () => boolean } = {}
): CodingAgent {
  const config = loadAgentConfig(repo.root);
  return new CodingAgent({
    root: repo.root, index: repo.store, memory: repo.memory, indexService: repo.indexService,
    tools: new DefaultToolRuntime({ root: repo.root, index: repo.store, indexService: repo.indexService, config }),
    backend, tokenCounter: new EstimatingTokenCounter(),
    policy: { ...POLICY, ...(over.policy ?? {}) }, decision: { ...DECISION, ...(over.decision ?? {}) },
    stateStore: new AgentStateStore(repo.root), config, limits: over.limits, now: over.now, aborted: over.aborted,
  });
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}
