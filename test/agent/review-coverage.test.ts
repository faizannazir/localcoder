import { test } from "node:test";
import assert from "node:assert/strict";
import { CodingAgent } from "../../src/agent/coding-agent";
import { AgentStateStore } from "../../src/agent/state";
import { DefaultToolRuntime } from "../../src/agent/tool-runtime";
import { loadAgentConfig } from "../../src/agent/config";
import type { AgentModelWorkflow } from "../../src/agent/model-workflow";
import { BackendTokenCounter } from "../../src/context/token-counter";
import { makeRepo, ScriptedBackend, POLICY, DECISION, collect } from "./helpers";

test("review discloses omitted file context while supplying the complete five-file diff", async () => {
  const paths = ["a.js", "b.js", "c.js", "d.js", "e.js"];
  const repo = await makeRepo({ buggy: false, extra: Object.fromEntries(paths.map((file) => [file, "module.exports = 1;\n"])) });
  try {
    let reviewerPrompt = "";
    const models = { planner: "plan", coder: "code", reviewer: "review" };
    const workflow: AgentModelWorkflow = { models, withRole: async (role, operation) => {
      const backend = new ScriptedBackend((_n, prompt) => {
        if (role === "planner") return JSON.stringify({ plan: ["Update five constants"], queries: [], files: paths });
        if (role === "coder") return JSON.stringify({ reasoning: "Update constants", edits: paths.map((file) => ({ op: "replace", path: file, old_text: "module.exports = 1;", new_text: "module.exports = 2;" })) });
        reviewerPrompt = prompt;
        return JSON.stringify({ approved: true, summary: "Complete diff is sufficient for these constant changes", findings: [] });
      });
      return operation({ backend, tokenCounter: new BackendTokenCounter(backend), policy: POLICY, decision: DECISION });
    } };
    const config = loadAgentConfig(repo.root);
    const agent = new CodingAgent({ root: repo.root, index: repo.store, memory: repo.memory, indexService: repo.indexService,
      tools: new DefaultToolRuntime({ root: repo.root, index: repo.store, indexService: repo.indexService, config }), modelWorkflow: workflow,
      policy: POLICY, decision: DECISION, config, stateStore: new AgentStateStore(repo.root) });
    const events = await collect(agent.run({ task: "Update all five constants" }));
    assert.equal(events.find((event) => event.type === "done")?.success, true);
    assert.match(reviewerPrompt, /## review_scope/);
    assert.match(reviewerPrompt, /Omitted file excerpts: e\.js/);
    assert.match(reviewerPrompt, /may be absent or truncated/);
    assert.match(reviewerPrompt, /reject.*insufficient/i);
    for (const file of paths) assert.ok(reviewerPrompt.includes(`+++ b/${file}`));
  } finally { repo.cleanup(); }
});
