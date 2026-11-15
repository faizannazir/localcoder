import { createHash, randomBytes } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, statSync, openSync, closeSync, fchmodSync, unlinkSync } from "fs";
import path from "path";

export const hashText = (t: string) => createHash("sha256").update(t).digest("hex");
export const agentDir = (root: string) => path.join(root, ".localcoder", "agent");

/** Content-addressed pre-edit backups: the "before" side of the undo journal. Never garbage-collected (documented limitation). */
export function storeBackup(root: string, content: string): string {
  const h = hashText(content);
  const dir = path.join(agentDir(root), "backups");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, h);
  if (!existsSync(f)) writeFileSync(f, content);
  return h;
}

export function loadBackup(root: string, ref: string): string {
  if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("invalid backup reference");
  return readFileSync(path.join(agentDir(root), "backups", ref), "utf8");
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

export function writeAtomic(abs: string, content: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.lc-tmp-${randomBytes(16).toString("hex")}`;
  let mode: number | undefined;
  try { mode = statSync(abs).mode; } catch { /* new file */ }
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
