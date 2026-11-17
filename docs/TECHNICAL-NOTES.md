# Implementation Notes — Deviations from `implementation-spec.md`

Per this project's own stated values (flag corrections, don't silently patch over them), here's every place the Phase 0 implementation had to deviate from the locked spec, and why.

## 1. `InferenceBackend.tokenize` / `countTokens` — made async

**Spec said:** `tokenize(text: string): number[]` / `countTokens(text: string): number` (synchronous).

**Problem:** the only accurate tokenizer is the model's own, and a subprocess-based backend can only reach it via an HTTP call to `llama-server`'s `POST /tokenize` — inherently asynchronous. A synchronous signature would have forced either a fake local word/character approximation everywhere (exactly what §2.7 says not to do) or a blocking-I/O hack.

**Fix:** both methods now return `Promise<...>`. `LlamaCppBackend` calls the real endpoint; `MockInferenceBackend` uses an explicitly-labeled, non-production whitespace-split approximation.

## 2. `ModelManager.ensure()` — added a `ResourcePolicy` parameter

**Spec said:** `ensure(decision: RoutingDecision, priority?: number): Promise<LoadedModel>` — no policy input.

**Problem:** `ensure()` is supposed to make room (via `evictIfNeeded`) before loading a new model, but `evictIfNeeded` needs a `ResourcePolicy.memory_budget_gb` to know how much room is actually available. Without it, `ensure()` would have had to either fabricate a policy (unsafe — exactly the kind of thing that undermines the whole memory-safety design) or trust every caller to remember to call `evictIfNeeded()` themselves first (fragile — one forgotten call site anywhere in the codebase breaks the guarantee this component exists for).

**Fix:** `ensure(decision, policy, priority?)`. All call sites (both HTTP routes, both `ModelManager` tests) pass the real policy through.

## 3. Path traversal depth — fixed an off-by-one bug (not a spec issue, a coding mistake)

Four files (`src/server/index.ts`, `src/router/registry.ts`, `src/cli/models.ts`, `src/cli/doctor.ts`) initially computed the project root as three `..` up from `__dirname`, copied from the assumption of a `dist/cli/` compiled layout without checking that `src/cli/` sits at the same depth. Caught immediately by running `doctor` for real, which failed to find `registry/models.json`. Fixed to two `..` in all four places. Left in these notes because it's exactly the kind of bug real hardware testing (per `implementation-spec.md` §9, Phase 6) is supposed to catch — this one just surfaced in Phase 0 instead.

## 4. Policy Engine — gave "fair" thermal a real, measured effect

**Problem found while writing AT-0.6:** the spec's thermal rule ("`unknown` treated as `fair`, not `nominal`") only means something if `fair` and `nominal` actually produce different `ResourcePolicy` output. The first implementation only escalated behavior at `serious`/`critical` — `fair` and `nominal` were policy-identical, which would have made the safety rule an untestable no-op.

**Fix:** `fair` now applies a measured pre-emptive trim (`max_context_tokens × 0.75`, `max_gpu_offload_fraction × 0.85`) on top of whatever mode was otherwise chosen, unless the mode already escalated to `silent_cool`/`low_memory`. This is also a more sensible design on its own terms — a gentler first response while a machine is getting warm, rather than doing nothing until it's genuinely hot.

---

None of these changes alter the spec's intent — each one either makes an existing guarantee actually enforceable, or fixes a mechanical mistake caught by running the code against real hardware rather than assuming it would work.

---

# Repository Intelligence and Persistent Memory

## What is real vs. substituted (read this first)

| Requirement | Status |
|---|---|
| SQLite persistence | **Real** — Node's built-in `node:sqlite` (experimental in Node 22; needs Node >= 22.13). Zero npm deps. |
| Tree-sitter parsing | **NOT implemented.** Tree-sitter grammars are native addons needing network `npm install`, unavailable in this build environment. Shipped a regex/indentation **heuristic** extractor behind the spec's `Parser`/`SymbolExtractor` interfaces. Languages extracted: TypeScript, JavaScript, Python only. C#/C/C++/Rust/Go are *detected* (indexed for text search) but yield **no symbols**. A real TreeSitterParser is a drop-in replacement. |
| ripgrep | **Not used** (not installed here). Text search uses a built-in scanner over indexed content; the rg fast-path is **not implemented**, only the fallback. Fine at measured scale (see below); revisit for very large repos. |
| Rename detection | fs.watch cannot distinguish renames; the watcher reports delete+create. `IndexService` handles an explicit `renamed` event and the delete+create pair reaches the same end state. Content-hash rename correlation is not implemented. |
| Semantic search | Returns `[]` by design. |
| Summaries | **Heuristic** (head/tail truncation + omission marker), `basis: "heuristic"`. No LLM summarization. |
| Token counts in CLI/bundles | **Estimated** (chars/4) unless a real backend counter is injected; always labelled. |

