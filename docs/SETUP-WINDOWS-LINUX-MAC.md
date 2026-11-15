# LocalCoder setup: Windows, Linux, and macOS

This guide installs LocalCoder with a **real local model**. You need three things: Node.js/npm for LocalCoder, a platform-matched `llama-server` executable, and a `.gguf` model file. LocalCoder does not automatically download the engine or model.

> **Quick recommendation:** start with the Qwen2.5-Coder 0.5B Instruct model in `Q4_K_M` quantization (roughly 0.4 GB). It is small enough for initial setup and plumbing checks, but it is a small model and should not be expected to perform like a larger coding model. Choose a larger model only if `localcoder doctor` shows enough safe memory.

## 1. Requirements

- **Node.js 22.5 or newer** and npm. Check with `node --version` and `npm --version`.
- Git, or a downloaded ZIP of the LocalCoder repository.
- A few GB of free disk space for the repository, dependencies, engine archive, and model.
- Internet access to download dependencies, the engine, and the model. Once downloaded, inference runs locally.
- For model selection, run `npm run doctor`; do not choose a model by file size alone.

## 2. Download the two inference files

### A. `llama-server` engine

Open the official [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases) and download the **prebuilt archive matching your OS and CPU**. Asset names can change between releases, so select by platform in the release assets rather than copying a version number from an old guide.

| Platform | Choose this kind of release asset | Expected executable after extraction |
|---|---|---|
| Windows x64, CPU | `llama-b<build>-bin-win-cpu-x64.zip` | `llama-server.exe` |
| Linux x64, CPU | `llama-b<build>-bin-ubuntu-x64.tar.gz` | `llama-server` |
| macOS Apple Silicon (M1/M2/M3/M4) | `llama-b<build>-bin-macos-arm64.tar.gz` | `llama-server` |
| macOS Intel | Choose a macOS x64 asset if the release provides one; otherwise use Homebrew (`brew install llama.cpp`) or build from source | `llama-server` |
| Linux with a supported Vulkan GPU | `llama-b<build>-bin-ubuntu-vulkan-x64.tar.gz` | `llama-server` |

`<build>` is a release-specific build number. For an NVIDIA/CUDA system or a different CPU architecture (including Linux ARM), select a matching asset from the current release if available; otherwise use the official install/build options. Do not use the CPU-only archive expecting CUDA acceleration. See the [llama.cpp installation guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md).

**Extract the entire archive**, not just the executable. Keep the accompanying `.dll`, `.so`, `.dylib`, and other files together with `llama-server`. LocalCoder may fail to start if those companion libraries are separated.

### B. GGUF model

Open the [official Qwen2.5-Coder-0.5B-Instruct-GGUF model page on Hugging Face](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF). Open **Files and versions**, choose the `Q4_K_M` `.gguf` file, and download it. If Hugging Face presents several quantizations, choose `Q4_K_M`, not a Transformers `.safetensors` file.

Place/rename the downloaded file to:

`<LocalCoder repository>/models/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf`

The `models/` folder is in the repository root, alongside `src/`, `docs/`, and `package.json`. Keep the `.gguf` file intact; do not unzip it.

You may use a different compatible GGUF model. Update the path in the commands below and register that file with `models add`.

## 3. Where files go

