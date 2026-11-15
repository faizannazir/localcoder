import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "child_process";
import os from "os";
import { HardwareProfiler } from "../../src/hardware/profiler";

const GIB = 1024 ** 3;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 65536.
Pages active: 100000.
Pages inactive: 200000.
Pages speculative: 131072.
Pages wired down: 100000.
Pages occupied by compressor: 100000.
File-backed pages: 327680.
Anonymous pages: 400000.
`;

test("macOS profiler includes reclaimable file cache while preserving reserved headroom", async (t) => {
  t.mock.method(os, "platform", () => "darwin" as const);
  t.mock.method(os, "totalmem", () => 16 * GIB);
  t.mock.method(os, "freemem", () => GIB / 4);
  t.mock.method(childProcess, "execFileSync", (file: string) => {
    assert.equal(file, "/usr/bin/vm_stat");
    return Buffer.from(VM_STAT);
  });
  t.mock.method(childProcess, "execSync", () => Buffer.from("No battery"));
  const profile = await new HardwareProfiler().sample();
  assert.equal(profile.ram_available_gb, 6);
  assert.equal(profile.memory_budget_gb, 3.5);
  assert.equal(profile.ram_total_gb, 16);
});

test("macOS vm_stat parser uses reported page sizes and counts file-backed pages once", async () => {
  const { parseAvailableMemory } = await import("../../src/hardware/macos");
  const intel = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free: 10.
Pages speculative: 20.
Pages inactive: 500.
Pages wired down: 300.
Pages occupied by compressor: 100.
File-backed pages: 30.
Anonymous pages: 400.
`;
  assert.equal(parseAvailableMemory(intel), 40 * 4096);
  assert.equal(parseAvailableMemory(VM_STAT), 6 * GIB);
  assert.equal(parseAvailableMemory(intel.replace("Pages free: 10.", "Pages free: 0.").replace("File-backed pages: 30.", "File-backed pages: 0.")), 0);
});

test("macOS vm_stat parser rejects incomplete, invalid, and overflowing counts", async () => {
  const { parseAvailableMemory } = await import("../../src/hardware/macos");
  for (const invalid of [
    "", "not vm_stat output", VM_STAT.replace("File-backed pages:", "Missing pages:"),
    VM_STAT.replace("16384 bytes", "0 bytes"), VM_STAT.replace("16384 bytes", "-4096 bytes"),
    VM_STAT.replace("65536.", "-1."), VM_STAT.replace("65536.", "1.5."),
    VM_STAT.replace("65536.", "NaN."), VM_STAT.replace("65536.", "Infinity."),
    VM_STAT.replace("65536.", "9007199254740992."), VM_STAT.replace("65536.", "9007199254740991."),
  ]) assert.equal(parseAvailableMemory(invalid), null, invalid);
});

test("macOS available memory clamps the probe to physical RAM and falls back on probe failures", async (t) => {
  const { readAvailableMemory } = await import("../../src/hardware/macos");
  t.mock.method(os, "totalmem", () => 4 * GIB);
  t.mock.method(os, "freemem", () => GIB / 4);
  const probe = t.mock.method(childProcess, "execFileSync", (file: string, args?: readonly string[], options?: object) => {
    assert.equal(file, "/usr/bin/vm_stat");
    assert.deepEqual(args, []);
    assert.equal((options as { timeout: number }).timeout, 2000);
    return Buffer.from(VM_STAT);
  });
  assert.equal(readAvailableMemory(), 4 * GIB);
  probe.mock.mockImplementation(() => Buffer.from("unsupported vm_stat output"));
  assert.equal(readAvailableMemory(), GIB / 4);
  probe.mock.mockImplementation(() => { throw new Error("probe unavailable"); });
  assert.equal(readAvailableMemory(), GIB / 4);
});

test("non-macOS profiler keeps the platform's free-memory reading", async (t) => {
  t.mock.method(os, "platform", () => "linux" as const);
  t.mock.method(os, "totalmem", () => 16 * GIB);
  t.mock.method(os, "freemem", () => 4 * GIB);
  const probe = t.mock.method(childProcess, "execFileSync", () => { throw new Error("macOS probe must not run"); });
  const profile = await new HardwareProfiler().sample();
  assert.equal(profile.ram_available_gb, 4);
  assert.equal(probe.mock.callCount(), 0);
});