## Measured (this sandbox: 1 CPU, 3.9GB RAM, Node 22.22; synthetic repo; heuristic parser, so real Tree-sitter will cost more)

- 54,250-line / 620-file repo: full index **898 ms**, 19,530 symbols. [measured]
- Incremental single-file re-index (n=30): **median 1.3 ms, p95 2.1 ms, max 10.3 ms** (target <500 ms: met). [measured]
- Text search over the full repo (fallback scanner): ~15 ms. [measured]
- RSS after indexing: ~124 MB. [measured]
- Before adding WAL + per-file transactions the same run took 10.9 s / 35 ms median — per-statement fsync dominated. That optimization was made after measuring, not assumed.
- Token efficiency (`scripts/bench-context.ts`, tokens **estimated**): fresh turn 86.6% reduction vs raw candidates; same-file delta turn 92.4%; "continue" turn 0% (nothing redundant to remove — reported honestly). These are ratios against this scenario's own raw candidate set, not a claim about real-world sessions.
- Not measured: performance on 8 GB PCs / Apple Silicon, real-model token counts, real Tree-sitter speed.

## Interface changes
- Phase 0 placeholders `SymbolRef`, `SearchResult`, `IndexStore`, `ContextBundle`, `ContextManager` were reshaped to the Phase 1 spec. Nothing in Phase 0 used them; all Phase 0 tests pass unchanged.
- `ContextBundle` gained `token_basis` ("measured" | "estimated"). A bundle mixing both is reported "estimated".

## Memory design
- Same per-repo SQLite file as the index (`<repo>/.localcoder/index.sqlite`) → project isolation by construction; no global store.
- STALE marking: file modified/deleted/renamed → entries listing that file in `related_files` are marked stale (only when content hash actually changed). Stale memory is **excluded** from context (current-state precedence), never silently rebuilt. `memory refresh <id>` re-confirms it.
- Secrets: paths use the same `isSecretPath` as the indexer; content is checked against a short high-confidence pattern list. Heuristic, not exhaustive.
- Task continuity: "continue / finish this / resume" resolves the active task and re-reads its files **live** from the index.
- Not built: Git-state-triggered staleness (only file-hash changes trigger it), conversation-summary *generation* (store/retrieve exists; something must write the summaries — Phase 2), tool-layer compression wiring (utility exists and is tested; no ToolRuntime yet), hierarchical "tools" layer (empty until Phase 2).
- The context stages' relevance scoring is simple ordering, not a tuned formula.

## KV-cache technical debt (unchanged from Phase 0)
Router still uses a parameter-count heuristic. Future: layers, attention/KV heads, head_dim, KV dtype, ctx length, then compare against llama-server telemetry. Registry fields (`layers`, `attention_heads`, `kv_heads`, `head_dim`) are not yet added. No actual KV usage has been measured.

## Bugs found by tests during this phase
Python extractor treated blank lines as dedent (methods after a blank line became functions); tests written with wrong assumptions (dedup, gitignore timing) were corrected; a dropped `ToolResult` type and a `count()` arity type error were fixed.

---

# Coding Agent

## Definition-of-Done status (read first)

