type Op = { t: " " | "-" | "+"; line: string };

function lcsOps(A: string[], B: string[]): Op[] {
  const n = A.length, m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: " ", line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "-", line: A[i++] });
    else ops.push({ t: "+", line: B[j++] });
  }
  while (i < n) ops.push({ t: "-", line: A[i++] });
  while (j < m) ops.push({ t: "+", line: B[j++] });
  return ops;
}

export function unifiedDiff(oldText: string, newText: string, filePath: string, context = 3): string {
  if (oldText === newText) return "";
  const a = oldText.split("\n"), b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const mid: Op[] = A.length * B.length > 4_000_000
    ? [...A.map((line) => ({ t: "-" as const, line })), ...B.map((line) => ({ t: "+" as const, line }))]
    : lcsOps(A, B);
  const ops: Op[] = [
    ...a.slice(0, s).map((line) => ({ t: " " as const, line })),
    ...mid,
    ...a.slice(ea).map((line) => ({ t: " " as const, line })),
  ];
  const oldNo: number[] = [], newNo: number[] = [];
  let o = 1, n = 1;
  for (const op of ops) { oldNo.push(o); newNo.push(n); if (op.t !== "+") o++; if (op.t !== "-") n++; }

  const hunks: [number, number][] = [];
  let hs = -1, he = -1;
  ops.forEach((op, ci) => {
    if (op.t === " ") return;
    const st = Math.max(0, ci - context), en = Math.min(ops.length - 1, ci + context);
    if (hs === -1) { hs = st; he = en; }
    else if (st <= he + 1) he = Math.max(he, en);
    else { hunks.push([hs, he]); hs = st; he = en; }
  });
  if (hs !== -1) hunks.push([hs, he]);

  const out = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const [st, en] of hunks) {
    const slice = ops.slice(st, en + 1);
    const oldLen = slice.filter((x) => x.t !== "+").length;
    const newLen = slice.filter((x) => x.t !== "-").length;
    out.push(`@@ -${oldNo[st]},${oldLen} +${newNo[st]},${newLen} @@`);
    for (const x of slice) out.push(x.t + x.line);
  }
  return out.join("\n") + "\n";
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}

export type PatchResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Strict unified-diff applier. Hunk line COUNTS in the header are not trusted (models get them wrong);
 * hunks are located by exact content match of context+removed lines. Zero matches or ambiguous
 * matches are refused rather than guessed.
 */
export function applyUnifiedPatch(original: string, patch: string): PatchResult {
  const crlf = original.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const fileLines = original.split(eol);

  const raw = patch.replace(/\r\n/g, "\n").split("\n");
  if (raw.length && raw[raw.length - 1] === "") raw.pop();
  const hunks: { hint: number; old: string[]; neu: string[] }[] = [];
  let cur: { hint: number; old: string[]; neu: string[] } | null = null;
  for (const line of raw) {
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)/);
      cur = { hint: m ? parseInt(m[1], 10) - 1 : 0, old: [], neu: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // file headers / preamble before the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = line[0];
    const body = line.slice(1);
    if (line === "") { cur.old.push(""); cur.neu.push(""); }
    else if (tag === " ") { cur.old.push(body); cur.neu.push(body); }
    else if (tag === "-") cur.old.push(body);
    else if (tag === "+") cur.neu.push(body);
    else return { ok: false, error: `malformed patch line: "${line.slice(0, 60)}"` };
  }
  if (hunks.length === 0) return { ok: false, error: "patch contains no hunks (@@ ... @@)" };

  let lines = fileLines;
  let cursor = 0;
  for (let h = 0; h < hunks.length; h++) {
    const { hint, old, neu } = hunks[h];
    if (old.length === 0) return { ok: false, error: `hunk ${h + 1} has no context or removed lines; cannot locate it safely` };
    const matches: number[] = [];
    for (let i = cursor; i + old.length <= lines.length; i++) {
      let same = true;
      for (let k = 0; k < old.length; k++) if (lines[i + k] !== old[k]) { same = false; break; }
      if (same) matches.push(i);
    }
    if (matches.length === 0) return { ok: false, error: `hunk ${h + 1} context does not match the file (re-read the file and retry)` };
    let at = matches[0];
    if (matches.length > 1) {
      const exact = matches.find((m) => m === hint + (lines.length - fileLines.length));
      if (exact === undefined) return { ok: false, error: `hunk ${h + 1} matches ${matches.length} places; add more context lines` };
      at = exact;
    }
    lines = [...lines.slice(0, at), ...neu, ...lines.slice(at + old.length)];
    cursor = at + neu.length;
  }
  return { ok: true, content: lines.join(eol) };
}
