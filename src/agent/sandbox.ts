import { realpathSync, existsSync } from "fs";
import path from "path";
import { IgnoreRules, isSecretPath } from "../index/ignore";
import { containsLikelySecret } from "../memory/secret-guard";

export type PathCheck = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

/**
 * Workspace jail for every agent file operation. Resolves symlinks on the nearest existing
 * ancestor (so a symlinked parent directory cannot smuggle a new file outside the root),
 * then applies the same secret-path rule the Phase 1 indexer uses. Application-level only:
 * there is NO OS-level sandbox (see NOTES.md).
 */
export class Sandbox {
  readonly realRoot: string;
  constructor(readonly root: string, private ignore: IgnoreRules) {
    this.realRoot = realpathSync(root);
  }

  private deny(rel: string, forWrite: boolean): string | null {
    const parts = rel.toLowerCase().split("/");
    if (isSecretPath(rel)) return "path is protected (secret material)";
    if (parts.includes(".git")) return "the .git directory is off-limits";
    if (parts.includes(".localcoder")) return "the .localcoder directory is off-limits";
    if (forWrite && this.ignore.shouldIgnore(rel)) return "path is ignored (build output or gitignored); writes there are refused";
    return null;
  }

  resolve(input: unknown, forWrite: boolean, allowRoot = false): PathCheck {
    if (typeof input !== "string" || input === "" || input.includes("\0")) return { ok: false, reason: "invalid path" };
    const candidate = path.isAbsolute(input) ? path.normalize(input) : path.resolve(this.realRoot, input);
    let existing = candidate;
    const tail: string[] = [];
    while (!existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return { ok: false, reason: "invalid path" };
      tail.unshift(path.basename(existing));
      existing = parent;
    }
    let realExisting: string;
    try { realExisting = realpathSync(existing); } catch { return { ok: false, reason: "unreadable path" }; }
    const real = path.join(realExisting, ...tail);
    const relFromRoot = path.relative(this.realRoot, real);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) return { ok: false, reason: "path escapes the workspace" };
    if (relFromRoot === "") return allowRoot ? { ok: true, abs: real, rel: "" } : { ok: false, reason: "path is the workspace root" };
    const rel = relFromRoot.split(path.sep).join("/");
    const lexRel = path.relative(this.realRoot, candidate).split(path.sep).join("/");
    for (const r of new Set([rel, lexRel])) {
      const d = this.deny(r, forWrite);
      if (d) return { ok: false, reason: d };
    }
    return { ok: true, abs: real, rel };
  }
}

/** Minimal environment for child processes: no inherited tokens/credentials, no NODE_OPTIONS/NODE_TEST_CONTEXT leakage. */
export function safeEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "PATHEXT"];
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

export function redactSecrets(text: string): string {
  return text.split("\n").map((l) => (containsLikelySecret(l) ? "[redacted line: looks like a credential]" : l)).join("\n");
}
