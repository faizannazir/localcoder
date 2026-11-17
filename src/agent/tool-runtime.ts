import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import path from "path";
import type { ToolRuntime, ToolResult, SandboxContext, IndexStore } from "../types/index";
import type { IndexService } from "../index/index-service";
import { IgnoreRules } from "../index/ignore";
import { Sandbox, redactSecrets } from "./sandbox";
import { runCommand } from "./command-runner";
import type { AgentConfig } from "./config";
import { applyUnifiedPatch, unifiedDiff, diffStats } from "./unified-diff";
import { hashText, storeBackup, storeOutput, writeAtomic } from "./workdir";

const READ_LIMIT_BYTES = 16_000;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_READ_FILE = 2_000_000;

export interface ToolRuntimeOptions {
  root: string;
  index: IndexStore;
  indexService?: IndexService;
  config: AgentConfig;
}

const ok = (data: unknown, truncated = false): ToolResult => ({ ok: true, data, truncated, size_bytes: Buffer.byteLength(JSON.stringify(data)) });
const fail = (error: string, extra: Record<string, unknown> = {}): ToolResult => {
  const data = { error, ...extra };
  return { ok: false, data, truncated: false, size_bytes: Buffer.byteLength(JSON.stringify(data)), error };
};

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`argument "${key}" (string) is required`);
  return v;
}
const safeArg = (rel: string) => (rel.startsWith("-") ? `./${rel}` : rel);
const fill = (tpl: string[], file: string) => tpl.map((t) => t.replace("{file}", safeArg(file)));

/** Keeps the lines that matter (failures/errors) plus the tail, bounded. */
export function summarizeOutput(text: string, maxChars = 2500): string {
  const lines = text.split("\n");
  if (text.length <= maxChars) return text.trim();
  const key = lines.filter((l) => /(not ok|fail|error|assert|expected|actual|✖|traceback|exception|cannot find|syntaxerror)/i.test(l)).slice(0, 25);
  const tail = lines.slice(-8);
  const out = [...key, key.length ? "..." : "", ...tail].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  return (out.length > maxChars ? out.slice(0, maxChars) + "\n[truncated]" : out) + `\n(${lines.length} lines total, full output by output_ref)`;
}

export const TOOL_NAMES = ["read_file", "write_file", "apply_patch", "search", "find_symbol", "list_files", "run_tests", "run_linter", "run_formatter", "run_build", "git_status", "git_diff"] as const;

const SCHEMAS = [
  { name: "read_file", description: "Read a bounded window of a workspace file", parameters: { path: "string", start_line: "number?", end_line: "number?" } },
  { name: "write_file", description: "Create a file; overwriting an existing file is the last-resort edit and needs allow_overwrite", parameters: { path: "string", content: "string", allow_overwrite: "boolean?" } },
  { name: "apply_patch", description: "Targeted edit: unified diff, or exact old_text->new_text replacement (must match once)", parameters: { path: "string", patch: "string?", old_text: "string?", new_text: "string?", expected_hash: "string?" } },
  { name: "search", description: "Search the repository index (text or symbol)", parameters: { query: "string", kind: "text|symbol?", k: "number?" } },
  { name: "find_symbol", description: "Find symbol definitions by name", parameters: { name: "string" } },
  { name: "list_files", description: "List workspace files (ignore rules applied)", parameters: { dir: "string?", max: "number?" } },
  { name: "run_tests", description: "Run the configured test command (optionally for one test file)", parameters: { target: "string?" } },
  { name: "run_linter", description: "Run the configured linter / built-in syntax check on a file", parameters: { target: "string?" } },
  { name: "run_formatter", description: "Run the configured formatter on one file", parameters: { target: "string" } },
  { name: "run_build", description: "Run the configured build command", parameters: {} },
  { name: "git_status", description: "git status --porcelain", parameters: {} },
  { name: "git_diff", description: "git diff (optionally one path)", parameters: { path: "string?" } },
];

