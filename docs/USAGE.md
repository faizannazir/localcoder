# Usage

## CLI commands

```bash
localcoder serve [--port 8080] [--backend llama|mock]
localcoder doctor
localcoder agent "<task>" [--session <id>] [--resume <task_id>]
localcoder undo [task_id] [--force]
localcoder models [add <file.gguf> | remove <id>]
localcoder verify [--model <file.gguf>] [--llama-server <path>] [--skip-agent] [--json-trials N] [--agent-seconds N]
```

(During development without a build step, prefix these with `npx tsx src/cli/index.ts` instead of `localcoder`, e.g. `npx tsx src/cli/index.ts doctor`.)

- **`serve`** — starts the local API server. Defaults to the real `llama-server` backend on port 8080; pass `--backend mock` to exercise the full pipeline with stub responses instead (no model download needed).
- **`doctor`** — one-shot diagnostic: detected hardware, computed memory budget, chosen power mode, the engine path resolved from configuration or `PATH`, and which registered model (if any) would currently be selected.
- **`models`** — lists the shipped and user-registered models with its size, context window, and whether the GGUF file is actually present on disk yet.

## API

The HTTP endpoints are available at `http://127.0.0.1:8080` (or the configured `--port`).

**List available models:**
```bash
curl http://127.0.0.1:8080/v1/models
```

**Check current hardware/policy state** — useful for an IDE status bar:
```bash
curl http://127.0.0.1:8080/v1/resource
```

**Chat completion** (streamed, OpenAI-compatible SSE):
```bash
curl -N -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a function that reverses a linked list."}]}'
```

**Fill-in-middle autocomplete** — the isolated fast path, bypasses the classifier/context/agent entirely (see `implementation-spec.md` §2.8):
```bash
curl -N -X POST http://127.0.0.1:8080/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"prefix":"function add(a, b) {\n  return ","suffix":"\n}"}'
```

If the memory-safety gate rejects every candidate model, you'll get a clean `503` with the reason and exactly what was attempted — not a crash:
```json
{
  "error": {
    "message": "No registered model fits the current memory budget. ...",
    "reason": "no_model_fits_budget",
    "attempted": [{ "model_id": "qwen2.5-coder-7b-q4", "required_gb": 6.0, "budget_gb": 2.1 }]
  }
}
```

## Connecting an IDE / existing agent tool

Because the API is OpenAI-compatible, tools like **Continue**, **Aider**, **Cline**, and **OpenCode** need configuration, not custom code — point their "custom OpenAI-compatible endpoint" setting at:

```
http://127.0.0.1:8080/v1
```

Set the client API key to `LOCALCODER_API_TOKEN` when bearer authentication is enabled.

## Runtime behavior

- Resource policy selects the power mode automatically from hardware readings.
- Chat and FIM endpoints perform inference. Repository context and tool execution are provided through the coding agent and workspace CLI commands.
- KV-cache budgeting uses architecture metadata from GGUF files when available and a documented estimate for entries with incomplete metadata.
- Windows and macOS thermal readings use `unknown` with low confidence. Policy treats that reading conservatively as `fair`.
- POST bodies require JSON, have a 1 MiB limit, and validate generation parameters. Requested output tokens are capped to routing policy.

## Troubleshooting

- **"llama-server not found on PATH"** — see [INSTALL.md](INSTALL.md) §3, or set `LOCALCODER_LLAMA_SERVER_BIN`.
- **"Model file not found: models/..."** — the registry entry is a placeholder until you download the actual GGUF; see [MODELS.md](MODELS.md).
- **Every request gets a 503 memory rejection** — run `localcoder doctor` to see your actual memory budget and what each model needs. On very constrained machines (under ~4GB free), even the smallest registered model may not fit; see MODELS.md for lighter options or adjust `registry/models.json`.
- **Build or type-check failures** — confirm Node.js 22.13 or newer, run `npm ci`, and rerun `npm run typecheck` and `npm run build`.

## Repository intelligence and memory

