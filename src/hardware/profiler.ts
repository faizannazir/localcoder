import os from "os";
import type { HardwareProfile, HardwareProfiler as IHardwareProfiler, Platform } from "../types/index";
import * as linux from "./linux";
import * as windows from "./windows";
import * as macos from "./macos";

const SAFETY_MARGIN_GB = 0.5;
const SAMPLE_INTERVAL_MS = 7000;

function currentPlatform(): Platform {
  const p = os.platform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux"; // Phase 0 targets linux/windows/macos only; anything else falls back to linux probes
}

function platformModule(p: Platform) {
  if (p === "windows") return windows;
  if (p === "macos") return macos;
  return linux;
}

function pressureFrom(memoryBudgetGb: number): "low" | "medium" | "high" {
  // Phase 0 thresholds — coarse on purpose, revisit once Phase 6 has real usage data.
  if (memoryBudgetGb >= 4) return "low";
  if (memoryBudgetGb >= 1) return "medium";
  return "high";
}

export class HardwareProfiler implements IHardwareProfiler {
  private listeners: ((p: HardwareProfile) => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastProfile: HardwareProfile | null = null;

  async sample(): Promise<HardwareProfile> {
    const platform = currentPlatform();
    const mod = platformModule(platform);

    const ram_total_gb = os.totalmem() / 1024 ** 3;
    const ram_available_gb = os.freemem() / 1024 ** 3;
    const os_reserve_gb =
      platform === "windows" ? windows.OS_RESERVE_GB : platform === "macos" ? macos.OS_RESERVE_GB : linux.OS_RESERVE_GB;

    const memory_budget_gb = Math.max(0, ram_available_gb - os_reserve_gb - SAFETY_MARGIN_GB);

    const thermal = mod.readThermal();
    const battery = mod.readBattery();
    const gpuInfo = mod.readGpu();

    const cpus = os.cpus();
    const arch = os.arch() === "arm64" ? "arm64" : "x86_64";

    const profile: HardwareProfile = {
      ram_total_gb: round2(ram_total_gb),
      ram_available_gb: round2(ram_available_gb),
      memory_budget_gb: round2(memory_budget_gb),
      ram_pressure: pressureFrom(memory_budget_gb),
      cpu: {
        cores: cpus.length,
        arch,
        isa: arch === "arm64" ? ["neon"] : ["sse4.2", "avx2"], // best-effort default; not probed precisely in Phase 0
      },
      gpu: {
        backend: gpuInfo.backend,
        vram_gb: "vram_gb" in gpuInfo ? gpuInfo.vram_gb : undefined,
        unified_memory: "unified_memory" in gpuInfo ? !!gpuInfo.unified_memory : false,
      },
      battery,
      thermal_state: thermal.state,
      thermal_confidence: thermal.confidence,
      timestamp: new Date().toISOString(),
    };

    this.lastProfile = profile;
    return profile;
  }

  onChange(cb: (p: HardwareProfile) => void): () => void {
    this.listeners.push(cb);
    if (!this.timer) {
      this.timer = setInterval(async () => {
        const p = await this.sample();
        for (const l of this.listeners) l(p);
      }, SAMPLE_INTERVAL_MS);
      // Don't hold the process open just for polling.
      this.timer.unref?.();
    }
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
      if (this.listeners.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
