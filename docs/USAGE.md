# Usage

## CLI commands

```bash
localcoder serve [--background] [--port 8080] [--backend llama|mock]
localcoder start [--port 8080] [--backend llama|mock]
localcoder status | stop | restart
localcoder doctor
localcoder agent "<task>" [--model <id>] [--delete-file <path>] [--session <id>] [--resume <task_id>]
localcoder files delete <path>
localcoder undo [task_id] [--force]
localcoder models list [--downloaded]
localcoder models download <id>
localcoder models add <file.gguf> | remove <id>
localcoder models load <id> | unload <id> [--port <port>]
localcoder models ps [--port <port>]
localcoder run <id> "<prompt>" [--port <port>]
localcoder config [list | path | get <key> | set <key> <json> | unset <key>]
localcoder verify [--model <file.gguf>] [--llama-server <path>] [--skip-agent] [--json-trials N] [--agent-seconds N]
```

(During development without a build step, prefix these with `npx tsx src/cli/index.ts` instead of `localcoder`, e.g. `npx tsx src/cli/index.ts doctor`.)

- **`serve`** — starts the local API server. Defaults to the real `llama-server` backend on port 8080; pass `--backend mock` to exercise the full pipeline with stub responses instead (no model download needed).
- **`doctor`** — one-shot diagnostic: detected hardware, computed memory budget, chosen power mode, the engine path resolved from configuration or `PATH`, and which registered model (if any) would currently be selected.
- **`models`** — lists catalog and custom models with their size, context window, and download status. See the [model download and sizing guide](MODELS.md).

For a one-model task, pick an installed ID from `localcoder models list` and run `localcoder agent "Fix the failing parser test" --model <id>`. This overrides the project’s role configuration for the run. Repeat the flag when resuming that task to keep the same model. A task with saved planner, coder, and reviewer assignments resumes with those assignments.

### File operations

The coding agent can search and read workspace files, create files, apply targeted edits, and run configured checks. To authorize the agent to remove one named file, pass `--delete-file` with its path. Repeat the flag if resuming a deletion task. To delete a file directly without loading a model, use `localcoder files delete <path>`.

```bash
localcoder agent "Remove the obsolete helper and update its callers" --delete-file src/obsolete.js
localcoder files delete drafts/obsolete.txt
localcoder undo <task_id>
```

LocalCoder preserves UTF-8 with or without a BOM, UTF-16 little- and big-endian with a BOM, and existing line endings. With mixed line endings, use an exact replacement that preserves those breaks. New files use UTF-8. LocalCoder refuses unknown encodings and checks the raw bytes for conflicts, including encoding-only changes. Agent diffs are decoded text previews. Undo restores the original bytes.

Deletion supports regular text files up to 512 KB. LocalCoder keeps a byte-for-byte backup for undo, refuses protected paths and symlinks, and checks for conflicts before overwriting a file recreated after deletion.

With the server running, `localcoder run <id> "<prompt>"` sends a chat request from the terminal. Use `models load <id>` to warm a model, `models ps` to see what is in memory, and `models unload <id>` to release it after active requests finish. Unloading leaves the weights on disk. Pass `--port <port>` when the server uses a different port.

## Run the server in the background

```bash
localcoder start --port 8080
localcoder status
localcoder models ps
localcoder restart
localcoder stop
```

`start` and `serve --background` manage one server per `LOCALCODER_HOME`. Start it from the project you want to use. Check its port, workspace, and log path with `status`. `restart` reuses the port, backend, and workspace and reads authentication from the current environment. Restart after installing a new model to refresh the server's registry. `run` and model residency commands default to the managed server's port. For foreground servers, press Ctrl+C to stop.

## Project settings

Run these commands from the project directory. `config list` shows the project overrides and detected npm scripts. `config path` reports the workspace file, and `config unset` restores the default for a setting.

```bash
localcoder config list
localcoder config set models '{"planner":"qwen2.5-coder-0.5b-q4","coder":"qwen2.5-coder-1.5b-q4","reviewer":"qwen2.5-coder-1.5b-q4"}'
localcoder config set test '["node","--test"]'
localcoder config set timeout_ms 60000
localcoder config get models
localcoder config unset timeout_ms
```

Command settings use JSON arrays of arguments. Use `test`, `test_target`, `lint`, `lint_target`, `format_target`, and `build` to configure available checks. Use `timeout_ms` and `max_result_bytes` for command limits. Use `serve --port` and `serve --backend` to choose how to start the server. Set `LOCALCODER_API_TOKEN` in the environment for API authentication.

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

## Using LocalCoder from an IDE

