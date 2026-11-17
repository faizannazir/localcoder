/**
 * Locked Phase 0 contracts.
 *
 * These mirror implementation-spec.md §2 exactly. If you need to change a shape here,
 * update the spec doc first — this file and that doc are not allowed to drift.
 *
 * A couple of types (PromptPayload, GenParams, IncomingRequest) were left abstract in the
 * spec and are made concrete here, since an implementation has to pick something. They're
 * called out below so a reviewer knows these are implementation choices, not spec text.
 */

// ---------------------------------------------------------------------------
// Hardware Profiler
// ---------------------------------------------------------------------------

export type ThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";
export type Confidence = "high" | "medium" | "low";
export type GpuBackend = "metal" | "cuda" | "vulkan" | "cpu";
export type Arch = "x86_64" | "arm64";
export type Platform = "linux" | "windows" | "macos";

export interface HardwareProfile {
  ram_total_gb: number;
  ram_available_gb: number;
  /** Safely allocatable RAM — NOT the same as ram_available_gb. The Router reads this field only. */
  memory_budget_gb: number;
  ram_pressure: "low" | "medium" | "high";
  cpu: { cores: number; arch: Arch; isa: string[] };
  gpu: { backend: GpuBackend; cores?: number; vram_gb?: number; unified_memory: boolean };
  battery: { present: boolean; on_ac: boolean; percent?: number };
  thermal_state: ThermalState;
  thermal_confidence: Confidence;
  timestamp: string;
}

export interface HardwareProfiler {
  sample(): Promise<HardwareProfile>;
  onChange(cb: (p: HardwareProfile) => void): () => void;
}

// ---------------------------------------------------------------------------
// Policy Engine
// ---------------------------------------------------------------------------

export type PowerMode = "performance" | "balanced" | "battery" | "silent_cool" | "low_memory";

export interface ResourcePolicy {
  power_mode: PowerMode;
  memory_budget_gb: number;
  max_context_tokens: number;
  /** Portable 0..1 fraction. InferenceBackend converts this to a backend-specific layer count. */
  max_gpu_offload_fraction: number;
  max_agent_wall_seconds: number;
  max_tool_calls: number;
  allow_background_indexing: boolean;
}

export interface PolicyEngine {
  derive(profile: HardwareProfile, userOverride?: Partial<ResourcePolicy>): ResourcePolicy;
}

// ---------------------------------------------------------------------------
// Task Classifier
// ---------------------------------------------------------------------------

export type TaskClass = "autocomplete" | "chat_simple" | "normal_coding" | "hard_agent" | "code_review";

/**
 * IMPLEMENTATION CHOICE (not in the spec text): the shape of a classifiable request.
 * Kept minimal on purpose — Phase 0 only has chat-completions to classify.
 */
export interface IncomingRequest {
  endpoint: "chat_completions" | "completions";
  messages?: { role: "system" | "user" | "assistant"; content: string }[];
  review?: boolean;
}

export interface TaskClassifier {
  classify(request: IncomingRequest): TaskClass;
}

// ---------------------------------------------------------------------------
// Model Registry / Router / Manager
// ---------------------------------------------------------------------------

export type Quantization = "Q4_K_M" | "Q5_K_M" | "Q6_K" | "Q8_0" | "mxfp4" | "Q4_0" | "Q4_K_S" | "Q5_K_S" | "Q3_K_M" | "Q2_K" | "F16" | "F32" | "other";
export type Capability = "fim" | "tool_calling" | "long_context";

export interface ModelRegistryEntry {
  model_id: string;
  architecture: "dense" | "moe";
  parameter_count: { total: number; active?: number }; // in billions
  quantization: Quantization;
  file_path: string;
  context_limit: number;
  backend_requirements: ("cpu" | "cuda" | "metal" | "vulkan")[];
  estimated_memory_gb: number;
  capabilities: Capability[];
  /** Optional architecture facts (read from the GGUF by `localcoder models add`). When layers, kv_heads and head_dim are all present the router computes KV-cache size exactly instead of using the parameter-count heuristic. */
  layers?: number;
  attention_heads?: number;
  kv_heads?: number;
  head_dim?: number;
}

export type KvCacheDtype = "f16" | "q8_0" | "q4_0";

export interface RoutingDecision {
  model_id: string;
  ctx_window: number;
  kv_cache_budget_mb: number;
  kv_cache_dtype: KvCacheDtype;
  max_output_tokens: number;
  gpu_offload_fraction: number;
}

export interface RouterRejection {
  rejected: true;
  reason: "no_model_fits_budget" | "no_model_for_task";
  attempted: { model_id: string; required_gb: number; budget_gb: number }[];
}

export interface ModelRouter {
  route(
    task: TaskClass,
    policy: ResourcePolicy,
    registry: ModelRegistryEntry[]
  ): RoutingDecision | RouterRejection;
}

export function isRejection(x: RoutingDecision | RouterRejection): x is RouterRejection {
  return (x as RouterRejection).rejected === true;
}

export interface LoadedModel {
  model_id: string;
  process_handle: unknown;
  loaded_at: string;
  last_used_at: string;
  priority: number;
}

