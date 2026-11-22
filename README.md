# LocalCoder

LocalCoder runs a local coding assistant backed by llama.cpp. It combines hardware-aware model routing, a streaming HTTP API, repository search, persistent project memory, and a coding agent that edits files and runs configured checks.

## Features

- Routes tasks to installed GGUF models according to memory, battery, and thermal policy.
- Manages llama-server processes, model residency, and concurrent inference requests.
- Streams chat responses and fill-in-middle code completions over HTTP.
- Indexes repository files in SQLite and extracts JavaScript, TypeScript, and Python symbols with heuristic parsers.
- Assembles context within a token budget using search results, project memory, task state, and cached summaries.
- Creates files, applies targeted edits, removes explicitly authorized files, runs validation, and supports conflict-aware undo.

## Install

Use **Node.js 22.13 or newer** and npm. For a trained-model setup on Apple Silicon, run this from the checkout:

```bash
bash scripts/setup-macos.sh
```

The installer downloads about 1.14 GB of pinned engine and model files. For other platforms or an existing engine, follow the [installation guide](docs/INSTALL.md). To install dependencies and build without downloading a model:

```bash
npm ci
npm run build
node dist/cli/index.js --help
node dist/cli/index.js doctor
```

Run `bash scripts/setup-macos.sh --link` from the checkout to use `localcoder` directly from any project directory. Then run `localcoder doctor` to check the engine and current memory budget.

After linking, use `localcoder models list --downloaded` to find an installed model. Run `localcoder start` from your project to start the API in the background, `localcoder run <id> "<prompt>"` to prompt a model, and `localcoder stop` when finished. [Terminal commands and IDE setup](docs/USAGE.md)

The `doctor` command reports the hardware profile, resource policy, and model routing decisions. LocalCoder calculates a conservative memory budget before loading a model. On macOS, the available-memory estimate includes reclaimable file cache. Requests receive an HTTP `503` when every candidate exceeds the budget.

Real inference requires a compatible GGUF model and the platform-specific llama-server binary. Extract the full llama.cpp release archive so its companion libraries remain beside the executable. Register a downloaded model, then start the server.

```bash
export LOCALCODER_LLAMA_SERVER_BIN=/absolute/path/to/llama-server
node dist/cli/index.js models add /absolute/path/to/model.gguf
node dist/cli/index.js models
node dist/cli/index.js serve --port 8080
```

Registered models are recorded in `~/.localcoder/models.local.json`. Set `LOCALCODER_HOME` to choose another user-data directory. The server uses the current working directory as its repository workspace and listens on `127.0.0.1`.

For Windows commands, engine downloads, and model sizing, follow the setup and model guides. [Platform setup](docs/SETUP-WINDOWS-LINUX-MAC.md) · [Installation](docs/INSTALL.md) · [Models](docs/MODELS.md)

## Try a real coding task

After the Apple Silicon setup, run `node scripts/demo.cjs` from the checkout. The demo repairs a bug using a trained model, reruns the original test, and checks that undo restores the disposable workspace. [Demo instructions](docs/DEMO.md)

## Run with the mock backend

The mock backend returns responses labeled `[mock:...]` and exercises request routing and streaming without downloading an engine or model. It uses the same resource-policy gate.

```bash
node dist/cli/index.js serve --backend mock --port 8080
```

## HTTP API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/models` | Model registry, installation status, and residency |
| GET | `/v1/resource` | Hardware profile, resource policy, and available repository statistics |
| POST | `/v1/chat/completions` | Generate a chat response as JSON or a stream |
| POST | `/v1/completions` | Stream fill-in-middle completions from `prefix` and `suffix` |
| POST | `/v1/agent/run` | Run or resume a coding task and stream its events |
| POST | `/v1/agent/undo` | Undo edits from a saved task |

Chat uses OpenAI-style server-sent events and ends with `data: [DONE]`. Fill-in-middle requires a model with FIM support and accepts `prefix` and `suffix` fields.

```bash
curl -N http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Write a function that adds two numbers."}],"max_tokens":64}'

curl -N http://127.0.0.1:8080/v1/completions \
  -H 'Content-Type: application/json' \
  -d '{"prefix":"function add(a, b) {\n  return ","suffix":"\n}","max_tokens":32}'
```

POST requests require JSON. Set `LOCALCODER_API_TOKEN` to require bearer authentication. Browser origins and additional Host headers can be configured with `LOCALCODER_ALLOWED_ORIGINS` and `LOCALCODER_ALLOWED_HOSTS`. [CLI and API usage](docs/USAGE.md)

## Work with a repository

Run workspace commands from the repository you want to inspect or edit. Point `LOCALCODER_CLI` to this project's built CLI before changing directories.

