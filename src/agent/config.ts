import { existsSync, readFileSync } from "fs";
import path from "path";

export const MODEL_ROLES = ["planner", "coder", "reviewer"] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export type AgentModels = Record<ModelRole, string>;

export function parseAgentModels(value: unknown): AgentModels {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== MODEL_ROLES.length
    || !MODEL_ROLES.every((role) => typeof (value as any)[role] === "string" && (value as any)[role].trim())) {
    throw new Error('.localcoder/agent.json: "models" must contain non-empty planner, coder, and reviewer model IDs only');
  }
  return Object.fromEntries(MODEL_ROLES.map((role) => [role, (value as AgentModels)[role].trim()])) as AgentModels;
}

/**
 * The command allowlist. The model never supplies a command string: it can only pick a tool
 * (run_tests, run_linter, ...) and optionally a target FILE. The argv templates below are the
 * only things that can ever be executed. `{file}` is replaced by a sandbox-validated path.
 * NOTE: this constrains WHICH command runs, not what the repo's own scripts do (e.g. `npm test`
 * runs whatever package.json says) — see docs/TECHNICAL-NOTES.md.
 */
export interface AgentConfig {
  models?: AgentModels;
  test?: string[];
  test_target?: string[];
  lint?: string[];
  lint_target?: string[];
  format_target?: string[];
  build?: string[];
  timeout_ms?: number;
  max_result_bytes?: number;
}

const ARGV_KEYS: (keyof AgentConfig)[] = ["test", "test_target", "lint", "lint_target", "format_target", "build"];

export function loadAgentConfig(root: string): AgentConfig {
  const cfg: AgentConfig = {};
  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
      if (typeof scripts.test === "string") cfg.test = ["npm", "test", "--silent"];
      if (typeof scripts.lint === "string") cfg.lint = ["npm", "run", "lint", "--silent"];
      if (typeof scripts.build === "string") cfg.build = ["npm", "run", "build", "--silent"];
    } catch { /* unreadable package.json: no auto-detected commands */ }
  }
  const explicit = path.join(root, ".localcoder", "agent.json");
  if (existsSync(explicit)) {
    const raw = JSON.parse(readFileSync(explicit, "utf8"));
    if (raw.models !== undefined) cfg.models = parseAgentModels(raw.models);
    for (const k of ARGV_KEYS) {
      const v = raw[k];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) throw new Error(`.localcoder/agent.json: "${k}" must be a non-empty array of strings`);
      (cfg as any)[k] = v;
    }
    if (typeof raw.timeout_ms === "number") cfg.timeout_ms = raw.timeout_ms;
    if (typeof raw.max_result_bytes === "number") cfg.max_result_bytes = raw.max_result_bytes;
  }
  return cfg;
}