export interface ModelManager {
  /**
   * DEVIATION FROM implementation-spec.md §2.5: the spec's ensure() took no ResourcePolicy,
   * which meant it had nothing to evict against internally and had to either trust the
   * caller to invoke evictIfNeeded() first (fragile — one forgotten call site breaks the
   * memory-safety guarantee this component exists for) or fabricate a policy (unsafe,
   * worse). Threaded the real policy through instead. Flagged here, not silently patched.
   */
  ensure(decision: RoutingDecision, policy: ResourcePolicy, priority?: number): Promise<LoadedModel>;
  unload(model_id: string): Promise<void>;
  resident(): LoadedModel[];
  evictIfNeeded(requiredGb: number, policy: ResourcePolicy): Promise<void>;
}

// ---------------------------------------------------------------------------
// Inference Backend
// ---------------------------------------------------------------------------

/**
 * IMPLEMENTATION CHOICE: the spec left PromptPayload/GenParams abstract. Concretized here
 * as a discriminated union so chat and FIM requests are handled distinctly end to end
 * (this is also what makes the autocomplete-isolation rule in §2.8 enforceable in code).
 */
export type PromptPayload =
  | { mode: "chat"; messages: { role: "system" | "user" | "assistant"; content: string }[] }
  | { mode: "fim"; prefix: string; suffix: string };

export interface GenParams {
  signal?: AbortSignal;
  max_tokens: number;
  temperature?: number;
  stop?: string[];
}

export interface TokenEvent {
  token: string;
  index: number;
  finish_reason?: "stop" | "length" | "tool_call";
}

