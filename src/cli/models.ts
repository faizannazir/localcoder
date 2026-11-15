import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { loadFullRegistry, isDownloaded } from "../router/registry";
import { userDataDir } from "../util/paths";
import { entryFromGguf, readGgufMeta, summarizeGguf } from "../inference/gguf";
import type { ModelRegistryEntry } from "../types/index";

export function registerLocalEntry(registryDir: string, entry: ModelRegistryEntry): void {
  const file = path.join(registryDir, "models.local.json");
  mkdirSync(registryDir, { recursive: true });
  const current: ModelRegistryEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  writeFileSync(file, JSON.stringify([...current.filter((e) => e.model_id !== entry.model_id), entry], null, 2) + "\n");
}

/** Registers a real GGUF file: reads its header and writes/updates registry/models.local.json. Returns the entry. */
export function addLocalModel(registryDir: string, ggufPath: string): ModelRegistryEntry {
  const entry = entryFromGguf(ggufPath, readGgufMeta(ggufPath));
  const file = path.join(registryDir, "models.local.json");
  mkdirSync(registryDir, { recursive: true });
  const current: ModelRegistryEntry[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  writeFileSync(file, JSON.stringify([...current.filter((e) => e.model_id !== entry.model_id), entry], null, 2) + "\n");
  return entry;
}

export function removeLocalModel(registryDir: string, id: string): boolean {
  const file = path.join(registryDir, "models.local.json");
  if (!existsSync(file)) return false;
  const current: ModelRegistryEntry[] = JSON.parse(readFileSync(file, "utf8"));
  const next = current.filter((e) => e.model_id !== id);
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next.length !== current.length;
}

export async function runModels(args: string[] = []): Promise<void> {
  const registryDir = userDataDir(); // user data, never the (possibly read-only) install directory

  if (args[0] === "add") {
    if (!args[1]) { console.log("Usage: localcoder models add <path/to/model.gguf>"); process.exitCode = 1; return; }
    try {
      const e = addLocalModel(registryDir, args[1]);
      console.log(`Registered ${e.model_id}`);
      console.log(`  arch ${summarizeGguf(readGgufMeta(args[1])).architecture}, ${e.parameter_count.total}B${e.parameter_count.active ? ` (${e.parameter_count.active}B active)` : ""}, ${e.quantization}, context ${e.context_limit}`);
      console.log(`  layers ${e.layers ?? "?"}, kv heads ${e.kv_heads ?? "?"}, head dim ${e.head_dim ?? "?"}${e.layers && e.kv_heads && e.head_dim ? "  -> KV cache is computed exactly" : "  -> incomplete: KV cache falls back to the heuristic"}`);
      console.log(`  capabilities: ${e.capabilities.join(", ") || "none detected"}`);
      console.log(`  estimated memory ${e.estimated_memory_gb} GB (file size + 8%; run "localcoder verify" to measure the real figure)`);
    } catch (err) { console.error(`localcoder: ${(err as Error).message}`); process.exitCode = 1; }
    return;
  }
  if (args[0] === "remove") {
    console.log(removeLocalModel(registryDir, args[1] ?? "") ? `Removed ${args[1]}` : `No locally-registered model "${args[1]}"`);
    return;
  }

  const registry = loadFullRegistry();
  const rows = registry.map((e) => ({
    model_id: e.model_id,
    params: `${e.parameter_count.total}B${e.parameter_count.active ? ` (${e.parameter_count.active}B active)` : ""}`,
    quant: e.quantization,
    ctx: e.context_limit.toLocaleString(),
    est_gb: e.estimated_memory_gb.toFixed(1),
    downloaded: isDownloaded(e) ? "yes" : "no — run `localcoder models add <file.gguf>`",
  }));
  const w = (k: keyof (typeof rows)[0], min: number) => Math.max(min, ...rows.map((r) => r[k].length));
  const widths = { model_id: w("model_id", 8), params: w("params", 6), quant: w("quant", 5), ctx: w("ctx", 3), est_gb: w("est_gb", 6) };
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad("MODEL_ID", widths.model_id)}  ${pad("PARAMS", widths.params)}  ${pad("QUANT", widths.quant)}  ${pad("CTX", widths.ctx)}  ${pad("EST_GB", widths.est_gb)}  DOWNLOADED`);
  for (const r of rows) console.log(`${pad(r.model_id, widths.model_id)}  ${pad(r.params, widths.params)}  ${pad(r.quant, widths.quant)}  ${pad(r.ctx, widths.ctx)}  ${pad(r.est_gb, widths.est_gb)}  ${r.downloaded}`);
}
