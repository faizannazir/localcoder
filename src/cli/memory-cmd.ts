import path from "path";
import { MemoryStore } from "../memory/memory-store";
import { indexDbPath } from "../index/open";
import type { MemoryCategory } from "../types/index";

const CATEGORIES: MemoryCategory[] = ["architecture", "convention", "decision", "constraint", "important_file", "known_issue"];

function open(): MemoryStore {
  return new MemoryStore(indexDbPath(path.resolve(".")));
}

export async function runMemory(args: string[]): Promise<void> {
  const store = open();
  try {
    const sub = args[0];
    if (sub === "add") {
      const category = args[1] as MemoryCategory;
      const text = args[2];
      const files = args.slice(3);
      if (!CATEGORIES.includes(category) || !text) {
        console.log(`Usage: localcoder memory add <${CATEGORIES.join("|")}> "<text>" [related-file...]`);
        process.exitCode = 1;
        return;
      }
      const entry = await store.addMemory(category, text, files);
      console.log(`Added memory #${entry.id} (${category})`);
    } else if (sub === "list") {
      const all = store.listMemory({ includeStale: true });
      if (all.length === 0) console.log("No project memory yet.");
      for (const m of all) console.log(`#${m.id} [${m.category}]${m.stale ? " STALE" : ""} ${m.content.slice(0, 100)}`);
    } else if (sub === "status" || sub === "--status" || !sub) {
      const all = store.listMemory({ includeStale: true });
      const stale = all.filter((m) => m.stale).length;
      const task = store.getActiveTask();
      console.log(`Project memory: ${all.length} entries (${stale} stale)`);
      console.log(`Active task: ${task ? `#${task.id} "${task.title}"` : "none"}`);
    } else if (sub === "refresh") {
      const id = parseInt(args[1], 10);
      const text = args[2];
      if (!id || !text) { console.log('Usage: localcoder memory refresh <id> "<text>"'); process.exitCode = 1; return; }
      await store.updateMemory(id, text);
      console.log(`Refreshed memory #${id} (no longer stale)`);
    } else if (sub === "delete") {
      store.deleteMemory(parseInt(args[1], 10));
      console.log(`Deleted memory #${args[1]}`);
    } else {
      console.log("Usage: localcoder memory [status|list|add|refresh|delete]");
    }
  } catch (err) {
    console.error(`localcoder: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

export async function runTask(args: string[]): Promise<void> {
  const store = open();
  try {
    const sub = args[0];
    if (sub === "new") {
      const t = store.createTask(args[1], args[2] ?? "", args.slice(3));
      console.log(`Started task #${t.id}: ${t.title}`);
    } else if (sub === "done") {
      const t = store.getActiveTask();
      if (!t) { console.log("No active task."); return; }
      store.updateTaskStatus(t.id, "done");
      console.log(`Marked task #${t.id} done.`);
    } else {
      const t = store.getActiveTask();
      if (!t) { console.log("No active task."); return; }
      console.log(`Task #${t.id}: ${t.title}\n${t.summary}\nfiles: ${t.related_files.join(", ") || "-"}\ndecisions: ${t.decisions.length}`);
    }
  } finally {
    store.close();
  }
}