```bash
LOCALCODER_CLI=/absolute/path/to/localcoder/dist/cli/index.js
cd /absolute/path/to/your-project

node "$LOCALCODER_CLI" index .
node "$LOCALCODER_CLI" search "add"
node "$LOCALCODER_CLI" symbols "add"
node "$LOCALCODER_CLI" context "add" --budget 4096 --explain
node "$LOCALCODER_CLI" memory status
```

Indexes, memory, saved agent tasks, and edit backups live under the workspace's `.localcoder/` directory. `index . --watch` explicitly starts incremental updates. Context output identifies estimated token counts.

With a suitable local model available, the agent can inspect the repository, propose targeted edits, and run validation.

```bash
node "$LOCALCODER_CLI" agent "Fix the add function so its tests pass" --session arithmetic
node "$LOCALCODER_CLI" agent "continue"
node "$LOCALCODER_CLI" undo
```

The agent discovers `test`, `lint`, and `build` scripts from `package.json`. Configure targeted checks and formatting in `.localcoder/agent.json` when needed. The `{file}` placeholder receives a validated workspace path.

```json
{
  "test": ["node", "--test"],
  "test_target": ["node", "--test", "{file}"],
  "timeout_ms": 120000
}
```

To use separate models within one task, add all three role IDs from `localcoder models` to the same configuration:

```json
{
  "models": {
    "planner": "your-planner-model-id",
    "coder": "your-coder-model-id",
    "reviewer": "your-reviewer-model-id"
  },
  "test": ["node", "--test"],
  "test_target": ["node", "--test", "{file}"]
}
```

The CLI and `/v1/agent/run` use this configuration. The planner prepares a compact plan; the coder edits and runs checks; the reviewer receives bounded current-file excerpts, the complete task diff, and validation evidence. Review prompts disclose omitted excerpts and possible truncation. Rejected reviews return actionable findings to the bounded repair loop. Configured tests must pass before reviewer approval can complete the task, including when the coder proposes no changes.

Each role loads alone and unloads before the next role or queued inference request can use the manager. Context assembly and token counting use that role's model and context limit. The hardware gate runs again before each load. This reduces simultaneous model memory; each complete model and its cache must still fit the current safe budget. Assigning the same installed ID to several roles is supported, with a fresh load for each call. CLI `model:` lines and API `model` events show the selected role and ID.

Saved workflow tasks retain their assignments on resume. Removing `models` from current configuration does not bypass a saved review. Workspaces without `models` keep the single-model workflow, and older saved tasks resume in that mode.

Each run reports its verification level. Undo checks for later file changes and preserves completed rollback progress across retries. Project commands execute with the current user's permissions. The path jail and command allowlist operate at the application level, and repository scripts can access resources available to that user.

## Verify and test

Run the automated checks from the LocalCoder repository root.

```bash
npm run typecheck
npm run build
npm test
```

Set `LOCALCODER_LLAMA_SERVER_BIN` to include real llama.cpp integration tests. Those tests generate small random-weight GGUF fixtures to validate model loading, tokenization, streaming, cache settings, and process cleanup. Model-quality evaluation requires a trained model. Tests that need unavailable engine components or more live memory report a skip.

The `verify` command checks your installed engine and model, then attempts a coding task in a disposable repository. It writes a JSON report and returns an exit code of `0` for success, `1` for failed checks, or `2` for missing components.

```bash
node dist/cli/index.js verify
npm run bench:index
npm run bench:context
```

The benchmarks use synthetic repositories and print measurements for the current machine. Stored verification documents describe the environment and results from their recorded run. [Verification notes](docs/VERIFICATION.md) · [Historical verification report](docs/verification-report.json)

## Repository layout

```text
src/
  agent/       Task execution, file tools, validation, and undo
  cli/         Command-line entry points
  context/     Context assembly and token accounting
  hardware/    Platform hardware probes
  index/       SQLite index, search, and symbol extraction
  inference/   llama.cpp and mock backends, GGUF metadata
  manager/     Model residency and request coordination
  memory/      Project, task, and session memory
  policy/      Resource policy
  router/      Task classification and model selection
  server/      HTTP server and routes
  types/       Shared interfaces
  util/        Paths and engine discovery
test/
  core/        Routing, hardware, and inference API checks
  repository/  Indexing, search, and context tests
  memory/      Persistent memory and context reuse tests
  agent/       Editing, validation, recovery, and undo tests
  inference/   GGUF and real-engine integration tests
  server/      Request security and process lifecycle tests
registry/      Shipped model metadata
scripts/       Benchmarks and synthetic model generation
docs/          Setup, usage, models, and verification records
```

Licensed under Apache-2.0. [License](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and contribution ideas. Report security issues privately as described in [SECURITY.md](SECURITY.md).
