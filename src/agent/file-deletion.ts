import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Sandbox } from "./sandbox";
import type { AgentState, AgentStateStore } from "./state";
import { fileVersion, hashText, storeBackup } from "./workdir";

export function deletionPath(sandbox: Sandbox, input: string): { abs: string; rel: string } {
  const checked = sandbox.resolve(input, true);
  if (!checked.ok) throw new Error(checked.reason);
  if (path.resolve(sandbox.realRoot, input) !== checked.abs) throw new Error("Deleting through a symbolic link is refused.");
  return checked;
}

export function checkDeletionStorage(root: string): void {
  for (const directory of [".localcoder", ".localcoder/agent", ".localcoder/agent/backups", ".localcoder/agent/state"]) {
    const stat = lstatSync(path.join(root, directory), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`Deletion needs a regular workspace directory at ${directory} for undo.`);
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const db = lstatSync(path.join(root, ".localcoder", "index.sqlite" + suffix), { throwIfNoEntry: false });
    if (db && !db.isFile()) throw new Error("Workspace index storage must use regular files.");
  }
}

export function deleteWorkspaceFile(sandbox: Sandbox, store: AgentStateStore, state: AgentState, input: string, expectedHash?: string) {
  const { abs, rel } = deletionPath(sandbox, input);
  const stat = lstatSync(abs, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error("Deletion requires one existing regular file.");
  if (stat.size > 512 * 1024) throw new Error("File exceeds the 512KB deletion limit.");
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    if (fileVersion(fstatSync(fd, { bigint: true })) !== fileVersion(stat)) throw new Error("File changed before it could be read.");
    bytes = readFileSync(fd);
    if (fileVersion(fstatSync(fd, { bigint: true })) !== fileVersion(stat)) throw new Error("File changed while it was being read.");
  } finally { closeSync(fd); }
  const content = bytes.toString("utf8");
  if (content.includes("\0") || !bytes.equals(Buffer.from(content))) throw new Error("Deletion supports UTF-8 text files only.");
  const beforeHash = hashText(content);
  if (expectedHash !== undefined && beforeHash !== expectedHash) throw new Error("File changed since it was read.");

  checkDeletionStorage(sandbox.realRoot);
  const backup = storeBackup(sandbox.realRoot, content);
  // Publish the backup and rollback record before making the path disappear.
  state.edits.push({ path: rel, op: "delete", before_hash: beforeHash, after_hash: null,
    before_mode: Number(stat.mode & 0o777n), backup_ref: backup, step: state.tool_calls });
  try {
    store.save(state);
    const current = lstatSync(deletionPath(sandbox, input).abs, { bigint: true });
    if (fileVersion(current) !== fileVersion(stat)) throw new Error("File changed before deletion.");
    unlinkSync(abs);
  } catch (error) {
    state.edits.pop();
    store.save(state);
    throw error;
  }
  return { path: rel, mode: "delete", lines_added: 0, lines_removed: content.split("\n").length - Number(content === "" || content.endsWith("\n")) };
}
