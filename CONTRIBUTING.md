# Contributing to LocalCoder

Bug reports, reproducible model evaluations, platform fixes, and documentation improvements are welcome. For a larger change, discuss the use case in an issue before building it.

## Set up a development checkout

Use Node.js 22.13 or newer and npm. From the repository root:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Most tests run without downloading a model. Set `LOCALCODER_LLAMA_SERVER_BIN` to a compatible executable to include the real-engine cases. Those tests use small generated fixtures to check engine behavior. The [trained-model demo](docs/DEMO.md) checks coding behavior with actual weights. See the [installation guide](docs/INSTALL.md) for setup.

## Submit a change

1. Create a branch. Keep each commit focused on one change.
2. Exercise the affected CLI command or API endpoint. Add a regression test when existing tests would miss the failure.
3. Run the relevant checks, then open a pull request with the motivation, tested commands, outcomes, and any platform or model limitations.

For bug reports, include the LocalCoder revision, Node.js version, OS and architecture, and the smallest reproduction you can share. For inference issues, include the model and quantization, llama.cpp build, and relevant memory or policy output from `doctor`. Redact API tokens and private paths or code. Keep downloaded weights, engines, and workspace state out of commits.

## Where to start

- Installer and documentation improvements with a clean-checkout reproduction.
- Model behavior reports that include independent test results and record failures as well as successes.
- Windows and Linux verification with a named engine build and hardware profile.

See [SECURITY.md](SECURITY.md) for private reporting of security issues. Contributions are handled under the repository's [license](LICENSE).
