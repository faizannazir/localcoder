import { readFileSync, existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import type { ThermalState, Confidence, GpuBackend } from "../types/index";

/** RAM the OS itself needs headroom for, before we ever compute a model's budget. */
export const OS_RESERVE_GB = 1.0;

export function readThermal(): { state: ThermalState; confidence: Confidence } {
  // /sys/class/thermal/thermal_zone*/temp is in millidegrees C where present. Container
  // environments and many desktops simply don't expose this — that's a real "unknown",
  // not a bug, so we report it as such rather than guessing from CPU load.
  try {
    if (!existsSync("/sys/class/thermal")) {
      return { state: "unknown", confidence: "low" };
    }
    const zones = readdirSync("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone"));
    if (zones.length === 0) return { state: "unknown", confidence: "low" };

    let maxMilliC = -Infinity;
    for (const zone of zones) {
      const path = `/sys/class/thermal/${zone}/temp`;
      if (!existsSync(path)) continue;
      const raw = parseInt(readFileSync(path, "utf8").trim(), 10);
      if (!Number.isNaN(raw)) maxMilliC = Math.max(maxMilliC, raw);
    }
    if (maxMilliC === -Infinity) return { state: "unknown", confidence: "low" };

    const celsius = maxMilliC / 1000;
    // Coarse, conservative thresholds for Phase 0 — replace with per-device calibration
    // once Phase 6 has measured real thermal behavior across reference hardware.
    if (celsius < 70) return { state: "nominal", confidence: "high" };
    if (celsius < 85) return { state: "fair", confidence: "high" };
    if (celsius < 95) return { state: "serious", confidence: "high" };
    return { state: "critical", confidence: "high" };
  } catch {
    return { state: "unknown", confidence: "low" };
  }
}

export function readBattery(): { present: boolean; on_ac: boolean; percent?: number } {
  try {
    const supplyDir = "/sys/class/power_supply";
    if (!existsSync(supplyDir)) return { present: false, on_ac: true };

    const entries = readdirSync(supplyDir);
    const bat = entries.find((e) => e.startsWith("BAT"));
    const ac = entries.find((e) => e.startsWith("A") || e.startsWith("AC") || e.startsWith("ADP"));

    if (!bat) {
      // Desktop / server / VM: no battery at all, so effectively always "on_ac".
      return { present: false, on_ac: true };
    }

    const capacityPath = `${supplyDir}/${bat}/capacity`;
    const percent = existsSync(capacityPath) ? parseInt(readFileSync(capacityPath, "utf8").trim(), 10) : undefined;

    let on_ac = true;
    if (ac) {
      const onlinePath = `${supplyDir}/${ac}/online`;
      if (existsSync(onlinePath)) {
        on_ac = readFileSync(onlinePath, "utf8").trim() === "1";
      }
    }

    return { present: true, on_ac, percent: Number.isNaN(percent) ? undefined : percent };
  } catch {
    return { present: false, on_ac: true };
  }
}

export function readGpu(): { backend: GpuBackend; vram_gb?: number } {
  try {
    execSync("which nvidia-smi", { stdio: "ignore" });
    try {
      const out = execSync(
        "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits",
        { stdio: ["ignore", "pipe", "ignore"] }
      )
        .toString()
        .trim()
        .split("\n")[0];
      const mb = parseInt(out, 10);
      return { backend: "cuda", vram_gb: Number.isNaN(mb) ? undefined : mb / 1024 };
    } catch {
      return { backend: "cuda" };
    }
  } catch {
    /* no nvidia-smi */
  }

  try {
    execSync("which rocm-smi", { stdio: "ignore" });
    return { backend: "vulkan" }; // ROCm devices are addressed via Vulkan in our backend_requirements vocabulary
  } catch {
    /* no rocm-smi */
  }

  return { backend: "cpu" };
}
