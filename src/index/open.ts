import path from "path";
import { SqliteIndexStore } from "./sqlite-store";

export function indexDbPath(root: string): string {
  return path.join(root, ".localcoder", "index.sqlite");
}

export function openIndexStore(root: string): SqliteIndexStore {
  return new SqliteIndexStore(indexDbPath(root));
}