export class DefaultToolRuntime implements ToolRuntime {
  private sb: Sandbox;
  private maxResult: number;
  private timeout: number;

  constructor(private o: ToolRuntimeOptions) {
    this.sb = new Sandbox(o.root, new IgnoreRules(o.root));
    this.maxResult = o.config.max_result_bytes ?? 4000;
    this.timeout = o.config.timeout_ms ?? 120_000;
  }

  schemas(): unknown[] { return SCHEMAS; }

  async invoke(name: string, args: Record<string, unknown>, sandbox: SandboxContext): Promise<ToolResult> {
    try {
      let given: string;
      try { given = (await import("fs")).realpathSync(sandbox.workspaceRoot); } catch { return fail("sandbox workspace is not accessible"); }
      if (given !== this.sb.realRoot) return fail("sandbox workspace does not match this tool runtime's workspace");
      switch (name) {
        case "read_file": return this.readFile(args);
        case "write_file": return await this.writeFile(args);
        case "apply_patch": return await this.applyPatch(args);
        case "search": return await this.search(args);
        case "find_symbol": return await this.findSymbol(args);
        case "list_files": return this.listFiles(args);
        case "run_tests": return await this.runTests(args);
        case "run_linter": return await this.runLinter(args);
        case "run_formatter": return await this.runFormatter(args);
        case "run_build": return this.o.config.build ? await this.exec(this.o.config.build) : fail("no build command configured");
        case "git_status": return await this.exec(["git", "-c", "core.fsmonitor=false", "--no-pager", "status", "--porcelain"]);
        case "git_diff": return await this.gitDiff(args);
        default: return fail(`unknown tool "${name}" (not in the allowlist)`);
      }
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  // --- files ---------------------------------------------------------------

  private readFile(args: Record<string, unknown>): ToolResult {
    const c = this.sb.resolve(args.path, false);
    if (!c.ok) return fail(c.reason);
    if (!existsSync(c.abs) || !statSync(c.abs).isFile()) return fail("file not found");
    if (statSync(c.abs).size > MAX_READ_FILE) return fail("file too large to read (>2MB)");
    const content = readFileSync(c.abs, "utf8");
    if (content.includes("\0")) return fail("binary file");
    const lines = content.split("\n");
    const total = lines.length;
    const start = Math.min(total, Math.max(1, Math.floor(Number(args.start_line)) || 1));
    const end = Math.min(total, Math.max(start, Math.floor(Number(args.end_line)) || total));
    const out: string[] = [];
    let bytes = 0, last = start - 1;
    for (let i = start - 1; i < end; i++) {
      const b = Buffer.byteLength(lines[i]) + 1;
      if (bytes + b > READ_LIMIT_BYTES && out.length > 0) break;
      out.push(lines[i]); bytes += b; last = i + 1;
    }
    const partial = !(start === 1 && last === total);
    return ok({ path: c.rel, start_line: start, end_line: last, total_lines: total, content: out.join("\n"), hash: hashText(content), partial }, partial);
  }

  private async commit(rel: string, abs: string, before: string | null, after: string, mode: string): Promise<ToolResult> {
    if (Buffer.byteLength(after) > MAX_WRITE_BYTES) return fail("resulting file exceeds the 512KB write limit");
    const backup_ref = before === null ? null : storeBackup(this.o.root, before);
    writeAtomic(abs, after);
    const warning = await this.refreshAfterMutation(rel, before === null ? "created" : "modified");
    const stats = diffStats(unifiedDiff(before ?? "", after, rel));
    return ok({ path: rel, mode, before_hash: before === null ? null : hashText(before), after_hash: hashText(after), backup_ref, lines_added: stats.added, lines_removed: stats.removed, ...(warning ? { warning } : {}) });
  }

  private async refreshAfterMutation(rel: string, type: "created" | "modified"): Promise<string | undefined> {
    try { await this.o.indexService?.handleEvent({ type, path: rel }); }
    catch (error) { return `Index refresh failed for ${rel}; the file change was saved: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500)}`; }
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolResult> {
    const c = this.sb.resolve(args.path, true);
    if (!c.ok) return fail(c.reason);
    const content = str(args, "content");
    const exists = existsSync(c.abs);
    if (exists && !statSync(c.abs).isFile()) return fail("path is not a regular file");
    if (exists && args.allow_overwrite !== true) return fail("file already exists: use apply_patch for targeted edits (full-file overwrite is the last resort)");
    const before = exists ? readFileSync(c.abs, "utf8") : null;
    if (before === content) return fail("write would not change the file");
    return this.commit(c.rel, c.abs, before, content, exists ? "overwrite" : "create");
  }

  private async applyPatch(args: Record<string, unknown>): Promise<ToolResult> {
    const c = this.sb.resolve(args.path, true);
    if (!c.ok) return fail(c.reason);
    if (!existsSync(c.abs) || !statSync(c.abs).isFile()) return fail("file does not exist (use write_file to create a new file)");
    const cur = readFileSync(c.abs, "utf8");
    if (typeof args.expected_hash === "string" && hashText(cur) !== args.expected_hash) return fail("file changed on disk since it was read; re-read it before editing");
    let next: string, mode: string;
    if (typeof args.patch === "string") {
      const r = applyUnifiedPatch(cur, args.patch);
      if (!r.ok) return fail(r.error);
      next = r.content; mode = "patch";
    } else if (typeof args.old_text === "string" && typeof args.new_text === "string") {
      if (args.old_text === "") return fail("old_text must not be empty");
      const n = cur.split(args.old_text).length - 1;
      if (n === 0) return fail("old_text was not found in the file");
      if (n > 1) return fail(`old_text matches ${n} places; include more surrounding lines so it matches exactly once`);
      const nt = args.new_text;
      next = cur.replace(args.old_text, () => nt); mode = "replace";
    } else return fail("provide either patch, or old_text and new_text");
    if (next === cur) return fail("edit produces no change");
    return this.commit(c.rel, c.abs, cur, next, mode);
  }

  // --- repository queries ---------------------------------------------------

  private compactHits(rs: Awaited<ReturnType<IndexStore["query"]>>) {
    return rs.map((r) => ({ path: r.path, line_start: r.line_start, line_end: r.line_end, symbol: r.symbol, score: Number(r.score.toFixed(2)), snippet: r.snippet?.slice(0, 240) }));
  }

  private async search(args: Record<string, unknown>): Promise<ToolResult> {
    const kind = args.kind === "symbol" ? "symbol" : "text";
    const k = Math.min(10, Math.max(1, Math.floor(Number(args.k)) || 5));
    const hits = this.compactHits(await this.o.index.query(str(args, "query"), kind, k));
    return ok({ query: args.query, kind, count: hits.length, hits });
  }

  private async findSymbol(args: Record<string, unknown>): Promise<ToolResult> {
    const hits = this.compactHits(await this.o.index.query(str(args, "name"), "symbol", 8));
    return ok({ name: args.name, count: hits.length, hits });
  }

  private listFiles(args: Record<string, unknown>): ToolResult {
    const dirArg = typeof args.dir === "string" && args.dir !== "" && args.dir !== "." ? args.dir : null;
    const base = dirArg ? this.sb.resolve(dirArg, false) : this.sb.resolve(".", false, true);
    if (!base.ok) return fail(base.reason);
    if (!existsSync(base.abs) || !statSync(base.abs).isDirectory()) return fail("directory not found");
    const max = Math.min(200, Math.max(1, Math.floor(Number(args.max)) || 100));
    const ignore = new IgnoreRules(this.o.root);
    const files: string[] = [];
    let bytes = 0, cut = false;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (cut) return;
        if (e.isSymbolicLink()) continue;
        const rel = path.relative(this.sb.realRoot, path.join(dir, e.name)).split(path.sep).join("/");
        if (ignore.shouldIgnore(rel, e.isDirectory())) continue;
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.isFile()) {
          bytes += rel.length + 3;
          if (files.length >= max || bytes > this.maxResult) { cut = true; return; }
          files.push(rel);
        }
      }
    };
    walk(base.abs);
    return ok({ dir: base.rel || ".", count: files.length, files }, cut);
  }

