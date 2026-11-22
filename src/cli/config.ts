import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENT_CONFIG_KEYS, agentConfigPath, loadAgentConfig, parseAgentConfig, readAgentConfigOverrides } from "../agent/config";

export function runConfig(args: string[]): void {
  const [action = "list", key, value] = args;
  const root = process.cwd();
  const file = agentConfigPath(root);
  const usage = `Usage: localcoder config list|path|get <key>|set <key> <json>|unset <key>. Settings: ${AGENT_CONFIG_KEYS.join(", ")}.`;
  if ((action === "help" || action === "--help") && args.length === 1) {
    console.log(usage);
    return;
  }

  if (action === "list" && args.length <= 1) {
    console.log(JSON.stringify(loadAgentConfig(root), null, 2));
    return;
  }
  if (action === "path" && args.length === 1) {
    console.log(file);
    return;
  }
  const setting = AGENT_CONFIG_KEYS.find((name) => name === key);
  if (setting === undefined) {
    throw new Error(usage);
  }
  if (action === "get" && args.length === 2) {
    const value = loadAgentConfig(root)[setting];
    console.log(value === undefined ? "null" : JSON.stringify(value, null, 2));
    return;
  }

  let replacement: unknown;
  if (action === "set" && args.length === 3) {
    try { replacement = JSON.parse(value); }
    catch { throw new Error("Setting values must be valid JSON. Quote arrays and objects in your shell."); }
  } else if (action !== "unset" || args.length !== 2) {
    throw new Error("Use localcoder config set <key> <json> or localcoder config unset <key>.");
  }

  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const lockPath = path.join(directory, ".agent-config.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Another config update is active. If it was interrupted, remove ${lockPath} before retrying.`);
  }
  try {
    const overrides = readAgentConfigOverrides(root);
    if (action === "set") {
      overrides[setting] = replacement;
    } else {
      if (!Object.hasOwn(overrides, setting)) {
        console.log(`No override for ${setting}`);
        return;
      }
      delete overrides[setting];
    }
    parseAgentConfig(overrides);
    const scratch = mkdtempSync(path.join(directory, ".config-"));
    try {
      const temporary = path.join(scratch, "agent.json");
      writeFileSync(temporary, JSON.stringify(overrides, null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    closeSync(lock);
    rmSync(lockPath);
  }
  console.log(`${action === "set" ? "Set" : "Unset"} ${setting} in ${file}`);
}
