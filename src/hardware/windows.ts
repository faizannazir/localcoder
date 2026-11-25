import { execFileSync } from "child_process";
import type { ThermalState, Confidence, GpuBackend } from "../types/index";

export const OS_RESERVE_GB = 1.5;

/**
 * Windows has no single reliable, non-elevated, version-stable API for CPU/package
 * temperature (WMI's MSAcpi_ThermalZoneTemperature is frequently absent or requires
 * elevation on modern hardware). Rather than fabricate a number from CPU%, Phase 0
 * reports this honestly as unknown/low-confidence — see implementation-spec.md §2.2,
 * the same rule that makes the sandboxed-Linux-container case behave correctly.
 */
export function readThermal(): { state: ThermalState; confidence: Confidence } {
  return { state: "unknown", confidence: "low" };
}

export function readBattery(): { present: boolean; on_ac: boolean; percent?: number } {
  try {
    // `wmic` is deprecated but still present on most Windows 10/11 builds as of this
    // writing; if it's gone (stripped Windows 11 builds), this throws and we degrade
    // to "no battery detected" rather than crash.
    const out = execFileSync(
      "wmic", ["path", "Win32_Battery", "get", "EstimatedChargeRemaining,BatteryStatus", "/format:csv"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 3000 }
    ).toString();
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return { present: false, on_ac: true };

    const cols = lines[1].split(",");
    const percent = parseInt(cols[1], 10);
    const status = parseInt(cols[2], 10); // 2 = "on AC / charging" per Win32_Battery.BatteryStatus
    return {
      present: true,
      on_ac: status === 2,
      percent: Number.isNaN(percent) ? undefined : percent,
    };
  } catch {
    return { present: false, on_ac: true };
  }
}

export function readGpu(): { backend: GpuBackend; vram_gb?: number } {
  try {
    const out = execFileSync(
      "nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 3000 }
    )
      .toString()
      .trim()
      .split("\n")[0];
    const mb = parseInt(out, 10);
    return { backend: "cuda", vram_gb: Number.isNaN(mb) ? undefined : mb / 1024 };
  } catch {
    return { backend: "cpu" };
  }
}
