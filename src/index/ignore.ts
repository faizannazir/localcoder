import { readFileSync, existsSync } from "fs";
import path from "path";

/** Directory names never indexed, regardless of .gitignore — implementation-spec.md / Phase 1 spec §"File watcher". */
export const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  ".localcoder",
  "node_modules",
  "dist",
  "build",
  "target",
  "bin",
  "obj",
  ".vscode",
  ".idea",
  "coverage",
  ".cache",
]);

/**
 * Never indexed, ever — secret material. Matched against the file's basename.
 * Deliberately a superset of Phase 0's tool-runtime denylist philosophy applied to indexing.
 */
const SECRET_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/,
  /^.*\.pem$/,
  /^.*\.key$/,
  /^credentials\..+$/,
  /^secrets\..+$/,
];

export function isSecretPath(relativePath: string): boolean {
  const base = path.basename(relativePath);
  if (SECRET_PATTERNS.some((re) => re.test(base))) return true;
  if (relativePath.split(path.sep).includes(".ssh")) return true;
  return false;
}

/**
 * Pragmatic .gitignore support — covers the common cases (comments, blank lines, `/`-anchored
 * patterns, directory-only trailing `/`, `*`/`**` globs) but is not a fully spec-compliant
 * gitignore parser (no negation support in this version). Good enough to avoid indexing
 * build output a project already ignores; not a substitute for the explicit denylist above,
 * which always applies regardless of what .gitignore says.
 */
function gitignoreLineToRegExp(line: string): { re: RegExp; dirOnly: boolean } | null {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) return null; // negation unsupported, documented above

  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000DOUBLESTAR\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000DOUBLESTAR\u0000/g, ".*")
    .replace(/\?/g, ".");

  const full = anchored ? `^${re}(/.*)?$` : `(^|/)${re}(/.*)?$`;
  return { re: new RegExp(full), dirOnly };
}

export function loadGitignore(root: string): { re: RegExp; dirOnly: boolean }[] {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) return [];
  try {
    return readFileSync(gitignorePath, "utf8")
      .split("\n")
      .map(gitignoreLineToRegExp)
      .filter((x): x is { re: RegExp; dirOnly: boolean } => x !== null);
  } catch {
    return []; // an unreadable .gitignore degrades to "no extra ignores", not a crash
  }
}

export interface IgnoreConfig {
  extraDirs?: string[];
  extraGitignorePatterns?: string[]; // literal .gitignore-style lines, for project-specific overrides
}

export class IgnoreRules {
  private dirs: Set<string>;
  private gitignoreRules: { re: RegExp; dirOnly: boolean }[];

  constructor(root: string, config: IgnoreConfig = {}) {
    this.dirs = new Set([...DEFAULT_IGNORE_DIRS, ...(config.extraDirs ?? [])]);
    this.gitignoreRules = [
      ...loadGitignore(root),
      ...(config.extraGitignorePatterns ?? [])
        .map(gitignoreLineToRegExp)
        .filter((x): x is { re: RegExp; dirOnly: boolean } => x !== null),
    ];
  }

  /** relativePath uses forward slashes, relative to the workspace root. */
  shouldIgnore(relativePath: string, isDirectory = false): boolean {
    const parts = relativePath.split("/");
    if (parts.some((p) => this.dirs.has(p))) return true;
    if (isSecretPath(relativePath)) return true;
    for (const rule of this.gitignoreRules) {
      if (rule.dirOnly && !isDirectory && !relativePath.includes("/")) continue;
      if (rule.re.test(relativePath)) return true;
    }
    return false;
  }
}
