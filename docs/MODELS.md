# Models and the inference engine

localcoder does not download anything itself. You provide two real components:

For exact Windows, Linux, and macOS download choices, extraction steps, and destination folders, follow [SETUP-WINDOWS-LINUX-MAC.md](SETUP-WINDOWS-LINUX-MAC.md).

1. **`llama-server`** (the llama.cpp inference server) — see [INSTALL.md](INSTALL.md) §3.
2. **One or more GGUF model files.**

## Register a model (preferred): `localcoder models add`

```bash
localcoder models add ~/models/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf
```

This reads the GGUF header (it never loads the weights) and records the model's real facts — layer count, KV heads, head dimension, context length, quantization, whether it has fill-in-middle tokens and a tool-capable chat template — in `registry/models.local.json`. With those facts the router computes the KV cache **exactly** instead of guessing, and can shrink context/KV precision to fit your memory before refusing. `localcoder models remove <id>` undoes it.

`estimated_memory_gb` is set to file size + 8% — still an **estimate**. Run `localcoder verify` to see the real resident memory of `llama-server` with your model.

## Where to get files

Download the engine from the official [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases). For a starter model, use the official [Qwen2.5-Coder-0.5B-Instruct-GGUF page on Hugging Face](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF), choose the `Q4_K_M` `.gguf` file, and place it in the repository `models/` folder. See the platform guide for the complete layout and commands.


| What | Where | Notes |
|---|---|---|
| llama.cpp binaries | https://github.com/ggml-org/llama.cpp/releases | `llama-b<NNNN>-bin-ubuntu-x64.tar.gz` (Linux CPU), `…-ubuntu-vulkan-x64.tar.gz`, `…-macos-arm64.tar.gz` (Apple Silicon, Metal), `…-win-cpu-x64.zip`. Extract the whole folder. |
| Qwen2.5-Coder 0.5B / 1.5B / 3B / 7B | `Qwen/Qwen2.5-Coder-<size>-Instruct-GGUF` or `bartowski/Qwen2.5-Coder-<size>-Instruct-GGUF` on Hugging Face | Take the `Q4_K_M` file. Approximate sizes: 0.4 GB, ~1 GB, ~1.9 GB, ~4.4 GB. |

Pick by memory, not ambition: run `localcoder doctor` first. The safe budget is *free RAM − OS reserve − margin*, and weights + KV cache + 1 GB (runtime overhead + margin) must fit inside it. On a ~4 GB machine that means roughly a 0.5B–1.5B model; on 8 GB, 3B–4B; on 16 GB, 7B–14B.

## Shipped registry entries (`registry/models.json`)

These are **size estimates and placeholder paths**; the shipped list is never auto-downloaded. Prefer `models add` so the path and architecture facts are real. File names follow the common bartowski convention (`Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`) under `models/`.

| id | approx. weights | note |
|---|---|---|
| qwen2.5-coder-0.5b-q4 / 1.5b / 3b | 0.45 / 1.0 / 2.0 GB | have fill-in-middle tokens |
| qwen2.5-coder-7b / 14b / 32b-q4 | 5 / 9 / 20 GB | |
| gpt-oss-20b-mxfp4, devstral-small-2-24b-q4, qwen3-coder-30b-a3b-q4 | 14 / 13 / 18.6 GB | from the research pass; sizes not re-measured |

An earlier version listed a `qwen3.5-coder-4b` entry. That name was never verified to exist and has been removed.

## No model yet? A random-weight test model (plumbing only)

```bash
npm run make-test-model -- /tmp/tiny.gguf [headDim]      # headDim 16 (default) or 32, 64, 128
localcoder verify --llama-server <path> --model /tmp/tiny.gguf
```

This writes a REAL GGUF (2-layer llama architecture, random weights, byte tokenizer with fill-in-middle tokens) that a real `llama-server` loads and runs. Its output is gibberish by design, so it can prove the plumbing (load, tokenizer, streaming, `/infill`, KV flags, memory measurement) and that `verify` fails honestly on model-quality steps — it says nothing about real coding quality.

## Engine constraints found by running the real server

- A quantized KV cache (`q8_0`/`q4_0`) needs the quantization block size (32) to divide the model's head dimension. The router avoids quantized KV for models whose head dimension is known and not a multiple of 32.
- `llama-server` keeps a prompt cache in host RAM (`--cache-ram`, default 8192 MiB). localcoder passes `--cache-ram 0` so the memory budget it enforces is not silently exceeded.
- `--ctx-size` is shared across server slots; localcoder passes `--parallel 1` so the router's context size is what each request actually gets.

## Verify everything for real

```bash
localcoder verify --llama-server /path/to/llama-b1234/llama-server --model ~/models/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf
```

Runs against the real server and real model: hardware + policy → binary check → GGUF read → memory gate → load (measures RSS) → real tokenizer → chat → fill-in-middle → "can this model follow the agent's JSON contract?" → the agent fixing a bug in a tiny real repo, confirmed by re-running that repo's tests independently. It writes `verify-report.json`. Exit code 0 = all passed, 1 = something failed, 2 = a required component is missing (it tells you which, with the download name). Nothing in it is mocked.