```bash
localcoder index .                 # full index once (stored in ./.localcoder/index.sqlite)
localcoder index . --watch         # keep incrementally updating; marks affected memory STALE
localcoder symbols "TenantResolver"
localcoder search "resolve tenant"
localcoder context "fix token expiry" --file src/auth.ts --symbol validate --explain
localcoder memory add architecture "Hexagonal; ports in src/ports" src/ports/index.ts
localcoder memory list
localcoder memory status
localcoder memory refresh <id> "<text>"
localcoder memory delete <id>
localcoder task new "Harden validator" "Add charset checks" src/auth.ts
localcoder context "continue"      # resumes the active task without replaying any chat
```

`context` prints layers, raw vs optimized tokens, cache hit rate, stale memory skipped, and (with `--explain`) why each item was included or excluded. Token counts from the CLI are **estimated**. `.env`, keys, `.ssh` etc. are never indexed or stored in memory. Needs Node >= 22.13 (built-in SQLite; it prints an ExperimentalWarning).

## Coding agent

```bash
localcoder index .                                  # optional; the agent indexes once if the repo has no index yet
localcoder agent "Fix add() so the tests pass"     # needs llama-server + a model that fits (see doctor)
localcoder agent "continue"                         # resumes the latest interrupted task from its saved state
localcoder agent "..." --session my-session         # tasks in a session share a compact summary
localcoder undo [task_id] [--force]                 # revert the agent's edits (refuses if you changed the files since)
```

HTTP: `POST /v1/agent/run {"task": "...", "session_id"?, "resume_task_id"?}` streams SSE events `plan`, `tool_call`, `tool_result`, `observation`, `diff`, `done` (or `error`). `POST /v1/agent/undo {"task_id"?, "force"?}` reverts. A 503 means the hardware/memory policy refused the run before any work started; 409 means a run is already active for that repository.

**Telling the agent how to test.** It never runs commands you or the model type. It runs only what is configured: `scripts.test/lint/build` in `package.json` (auto-detected), or `.localcoder/agent.json`:

```json
{ "test": ["node", "--test"], "test_target": ["node", "--test", "{file}"],
  "lint_target": ["eslint", "{file}"], "format_target": ["prettier", "--write", "{file}"], "build": ["npm", "run", "build"] }
```

Without a configured test command the agent can only do a built-in syntax check (JS/Python) and will report `verification: syntax_only` or `none` — it does not claim the change is tested.

**Evaluate a trained model.** install `llama-server`, download a model from `registry/models.json` that fits `localcoder doctor`, then run `localcoder agent "<small task>"` in a throwaway git repo and review the printed diff. Expect small local models to sometimes produce invalid edit JSON; the agent retries once, then stops with a resumable error.

## Planner, coder, and reviewer workflow

Set `models.planner`, `models.coder`, and `models.reviewer` in the workspace's `.localcoder/agent.json` to installed IDs shown by `localcoder models`. All three IDs are required; the same ID may serve several roles. The [README configuration example](../README.md#work-with-a-repository) shows the complete mapping.

Run `localcoder agent "<task>"` or POST a task to `/v1/agent/run`. Each model event identifies the requested role and model. The agent loads one model, constructs and counts its prompt, generates, and unloads it before using another model. Concurrent requests wait while a role is active. Files, compact plans, observed checks, and diffs carry context between roles rather than replaying a complete chat transcript.

Review includes a complete task diff and up to four current-file excerpts. Required scope information identifies omitted excerpts and warns about truncation; reviewers must reject insufficient evidence rather than claim unseen file coverage. The reviewer cannot propose executable tools or file edits. Rejections feed the coder's existing repair limit, after which validation and review repeat. A failed or unavailable configured full test command prevents workflow completion. Without configured tests, the reported verification level remains targeted, syntax only, or none, even when a reviewer approves.

Use `localcoder agent "continue"` or `--resume <task_id>` after an interruption. Saved model assignments take precedence over current role configuration; interrupted reviews rerun validation. Cancellation and malformed model output preserve a resumable error instead of assuming approval. Undo remains available without loading a model.

Every selected model must fit the hardware policy individually. Sequential loading does not make an oversized model fit, and this workflow does not implement selective tensor loading. Real random-weight fixture tests verify engine switching and process cleanup; trained-model planning, editing, and review quality require separate evaluation with suitable installed models.
