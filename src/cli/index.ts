#!/usr/bin/env node
import { runServe } from "./serve";
import { runDoctor } from "./doctor";
import { runModels } from "./models";
import { runIndex } from "./index-cmd";
import { runSearch } from "./search";
import { runSymbols } from "./symbols";
import { runContext } from "./context-cmd";
import { runMemory, runTask } from "./memory-cmd";
import { runAgent, runUndo } from "./agent-cmd";
import { runVerify } from "./verify";

async function main() {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case "serve":
      await runServe(rest);
      return;
    case "doctor":
      await runDoctor();
      return;
    case "models":
      await runModels(rest);
      return;
    case "index":
      await runIndex(rest);
      return;
    case "search":
      await runSearch(rest);
      return;
    case "symbols":
      await runSymbols(rest);
      return;
    case "context":
      await runContext(rest);
      return;
    case "verify":
      await runVerify(rest);
      return;
    case "agent":
      await runAgent(rest);
      return;
    case "undo":
      await runUndo(rest);
      return;
    case "memory":
      await runMemory(rest);
      return;
    case "task":
      await runTask(rest);
      return;
    default:
      // eslint-disable-next-line no-console
      console.log(
        [
          "localcoder — Phase 0-2 (inference API, repository intelligence, coding agent)",
          "",
          "Usage:",
          "  localcoder serve [--port 8080] [--backend llama|mock]",
          "  localcoder doctor",
          "  localcoder models",
          "  localcoder index [path] [--status] [--clear] [--watch]",
          '  localcoder search "<query>"',
          '  localcoder symbols "<query>"',
          '  localcoder context "<query>" [--file <path>] [--symbol <name>] [--budget N] [--explain]',
          '  localcoder agent "<task>" [--session <id>] [--resume <task_id>] [--backend llama|mock]',
          '  localcoder undo [task_id] [--force]',
          '  localcoder memory [status|list|add|refresh|delete]',
          '  localcoder task [new "<title>" "<summary>" [files...]|done]',
        ].join("\n")
      );
      if (command && command !== "help" && command !== "--help") {
        console.log(`\nUnknown command: "${command}"`);
        process.exitCode = 1;
      }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`localcoder: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
