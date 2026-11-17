import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { LlamaCppBackend } from "../../src/inference/llama-cpp-backend";
import { DefaultModelManager } from "../../src/manager/model-manager";
import { DefaultModelRouter } from "../../src/router/router";
import { DefaultPolicyEngine } from "../../src/policy/engine";
import { SequentialModelWorkflow } from "../../src/agent/model-workflow";
import { FAKE_PROFILE } from "./helpers";
import type { ModelRegistryEntry } from "../../src/types/index";

for (const stage of ["tokenizer", "startup"] as const) test(`aborting stalled role ${stage} releases the exclusive model queue`, { skip: process.platform === "win32" ? "POSIX executable fixture" : false, timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-tokenize-cancel-"));
  const binary = path.join(root, "server");
  const model = path.join(root, "model.gguf"); writeFileSync(model, "fixture");
  writeFileSync(binary, `#!${process.execPath}
const http = require('http');
const alias = process.argv[process.argv.indexOf('--alias') + 1];
const server = http.createServer((req, res) => {
 if (req.url === '/health' && ${stage === 'startup'}) return;
 if (req.url === '/health') return res.end(JSON.stringify({status:'ok'}));
 if (req.url === '/props') return res.end(JSON.stringify({model_alias:alias}));
 if (req.url === '/tokenize') { process.stdout.write('TOKENIZE_STARTED\\n'); return; }
 res.end('{}');
});
server.listen(0,'127.0.0.1',()=>process.stderr.write('listening on http://127.0.0.1:'+server.address().port+'\\n'));
`, { mode: 0o755 });
  const entry: ModelRegistryEntry = { model_id: "fixture", file_path: model, architecture: "dense", parameter_count: { total: 0.1 }, quantization: "F32", context_limit: 4096, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: [] };
  const backends: LlamaCppBackend[] = [];
  const manager = new DefaultModelManager([entry], () => { const b = new LlamaCppBackend({ binary }); backends.push(b); if (stage === "startup") setTimeout(() => controller.abort(), 50); return b; });
  const controller = new AbortController();
  const workflow = new SequentialModelWorkflow({ registry: [entry], modelManager: manager, router: new DefaultModelRouter(), policyEngine: new DefaultPolicyEngine(), profiler: { sample: async () => FAKE_PROFILE, onChange: () => () => {} } }, { planner: "fixture", coder: "fixture", reviewer: "fixture" });
  let pending: Promise<unknown> | undefined;
  try {
    pending = workflow.withRole("planner", async ({ tokenCounter }) => {
      const count = tokenCounter.count("hello");
      setTimeout(() => controller.abort(), 30);
      return count;
    }, controller.signal);
    const outcome = pending.then(() => "completed", () => "aborted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([outcome, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("stalled"), 2000); })]);
    clearTimeout(timer);
    assert.equal(result, "aborted", "request cancellation must interrupt real HTTP model work");
    await manager.unloadAll();
    assert.equal(manager.resident().length, 0);
    assert.ok(backends.every((b) => b.pid === undefined));
  } finally {
    controller.abort();
    for (const backend of backends) await backend.unload();
    await pending?.catch(() => {});
    await manager.unloadAll();
    rmSync(root, { recursive: true, force: true });
  }
});
