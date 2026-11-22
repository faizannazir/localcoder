# Contributing to LocalCoder

Bug reports, reproducible model evaluations, platform fixes, and documentation improvements are welcome. Check existing issues before starting. Use the bug or feature form to share a reproduction or discuss a larger change. [Open issues](https://github.com/faizannazir/localcoder/issues) · [New issue](https://github.com/faizannazir/localcoder/issues/new/choose)

## Set up a development checkout

Fork and clone the repository. Use Node.js 22.13 or newer and npm. From the checkout:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Most tests run without downloading a model. Set `LOCALCODER_LLAMA_SERVER_BIN` to a compatible executable to include the real-engine cases. Those tests use small generated fixtures to check engine behavior. The [trained-model demo](docs/DEMO.md) checks coding behavior with actual weights. See the [installation guide](docs/INSTALL.md) for setup.

To work on the agent without running the full suite on every change, run `node --import tsx --test test/agent/*.test.ts` from the checkout, then run the full suite before submitting.

## Submit a change

1. Create a branch. Keep each commit focused on one change.
2. Exercise the affected CLI command or API endpoint. Add a regression test when existing tests would miss the failure.
3. Run the relevant checks, then open a pull request with the motivation, tested commands, outcomes, and any platform or model limitations.

For bug reports, include the LocalCoder revision, Node.js version, OS and architecture, and the smallest reproduction you can share. For inference issues, include the model and quantization, llama.cpp build, and relevant memory or policy output from `doctor`. Redact API tokens and private paths or code. Keep downloaded weights, engines, and workspace state out of commits.

## Where to start

- Follow the [installation guide](docs/INSTALL.md) from a clean checkout. Report any step that fails or requires an undocumented command.
- Run the [trained-model demo](docs/DEMO.md). Share the model ID, engine build, hardware, and independent test result.
- Verify [Windows or Linux setup](docs/SETUP-WINDOWS-LINUX-MAC.md). Include the operating system, CPU architecture, and whether the engine started.

See [SECURITY.md](SECURITY.md) for private reporting of security issues. Contributions are handled under the repository's [license](LICENSE).
