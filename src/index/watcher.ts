import { watch, FSWatcher, existsSync, statSync } from "fs";
import path from "path";
import type { RepositoryWatcher as IRepositoryWatcher, FileEvent } from "../types/index";
import { IgnoreRules } from "./ignore";

/**
 * fs.watch's "rename" event is really just "something changed about this path's existence" —
 * it doesn't distinguish create/delete/rename across platforms. This watcher resolves that
 * ambiguity down to created/modified/deleted using an existence check (see below); it never
 * emits "renamed" itself — that requires content-hash correlation, which needs the index's
 * historical state and is deliberately handled one layer up, in IndexService.
 */
export class FsWatcher implements IRepositoryWatcher {
  private watcher: FSWatcher | null = null;
  private listeners: ((e: FileEvent) => void)[] = [];
  private knownFiles = new Set<string>();
  private ignore: IgnoreRules | null = null;
  private root = "";

  async start(root: string): Promise<void> {
    this.root = root;
    this.ignore = new IgnoreRules(root);
    this.knownFiles = new Set(this.walk(root));

    this.watcher = watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const relative = filename.split(path.sep).join("/");
      if (this.ignore?.shouldIgnore(relative)) return;

      const abs = path.join(root, filename);
      const existedBefore = this.knownFiles.has(relative);
      const existsNow = existsSync(abs) && statSync(abs).isFile();

      if (existsNow && !existedBefore) {
        this.knownFiles.add(relative);
        this.emit({ type: "created", path: relative });
      } else if (existsNow && existedBefore) {
        this.emit({ type: "modified", path: relative });
      } else if (!existsNow && existedBefore) {
        this.knownFiles.delete(relative);
        this.emit({ type: "deleted", path: relative });
      }
      // !existsNow && !existedBefore: a directory event or a file we never tracked — ignore.
    });
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
  }

  onEvent(cb: (e: FileEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(e: FileEvent): void {
    for (const l of this.listeners) l(e);
  }

  private walk(dir: string, base = dir, out: string[] = []): string[] {
    let entries;
    try {
      entries = require("fs").readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const relative = path.relative(base, abs).split(path.sep).join("/");
      if (this.ignore?.shouldIgnore(relative, entry.isDirectory())) continue;
      if (entry.isSymbolicLink()) continue; // never follow symlinks while walking — see security notes in NOTES.md
      if (entry.isDirectory()) this.walk(abs, base, out);
      else if (entry.isFile()) out.push(relative);
    }
    return out;
  }
}
