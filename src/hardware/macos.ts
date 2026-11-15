import { execSync } from "child_process";
import os from "os";
import type { ThermalState, Confidence, GpuBackend } from "../types/index";

/** macOS reserves the most: unified memory is shared with WindowServer and the GPU. */
export const OS_RESERVE_GB = 2.0;

/**
 * Real thermal-pressure data on macOS comes from `powermetrics`, which requires sudo —
 * not viable to shell out to non-interactively from a background server process. Rather
 * than approximate temperature from CPU load (explicitly disallowed by spec §2.2), Phase 0
 * reports unknown/low-confidence here. A later phase can integrate IOKit thermal
 * notifications properly via a native addon; that's out of scope for the Node-only Phase 0.
 */
export function readThermal(): { state: ThermalState; confidence: Confidence } {
  return { state: "unknown", confidence: "low" };
}

export function readBattery(): { present: boolean; on_ac: boolean; percent?: number } {
  try {
    const out = execSync("pmset -g batt", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    if (!/InternalBattery/.test(out)) return { present: false, on_ac: true };

    const percentMatch = out.match(/(\d+)%/);
    const on_ac = /AC Power/.test(out);
    return {
      present: true,
      on_ac,
      percent: percentMatch ? parseInt(percentMatch[1], 10) : undefined,
    };
  } catch {
    return { present: false, on_ac: true };
  }
}

export function readGpu(): { backend: GpuBackend; unified_memory: boolean } {
  // Apple Silicon (arm64) always has a unified-memory Metal GPU. Intel Macs may have a
  // discrete AMD GPU, but detecting and sizing it reliably without a native call is out
  // of scope for Phase 0 — documented limitation, not silently wrong: we report "cpu"
  // for Intel Macs here rather than guess at Metal availability/VRAM we can't verify.
  if (os.arch() === "arm64") {
    return { backend: "metal", unified_memory: true };
  }
  return { backend: "cpu", unified_memory: false };
}