export interface InferenceBackend {
  load(entry: ModelRegistryEntry, decision: RoutingDecision): Promise<void>;
  generate(prompt: PromptPayload, params: GenParams): AsyncIterable<TokenEvent>;
  unload(): Promise<void>;
  /**
   * DEVIATION FROM implementation-spec.md §2: the spec wrote these as synchronous.
   * That can't be honest for a real backend — the only accurate tokenizer is the
   * model's own, and llama-server only exposes it over HTTP (POST /tokenize), which
   * is inherently async. A synchronous signature would force either a fake local
   * approximation everywhere (exactly what §2.7 says not to do) or blocking I/O
   * hacks. Made async here; flagged in the delivery notes as a spec correction,
   * not a silent change.
   */
  tokenize(text: string): Promise<number[]>;
  countTokens(text: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Phase 1 — Repository Intelligence & Context Manager
//
// The Phase 0 versions of SymbolRef/ContextBundle/SearchResult/IndexStore/ContextManager
// were explicitly unused placeholders (see the comment that used to sit here: "not
// implemented in Phase 0"). Nothing in the Phase 0 codebase constructs or consumes them,
// so evolving their shape to match what Phase 1 actually needs is not a breaking change —
// see docs/TECHNICAL-NOTES.md for the explicit call-out.
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "type"
  | "constant"
  | "variable"
  | "namespace";

export interface SymbolRef {
  file: string;
  name: string;
  kind: SymbolKind;
  qualified_name: string;
  parent_id?: number;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  signature?: string;
  content_hash: string;
}

export interface IndexedFile {
  path: string;
  language: string | "unknown";
  size_bytes: number;
  mtime: number;
  content_hash: string;
  content: string;
}

export interface IndexStats {
  files: number;
  symbols: number;
  languages: string[];
  last_indexed_at: string | null;
}

export interface SearchResult {
  path: string;
  kind: "symbol" | "text" | "semantic";
  score: number;
  line_start?: number;
  line_end?: number;
  symbol?: string;
  snippet?: string;
  reason?: string;
}

export interface IndexStore {
  query(query: string, kind: "symbol" | "text" | "semantic", k: number): Promise<SearchResult[]>;
  upsertFile(file: IndexedFile): Promise<void>;
  removeFile(path: string): Promise<void>;
  upsertSymbols(file: string, symbols: SymbolRef[]): Promise<void>;
  getFile(path: string): Promise<IndexedFile | null>;
  getSymbols(file: string): Promise<SymbolRef[]>;
  clear(): Promise<void>;
  stats(): Promise<IndexStats>;
  close(): void;
}

// --- Parsing ---------------------------------------------------------------

export interface ParsedFile {
  path: string;
  language: string;
  source: string;
}

export interface Parser {
  supports(language: string): boolean;
  parse(path: string, source: string): Promise<ParsedFile>;
}

export interface SymbolExtractor {
  extract(parsed: ParsedFile): SymbolRef[];
}

// --- File watching -----------------------------------------------------------

export type FileEvent =
  | { type: "created"; path: string }
  | { type: "modified"; path: string }
  | { type: "deleted"; path: string }
  | { type: "renamed"; oldPath: string; newPath: string };

export interface RepositoryWatcher {
  start(root: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(cb: (e: FileEvent) => void): () => void;
}

// --- Token accounting --------------------------------------------------------

export interface TokenCountResult {
  count: number;
  /** "measured" = came from a real model tokenizer; "estimated" = character-based fallback. Never silently mixed — see ContextManager. */
  basis: "measured" | "estimated";
}

export interface TokenCounter {
  count(text: string, model?: string): Promise<TokenCountResult>;
}

// --- Context Manager -----------------------------------------------------------

export interface ContextRequest {
  query: string;
  currentFile?: string;
  currentSymbol?: string;
  selectedText?: string;
  tokenBudget: number;
  contextWindow: number;
  reservedOutputTokens: number;
  reservedSystemTokens: number;
}

export interface ContextBundle {
  files: { path: string; snippet: string; why: string }[];
  symbols: SymbolRef[];
  budget_tokens_used: number;
  budget_tokens_max: number;
  token_basis: "measured" | "estimated";
  stage_reached: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface ContextManager {
  assemble(request: ContextRequest): Promise<ContextBundle>;
}

// ---------------------------------------------------------------------------
// Phase 1 Enhancement — Adaptive Context & Persistent Memory
//
// Purely additive: nothing below changes an existing type's shape. MemoryStore lives
// alongside IndexStore in the same per-repo SQLite file (project isolation falls out of
// that for free — see docs/TECHNICAL-NOTES.md). AdaptiveContextManager composes the existing, already-
// tested DefaultContextManager rather than replacing it.
// ---------------------------------------------------------------------------

export type MemoryCategory = "architecture" | "convention" | "decision" | "constraint" | "important_file" | "known_issue";

export interface MemoryEntry {
  id: number;
  category: MemoryCategory;
  content: string;
  related_files: string[]; // paths this memory depends on — drives staleness marking
  content_hash: string;
  stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChatSummary {
  id: number;
  session_id: string;
  summary: string; // compact — never the raw transcript
  active_task_id: number | null;
  referenced_files: string[];
  referenced_symbols: string[];
  created_at: string;
  updated_at: string;
}

export type TaskStatus = "active" | "done" | "abandoned";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  summary: string;
  related_files: string[];
  related_symbols: string[];
  decisions: string[];
  created_at: string;
  updated_at: string;
}

export interface SummaryCacheEntry {
  content_hash: string;
  kind: "file" | "symbol" | "tool_result" | "conversation";
  summary: string;
  basis: "heuristic" | "model"; // never presented as "model" unless an LLM actually produced it
  original_size_bytes: number;
  created_at: string;
}

export interface ContextMetrics {
  raw_tokens_estimate: number; // what an unoptimized "send everything" context would have cost
  optimized_tokens_used: number;
  reduction_pct: number;
  cache_hits: number;
  cache_misses: number;
  cache_hit_rate: number;
  assembly_latency_ms: number;
  stale_memory_skipped: number;
  basis: "measured" | "estimated"; // token basis, same discipline as ContextBundle.token_basis
}

export type ContextLayer = "system" | "project" | "conversation" | "task" | "repository" | "tools" | "current_request";

export interface ContextItemExplanation {
  layer: ContextLayer;
  path?: string;
  why: string;
  included: boolean;
  tokens: number;
  reason_excluded?: string;
}

export interface AdaptiveContextRequest extends ContextRequest {
  sessionId?: string;
  /** File-content-hash map the caller already has, e.g. from its last turn — enables delta mode. */
  knownFileHashes?: Record<string, string>;
}

export interface AdaptiveContextBundle extends ContextBundle {
  metrics: ContextMetrics;
  explanations: ContextItemExplanation[];
  layers_included: ContextLayer[];
}



export interface ToolResult {
  ok: boolean;
  data: unknown;
  truncated: boolean;
  size_bytes: number;
  error?: string;
}

export interface SandboxContext {
  workspaceRoot: string;
}

export interface ToolRuntime {
  invoke(name: string, args: Record<string, unknown>, sandbox: SandboxContext): Promise<ToolResult>;
  schemas(): unknown[];
}

export type Verification = "full" | "targeted" | "syntax_only" | "none";

// Phase 2: the Phase 0 placeholders for AgentEvent/CodingAgent were unused stubs; reshaped here.
export type AgentEvent =
  | { type: "model"; task_id: string; phase: string; role: "planner" | "coder" | "reviewer"; model_id: string }
  | { type: "plan"; task_id: string; phase: string; steps: string[] }
  | { type: "tool_call"; task_id: string; phase: string; id: number; name: string; args: unknown }
  | { type: "tool_result"; task_id: string; phase: string; id: number; name: string; result: ToolResult }
  | { type: "observation"; task_id: string; phase: string; content: string; ref?: string }
  | { type: "diff"; task_id: string; patch: string; files: string[] }
  | { type: "done"; task_id: string; success: boolean; verification: Verification; summary: string; iterations: number; fix_attempts: number }
  | { type: "error"; task_id: string; phase: string; message: string; recoverable: boolean };

export interface AgentRequest {
  task: string;
  session_id?: string;
  resume_task_id?: string;
}

export interface UndoResult {
  task_id: string;
  restored: string[];
  deleted: string[];
  conflicts: { path: string; reason: string }[];
  already_undone: boolean;
}

export interface CodingAgent {
  run(request: AgentRequest): AsyncIterable<AgentEvent>;
  undo(taskId: string, opts?: { force?: boolean }): Promise<UndoResult>;
}
