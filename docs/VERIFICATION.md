# Verification

## Verified on 2026-11-15

The current source passed clean dependency installation, strict type-checking, compilation, and the complete automated suite on macOS ARM64 with llama.cpp build `b12241`.

| Runtime | Tests | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- |
| Node.js 25.9.0 | 153 | 151 | 0 | 2 |
| Node.js 22.23.5 | 153 | 151 | 0 | 2 |

The two skipped checks required enough live memory for CLI verification and model-loaded server shutdown. The actual resource policy rejected their synthetic model under the observed memory budget. Other real-engine checks exercised GGUF loading, tokenization, chat, fill-in-middle, quantized KV caches, the HTTP API, and backend process cleanup.

The security and reliability regressions cover temporary-file symlinks, protected-path case variants, concurrent model loads, active request leases, partial undo retries, descendant-process timeouts, body-size limits, request validation, disconnected streams, and abandoned queued agent requests. Request validation also passed 12 consecutive focused runs comprising 60 test cases after an intermittent reset was corrected.

The built CLI was started on an ephemeral localhost port and checked using real HTTP requests. Model and resource requests returned `200`, malformed JSON returned `400`, an untrusted origin returned `403`, and a chat request without installed models returned `503` with the registration command. SIGTERM exited successfully and closed the listening port.

A disposable JavaScript project was indexed and queried through the built CLI. Symbol search found `add`, and context assembly included its implementation and test within a 4096-token budget. README and documentation links were checked after directory and file renaming.

An eight-lens code review and focused follow-up completed with zero remaining actionable findings. The fixes were committed and pushed individually to `main` in the private repository.

The generated GGUF fixtures use random weights. Trained-model coding quality and execution on Windows and Linux remain unverified in this run. The historical records below retain their original environment-specific findings.

## Historical record from 2026-10-28

## Result

**Real inference is BLOCKED in this validation environment.** No `llama-server` executable or GGUF model is present. No real-model task was attempted, and no model-quality, TTFT, tokens/sec, or agent-task success claims are made.

This report records checks performed against the supplied `localcoder-checkpoint.zip`. It does not overwrite the separate historical real-server results documented in `TECHNICAL-NOTES.md` under Real inference verification; those used a different environment and a random-weight fixture model, not a coding model.

## Environment observed

- OS: Linux, kernel `6.18.55`
- Architecture: x86_64
- Node.js: `v22.16.0`
- npm: `10.9.2`
- CPU reported by `doctor`: 3 cores, SSE4.2/AVX2
- RAM reported by `doctor`: 5.81 GB total, 4.54 GB available
- LocalCoder safe memory budget: 3.04 GB
- GPU: CPU backend; thermal sensor confidence low / state unknown
- `llama-server`: not found on PATH or in the repository's expected `engine/` location
- `*.gguf`: none found in the searched workspace/model locations

## Commands and observed outcomes

| Check | Outcome | Evidence / limitation |
|---|---|---|
| `npm test` | BLOCKED | `tsx: not found`; dependencies are not installed in the archive. |
| `npm install --ignore-scripts --no-audit --no-fund` | BLOCKED | Timed out in this environment; no `node_modules` was produced. |
| `tsc` | BLOCKED as a clean build | Global TypeScript `5.8.3` ran without the project's declared dependencies. Errors were dominated by missing Node.js declarations (`@types/node` absent), plus related ambient-type errors. This is not evidence of a clean project build. |
| `node dist/cli/index.js doctor` | PASS | Compiled CLI ran and reported the environment and a 3.04 GB safe memory budget. `node:sqlite` emitted its expected ExperimentalWarning. |
| `node dist/cli/index.js verify --json-trials 1 --report /tmp/localcoder-verify-report.json` | BLOCKED, exit 2 | The real verification command correctly stopped before inference because both `llama-server` and a downloaded/selected model were missing. JSON report is preserved in [`verification-report.json`](verification-report.json). |
| Real `/v1/chat/completions` and `/v1/agent/run` with a coding model | NOT RUN | Missing engine and model; no mock was substituted for this result. |
| Insufficient-memory rejection / zero-spawn safety test | NOT independently run in this checkpoint environment | The real verify command stopped at missing prerequisites. Run the test suite after installing dependencies to validate the automated safety tests. |

## Minimal setup to unblock real inference

1. Install the project's declared development dependencies in a network-enabled environment:
   ```bash
   npm install
   ```
2. Obtain the complete Linux x64 CPU release bundle of `llama.cpp` from the official releases page and extract the entire bundle so any required shared libraries remain beside `llama-server`:
   `https://github.com/ggml-org/llama.cpp/releases`
3. Obtain a small, compatible coding GGUF that fits the current **3.04 GB safe budget**. A Q4 1.5B-class model is the intended starting point; verify the actual file size, runtime overhead, and context requirement rather than assuming it fits. Do not attempt a 7B model in this environment.
4. Run the checks with explicit paths:
   ```bash
   npm test
   npm run build
   npm run doctor
   node dist/cli/index.js verify \
     --llama-server /absolute/path/to/llama-server \
     --model /absolute/path/to/coder.gguf \
     --report verify-report.json
   ```
5. Only claim real agent-task success if the report's real backend/model steps pass and a repository task actually produces a verified patch. A random-weight fixture can validate server plumbing, but cannot validate coding quality.

## Conclusion

The supplied checkpoint contains the Phase 2 implementation and its real-backend verification path. In this execution environment, the CLI's prerequisite gate behaves correctly, but **full tests/build and real coding-model validation remain blocked** by missing npm dependencies, `llama-server`, and GGUF weights. Preserve this distinction in release notes and marketing claims.
