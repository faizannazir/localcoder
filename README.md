# localcoder — Phase 0

A hardware-aware local coding agent platform. This is the **Phase 0 vertical slice**: a real, runnable server + CLI that proves the core memory-safety and routing model works, before any of the agent/repository-intelligence layers get built on top of it.

> This implements the Phase 0 scope exactly as locked in `implementation-spec.md` (§7): `HardwareProfiler → PolicyEngine → static ModelRegistry → ModelRouter → ModelManager → llama-server`, and nothing more. No agent, no repository index, no embeddings, no speculative decoding, no distillation, no trained classifier — those are later phases, on purpose.

## What this actually does

- Detects your machine's real RAM/CPU/GPU/battery/thermal state and computes a **safe** memory budget (not just "how much RAM is free")
- Picks the right coding model for the task from a registry of real current models — and **refuses cleanly** rather than crashing if nothing fits
- Runs inference through **`llama-server`** (the real llama.cpp server, not a simulation) as a managed child process
- Serves an OpenAI-compatible local API: `GET /v1/models`, `GET /v1/resource`, `POST /v1/chat/completions`, `POST /v1/completions` (fill-in-middle autocomplete)
- A `doctor` command that tells you exactly what it detected and why it picked (or rejected) a model

## Quick start

```bash
npm install
npm run build

# See what your machine looks like and what model it would pick
npm run doctor    # or: node dist/cli/index.js doctor

# Download a model and install llama-server first — see docs/MODELS.md
npm run serve     # starts the real server on http://127.0.0.1:8080
```

Don't have a model downloaded yet, or just want to see the plumbing work first? Run with the mock backend — it exercises the entire classify → route → load → generate → stream pipeline without needing any GGUF weights or `llama-server` binary, returning clearly-labeled stub responses:

```bash
npm run serve:mock
```

Full instructions: **[cross-platform setup guide](docs/SETUP-WINDOWS-LINUX-MAC.md)** · **[docs/INSTALL.md](docs/INSTALL.md)** · **[docs/USAGE.md](docs/USAGE.md)** · **[docs/MODELS.md](docs/MODELS.md)**

## Why "real, not mock" matters here

The `LlamaCppBackend` is the actual production path: it spawns real `llama-server` processes, speaks its real HTTP API (`/health`, `/v1/chat/completions`, `/infill`, `/tokenize`), and streams real generated tokens. `MockInferenceBackend` exists purely so the request pipeline can be tested and demoed without a multi-gigabyte model download — it is never the default (`serve` uses the real backend unless you explicitly pass `--backend mock`), and every response it returns is prefixed `[mock:...]` so it's never mistaken for a real completion.

## Repo layout

```
src/
  types/       Locked Phase 0 interfaces (implementation-spec.md §2) — the source of truth
  hardware/    HardwareProfiler + linux/windows/macos-specific probes
  policy/      Policy Engine (RAM budget, thermal, battery → ResourcePolicy)
  router/      Task classifier, model router, static registry loader
  manager/     Model Manager (resource-aware residency & eviction)
  inference/   LlamaCppBackend (real) and MockInferenceBackend (testing only)
  server/      HTTP API + the 4 Phase 0 routes
  cli/         localcoder serve / doctor / models
registry/models.json   Static Phase 0 model registry
test/phase0-acceptance/  Automated tests for AT-0.1 through AT-0.8
docs/                  Install, usage, and model-download guides
```

## Phase 1: repository intelligence + persistent memory

Incremental SQLite index, symbol/text search, a 6-stage budget-aware Context Manager, and an adaptive layer (project/task/conversation memory, STALE marking, delta context, content-hash summary cache, metrics). **Symbol extraction is heuristic (TS/JS/Python), not Tree-sitter** — see NOTES.md for exactly what is real, substituted, measured, and not built.

## Phase 2: coding agent

`localcoder agent "<task>"` / `POST /v1/agent/run` (SSE) run a bounded PLAN → SEARCH → READ → REASON → EDIT → TEST → OBSERVE → FIX* → VERIFY loop over your repository using the local model, with a path-jailed, allowlisted tool runtime, targeted edits, smallest-validation-first testing, a persisted/resumable state, and `localcoder undo`. **Never verified against a real llama-server in this build environment** — see NOTES.md ("Phase 2") before trusting it with real work.

## Making it real on your machine

This repo needs two things it cannot download for you: a `llama-server` binary and a GGUF model (see `docs/MODELS.md`). Once you have them, `localcoder models add <file.gguf>` then `localcoder verify` runs the whole stack — inference, tokenizer, fill-in-middle, and the coding agent fixing a real bug in a throwaway repo — against the real server, and tells you precisely what failed or is missing.

## Status

Verified working (including live, on real constrained hardware — see the test suite and its comments): hardware detection, the memory-safety rejection gate, the full classify→route→load→generate→stream pipeline (mock backend), and all 19 automated acceptance tests. The `LlamaCppBackend` is implemented against llama.cpp's real, documented server API but needs a real `llama-server` + GGUF model on your machine to exercise end to end — see `docs/MODELS.md`.

Three real interface bugs were found and fixed while building this against the spec (see `NOTES.md`): `tokenize`/`countTokens` had to become async, `ModelManager.ensure()` needed a `ResourcePolicy` parameter it was missing, and the "fair" thermal state needed a real measurable effect for the "unknown treated as fair" safety rule to be testable at all.

License: Apache-2.0.
