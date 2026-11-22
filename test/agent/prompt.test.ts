import { test } from "node:test";
import assert from "node:assert/strict";
import { fitPrompt } from "../../src/agent/prompt";

test("a complete prompt that fits uses one tokenizer call", async () => {
  let calls = 0;
  const counter = { count: async (text: string) => {
    calls++;
    return { count: text.length, basis: "measured" as const };
  } };
  const result = await fitPrompt("Instructions", [
    { id: "goal", text: "Fix addition", priority: 100, required: true },
    { id: "source", text: "return a - b", priority: 50 },
  ], 200, counter);
  assert.match(result.messages[1].content, /return a - b/);
  assert.equal(calls, 1);
  assert.equal(result.tokens, result.messages.map((message) => message.content).join("\n").length);
});
