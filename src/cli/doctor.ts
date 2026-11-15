import os from "os";
import { HardwareProfiler } from "../hardware/profiler";
import { DefaultPolicyEngine } from "../policy/engine";
import { DefaultModelRouter } from "../router/router";
import { loadFullRegistry, isDownloaded } from "../router/registry";
import { isRejection } from "../types/index";
import { locateLlamaServer } from "../util/paths";

export async function runDoctor(): Promise<void> {
  const profiler = new HardwareProfiler();
  const policyEngine = new DefaultPolicyEngine();
  const router = new DefaultModelRouter();

  const registry = loadFullRegistry();
  const engine = locateLlamaServer();

  const profile = await profiler.sample();
  const policy = policyEngine.derive(profile);
  const decision = router.route("normal_coding", policy, registry);

  const lines: string[] = [];
  lines.push(`localcoder doctor`);
  lines.push(`─────────────────`);
  lines.push(`OS               ${os.platform()} ${os.release()} (${profile.cpu.arch})`);
  lines.push(`CPU              ${profile.cpu.cores} cores, isa: ${profile.cpu.isa.join(", ")}`);
  lines.push(`GPU              ${profile.gpu.backend}${profile.gpu.vram_gb ? ` (${profile.gpu.vram_gb.toFixed(1)}GB VRAM)` : ""}${profile.gpu.unified_memory ? " [unified memory]" : ""}`);
  lines.push(`RAM total        ${profile.ram_total_gb.toFixed(2)} GB`);
  lines.push(`RAM available    ${profile.ram_available_gb.toFixed(2)} GB`);
  lines.push(`Memory budget    ${profile.memory_budget_gb.toFixed(2)} GB  (safely allocatable — see implementation-spec.md §2.1)`);
  lines.push(`RAM pressure     ${profile.ram_pressure}`);
  lines.push(`Battery          ${profile.battery.present ? `${profile.battery.percent ?? "?"}% (${profile.battery.on_ac ? "on AC" : "on battery"})` : "not present"}`);
  lines.push(`Thermal state    ${profile.thermal_state}  (confidence: ${profile.thermal_confidence})`);
  lines.push(`Power mode       ${policy.power_mode}`);
  lines.push(`Max context      ${policy.max_context_tokens} tokens`);
  lines.push(``);
  lines.push(`llama-server     ${engine.path ? `found at ${engine.path}` : "NOT found — see docs/MODELS.md"}`);
  lines.push(``);

  if (isRejection(decision)) {
    lines.push(`Selected model   none — ${decision.reason}`);
    for (const a of decision.attempted) {
      lines.push(`                   ${a.model_id}: needs ~${a.required_gb.toFixed(1)}GB, budget is ${a.budget_gb.toFixed(1)}GB`);
    }
  } else {
    const entry = registry.find((e) => e.model_id === decision.model_id);
    lines.push(`Selected model   ${decision.model_id} (${entry?.parameter_count.total}B${entry?.parameter_count.active ? `, ${entry.parameter_count.active}B active` : ""}, ${entry?.quantization})`);
    lines.push(`                   downloaded: ${entry ? isDownloaded(entry) : false}`);
    lines.push(`                   ctx window: ${decision.ctx_window}, kv dtype: ${decision.kv_cache_dtype}, gpu offload: ${(decision.gpu_offload_fraction * 100).toFixed(0)}%`);
  }

  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}
