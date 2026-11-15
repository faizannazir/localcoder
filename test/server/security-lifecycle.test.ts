import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, existsSync } from "fs";
import { spawn, spawnSync } from "child_process";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { pathToFileURL } from "url";
import { HardwareProfiler } from "../../src/hardware/profiler";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import { DefaultModelRouter } from "../../src/router/router";
import { isRejection } from "../../src/types/index";
import { buildContext, createServer } from "../../src/server/index";
import { securityFromEnv } from "../../src/server/security";
import { resolveCommand, runCommand } from "../../src/agent/command-runner";
import { locateLlamaServer, userDataDir } from "../../src/util/paths";
import { installedOnly, resolveModelPath } from "../../src/router/registry";
import { entryFromGguf } from "../../src/inference/gguf";
import { writeTinyModel } from "../../scripts/tiny-model";
import { FAKE_PROFILE } from "../agent/helpers";

const entry = (id: string, file: string) => ({ model_id: id, architecture: "dense", parameter_count: { total: 0.1 }, quantization: "Q4_K_M", file_path: file, context_limit: 4096, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: ["fim"] });

async function start(opts: { token?: string; origins?: string[] } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "lc-sec-"));
  mkdirSync(path.join(base, "registry"), { recursive: true });
  writeFileSync(path.join(base, "registry", "models.json"), JSON.stringify([entry("t", "x.gguf")]));
  const ctx = buildContext({ baseDir: base, backend: "mock", repoRoot: base });
  ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
  const server = createServer(ctx, { token: opts.token, allowedOrigins: opts.origins ?? [], extraHosts: [] });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, cleanup: async () => { (server as any).closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); rmSync(base, { recursive: true, force: true }); } };
}

/** Raw HTTP so we can set Host/Origin exactly like a browser/attacker would (fetch() won't let us forge Host). */
function raw(port: number, method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Connection: "close", ...headers } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const CHAT = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

test("SECURITY: the CSRF / DNS-rebinding attack that worked before the fix is now refused (foreign Host, foreign Origin, text/plain POST)", async () => {
  const s = await start();
  try {
    const good = { Host: `127.0.0.1:${s.port}`, "Content-Type": "application/json" };
    assert.equal((await raw(s.port, "POST", "/v1/chat/completions", good, CHAT)).status, 200, "legitimate local client still works");
    assert.equal((await raw(s.port, "GET", "/v1/models", { Host: `localhost:${s.port}` })).status, 200);
    const rebind = await raw(s.port, "POST", "/v1/chat/completions", { ...good, Host: "evil.example" }, CHAT);
    assert.equal(rebind.status, 403); assert.match(rebind.body, /DNS-rebinding/);
    const cross = await raw(s.port, "POST", "/v1/chat/completions", { ...good, Origin: "http://evil.example" }, CHAT);
    assert.equal(cross.status, 403); assert.match(cross.body, /Cross-origin/);
    assert.equal((await raw(s.port, "POST", "/v1/agent/run", { Host: good.Host, "Content-Type": "text/plain" }, JSON.stringify({ task: "rm everything" }))).status, 415);
    assert.equal((await raw(s.port, "OPTIONS", "/v1/agent/run", { Host: good.Host, Origin: "http://evil.example", "Access-Control-Request-Method": "POST" })).status, 403, "CORS preflight is not granted");
    assert.equal((await raw(s.port, "GET", "/v1/models", { Host: good.Host, Origin: "http://evil.example" })).status, 403);
  } finally { await s.cleanup(); }
});

test("SECURITY: an allowed origin works; LOCALCODER_API_TOKEN enforces a bearer token", async () => {
  const s = await start({ token: "s3cret-token", origins: ["http://localhost:5173"] });
  try {
    const h = { Host: `127.0.0.1:${s.port}`, "Content-Type": "application/json", Origin: "http://localhost:5173" };
    assert.equal((await raw(s.port, "POST", "/v1/chat/completions", h, CHAT)).status, 401);
    assert.equal((await raw(s.port, "POST", "/v1/chat/completions", { ...h, Authorization: "Bearer wrong" }, CHAT)).status, 401);
    assert.equal((await raw(s.port, "POST", "/v1/chat/completions", { ...h, Authorization: "Bearer s3cret-token" }, CHAT)).status, 200);
    assert.equal((await raw(s.port, "GET", "/v1/models", { Host: h.Host })).status, 401);
  } finally { await s.cleanup(); }
  assert.deepEqual(securityFromEnv({ LOCALCODER_API_TOKEN: "t", LOCALCODER_ALLOWED_ORIGINS: "http://a, http://b" } as any), { token: "t", allowedOrigins: ["http://a", "http://b"], extraHosts: [] });
});

