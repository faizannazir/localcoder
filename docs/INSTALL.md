# Install LocalCoder

For the complete, copy-paste setup for **Windows, Linux, and macOS**, including exact download types and folder locations, see [SETUP-WINDOWS-LINUX-MAC.md](SETUP-WINDOWS-LINUX-MAC.md).

## Prerequisites

- **Node.js 22.13 or newer** and npm.
- The LocalCoder repository (clone it or extract its ZIP).
- For real inference: a platform-matched `llama-server` executable and at least one compatible `.gguf` model file. LocalCoder does not download either automatically.

## Install and build

From the repository root:

```bash
npm install
npm run build
npm test
npm run doctor
```

`npm install` installs development tools (`typescript`, `@types/node`, and `tsx`); LocalCoder has no production npm runtime dependencies.

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
