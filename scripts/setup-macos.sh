#!/usr/bin/env bash
# Run from a source checkout. Downloads stay in Git-ignored directories.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ $# -gt 1 || ($# -eq 1 && "$1" != --link) ]]; then
  echo "Usage: bash scripts/setup-macos.sh [--link]" >&2
  exit 1
fi

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This installer supports Apple Silicon Macs. See docs/SETUP-WINDOWS-LINUX-MAC.md." >&2
  exit 1
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null ||
   ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(Number(major < 22 || (major === 22 && minor < 13)))'; then
  echo "Install Node.js 22.13 or newer and npm first." >&2
  exit 1
fi

mkdir -p .localcoder
scratch="$(mktemp -d "$PWD/.localcoder/setup.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
verify_file() {
  printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c -
}
download() {
  curl --fail --location --retry 2 --proto '=https' --proto-redir '=https' "$1" -o "$2"
  verify_file "$3" "$2"
}

release=b12241
archive="llama-$release-bin-macos-arm64.tar.gz"
engine="engine/llama-$release/llama-server"
model="models/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf"
model_hash=cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046
mkdir -p engine models

if [[ ! -x "$engine" ]]; then
  download "https://github.com/ggml-org/llama.cpp/releases/download/$release/$archive" "$scratch/$archive" 34dd4385b3f428d78248131dca766ae0cc6f34e29d1ae93a9942d53a7c83595d
  if [[ -e "engine/llama-$release" || -L "engine/llama-$release" ]]; then
    echo "Incomplete engine at engine/llama-$release. Move it aside before retrying." >&2
    exit 1
  fi
  tar -xzf "$scratch/$archive" -C "$scratch"
  [[ -x "$scratch/llama-$release/llama-server" ]]
  mv "$scratch/llama-$release" engine/
fi
"$engine" --version
if [[ -e "$model" ]]; then
  verify_file "$model_hash" "$model"
else
  download 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/f86cb2c1fa58255f8052cc32aeede1b7482d4361/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf' "$scratch/model.gguf" "$model_hash"
  mv "$scratch/model.gguf" "$model"
fi

npm ci
npm run build
LOCALCODER_LLAMA_SERVER_BIN="$PWD/$engine" node dist/cli/index.js doctor
if [[ ${1:-} == --link ]]; then
  npm link --offline
  node - "$PWD/$engine" <<'NODE'
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { userEngineDir, installedEnginePath } = require("./dist/util/paths");
const dir = userEngineDir();
if (!installedEnginePath()) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "current.json"), JSON.stringify({ binary: process.argv[2] }) + "\n", { mode: 0o600 });
}
NODE
  printf '\nRun localcoder doctor from any project. If the command is missing, add %s/bin to PATH.\n' "$(npm prefix -g)"
else
  printf '\nTo use the engine from any project, run:\nexport LOCALCODER_LLAMA_SERVER_BIN=%q\n' "$PWD/$engine"
fi
