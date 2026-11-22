# Install LocalCoder

For the complete, copy-paste setup for **Windows, Linux, and macOS**, including exact download types and folder locations, see [SETUP-WINDOWS-LINUX-MAC.md](SETUP-WINDOWS-LINUX-MAC.md).

## Prerequisites

- **Node.js 22.13 or newer** and npm.
- The LocalCoder repository (clone it or extract its ZIP).
- For real inference: a platform-matched `llama-server` executable and at least one compatible `.gguf` model file. The Apple Silicon installer below downloads both. Other platforms use the manual setup guide.

## Install from GitHub Releases

Download the CLI archive for your operating system. Each archive contains compiled JavaScript, launchers, model metadata, and documentation. Node.js 22.13 or newer is required. The CLI works on supported CPU architectures with a matching Node.js build and inference engine. [Latest release](https://github.com/faizannazir/localcoder/releases/latest)

| Platform | Archive | Run after extracting |
| --- | --- | --- |
| macOS | `localcoder-v<version>-macos.tar.gz` | `./localcoder --help` |
| Linux | `localcoder-v<version>-linux.tar.gz` | `./localcoder --help` |
| Windows | `localcoder-v<version>-windows.zip` | `.\localcoder.cmd --help` |

The engine and model weights are separate downloads. Put a compatible llama.cpp build and its libraries in `engine/`, or set `LOCALCODER_LLAMA_SERVER_BIN` to your existing executable. From the extracted folder, run the launcher with `models download qwen2.5-coder-0.5b-q4`, then with `doctor`. Follow the [platform setup guide](SETUP-WINDOWS-LINUX-MAC.md#2-download-the-two-inference-files) for engine downloads.

Verify archives against `SHA256SUMS`. Use `shasum -a 256 <file>` on macOS, `sha256sum <file>` on Linux, or `Get-FileHash <file> -Algorithm SHA256` in PowerShell. The `-source.zip` asset contains the source for building the CLI yourself.

## Quick setup on Apple Silicon

From the source checkout, with Node.js and npm already installed:

```bash
bash scripts/setup-macos.sh
```

This downloads the pinned llama.cpp engine and Qwen2.5-Coder 1.5B GGUF (about 1.14 GB combined), checks the download hashes, installs locked npm dependencies, builds the CLI, and runs `doctor`. Rerunning it reuses the engine and verifies the existing model file. Save the printed engine export when running LocalCoder from a different project. `doctor` reports the current memory budget, which can change as other apps use RAM.

To put the command on your terminal's `PATH`, run `bash scripts/setup-macos.sh --link` from the checkout. Then run `localcoder doctor`, `localcoder models list`, or `localcoder serve --port 8080` from any project. The link uses npm's global bin directory and points to this checkout. Keep the checkout in place and rerun setup after moving it. Unlink with `npm uninstall -g localcoder`.

## Manual install and build

From the repository root:

```bash
npm ci
npm run build
npm test
npm run doctor
```

`npm ci` installs development tools (`typescript`, `@types/node`, and `tsx`); LocalCoder has no production npm runtime dependencies.

## Engine and model locations

Recommended repository-local layout:

```text
localcoder/
├── engine/llama-server       # Windows: engine/llama-server.exe
├── engine/<companion files>  # Keep DLL/SO/DYLIB files beside the engine
└── models/<model-name>.gguf
```

Extract the entire official `llama.cpp` release archive into `engine/`; do not separate the executable from its companion libraries. Put the downloaded `.gguf` file in `models/`. Register it and verify real inference using the platform-specific commands in the setup guide.

- [Platform setup guide](SETUP-WINDOWS-LINUX-MAC.md)
- [Model download and sizing guide](MODELS.md)
- [CLI and API usage](USAGE.md)
