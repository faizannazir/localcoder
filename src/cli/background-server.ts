import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { userDataDir } from "../util/paths";
import { CONTROL_ROUTE } from "../server/control";

export const CONTROL_TOKEN_ENV = "LOCALCODER_INTERNAL_CONTROL_TOKEN";
export type ServerBackend = "llama" | "mock";

interface ServerRecord {
  pid: number;
  port: number;
  backend: ServerBackend;
  workspace: string;
  controlToken: string;
}

const recordPath = () => path.join(userDataDir(), "server.json");
const logPath = () => path.join(userDataDir(), "server.log");

function readServerRecord(): ServerRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(recordPath(), "utf8")) as ServerRecord;
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535 ||
        !["llama", "mock"].includes(record.backend) || typeof record.workspace !== "string" ||
        typeof record.controlToken !== "string" || !/^[0-9a-f-]{36}$/i.test(record.controlToken)) {
      throw new Error("Invalid background server state.");
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function activeBackgroundPort(): Promise<number | undefined> {
  const current = readServerRecord();
  if (!current) return undefined;
  if (!await control(current, "GET")) {
    throw new Error("The managed server did not respond. Run localcoder status or specify --port explicitly.");
  }
  return current.port;
}

async function control(record: ServerRecord, method: "GET" | "POST"): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}${CONTROL_ROUTE}`, {
      method, headers: { Authorization: `Bearer ${record.controlToken}`, "Content-Type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(1500),
    });
    const result = response.ok ? await response.json() as { pid?: number } : undefined;
    if (!response.ok) await response.body?.cancel();
    return result?.pid === record.pid;
  } catch { return false; }
}

async function editServerState(operation: () => Promise<void>): Promise<void> {
  const directory = userDataDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, "server.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Another background server operation is active. If it was interrupted, remove ${lockPath} before retrying.`);
  }
  try { await operation(); }
  finally { closeSync(lock); rmSync(lockPath); }
}

async function launch(port: number, backend: ServerBackend, workspace: string): Promise<void> {
  const controlToken = randomUUID();
  const log = openSync(logPath(), "a", 0o600);
  let child: ReturnType<typeof fork>;
  try {
    child = fork(require.resolve("./index"), ["serve", "--port", String(port), "--backend", backend], {
      cwd: workspace, detached: true, stdio: ["ignore", log, log, "ipc"],
      env: { ...process.env, [CONTROL_TOKEN_ENV]: controlToken },
    });
  } finally { closeSync(log); }
  const temporary = `${recordPath()}.${randomUUID()}`;
  let published = false;
  try {
    const boundPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out starting LocalCoder.")), 15_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`LocalCoder exited during startup (code ${code}).`)));
      child.once("message", (message: { port?: number }) => {
        clearTimeout(timer);
        if (typeof message.port === "number") resolve(message.port);
        else reject(new Error("LocalCoder did not report its bound port."));
      });
    });
    const record: ServerRecord = { pid: child.pid!, port: boundPort, backend, workspace, controlToken };
    writeFileSync(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, recordPath());
    published = true;
    await new Promise<void>((resolve, reject) => {
      child.send({ registered: true }, (error) => error ? reject(error) : resolve());
    });
    child.disconnect();
    child.unref();
    console.log(`LocalCoder running in background at http://127.0.0.1:${record.port} (PID ${record.pid})`);
    console.log(`Log: ${logPath()}`);
  } catch (error) {
    if (child.exitCode === null && child.pid) child.kill();
    if (child.connected) child.disconnect();
    if (published) rmSync(recordPath(), { force: true });
    rmSync(temporary, { force: true });
    throw new Error(`${(error as Error).message} See ${logPath()}.`);
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function stop(record: ServerRecord): Promise<void> {
  if (!await control(record, "POST")) {
    throw new Error("The managed server did not confirm shutdown. Its state was kept.");
  }
  const deadline = Date.now() + 15_000;
  while (processExists(record.pid)) {
    if (Date.now() >= deadline) throw new Error(`LocalCoder is still shutting down. See ${logPath()}.`);
    await delay(75);
  }
  rmSync(recordPath(), { force: true });
  console.log("LocalCoder stopped.");
}

export async function startBackgroundServer(port: number, backend: ServerBackend): Promise<void> {
  await editServerState(async () => {
    const current = readServerRecord();
    if (current) {
      if (await control(current, "GET")) {
        throw new Error(`LocalCoder is already running in the background on port ${current.port}.`);
      }
      if (processExists(current.pid)) {
        throw new Error(`The recorded server PID ${current.pid} is still present but did not respond. Inspect ${logPath()} before starting another server.`);
      }
    }
    await launch(port, backend, process.cwd());
  });
}

export async function manageBackgroundServer(action: "status" | "stop" | "restart", args: string[]): Promise<void> {
  if (args.length) throw new Error(`Usage: localcoder ${action}`);
  if (action === "status") {
    const current = readServerRecord();
    if (current && await control(current, "GET")) {
      console.log(`LocalCoder running at http://127.0.0.1:${current.port} (PID ${current.pid}, ${current.backend})\nWorkspace: ${current.workspace}\nLog: ${logPath()}`);
    } else if (current) {
      console.log(`The managed server did not respond on port ${current.port} (recorded PID ${current.pid}). Log: ${logPath()}`);
    } else {
      console.log("No managed LocalCoder server is running.");
    }
    return;
  }
  await editServerState(async () => {
    const current = readServerRecord();
    if (!current || !await control(current, "GET")) {
      if (current && processExists(current.pid)) throw new Error(`The managed server did not respond. Its state was kept. See ${logPath()}.`);
      if (current) rmSync(recordPath(), { force: true });
      if (action === "restart") throw new Error("No managed server to restart. Run localcoder serve --background.");
      console.log("No managed LocalCoder server is running.");
      return;
    }
    await stop(current);
    if (action === "restart") await launch(current.port, current.backend, current.workspace);
  });
}