The tested integration is the CLI in an IDE terminal, plus the native `/v1/agent/run` HTTP/SSE endpoint. There is no dedicated LocalCoder VS Code extension yet. Run from the project you want to edit:

```bash
export LOCALCODER_ROOT=/absolute/path/to/localcoder
export LOCALCODER_CLI="$LOCALCODER_ROOT/dist/cli/index.js"
export LOCALCODER_LLAMA_SERVER_BIN="$LOCALCODER_ROOT/engine/llama-server"
node "$LOCALCODER_CLI" models add "$LOCALCODER_ROOT/models/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"
cd /absolute/path/to/your-project
node "$LOCALCODER_CLI" doctor
node "$LOCALCODER_CLI" agent "Fix the failing tests"
```

The model registration command is a one-time step. Check `models` for the exact ID. To use the three-role workflow, set the following in that project's `.localcoder/agent.json`, preserving any configured test commands:

```json
{
  "models": {
    "planner": "qwen2.5-coder-1.5b-instruct-q4-k-m",
    "coder": "qwen2.5-coder-1.5b-instruct-q4-k-m",
    "reviewer": "qwen2.5-coder-1.5b-instruct-q4-k-m"
  }
}
```

This 1.5B assignment completed the recorded small CLI/API tasks. The mixed 0.5B assignments did not; see [trained-model results](VERIFICATION.md#trained-models-verified-on-2026-11-22). Without a role map the agent uses automatic single-model selection.

For a chat client, start the server from the target project:

```bash
node "$LOCALCODER_CLI" serve --port 8080
```

Use a model ID returned as `id` by `GET /v1/models`. This example selects the 1.5B model installed by the Apple Silicon setup. A Continue chat configuration can follow its [official OpenAI-provider configuration](https://docs.continue.dev/customize/model-providers/top-level/openai):

```yaml
name: LocalCoder chat
version: 1.0.0
schema: v1
models:
  - name: LocalCoder Qwen Coder 1.5B
    provider: openai
    model: qwen2.5-coder-1.5b-q4
    apiBase: http://127.0.0.1:8080/v1
    apiKey: local
    roles: [chat]
    useResponsesApi: false
    useLegacyCompletionsEndpoint: false
    defaultCompletionOptions:
      maxTokens: 512
```

This is a configuration example, not an end-to-end tested extension integration. Use Chat mode. If server authentication is enabled, replace the dummy client key with your `LOCALCODER_API_TOKEN`; keep real keys out of shared configuration.

For VS Code with Copilot Chat, open **Chat: Manage Language Models**, choose **Add Models → Custom Endpoint**, and select **Chat Completions**. Use the full URL `http://127.0.0.1:8080/v1/chat/completions` and the same model ID. Set `toolCalling` and `vision` to `false`; use **Ask** for text chat. Start with `maxInputTokens: 3000` and `maxOutputTokens: 512` so the request leaves room under tighter memory policies. See the [VS Code custom endpoint instructions](https://code.visualstudio.com/docs/agent-customization/language-models#_add-a-custom-endpoint-model).

The API supports these chat clients' request formats. The desktop extension flows require their own verification:

- Chat supports streaming and explicit `stream: false`, with strings or text parts and system/developer/user/assistant roles. It accepts `max_tokens` and `max_completion_tokens`. Native tool calls, images, and `/v1/responses` are outside this chat API.
- Chat honors an installed `model` ID and reports unknown IDs with HTTP 404. Use `localcoder-auto` or omit `model` for automatic routing. Every selection still uses the live memory gate.
- `/v1/completions` takes `prefix` and optional `suffix`, rather than a standard OpenAI `prompt` body. An autocomplete client needs the appropriate adapter.
- Chat requests do not invoke LocalCoder's plan/code/review loop. An IDE agent integration must call `/v1/agent/run` and handle its events, diffs, validation, resume, and undo.

Cline, Aider, OpenCode, Continue Agent mode, and other integrations should not be advertised as plug-and-play until their actual request formats and workflows are tested. Continue [documents tool-use capability as required for Agent mode](https://docs.continue.dev/customize/deep-dives/model-capabilities).

## Apple Foundation Model chat on macOS 27

If Apple Intelligence is available on your Mac, macOS 27 can serve the built-in `system` model directly for terminal chat or an IDE chat client. Apple manages the model files, so this setup needs no GGUF download or llama.cpp installation. If `fm` prompts for its machine-wide terms, review them before proceeding. [Apple's fm CLI guide](https://developer.apple.com/videos/play/wwdc2026/334/)

```bash
fm available
fm chat
```

For editor chat, start the Apple server on loopback in a separate terminal.

```bash
fm serve --host 127.0.0.1 --port 1976
curl http://127.0.0.1:1976/v1/models
```

In Continue's OpenAI provider configuration above, set the model to `system` and the API base to `http://127.0.0.1:1976/v1`. In VS Code's Chat Completions custom endpoint, the model ID is `system` and the URL is `http://127.0.0.1:1976/v1/chat/completions`. Use the text chat role. Press Ctrl+C in the Apple server terminal to stop it.

This connects the editor directly to Apple. LocalCoder's repository agent, routed model roles, and undo are available through the LocalCoder CLI and API with supported GGUF models.

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
localcoder memory prune-cache 500
localcoder memory refresh <id> "<text>"
localcoder memory delete <id>
localcoder task new "Harden validator" "Add charset checks" src/auth.ts
localcoder context "continue"      # resumes the active task without replaying any chat
```

`context` prints layers, raw vs optimized tokens, cache hit rate, stale memory skipped, and (with `--explain`) why each item was included or excluded. Token counts from the CLI are **estimated**. `.env`, keys, `.ssh` etc. are never indexed or stored in memory. Needs Node >= 22.13 (built-in SQLite; it prints an ExperimentalWarning).

`memory prune-cache [number-to-keep]` keeps the newest generated file summaries in the current project's cache. The default is 500. Project memories, task history, conversation summaries, and undo backups are retained.

## Coding agent

```bash
localcoder index .                                  # optional; the agent indexes once if the repo has no index yet
localcoder agent "Fix add() so the tests pass"     # needs llama-server + a model that fits (see doctor)
localcoder agent "continue"                         # resumes the latest interrupted task from its saved state
localcoder agent "..." --session my-session         # tasks in a session share a compact summary
localcoder undo [task_id] [--force]                 # revert the agent's edits (refuses if you changed the files since)
```

HTTP: `POST /v1/agent/run {"task": "...", "session_id"?, "resume_task_id"?}` streams SSE events `model` (configured workflow), `plan`, `tool_call`, `tool_result`, `observation`, `diff`, `done` (or `error`). `POST /v1/agent/undo {"task_id"?, "force"?}` reverts. A 503 means the hardware/memory policy refused the run before any work started; 409 means a run is already active for that repository.

**Telling the agent how to test.** It never runs commands you or the model type. It runs only what is configured: `scripts.test/lint/build` in `package.json` (auto-detected), or `.localcoder/agent.json`:

```json
{ "test": ["node", "--test"], "test_target": ["node", "--test", "{file}"],
  "lint_target": ["eslint", "{file}"], "format_target": ["prettier", "--write", "{file}"], "build": ["npm", "run", "build"] }
```

If a full test command is configured, the agent runs it even when the model says no edit is needed. A failing check sends its output back to the model for a bounded repair attempt. Without a configured test command, the agent reports the level of checks it could run, such as `syntax_only` or `none`.

**Evaluate a trained model.** install `llama-server`, download a model from `registry/models.json` that fits `localcoder doctor`, then run `localcoder agent "<small task>"` in a throwaway git repo and review the printed diff. Expect small local models to sometimes produce invalid edit JSON; the agent retries once, then stops with a resumable error.

## Planner, coder, and reviewer workflow

Set `models.planner`, `models.coder`, and `models.reviewer` in the workspace's `.localcoder/agent.json` to installed IDs shown by `localcoder models`. All three IDs are required; the same ID may serve several roles. The [README configuration example](../README.md#work-with-a-repository) shows the complete mapping.

Run `localcoder agent "<task>"` or POST a task to `/v1/agent/run`. Each model event identifies the requested role and model. The agent loads one model, constructs and counts its prompt, generates, and unloads it before using another model. Concurrent requests wait while a role is active. Files, compact plans, observed checks, and diffs carry context between roles rather than replaying a complete chat transcript.

Review includes a complete task diff and up to four current-file excerpts. Required scope information identifies omitted excerpts and warns about truncation; reviewers must reject insufficient evidence rather than claim unseen file coverage. The reviewer cannot propose executable tools or file edits. Rejections feed the coder's existing repair limit, after which validation and review repeat. A failed or unavailable configured full test command prevents workflow completion. Without configured tests, the reported verification level remains targeted, syntax only, or none, even when a reviewer approves.

Use `localcoder agent "continue"` or `--resume <task_id>` after an interruption. Saved model assignments take precedence over current role configuration; interrupted reviews rerun validation. Cancellation and malformed model output preserve a resumable error instead of assuming approval. Undo remains available without loading a model.

Every selected model must fit the hardware policy individually. Sequential loading does not make an oversized model fit, and this workflow does not implement selective tensor loading. Real random-weight fixture tests verify engine switching and process cleanup; trained-model planning, editing, and review quality require separate evaluation with suitable installed models.
