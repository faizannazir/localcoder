# LocalCoder

**LocalCoder is an open-source local AI coding agent for your terminal and editor.** It runs GGUF models through llama.cpp on your machine, searches your repository, edits files, and runs your project's checks. The memory router chooses models that fit your hardware. A task can use separate planner, coder, and reviewer models, loaded one at a time.

[Quick start](#quick-start) · [Try the coding demo](docs/DEMO.md) · [Connect an editor](docs/USAGE.md#using-localcoder-from-an-ide) · [Contribute](CONTRIBUTING.md)

## Quick start

Prebuilt CLI archives are available for macOS, Linux, and Windows. See [GitHub Releases](https://github.com/faizannazir/localcoder/releases/latest) and the [release installation guide](docs/INSTALL.md#install-from-github-releases).

On an **Apple Silicon Mac**, install Node.js 22.13 or newer and npm, then run:

```bash
git clone https://github.com/faizannazir/localcoder.git
cd localcoder
bash scripts/setup-macos.sh --link
localcoder doctor
node scripts/demo.cjs
```

Setup downloads about 1.14 GB of pinned engine and model files. The demo starts with a failing JavaScript test, asks a trained Qwen model to repair the bug, reruns the original test independently, and verifies undo. It works in a disposable directory. If memory is tight, `doctor` reports the available budget. [Demo and troubleshooting](docs/DEMO.md)

For **Windows and Linux**, or to use an existing llama.cpp installation, see the [platform setup guide](docs/SETUP-WINDOWS-LINUX-MAC.md). Use the [model guide](docs/MODELS.md) to select, download, or import a GGUF.

## Work with a repository

Run these commands from the repository you want to work on:

```bash
localcoder index .
localcoder search "parseToken"
localcoder agent "Fix the failing token parser test"
localcoder undo
```

- **Repository search and project memory.** A local SQLite index stores text and extracted JavaScript, TypeScript, and Python symbols. The agent reuses unchanged file views and carries compact task context between runs. [Search and memory commands](docs/USAGE.md#repository-intelligence-and-memory)
- **File edits and undo.** Targeted edits preserve supported encodings, BOMs, and line endings. Deletion requires an explicit file path. Undo restores the original bytes and checks for later edits. [File operations](docs/USAGE.md#file-operations)
- **Planner, coder, and reviewer.** Configure role assignments to switch models within one task. The reviewer gets the diff, selected file excerpts, and test results. The live memory gate checks each model before loading it. [Sequential workflows](docs/USAGE.md#planner-coder-and-reviewer-workflow)

Here is an example role configuration for the two downloadable Qwen models. Run `localcoder models list --downloaded` to find the IDs available on your machine.

```bash
localcoder config set models '{"planner":"qwen2.5-coder-0.5b-q4","coder":"qwen2.5-coder-1.5b-q4","reviewer":"qwen2.5-coder-1.5b-q4"}'
```

The agent runs checks configured in `.localcoder/agent.json` or discovered from `package.json`. Use it in workspaces whose scripts you trust. [Agent configuration](docs/USAGE.md#coding-agent)

## Terminal chat and editor setup

```bash
localcoder models list --downloaded
localcoder start --port 8080
localcoder run qwen2.5-coder-1.5b-q4 "Explain a JavaScript closure"
localcoder stop
```

Run `localcoder vscode <model-id>` to generate model settings for VS Code Copilot Chat, or add `--continue` for Continue. The command uses the current GGUF context budget. For **Agent** mode, add `--tools` and choose a model that supports function calls. Microsoft Foundry Local models can be selected through the same endpoint using a `foundry/` model ID. [Editor and Foundry setup](docs/USAGE.md#using-localcoder-from-an-ide)

To try the small model verified for tool calling, run `localcoder models download qwen3-0.6b-q8-0`, then generate its editor settings with `localcoder vscode qwen3-0.6b-q8-0 --tools` after starting or restarting the server.

On macOS 27, Apple’s built-in `system` model is available for editor chat through Apple’s `fm serve`. Use LocalCoder’s GGUF backend for workspace edits, verification, and undo. [Apple Foundation Model setup](docs/USAGE.md#apple-foundation-model-chat-on-macos-27)

## Performance and verification

A dense search fixture with 15,000 matching lines ran in about **8 ms median**, down from about **550 ms** before the search changes, on an M1 Pro. This measures indexed text search on a synthetic repository. [Method and scope](docs/TECHNICAL-NOTES.md#repository-search-and-file-identity)

```bash
npm ci
npm run build
npm run typecheck
npm test
```

Set `LOCALCODER_LLAMA_SERVER_BIN` to a local llama.cpp binary to include native-engine tests. The suite uses generated model fixtures for protocol and process checks. Run the [trained-model demo](docs/DEMO.md) to evaluate coding behavior. [Verification notes](docs/VERIFICATION.md)

## Contribute

Start with a [bug report or feature request](https://github.com/faizannazir/localcoder/issues/new/choose), or pick a small contribution in the [contributor guide](CONTRIBUTING.md). Clean-checkout setup reports, Windows and Linux verification, and reproducible local-model results are especially welcome.

Use the [security policy](SECURITY.md) for private vulnerability reporting. LocalCoder is licensed under [Apache-2.0](LICENSE).

## Acknowledgment

Thanks to the llama.cpp maintainers and contributors. Their inference engine makes it possible for LocalCoder to load and run GGUF models on your machine. [llama.cpp](https://github.com/ggml-org/llama.cpp)
