import { createHash, randomBytes } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, statSync, openSync, closeSync, fchmodSync, unlinkSync, constants, lstatSync, fstatSync, linkSync } from "fs";
import path from "path";
import type { BigIntStats } from "fs";

export const hashText = (t: string) => createHash("sha256").update(t).digest("hex");
export const fileVersion = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
export const agentDir = (root: string) => path.join(root, ".localcoder", "agent");

/** Content-addressed pre-edit backups: the "before" side of the undo journal. Never garbage-collected (documented limitation). */
export function storeBackup(root: string, content: string): string {
  const h = hashText(content);
  const dir = path.join(agentDir(root), "backups");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, h);
  if (!lstatSync(f, { throwIfNoEntry: false })) {
    const temp = path.join(dir, `.backup-${randomBytes(16).toString("hex")}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try { writeFileSync(fd, content); } finally { closeSync(fd); }
      try { linkSync(temp, f); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temp); }
  }
  loadBackup(root, h);
  return h;
}

export function loadBackup(root: string, ref: string): string {
  if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("invalid backup reference");
  const file = path.join(agentDir(root), "backups", ref);
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("Backup is not a regular file.");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fileVersion(fstatSync(fd, { bigint: true })) !== fileVersion(stat)) throw new Error("Backup changed before it could be read.");
    const bytes = readFileSync(fd);
    if (createHash("sha256").update(bytes).digest("hex") !== ref) throw new Error("Backup content does not match its recorded hash.");
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

/** Full command output kept on disk (already secret-redacted, capped) so tool results can carry a short reference instead of raw text. */
export function storeOutput(root: string, text: string): string {
  const capped = text.length > 200_000 ? text.slice(0, 200_000) : text;
  const h = hashText(capped);
  const dir = path.join(agentDir(root), "outputs");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${h}.txt`);
  if (!existsSync(f)) writeFileSync(f, capped);
  return h;
}

export function writeAtomic(abs: string, content: string, restoreMode?: number): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.lc-tmp-${randomBytes(16).toString("hex")}`;
  let mode = restoreMode;
  if (mode === undefined) {
    try { mode = statSync(abs).mode; } catch { /* new file */ }
  }
  const fd = openSync(tmp, "wx");
  try {
    try {
      writeFileSync(fd, content);
      if (mode !== undefined) fchmodSync(fd, mode & 0o777);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, abs);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