test("WINDOWS commands: npm/npx/pnpm/yarn use a shell ONLY with plain-token args; injection attempts are refused; other commands never use a shell", () => {
  assert.deepEqual(resolveCommand(["npm", "test", "--silent"], "win32"), { command: "npm.cmd", args: ["test", "--silent"], shell: true });
  for (const evil of ["&calc", "a b", "x|y", "$(id)", '"q"', "%PATH%", "a;b", "<f", "^x", "`id`"]) assert.ok("error" in (resolveCommand(["npm", "test", evil], "win32") as any), `must refuse ${evil}`);
  assert.deepEqual(resolveCommand(["node", "--test", "a b.js"], "win32"), { command: "node", args: ["--test", "a b.js"], shell: false });
  assert.deepEqual(resolveCommand(["npm", "test"], "linux"), { command: "npm", args: ["test"], shell: false });
});

test("runCommand reports an unstartable command as spawn_error instead of throwing", async () => {
  assert.ok((await runCommand(["definitely-not-a-real-binary-xyz"], os.tmpdir(), { timeout_ms: 2000, max_bytes: 1000 })).spawn_error);
});

test("ROUTING: with the real engine only INSTALLED models are offered; with none installed the error says how to fix it", async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "lc-inst-"));
  try {
    const real = path.join(d, "present.gguf"); writeTinyModel(real);
    const present = entryFromGguf(real);
    const missing = { ...present, model_id: "ghost", file_path: path.join(d, "ghost.gguf") };
    assert.deepEqual(installedOnly([missing, present] as any).map((e) => e.model_id), [present.model_id]);
    assert.equal(resolveModelPath(missing as any), null);
    const base = path.join(d, "base"); mkdirSync(path.join(base, "registry"), { recursive: true });
    writeFileSync(path.join(base, "registry", "models.json"), JSON.stringify([missing]));
    const ctx = buildContext({ baseDir: base, backend: "llama", repoRoot: d });
    assert.equal(ctx.registry.length, 0);
    ctx.profiler = { sample: async () => ({ ...FAKE_PROFILE }), onChange: () => () => {} };
    const server = createServer(ctx);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await raw(port, "POST", "/v1/chat/completions", { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" }, CHAT);
      assert.equal(r.status, 503);
      assert.match(r.body, /No models are installed\. Run `localcoder models add <file\.gguf>`/);
    } finally { (server as any).closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("user data lives in LOCALCODER_HOME: `models add` writes there and `models` lists it; the engine locator honours explicit > env", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lc-home-"));
  try {
    assert.equal(userDataDir({ LOCALCODER_HOME: home } as any), home);
    const gg = path.join(home, "Tiny-Test-Model.gguf"); writeTinyModel(gg);
    const CLI = path.join(__dirname, "../../src/cli/index.ts");
    const env = { ...process.env, LOCALCODER_HOME: home };
    const add = spawnSync("npx", ["tsx", CLI, "models", "add", gg], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(add.status, 0, add.stderr);
    assert.ok(existsSync(path.join(home, "models.local.json")));
    assert.match(spawnSync("npx", ["tsx", CLI, "models"], { env, encoding: "utf8", timeout: 60_000 }).stdout, /tiny-test-model\s.*yes/);
    const fake = path.join(home, "llama-server");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755);
    assert.equal(locateLlamaServer(fake, {} as any).path, fake);
    assert.equal(locateLlamaServer(undefined, { LOCALCODER_LLAMA_SERVER_BIN: fake } as any).path, fake);
    assert.notEqual(locateLlamaServer(path.join(home, "nope"), {} as any).path, path.join(home, "nope"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const CLI = path.join(__dirname, "../../src/cli/index.ts");
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;

function launchCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  child.on("error", (err) => { output += err.message; });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  return { child, closed, output: () => output };
}

async function listeningPort(cli: ReturnType<typeof launchCli>): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = cli.output().match(/serving on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      const port = Number(match[1]);
      assert.ok(port > 0, "serve --port 0 must print the actual listening port");
      return port;
    }
    assert.equal(cli.child.exitCode, null, cli.output());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`CLI did not start within 10 seconds: ${cli.output()}`);
}

async function stopCli(cli: ReturnType<typeof launchCli>, signal: NodeJS.Signals): Promise<number | null> {
  if (cli.child.exitCode !== null || cli.child.signalCode !== null) return cli.closed;
  cli.child.kill(signal);
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      cli.closed,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`CLI did not exit: ${cli.output()}`)), 10_000); }),
    ]);
  } finally { clearTimeout(timer!); }
}

