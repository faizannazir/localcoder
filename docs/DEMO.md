# Run the trained-model demo

The demo uses Qwen2.5-Coder 1.5B Q4_K_M for the planner, coder, and reviewer. It creates a disposable JavaScript workspace. The original test fails, the agent repairs the addition function, and the demo independently reruns the original test after review. It then runs undo and checks that the source and test are restored byte for byte.

From a source checkout on Apple Silicon:

```bash
bash scripts/setup-macos.sh
node scripts/demo.cjs
```

The demo prints the selected model roles, tool results, final diff, and undo result. Exit code zero means the trained model completed the task, passed review and independent testing, and the original files were restored. A memory refusal or model error yields a nonzero exit. The fixture is removed on exit.

The first failing assertion is expected. If the agent reports that a role does not fit the memory budget, the message shows the budget measured at that role and the smallest model configuration tried. Close memory-heavy applications and rerun `node scripts/demo.cjs`. There is no need to reinstall. The earlier `doctor` output is a separate snapshot, and its suggested model does not control the demo's role assignments.

The same weights load separately for each role. The live memory policy is active throughout. This is a small reproducible coding task, and model output can vary between runs. See [trained-model verification](VERIFICATION.md#trained-models-verified-on-2026-11-22) for measured results and failed mixed-model attempts.