| Item | Status |
|---|---|
| All 65 earlier tests still pass | **Yes** (101/101 total, `npm test`) |
| Phase 2 tests pass | **Yes** — 36 new tests |
| `npm run build` | **Yes, and the compiled CLI was executed** (`node dist/cli/index.js doctor/models/index/symbols/undo/agent`). Without `@types/node` (not installable here) `tsc` prints missing-Node-types noise but emits working JS; no other type errors. |
| `npm run doctor` | **Clean** (reports that this 3.9 GB sandbox cannot fit any registered model — correct, not a fault). |
| Agent completes a real task through the real **llama-server** backend | **NOT VERIFIED.** This environment has no `llama-server` binary, no GGUF weights, no network, and ~2 GB of usable RAM. Every agent test drives the loop with a **test-only scripted backend** (`ScriptedBackend` in `test/agent/helpers.ts`) that returns canned JSON. Everything else in those tests is real: file edits, SQLite index/memory, subprocess `node --test`/`node --check`, the HTTP server and SSE stream, the sandbox, undo. What is therefore **unproven**: that a real small model returns usable edit JSON; that the Phase 0 `LlamaCppBackend.generate()` chat streaming works against a real server (this has been true since Phase 0 — it was written against llama.cpp's documented API but never run against it); agent quality, latency, or memory use with a real model. No performance numbers for the agent loop are claimed. |

## Bug found only by executing the build
`tsconfig` used `rootDir: "."`, so `tsc` emitted `dist/src/...`; `bin`/`npm start` pointed at `dist/cli/index.js` (missing) and `__dirname`-relative registry lookup would also have failed. Present since Phase 0 because earlier checks only looked for type errors and never ran compiled output. Fixed: build covers `src/` only (`rootDir: src`); tests/scripts are type-checked by `npm run typecheck`.

## What was built
`src/agent/`: `state.ts` (serializable `AgentState`, explicit transition table, atomic per-task JSON in `.localcoder/agent/state/`), `tool-runtime.ts` (the 12 tools), `sandbox.ts`, `command-runner.ts`, `config.ts` (command allowlist), `unified-diff.ts` (diff + strict patch applier), `prompt.ts` (token-budgeted prompt fitting), `coding-agent.ts` (loop, ladder, undo, memory writes), `preflight.ts` (resource gate), `session.ts`. Routes `POST /v1/agent/run` (SSE) and `/v1/agent/undo`; CLI `agent` and `undo`.

## Behaviour worth knowing
- **Resource policy before work:** `preflightAgent` derives the Phase 0 policy and routes task class `hard_agent`; a rejected route or a policy with <2048 context / <5 tool calls refuses the run (503 / CLI error) before any model or tool call. During a run: `max_tool_calls`, `max_agent_wall_seconds`, context window and `max_iterations` are enforced; hitting a limit ends with `done{success:false}` and the reason.
- **Stateless prompts, delta by selection:** the model keeps no conversation. The edit prompt carries goal, plan, exact focus-file content, a compact observation digest and an Adaptive Context bundle (files already shown exactly are replaced by "provided in full above"). The FIX prompt re-sends only files that changed or are named in the failure, plus the diff so far; other files read earlier are listed by hash and **omitted** (the model cannot ask for them back — no `need_files` round-trip).
- **Token budget:** every prompt is built by `fitPrompt` and verified by a final whole-prompt count ≤ budget (`min(policy ctx, model ctx) − output reserve − 64`). The 64-token chat-template overhead is a fixed reserve, not measured. Tests count with the chars/4 estimator; with a real backend the counter would be llama-server `/tokenize` (one HTTP call per section — cost unmeasured). Oversized files are truncated from the top (no windowing to the relevant symbol).
- **Edit ladder:** `replace`/`patch` first (exact-once match / content-located hunks, stale-hash check, no-op and ambiguity refusals); `write` on an existing file is refused unless a targeted edit for that path already failed. **The AST/symbol-edit rung is not implemented** — there is no real AST (Phase 1 is a heuristic parser).
- **Validation ladder:** syntax/lint per changed file → targeted test file (found by naming convention via the index) → full test command only in VERIFY. Fails fast. Repeated identical failure (timings normalised) stops after two repeats; fix attempts capped at 3.
- **Tool output reuse:** command output is redacted, stored by hash in `.localcoder/agent/outputs/`, and results/observations carry a ≤2.5 KB failure-focused summary + `output_ref`; the same failure is recorded once ("same failure as observation #n").
- **Memory now writable:** completion updates the memory task (status, files, symbols, decisions) and appends a compact, mechanically generated (not LLM-written) session summary (≤1200 chars); later runs in the same session see it via the Adaptive Context layer. Goals/decisions that look like credentials are refused by the memory secret guard (the run continues without a memory task).
- **Undo:** per-edit journal (before/after hashes + content-addressed backups). Refuses files modified since (override with `--force`); deletes files the agent created; refreshes the index. Available as `localcoder undo` and `POST /v1/agent/undo`; there is no interactive `/undo` slash command (no REPL exists).

## Genuine limitations
- **No OS-level sandbox.** Protection is application-level: workspace path jail (symlink-aware), secret/`.git`/`.localcoder` denial, tool and command allowlist (the model can never supply a command string), minimal env (no inherited tokens), timeouts, capped/redacted output. Not enforced: network isolation, CPU/RAM limits on child processes, filesystem isolation for what test commands themselves do. **The allowlist limits which command runs, not what the repo's scripts do** — `npm test` runs whatever `package.json` says, and the model may edit `package.json`. Do not run the agent on a repository you don't trust.
- Small local models are unreliable at strict JSON; handling is extraction + one nudge retry, then a resumable `error`. llama.cpp grammar/JSON-schema constrained decoding is **not** used.
- Crash window: state is saved after every applied edit, but a crash between applying an edit and saving can leave it applied-yet-pending; on resume the retry fails the exact-match check and is recorded as a failed edit rather than applied twice (reasoned, covered only by a backend-crash test, not a mid-write kill test).
- One agent run per repository per **process** (in-memory lock); no cross-process lock. Two processes could interleave.
- Backups/outputs in `.localcoder/agent/` are never garbage-collected.
- Test/lint commands are auto-detected only from `package.json` scripts or `.localcoder/agent.json`; no Python/Go/Rust/.NET auto-detection. `npm` is spawned without a shell, so Windows (`npm.cmd`) is unhandled; nothing was tested on Windows or macOS.
- Targeted-test discovery is naming-convention based (`foo.test.ext`, `test_foo.py`, …).
- Git-state changes still do not mark memory STALE (only file-content changes do).
- Search remains Phase 1's fallback scanner; the parser remains the heuristic one; token counts in CLI paths remain estimates; the KV-cache estimator is untouched.

## Interface/behaviour changes
Phase 0's unused `AgentEvent`/`CodingAgent` placeholders were reshaped (`AgentEvent` gained `error`; `CodingAgent` is `run(request)` + `undo`). `ToolResult.error?` added. `MemoryStore.createTask`/`appendTaskDecision` now apply the secret guard (previously only `addMemory`/summaries did) and `updateTaskRelations` was added. `AppContext.repoRoot` added; `ServeOptions.backendFactory` is a test seam. `tsconfig.json` changed as described above.

---

# Inference Backend Integration

> **Partly superseded by Phase 2.2 below**: a real `llama-server` (build 11392) has since been run. The "Not verified" list in this section is corrected there.

## What I could and could not do
Probed this build environment directly: no `llama-server`/llama.cpp/Ollama binary, no `.gguf` file anywhere, network blocked (`host_not_allowed`), 1 CPU, 3.9 GB RAM, `gcc`/`make` present but no `cmake`. So **nothing in this release has been run against a real llama-server and a real model.** Rather than add more stand-ins, this release adds the real pieces that do not need those assets, plus one command that exercises everything for real the moment they exist.

## Components that must be supplied (cannot be downloaded here)
1. **`llama-server`** — llama.cpp release asset `llama-b<NNNN>-bin-ubuntu-x64.tar.gz` (or your platform's), extracted whole.
2. **A GGUF model that fits the memory gate.** In *this* 3.9 GB sandbox the safe budget is ~2.0 GB, which allows at most `Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf` (~1 GB) and only at a reduced context; 0.5B fits comfortably. A 1.5B model may be too weak for reliable agent JSON — `verify` measures exactly that.
Optional, for the deferred items only: `ripgrep`, the `tree-sitter` npm packages + grammars, and `@types/node` (so `tsc` prints no missing-Node-types noise). None are needed for the above.

## Added (all real, no mocks)
- `src/inference/gguf.ts`: streaming GGUF v2/v3 metadata reader (never loads weights). `localcoder models add` uses it to register real models in `registry/models.local.json` (merged by the loader; local entries win).
- **KV-cache debt reduced:** when a registry entry has `layers`/`kv_heads`/`head_dim` (all filled by `models add`) the router computes the KV cache exactly: `2 × layers × kv_heads × head_dim × ctx × bytes/element` (f16 2, q8_0 34/32, q4_0 18/32). Entries without them keep the old heuristic.
- **Router now shrinks to fit before refusing** (original spec §9): preferred setting → q8_0 KV → halve context, never below 4096 for agent/review tasks (2048 otherwise). It still never returns a configuration that fails the memory gate (tested by sweeping budgets).
- `localcoder verify`: the real end-to-end check described in MODELS.md; JSON report; exit codes 0/1/2.
- `LlamaCppBackend`: now passes `--parallel 1` (llama-server otherwise splits `--ctx-size` across parallel slots, which would silently shrink the context and un-budget KV memory), exposes `pid` for RSS measurement, and caps its retained log (pipes are still drained).
- Registry correction: removed the `qwen3.5-coder-4b` entry (name invented in Phase 0, never verified); added Qwen2.5-Coder 0.5B/1.5B/3B; documented real file names.

## Tested for real (no mocks) vs. NOT verified
Tested: GGUF reader on spec-conformant byte fixtures (all scalar/array/nested types, v2/v3, truncation, corruption, a 200k-token vocabulary across read-chunk boundaries, keys after a huge array); exact KV math; shrink-to-fit routing and gate invariants; `models add/remove` + registry merge; real `ps`-based RSS of real processes; the `verify`/`models` CLI paths (including exit code 2 and the exact missing-component messages). Suite: 112 tests.

**Not verified — all of these first run for real in `localcoder verify`:**
- The GGUF reader against a *real* model file (fixtures follow the spec but are hand-built; a mismatch with real-world files, e.g. an unusual metadata layout, is possible).
- That the llama-server flags we pass (`--model --port --host --ctx-size --parallel --n-gpu-layers --cache-type-k/v`) are accepted by your build; that `q8_0`/`q4_0` KV needs flash attention on some builds (the router may now pick q8_0 KV; if your build rejects it, load fails with the server's own message rather than silently using more memory).
- `/health`, `/v1/chat/completions` streaming, `/infill`, `/tokenize` behaviour against the real server, and the agent's end-to-end behaviour with any real model.
- That the exact KV formula matches what llama.cpp actually allocates (it ignores padding, sliding-window layers and compute buffers — `verify` prints measured RSS next to the estimate).
- Any speed or memory number for real inference: none is claimed.
- `parameter_count` for a GGUF with no size label/filename hint is a ~4.8 bits-per-weight guess from file size.


---

# Real inference verification with llama-server build 11392

A real `llama-server` (llama.cpp build 11392, Linux x64 CPU, supplied by the project owner) was available for this phase. **No real coding model was** (the Hugging Face URL returns 403 from the build environment and the file was not uploaded), so everything below used a random-weight GGUF written by `scripts/tiny-model.ts`. That file is real and loads in the real server; its output is gibberish, so **no claim about coding quality, JSON compliance, agent success, tokens/second or real-model memory is made.**

## Now verified for real (121 tests, 0 skipped on this machine)
- Every flag we pass is accepted: `--model --port --host --ctx-size --parallel --n-gpu-layers --cache-type-k/v` (checked against `--help` and by loading).
- `--parallel 1` was necessary (the server's default is auto); the log shows `n_slots = 1, n_ctx_slot = 2048` and `/props` reports the full context.
- **Found:** the prompt cache defaults to 8192 MiB of host RAM, outside our memory budget → we now pass `--cache-ram 0`.
- **Found:** a quantized KV cache is rejected when block size 32 does not divide the head dimension (`K cache type q8_0 with block size 32 does not divide n_embd_head_k=16`). The router now avoids quantized KV when the registry knows an incompatible head dimension. With head_dim 32, q8_0 and q4_0 KV load **and generate** on the real server.
- **Exact KV formula validated against the engine's own allocation** (2 layers, 2 KV heads, head_dim 32, 2048 cells): f16 1.00 MiB, q8_0 0.53 MiB, q4_0 0.28 MiB — identical to `exactKvCacheMb`. Not validated for sliding-window, MoE, hybrid/recurrent models, nor for compute buffers.
- Real response formats match the backend's parsers: `/health`, `/tokenize`, `/v1/chat/completions` streaming (including the leading `content:null` chunk and `finish_reason:"length"`), `/infill` streaming (`stop:true` terminator), `/props`.
- Load failures surface the server's own message (invalid GGUF) quickly; missing file / missing binary give clear errors; `unload` really ends the process and frees the port.
- Real `ps`-based RSS of the real llama-server process is measurable.
- The HTTP API (`/v1/chat/completions`, `/v1/completions`, `/v1/models` residency) works through the real router, manager and server; `/v1/agent/run` with a gibberish model ends in an honest error/failed `done`, makes **no edits**, and does not crash.
- `localcoder verify` against the real server passes every plumbing step and honestly FAILS the model-quality steps (JSON contract, agent task) with exit code 1.
- The GGUF writer's output is accepted by the real loader, which independently supports that the reader's format assumptions match the real spec (reader still not tried on a real-world model file).

## Still NOT verified
Any real coding model: JSON-contract adherence, agent task success, quality, speed (tokens/s), real memory use, chat-template behaviour with real templates and tools. GPU backends (Metal/CUDA/Vulkan), macOS and Windows. The GGUF reader on real-world GGUFs (unusual metadata layouts). KV-cache memory for SWA/MoE/hybrid architectures. llama-server context checkpoints (`--ctx-checkpoints`, default 32/slot) may hold extra host memory for some architectures — not measured or limited.

## Still required from the project owner
The coding model file itself (e.g. `Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf`, ~1 GB): upload it, or run `localcoder verify` locally and share `verify-report.json`.

---

# Verification record from 2026-10-28

See [`docs/VERIFICATION.md`](VERIFICATION.md) for the commands and complete observed results. This environment differs from the Phase 2.2 environment above: it has no `llama-server` binary or GGUF weights. `doctor` ran from the compiled CLI and reported Linux x86_64, Node 22.16.0, 5.81 GB RAM, and a 3.04 GB safe budget. `verify` exited 2 before inference and correctly identified both missing prerequisites.

The full suite could not be rerun here: `npm test` stopped because `tsx` is absent; `npm install` timed out and produced no `node_modules`. The globally installed TypeScript 5.8.3 also cannot provide a clean build without the project's declared Node type dependencies. Therefore this checkpoint run **does not independently reconfirm** the historical test counts in the sections above. No real-model inference or coding-task result is claimed for this environment.


## Security and reliability verification

Atomic file replacement uses an exclusively created temporary file and preserves existing permissions. Protected paths are matched consistently across case variants. Model residency changes are serialized, and active requests hold a lease until their generation finishes or is cancelled.

Undo journals persist rollback progress per edit so partial conflicts and interrupted index refreshes can be retried. HTTP cancellation begins when the request is accepted and propagates through queued agent work and upstream inference streams. Command timeouts terminate the subprocess tree and bound pipe cleanup.

On macOS, available-memory estimation includes free and reclaimable file-backed pages from `vm_stat`. Anonymous, wired, and compressed pages stay outside this estimate. Failed probes retain the conservative free-memory fallback. The existing operating-system reserve and model-routing safety margins still apply.


## Model workflow and process ownership

A workflow role must own model residency while constructing context, counting tokens, and generating. Holding a legacy whole-run lease prevents the next role from unloading that backend. Releasing residency before token counting finishes can route the prompt through an unloaded tokenizer. The exclusive manager callback therefore covers the entire role operation and unloads before releasing its queue; hardware selection happens inside that queue after older leases drain.

A successful health response does not establish ownership of a spawned server. Probing a free port and closing the probe before spawning created a cross-process race in real tests. Backend startup now requests an OS-assigned port, reads the listening address from its own child, and checks a unique child alias in `/props`. Regression tests load several backends concurrently and verify ports, identities, and contexts.

Random byte-token fixtures can consume their requested generation budget while emitting zero visible text. Streaming fragments are not generated-token counts; protocol tests verify completion events and the engine's usage fields instead. Trained-model quality requires a separate trained-model evaluation.

After a successful file mutation, an index refresh error must not turn the result into an unjournaled failed edit. File and formatter operations preserve backup/hash metadata and return a bounded, redacted warning when indexing fails; the agent can still journal and undo the actual write. Regression tests cover both operations and restore the original file.