test("CLI lifecycle: serve --port 0 publishes its bound port and SIGTERM closes the server", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lc-mock-life-"));
  const cli = launchCli(["serve", "--backend", "mock", "--port", "0"], { ...process.env, LOCALCODER_HOME: home });
  try {
    const port = await listeningPort(cli);
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json() as { data: unknown[] }).data));
    assert.equal(await stopCli(cli, "SIGTERM"), 0, cli.output());
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) }));
  } finally {
    await stopCli(cli, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

function findEngine(): string | null {
  const env = process.env.LOCALCODER_LLAMA_SERVER_BIN;
  if (env && existsSync(env)) return env;
  try { for (const d of readdirSync("/home/claude/engine")) { const p = path.join("/home/claude/engine", d, "llama-server"); if (existsSync(p)) return p; } } catch { /* none */ }
  return null;
}
const ENGINE = findEngine();
const skip = ENGINE ? false : "no real llama-server available (set LOCALCODER_LLAMA_SERVER_BIN)";
const processIds = (needle: string) => (spawnSync("pgrep", ["-f", needle], { encoding: "utf8" }).stdout ?? "").trim().split("\n").filter(Boolean).map(Number);

async function killModelProcesses(modelFile: string): Promise<void> {
  for (const pid of processIds(modelFile)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* exited already */ }
  }
  const deadline = Date.now() + 5000;
  while (processIds(modelFile).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(processIds(modelFile).length, 0, "the temporary model's processes must be cleaned up");
}

test("REAL lifecycle: SIGTERM on `localcoder serve` unloads the model and leaves NO llama-server process behind", { skip, timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lc-life-"));
  const modelFile = path.join(home, "life-tiny-model.gguf");
  let cli: ReturnType<typeof launchCli> | undefined;
  try {
    writeTinyModel(modelFile);
    const model = entryFromGguf(modelFile);
    const profile = await new HardwareProfiler().sample();
    const policy = new DefaultPolicyEngine().derive(profile);
    const decision = new DefaultModelRouter().route("chat_simple", policy, [model]);
    if (isRejection(decision)) {
      t.skip(`live memory budget ${policy.memory_budget_gb}GB cannot hold the tiny model safely`);
      return;
    }
    writeFileSync(path.join(home, "models.local.json"), JSON.stringify([model]));
    cli = launchCli(["serve", "--port", "0"], { ...process.env, LOCALCODER_HOME: home, LOCALCODER_LLAMA_SERVER_BIN: ENGINE! });
    const port = await listeningPort(cli);
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 3 }), signal: AbortSignal.timeout(75_000),
    });
    assert.equal(r.status, 200, await r.text());
    assert.ok(processIds(modelFile).length >= 1, "a real llama-server is running while the model is loaded");
    assert.equal(await stopCli(cli, "SIGTERM"), 0, cli.output());
    assert.equal(processIds(modelFile).length, 0, "no orphaned llama-server after shutdown");
  } finally {
    try { if (cli) await stopCli(cli, "SIGKILL"); }
    finally {
      try { await killModelProcesses(modelFile); }
      finally { rmSync(home, { recursive: true, force: true }); }
    }
  }
});

test("REAL lifecycle: if the Node process exits abruptly, the exit hook kills the llama-server it spawned", { skip, timeout: 90_000 }, async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "lc-exit-"));
  const modelFile = path.join(d, "exit-hook-model.gguf");
  writeTinyModel(modelFile);
  const script = path.join(d, "run.ts");
  writeFileSync(script, `
    import { LlamaCppBackend } from ${JSON.stringify(path.join(__dirname, "../../src/inference/llama-cpp-backend"))};
    import { entryFromGguf } from ${JSON.stringify(path.join(__dirname, "../../src/inference/gguf"))};
    (async () => {
      const e = entryFromGguf(${JSON.stringify(modelFile)});
      const b = new LlamaCppBackend({ binary: ${JSON.stringify(ENGINE)} });
      await b.load(e, { model_id: e.model_id, ctx_window: 2048, kv_cache_budget_mb: 1, kv_cache_dtype: "f16", max_output_tokens: 8, gpu_offload_fraction: 0 });
      console.log("LOADED", b.pid);
      process.exit(0);
    })();`);
  try {
    const r = spawnSync(process.execPath, ["--import", TSX_LOADER, script], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /LOADED \d+/, r.stdout + r.stderr);
    const deadline = Date.now() + 5000;
    while (processIds(modelFile).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(processIds(modelFile).length, 0, "llama-server must not outlive the process that spawned it");
  } finally {
    await killModelProcesses(modelFile);
    rmSync(d, { recursive: true, force: true });
  }
});