After setup, the repository should look like this (the engine's companion libraries stay in `engine/` too):

```text
localcoder/
├── docs/
├── engine/
│   ├── llama-server.exe       # Windows; use llama-server on Linux/macOS
│   ├── *.dll                  # Windows companion libraries, if supplied
│   ├── *.so                   # Linux companion libraries, if supplied
│   └── *.dylib                # macOS companion libraries, if supplied
├── models/
│   └── Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf
├── package.json
├── registry/
├── src/
└── ...
```

The `.dll`, `.so`, and `.dylib` entries above are examples of possible platform-specific files, not files you should create yourself. Extract the release archive into `engine/` so `llama-server` (or `llama-server.exe`) is directly inside that directory. If the archive creates a nested directory, move its **contents** into `engine/` while keeping all companion files beside the executable.

`engine/` and `models/*.gguf` are intentionally ignored by Git so large binaries and model weights are not committed to the repository.

## 4. Install LocalCoder dependencies and build

Run these commands from the repository root (`localcoder/`) on all three platforms:

```bash
npm install
npm run build
npm test
```

The project has no production npm runtime dependencies; `npm install` installs the development tools used for TypeScript compilation and tests. If `npm test` or `npm run build` fails, resolve that before relying on the agent. On Windows, use PowerShell or Windows Terminal; on Linux/macOS, use your usual terminal.

## 5. Platform-specific extraction and checks

### Windows (PowerShell)

1. Extract the release ZIP into `<repo>\engine\`.
2. Confirm the executable and model exist:

```powershell
Test-Path .\engine\llama-server.exe
Test-Path .\models\Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf
```

3. If you put the executable somewhere else, use its absolute path in `--llama-server` (see verification below). If Windows blocks the downloaded archive, use the normal Windows file properties/security prompt only after verifying that it came from the official release page.

### Linux

1. Extract the `.tar.gz` archive into `engine/` from the repository root. For example, if the downloaded archive is in `~/Downloads`:

```bash
mkdir -p engine
# Replace the archive name with the exact downloaded asset name.
tar -xzf ~/Downloads/llama-b<build>-bin-ubuntu-x64.tar.gz -C engine
```

If it extracted a nested folder, move its contents so `engine/llama-server` exists and its libraries remain beside it. Then:

```bash
chmod +x engine/llama-server
./engine/llama-server --version
```

### macOS

1. For an Apple Silicon Mac, download the `macos-arm64` archive and extract it into `engine/`.
2. Ensure `engine/llama-server` exists and its companion files remain beside it:

```bash
chmod +x engine/llama-server
./engine/llama-server --version
```

If macOS reports that the downloaded binary cannot be opened, first confirm that you downloaded the correct official release and architecture. Do not disable macOS security globally to work around a download issue.

## 6. Register the model and run checks

From the repository root, run:

**Windows PowerShell**

```powershell
node .\dist\cli\index.js models add .\models\Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf
npm run doctor
node .\dist\cli\index.js verify --llama-server .\engine\llama-server.exe --model .\models\Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf --report verify-report.json
```

**Linux / macOS**

```bash
node dist/cli/index.js models add ./models/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf
npm run doctor
node dist/cli/index.js verify --llama-server ./engine/llama-server --model ./models/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf --report verify-report.json
```

`models add` reads the GGUF header and saves a local registry entry under your home directory (`~/.localcoder/models.local.json` on Linux/macOS; the equivalent home directory on Windows). It does not copy the model; keep the model file at the path you registered. If you move it later, register it again.

The `verify` command performs a real end-to-end check with the supplied binary and model, including loading, tokenization, generation, fill-in-middle where supported, and a small agent task. It creates `verify-report.json` in the current directory. Exit code `0` means all checks passed; `1` means a check failed; `2` means a required component is missing. A successful `doctor` alone does **not** prove that real inference works.

## 7. Start LocalCoder

After verification passes:

```bash
npm start -- serve
```

The API is served locally; see [USAGE.md](USAGE.md) for endpoints and CLI commands. Keep the server bound to localhost unless you intentionally configure and secure network access.

To try the request pipeline without downloading the engine/model, use `npm run serve:mock`. It returns explicitly labelled mock output and is **not real model inference**.

## 8. Optional: keep engine and models outside the repository

If you prefer a separate location, keep the complete engine release together and set the executable path explicitly. LocalCoder supports `LOCALCODER_LLAMA_SERVER_BIN` and the `--llama-server` verification flag. For example:

- Windows PowerShell: `$env:LOCALCODER_LLAMA_SERVER_BIN = 'D:\AI\llama\llama-server.exe'`
- Linux: `export LOCALCODER_LLAMA_SERVER_BIN="$HOME/.localcoder/engine/llama-server"`
- macOS: `export LOCALCODER_LLAMA_SERVER_BIN="$HOME/.localcoder/engine/llama-server"`

Use the actual path on your machine. Keep all engine companion libraries next to the executable. Models can live anywhere accessible; register the absolute model path using `models add`.

## Troubleshooting

- **`llama-server NOT found`**: check the path and filename. Windows needs `llama-server.exe`; Linux/macOS normally use `llama-server`. Pass the full path to `--llama-server` when verifying.
- **Missing shared library / DLL**: re-extract the entire release archive and keep all files together; do not copy only the executable.
- **Model missing / no model fits**: confirm the `.gguf` path, run `models add` again if it moved, and run `npm run doctor`. A larger context window and larger model require more memory.
- **Out of memory / very slow inference**: use a smaller quantization/model or reduce the context setting through the project’s supported configuration. Do not assume the model's advertised maximum context fits your RAM.
- **Tests say `tsx` is missing**: run `npm install` in the repository root and check that it completed successfully.
- **Network blocked**: download the release archive and GGUF from a machine with internet access, transfer them to this machine, and place them in the folders above. No runtime internet access is required once all files are present.
