# Verification

## Trained models verified on 2026-11-22

The production build and typecheck passed. The complete suite passed **182/182 tests with zero failures or skips** on this 16 GB ARM64 Mac. A flaky cancellation test was reproduced with a deliberately slow child startup and corrected to measure its two-second cleanup allowance from cancellation, with a separate bounded startup watchdog.

Official Qwen 0.5B and 1.5B trained GGUF weights were downloaded at pinned revisions and checked against the publisher's SHA-256 hashes. The native engine was llama.cpp `b12241`. Live hardware profiles and memory gates remained enabled. These are trained weights, separate from the random-weight process fixtures used in earlier records.

Real testing exposed a prompt problem: models copied the literal example path `file` even when they correctly identified the code defect. In paired 1.5B edit probes, the original prompt used the wrong path in 2/2 trials; descriptive field instructions produced the correct path and fix in 2/2. The role prompts now describe fields without prefilled answer examples. This is an observed fix on the tested tasks, not a guarantee of model obedience.

| Workflow | Models | Independent tests | Result | Elapsed | Maximum observed process RSS |
| --- | --- | --- | --- | ---: | ---: |
| CLI addition fix | 1.5B for all roles | Failed before, passed after | Approved | 14.3 s | 1706.8 MB |
| CLI clamp boundaries | 1.5B for all roles | Failed before, passed after | Approved | 34.1 s | 1707.5 MB |
| HTTP/SSE addition fix | 1.5B for all roles | Failed before, passed after | Approved | 38.0 s | 1708.3 MB |
| CLI mixed planner | 0.5B planner, 1.5B coder/reviewer | Still failed | Stopped after bounded repair | 23.4 s | 1707.5 MB |
| CLI mixed coder | 1.5B planner/reviewer, 0.5B coder | Still failed | Resumable invalid-JSON error | 8.8 s | 1653.6 MB |

Each run observed at most one model process at a time and zero remaining observed child processes. The successful runs used the same trained model in all three roles, with separate loads. Distinct-model switching was exercised in the failed runs; those results do not establish reliable mixed-model task completion. RSS was sampled every 200 ms and is neither a guaranteed peak nor a complete GPU-memory measurement.

The normal `verify` command also passed every step with the 1.5B model after the fix, including a separate independently retested coding task. Verification reports now record terminal generation evidence and label text fragments as text chunks rather than generated-token throughput. Empty random-weight output remains a quality failure even when transport completes.

See [machine-readable trained-model results](trained-model-validation.json) for pinned artifacts, cases, cleanup observations, failures, and limitations. These small fixtures are not a repository-scale quality benchmark, an IDE-extension compatibility test, or proof of superiority over another product. Model binaries remain in ignored local `models/` and `engine/` directories and are not committed to Git.

## Sequential workflow verified on 2026-11-18

Typecheck and production build passed on macOS ARM64, Node.js 25.9.0, using the official llama.cpp `b12241` binary. The complete updated suite ran 181 tests: 179 passed, none failed or were canceled, and two skipped because the live safe-memory budget could not fit the fixture. Dependencies were already installed; this continuation did not repeat clean-install or Node 22 verification.

New coverage includes exact configured model selection, per-role tokenizer/context fitting, one resident at a roomy budget, concurrent-request exclusion, queued cancellation, cancellation during startup and tokenization, resource-policy refresh after leases drain, reviewer rejection and coder repair, no-change review, failed full tests blocking approval, malformed review responses, persisted assignments, and resumed review validation, including targeted-only and syntax-only configurations after external edits. HTTP integration used three scripted role backends, actual file edits in a disposable repository, real `node --test` subprocesses, and persisted reviewer approval. The normal CLI entry point also completed all three roles using isolated HTTP engine fixtures and a fixed test hardware profile, with actual edits, test subprocesses, and saved approval. A separate CLI case exercised an honest constrained/mock-response failure. A separate smoke run repeated the successful three-role task against the compiled `dist/cli/index.js`, again with actual repository checks and persisted approval.

The real-engine workflow test used three separate random-weight GGUF fixtures. Each role loaded, counted tokens, generated with actual engine token usage, and exited before the next process spawned. Peak live workflow model processes was **one**. The final record below includes the observed RSS and acquisition timings. Concurrent real backend loads also verified distinct OS-assigned ports and child aliases. This catches a discovered startup race where a backend could otherwise accept another process's health response.

| Role | Acquisition (ms) | Observed RSS (MB) |
| --- | ---: | ---: |
| planner | 349 | 95.3 |
| coder | 310 | 94.3 |
| reviewer | 318 | 93.2 |

Acquisition times come from a focused follow-up run; they are observations for tiny fixtures, not performance forecasts for trained models.

Cancellation regressions cover stopping immediately after an announced edit, a stalled startup, and a stalled HTTP tokenizer; canceled work releases the model queue and child process. Edit and formatter regressions also force index refresh failures after successful writes, then verify retained backup metadata and actual undo. Reviewer scope tests use five real edited files to verify explicit omitted-context disclosure and a complete diff. Real upstream chat/FIM cancellation still releases leases and processes. Random byte-token fixtures can produce no visible text despite consuming generated tokens, so protocol checks use terminal events and engine usage rather than counting text fragments as tokens.

An independent eight-lens code review, final validation, and focused follow-ups completed with no unresolved actionable findings. Fixes were recorded as separate timestamped commits.

These checks establish workflow coordination and real process lifecycle. They do not establish trained-model planning, coding, or review quality. The live profiler reported high memory pressure (initial safe budget about 0.56 GB, later 0 GB), so the user-facing trained-model path was not forced past its memory gate. Full workflow correctness uses deterministic role replies with real repository validation; engine lifecycle tests use a fixed test profile to isolate switching from host memory fluctuations. Larger-than-memory models and selective tensor loading remain outside this implementation.

## Verified on 2026-11-15

The source at that date passed clean dependency installation, strict type-checking, compilation, and the complete automated suite on macOS ARM64 with llama.cpp build `b12241`.

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