  // --- commands -------------------------------------------------------------

  private async exec(argv: string[], extra: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = await runCommand(argv, this.o.root, { timeout_ms: this.timeout, max_bytes: 256 * 1024 });
    if (r.spawn_error) return fail(`could not start "${argv[0]}": ${r.spawn_error}`);
    const output = redactSecrets(r.output);
    const passed = r.exit_code === 0 && !r.timed_out;
    const data = {
      command: argv.join(" "), exit_code: r.exit_code, timed_out: r.timed_out, passed,
      summary: summarizeOutput(output), output_ref: storeOutput(this.o.root, output), output_truncated: r.truncated, duration_ms: r.duration_ms, ...extra,
    };
    const res = ok(data, r.truncated);
    if (!passed) res.ok = false, res.error = r.timed_out ? "timed out" : `exit code ${r.exit_code}`;
    return res;
  }

  private target(args: Record<string, unknown>): { rel: string } | ToolResult | null {
    if (args.target === undefined) return null;
    const c = this.sb.resolve(args.target, false);
    if (!c.ok) return fail(c.reason);
    if (!existsSync(c.abs) || !statSync(c.abs).isFile()) return fail("target file not found");
    return { rel: c.rel };
  }

  private async runTests(args: Record<string, unknown>): Promise<ToolResult> {
    const t = this.target(args);
    if (t && "ok" in t) return t;
    if (t) {
      if (!this.o.config.test_target) return fail("no targeted test command configured (test_target)");
      return this.exec(fill(this.o.config.test_target, t.rel));
    }
    return this.o.config.test ? this.exec(this.o.config.test) : fail("no test command configured");
  }

