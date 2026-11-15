import type { TokenCounter } from "../types/index";

export class BudgetError extends Error {}

export interface PromptSection { id: string; text: string; priority: number; required?: boolean; shrinkable?: boolean }

type Counter = (t: string) => Promise<number>;

async function shrinkToTokens(text: string, tokens: number, count: Counter): Promise<string> {
  const marker = "\n[... truncated to fit the token budget ...]";
  const lines = text.split("\n");
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await count(lines.slice(0, mid).join("\n") + marker)) <= tokens) lo = mid; else hi = mid - 1;
  }
  if (lo > 0) return lines.slice(0, lo).join("\n") + marker;
  const chars = text.slice(0, Math.max(0, tokens * 3)) + marker;
  return (await count(chars)) <= tokens ? chars : "";
}

/**
 * Builds a two-message chat prompt that is GUARANTEED (by a final whole-prompt count) not to
 * exceed `budget` tokens, or throws BudgetError. Sections are admitted by priority; shrinkable
 * ones are truncated rather than dropped; required ones are never dropped.
 */
export async function fitPrompt(system: string, sections: PromptSection[], budget: number, counter: TokenCounter) {
  const count: Counter = async (t) => (await counter.count(t)).count;
  let basis: "measured" | "estimated" = "measured";
  const countB: Counter = async (t) => { const r = await counter.count(t); if (r.basis === "estimated") basis = "estimated"; return r.count; };
  let used = await countB(system);
  const included = new Map<string, string>();
  const dropped: string[] = [], truncated: string[] = [];
  const rank = (s: PromptSection) => (s.required ? Number.MAX_SAFE_INTEGER : s.priority);
  for (const s of [...sections].sort((a, b) => rank(b) - rank(a))) {
    if (s.text.trim() === "") continue;
    const header = `## ${s.id}\n`;
    const c = await countB(header + s.text);
    if (used + c <= budget) { included.set(s.id, s.text); used += c; continue; }
    if (s.required) throw new BudgetError(`prompt budget (${budget} tokens) is too small for the required "${s.id}" section`);
    if (s.shrinkable) {
      const remaining = budget - used - (await countB(header)) - 4;
      if (remaining > 20) {
        const t = await shrinkToTokens(s.text, remaining, count);
        if (t) { included.set(s.id, t); truncated.push(s.id); used += await countB(header + t); continue; }
      }
    }
    dropped.push(s.id);
  }
  const build = () => sections.filter((s) => included.has(s.id)).map((s) => `## ${s.id}\n${included.get(s.id)}`).join("\n\n");
  let user = build();
  let total = await countB(system + "\n" + user);
  while (total > budget) {
    const victim = [...sections].filter((s) => included.has(s.id) && !s.required).sort((a, b) => a.priority - b.priority)[0];
    if (!victim) throw new BudgetError(`prompt budget (${budget} tokens) is too small for system prompt + required sections`);
    included.delete(victim.id); dropped.push(victim.id);
    user = build();
    total = await countB(system + "\n" + user);
  }
  return {
    messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: user }],
    tokens: total, basis: basis as "measured" | "estimated", dropped, truncated,
  };
}
