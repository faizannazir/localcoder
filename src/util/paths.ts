import os from "os";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";

/** Project root of the installed package (works from both src/util and dist/util). */
export const installRoot = (): string => path.join(__dirname, "..", "..");

/**
 * Where user data lives: downloaded models, the downloaded llama.cpp engine and locally-registered models.
 * Never inside the install directory (which is read-only/shared for a global npm install). Override with LOCALCODER_HOME.
 */
export function userDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALCODER_HOME ? path.resolve(env.LOCALCODER_HOME) : path.join(os.homedir(), ".localcoder");
}
export const userModelsDir = (env?: NodeJS.ProcessEnv) => path.join(userDataDir(env), "models");
export const userEngineDir = (env?: NodeJS.ProcessEnv) => path.join(userDataDir(env), "engine");
export const serverExe = (platform: string = process.platform) => (platform === "win32" ? "llama-server.exe" : "llama-server");

/** Path recorded by `localcoder setup` for the llama.cpp build it installed, if that binary still exists. */
export function installedEnginePath(env?: NodeJS.ProcessEnv): string | null {
  try {
    const f = path.join(userEngineDir(env), "current.json");
    if (!existsSync(f)) return null;
    const bin = JSON.parse(readFileSync(f, "utf8")).binary as string;
    return bin && existsSync(bin) ? bin : null;
  } catch { return null; }
}

/** Single source of truth for "where is llama-server": explicit flag → env → installed engine → PATH → ./llama-server → ./engine. */
export function locateLlamaServer(explicit?: string, env: NodeJS.ProcessEnv = process.env): { path: string | null; searched: string[] } {
  const fs = require("fs");
  const exe = serverExe();
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (env.LOCALCODER_LLAMA_SERVER_BIN) candidates.push(env.LOCALCODER_LLAMA_SERVER_BIN);
  const inst = installedEnginePath(env);
  if (inst) candidates.push(inst);
  const w = spawnSync(process.platform === "win32" ? "where" : "which", ["llama-server"], { encoding: "utf8", windowsHide: true });
  if (w.status === 0) candidates.push(...w.stdout.split(/\r?\n/).filter(Boolean));
  candidates.push(path.resolve(exe), path.resolve("engine", exe));
  for (const c of candidates) {
    try {
      const p = existsSync(c) && fs.statSync(c).isDirectory() ? path.join(c, exe) : c;
      fs.accessSync(p, fs.constants.X_OK);
      return { path: p, searched: candidates };
    } catch { /* next */ }
  }
  return { path: null, searched: candidates };
}
