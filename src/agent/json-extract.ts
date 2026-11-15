/** Pulls the first parseable JSON object out of model text (tolerates prose and ``` fences). Returns null if none. */
export function extractJson(text: string): unknown | null {
  const stripped = text.replace(/```(?:json)?/gi, "");
  for (let start = stripped.indexOf("{"); start !== -1; start = stripped.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(stripped.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}
