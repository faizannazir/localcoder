import { realpathSync, existsSync } from "fs";
import path from "path";

/**
 * Returns the resolved absolute path if — after resolving symlinks — it's still inside
 * `root`, or null if it would escape. This is the same "never trust a path alone" principle
 * Phase 0's Tool Runtime sandbox uses (implementation-spec.md §5): a plain string-prefix
 * check on the unresolved path is not enough, because a symlink inside the workspace can
 * point anywhere on disk.
 */
export function resolveWithinRoot(root: string, targetPath: string): string | null {
  const absoluteRoot = realpathSyncSafe(root) ?? path.resolve(root);
  const candidate = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);

  const resolved = realpathSyncSafe(candidate) ?? path.resolve(candidate);

  const relative = path.relative(absoluteRoot, resolved);
  const escapes = relative.startsWith("..") || path.isAbsolute(relative);
  return escapes ? null : resolved;
}

function realpathSyncSafe(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return realpathSync(p);
  } catch {
    return null;
  }
}
