import type { IncomingRequest, TaskClass, TaskClassifier as ITaskClassifier } from "../types/index";

// Heuristic signals for "this is a big, multi-file, architectural task" — deliberately
// simple regexes for Phase 0. Track the false-classification rate in real use (per
// implementation-spec.md Phase 3 row) before ever reaching for a trained classifier.
const HARD_AGENT_PATTERNS = [
  /\brefactor(ing)?\b/i,
  /\bacross (the )?(repo|codebase|project|files)\b/i,
  /\barchitecture\b/i,
  /\bmulti-?file\b/i,
  /\bevery (file|module|service)\b/i,
];

const STACK_TRACE_PATTERNS = [/Traceback \(most recent call last\)/, /^\s*at .+:\d+:\d+/m, /Exception in thread/];

const SIMPLE_MAX_CHARS = 200;

export class HeuristicTaskClassifier implements ITaskClassifier {
  classify(request: IncomingRequest): TaskClass {
    if (request.endpoint === "completions") {
      // Should never actually be called for this endpoint — see §2.8 isolation rule.
      // Kept here only so the type is total; routes/completions.ts must not import this class.
      return "autocomplete";
    }

    if (request.review) return "code_review";

    const text = (request.messages ?? []).map((m) => m.content).join("\n");

    if (HARD_AGENT_PATTERNS.some((re) => re.test(text))) return "hard_agent";
    if (STACK_TRACE_PATTERNS.some((re) => re.test(text))) return "normal_coding"; // a single error is a fix task, not yet "hard" — escalate only on repo-wide language above

    const fileMentions = (text.match(/\.\w{1,5}(\s|:|$)/g) ?? []).length; // crude "looks like it names files" signal
    if (fileMentions >= 3) return "hard_agent";

    if (text.length <= SIMPLE_MAX_CHARS && fileMentions === 0) return "chat_simple";

    return "normal_coding";
  }
}
