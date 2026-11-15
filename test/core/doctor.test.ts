import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { runDoctor } from "../../src/cli/doctor";
import { HardwareProfiler } from "../../src/hardware/profiler";
import { FAKE_PROFILE } from "../agent/helpers";

test("doctor runs without throwing and reports every required field", async () => {
  const originalLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += args.join(" ") + "\n";
  };

  try {
    await runDoctor(); // must not throw
  } finally {
    console.log = originalLog;
  }

  for (const requiredLabel of [
    "OS",
    "CPU",
    "GPU",
    "RAM total",
    "RAM available",
    "Memory budget",
    "Thermal state",
    "Power mode",
    "Selected model",
  ]) {
    assert.ok(output.includes(requiredLabel), `doctor output is missing the "${requiredLabel}" line`);
  }
});

test("doctor reports the configured engine and user-registered model", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lc-doctor-"));
  const previousHome = process.env.LOCALCODER_HOME;
  const previousEngine = process.env.LOCALCODER_LLAMA_SERVER_BIN;
  const engine = path.join(root, process.platform === "win32" ? "llama-server.exe" : "llama-server");
  const model = path.join(root, "doctor-local.gguf");
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => output.push(args.join(" ")));
  t.mock.method(HardwareProfiler.prototype, "sample", async () => ({ ...FAKE_PROFILE }));
  try {
    writeFileSync(engine, "#!/bin/sh\nexit 0\n");
    chmodSync(engine, 0o755);
    writeFileSync(model, "fixture placeholder");
    writeFileSync(path.join(root, "models.local.json"), JSON.stringify([{
      model_id: "doctor-user-model", architecture: "dense", parameter_count: { total: 0.01 },
      quantization: "F32", file_path: model, context_limit: 4096, backend_requirements: ["cpu"],
      estimated_memory_gb: 0.01, capabilities: ["fim"],
    }]));
    process.env.LOCALCODER_HOME = root;
    process.env.LOCALCODER_LLAMA_SERVER_BIN = engine;
    await runDoctor();
    const text = output.join("\n");
    assert.match(text, /Selected model\s+doctor-user-model/);
    assert.match(text, /downloaded: true/);
    assert.ok(text.includes(engine), "doctor should report the engine selected by the shared locator");
  } finally {
    if (previousHome === undefined) delete process.env.LOCALCODER_HOME;
    else process.env.LOCALCODER_HOME = previousHome;
    if (previousEngine === undefined) delete process.env.LOCALCODER_LLAMA_SERVER_BIN;
    else process.env.LOCALCODER_LLAMA_SERVER_BIN = previousEngine;
    rmSync(root, { recursive: true, force: true });
  }
});
