import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor } from "../../src/cli/doctor";

test("AT-0.8: doctor runs without throwing and reports every required field", async () => {
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
