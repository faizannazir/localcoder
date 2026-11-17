/** CLI orchestration with deterministic HTTP model replies; not trained-model quality evidence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { makeRepo, CALC_FIXED, PLAN_JSON, FAKE_PROFILE } from "./helpers";
import { AgentStateStore } from "../../src/agent/state";

test("CLI completes all three roles, runs repository tests and saves reviewer approval", { skip: process.platform === "win32" ? "POSIX executable fixture" : false, timeout: 15000 }, async () => {
  const models = { planner: "cli-plan", coder: "cli-code", reviewer: "cli-review" };
  const repo = await makeRepo({ config: { models, test: [process.execPath, "--test"], test_target: [process.execPath, "--test", "{file}"] } });
  try {
    const home = path.join(repo.root, ".localcoder", "test-home"); mkdirSync(home, { recursive: true });
    const replies = {
      "cli-plan": PLAN_JSON,
      "cli-code": JSON.stringify({ reasoning: "Use addition", edits: [{ op: "replace", path: "calc.js", old_text: "return a - b;", new_text: "return a + b;" }] }),
      "cli-review": JSON.stringify({ approved: true, summary: "Addition fixed with passing tests", findings: [] }),
    };
    const entries = Object.values(models).map((model_id) => {
      const file_path = path.join(home, model_id); writeFileSync(file_path, "HTTP engine fixture");
      return { model_id, file_path, architecture: "dense", parameter_count: { total: 0.1 }, quantization: "F32", context_limit: 16384, backend_requirements: ["cpu"], estimated_memory_gb: 0.1, capabilities: [] };
    });
    writeFileSync(path.join(home, "models.local.json"), JSON.stringify(entries));
    const preload = path.join(home, "profile.cjs");
    writeFileSync(preload, `require(${JSON.stringify(require.resolve("tsx/cjs"))});\nconst {HardwareProfiler}=require(${JSON.stringify(path.resolve(__dirname, "../../src/hardware/profiler.ts"))});\nHardwareProfiler.prototype.sample=async()=>(${JSON.stringify(FAKE_PROFILE)});\n`);
    const engine = path.join(home, "engine");
    writeFileSync(engine, `#!${process.execPath}
const http=require('http'),path=require('path');
const alias=process.argv[process.argv.indexOf('--alias')+1];
const id=path.basename(process.argv[process.argv.indexOf('--model')+1]);
const replies=${JSON.stringify(replies)};
const server=http.createServer((req,res)=>{
 let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
  if(req.url==='/health')return res.end(JSON.stringify({status:'ok'}));
  if(req.url==='/props')return res.end(JSON.stringify({model_alias:alias}));
  if(req.url==='/tokenize')return res.end(JSON.stringify({tokens:Array.from({length:Math.ceil(JSON.parse(body).content.length/4)},(_,i)=>i)}));
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({choices:[{delta:{content:replies[id]}}]})+'\\n\\n');
  res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n');
 });
});
server.listen(0,'127.0.0.1',()=>process.stderr.write('listening on http://127.0.0.1:'+server.address().port+'\\n'));
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, "--require", preload, path.resolve(__dirname, "../../src/cli/index.ts"), "agent", "Fix addition"], {
      cwd: repo.root, env: { ...process.env, LOCALCODER_HOME: home, LOCALCODER_LLAMA_SERVER_BIN: engine, LOCALCODER_BACKEND: "llama" }, encoding: "utf8", timeout: 12000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const [role, id] of Object.entries(models)) assert.ok(result.stdout.includes(`model: ${role} → ${id}`));
    assert.match(result.stdout, /DONE \(verification: full/);
    assert.equal(readFileSync(path.join(repo.root, "calc.js"), "utf8"), CALC_FIXED);
    const saved = new AgentStateStore(repo.root).list().at(-1)!;
    assert.equal(saved.status, "done"); assert.equal(saved.review?.approved, true); assert.deepEqual(saved.models, models);
  } finally { repo.cleanup(); }
});