  private async runLinter(args: Record<string, unknown>): Promise<ToolResult> {
    const t = this.target(args);
    if (t && "ok" in t) return t;
    if (!t) return this.o.config.lint ? this.exec(this.o.config.lint) : fail("no linter configured");
    if (this.o.config.lint_target) return this.exec(fill(this.o.config.lint_target, t.rel));
    const ext = path.extname(t.rel).toLowerCase();
    if ([".js", ".mjs", ".cjs"].includes(ext)) return this.exec(["node", "--check", safeArg(t.rel)], { builtin: "syntax-check" });
    if (ext === ".py") return this.exec([process.platform === "win32" ? "python" : "python3", "-m", "py_compile", safeArg(t.rel)], { builtin: "syntax-check" });
    return fail("no linter or built-in syntax check for this file type");
  }

  private async runFormatter(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.o.config.format_target) return fail("no formatter configured (format_target)");
    const t = this.target(args);
    if (!t) return fail("run_formatter requires a target file");
    if ("ok" in t) return t;
    const c = this.sb.resolve(t.rel, true);
    if (!c.ok) return fail(c.reason);
    const before = readFileSync(c.abs, "utf8");
    const backup_ref = storeBackup(this.o.root, before);
    const res = await this.exec(fill(this.o.config.format_target, t.rel));
    const after = readFileSync(c.abs, "utf8");
    if (after !== before) {
      (res.data as any).edit = { path: c.rel, before_hash: hashText(before), after_hash: hashText(after), backup_ref };
      const warning = await this.refreshAfterMutation(c.rel, "modified");
      if (warning) (res.data as any).warning = warning;
    }
    return res;
  }

  private async gitDiff(args: Record<string, unknown>): Promise<ToolResult> {
    const base = ["git", "-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    if (args.path === undefined) return this.exec(base);
    const c = this.sb.resolve(args.path, false);
    if (!c.ok) return fail(c.reason);
    return this.exec([...base, "--", safeArg(c.rel)]);
  }
}

