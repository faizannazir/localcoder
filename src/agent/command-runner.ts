import { spawn } from "child_process";
import { safeEnv } from "./sandbox";

export interface RunResult {
  exit_code: number | null;
  timed_out: boolean;
  output: string;
  truncated: boolean;
  duration_ms: number;
  spawn_error?: string;
}

const WIN_SHIMS = new Set(["npm", "npx", "pnpm", "yarn"]);
const SAFE_WIN_ARG = /^[A-Za-z0-9_@+=:,.\/\\-]+$/;

/**
 * Windows cannot spawn npm/npx/pnpm/yarn (.cmd shims) without a shell, and Node refuses to spawn .cmd files with shell:false.
 * For those four commands ONLY we use a shell, and only if every argument is a plain token (no spaces, quotes, % & | < > ^ ...),
 * so nothing can be injected. Everything else is spawned directly. NOT yet exercised on real Windows (see docs/TECHNICAL-NOTES.md).
 */
export function resolveCommand(argv: string[], platform: string = process.platform): { command: string; args: string[]; shell: boolean } | { error: string } {
  if (platform === "win32" && WIN_SHIMS.has(argv[0].toLowerCase())) {
    const bad = argv.find((a) => !SAFE_WIN_ARG.test(a));
    if (bad !== undefined) return { error: `argument "${bad}" is not allowed for a Windows .cmd shim (plain tokens only)` };
    return { command: `${argv[0]}.cmd`, args: argv.slice(1), shell: true };
  }
  return { command: argv[0], args: argv.slice(1), shell: false };
}

/** Runs a fixed argv (never a shell string) with a minimal env, a timeout and a capture cap. */
export function runCommand(argv: string[], cwd: string, opts: { timeout_ms: number; max_bytes: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      resolve({ exit_code: null, timed_out: timedOut, output, truncated, duration_ms: Date.now() - started, ...r });
    };
    let child;
    const rc = resolveCommand(argv);
    if ("error" in rc) return resolve({ exit_code: null, timed_out: false, output: "", truncated: false, duration_ms: 0, spawn_error: rc.error });
    try {
      child = spawn(rc.command, rc.args, { cwd, env: safeEnv(), shell: rc.shell, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ exit_code: null, timed_out: false, output: "", truncated: false, duration_ms: 0, spawn_error: (e as Error).message });
    }
    const onData = (d: Buffer) => {
      if (output.length >= opts.max_bytes) { truncated = true; return; }
      output += d.toString("utf8");
      if (output.length > opts.max_bytes) { output = output.slice(0, opts.max_bytes); truncated = true; }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      const finishTimeout = () => {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        done({ exit_code: child.exitCode });
      };
      // Escaped descendants can retain inherited pipes, so completion must also be bounded.
      cleanupTimer = setTimeout(finishTimeout, 1000);
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.once("error", finishTimeout);
        killer.once("close", finishTimeout);
      } else {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, opts.timeout_ms);
    child.on("error", (e) => done({ spawn_error: e.message }));
    child.on("close", (code) => done({ exit_code: code }));
  });
}
