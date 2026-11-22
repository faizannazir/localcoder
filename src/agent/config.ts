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

const ARGV_KEYS = ["test", "test_target", "lint", "lint_target", "format_target", "build"] as const;
const LIMIT_KEYS = ["timeout_ms", "max_result_bytes"] as const;
export const AGENT_CONFIG_KEYS = ["models", ...ARGV_KEYS, ...LIMIT_KEYS] as const;
export const agentConfigPath = (root: string) => path.join(root, ".localcoder", "agent.json");

export function readAgentConfigOverrides(root: string): Record<string, unknown> {
  const file = agentConfigPath(root);
  if (!existsSync(file)) return {};
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(".localcoder/agent.json must contain a JSON object");
  }
  return raw as Record<string, unknown>;
}

export function parseAgentConfig(raw: Record<string, unknown>): AgentConfig {
  const config: AgentConfig = {};
  if (raw.models !== undefined) config.models = parseAgentModels(raw.models);
  for (const key of ARGV_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
      throw new Error(`.localcoder/agent.json: "${key}" must be a non-empty array of strings`);
    }
    config[key] = value;
  }
  for (const key of LIMIT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error(`.localcoder/agent.json: "${key}" must be an integer from 1 to 2147483647`);
    }
    config[key] = value;
  }
  return config;
}

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
  return { ...cfg, ...parseAgentConfig(readAgentConfigOverrides(root)) };
}
