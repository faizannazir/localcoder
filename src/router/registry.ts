import { readFileSync, existsSync } from "fs";
import path from "path";
import type { ModelRegistryEntry } from "../types/index";
import { installRoot, userDataDir, userModelsDir } from "../util/paths";

const REQUIRED_FIELDS: (keyof ModelRegistryEntry)[] = [
  "model_id",
  "architecture",
  "parameter_count",
  "quantization",
  "file_path",
  "context_limit",
  "backend_requirements",
  "estimated_memory_gb",
  "capabilities",
];

export function loadRegistry(registryPath?: string): ModelRegistryEntry[] {
  const resolved = registryPath ?? path.join(__dirname, "..", "..", "registry", "models.json");
  if (!existsSync(resolved)) {
    throw new Error(
      `Model registry not found at ${resolved}. Expected registry/models.json — see docs/MODELS.md.`
    );
  }

  const read = (file: string): ModelRegistryEntry[] => {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) throw new Error(`Model registry at ${file} must be a JSON array of ModelRegistryEntry.`);
    for (const entry of raw) {
      for (const field of REQUIRED_FIELDS) {
        if (!(field in entry)) throw new Error(`Model registry entry ${JSON.stringify(entry.model_id ?? entry)} in ${file} is missing "${field}".`);
      }
    }
    return raw as ModelRegistryEntry[];
  };

  // User-registered models (`localcoder models add`) live next to the shipped list and win on id clashes.
  const local = path.join(path.dirname(resolved), "models.local.json");
  const merged = new Map(read(resolved).map((e) => [e.model_id, e] as const));
  if (existsSync(local)) for (const e of read(local)) merged.set(e.model_id, e);
  return [...merged.values()];
}

/** Finds the real file for an entry: absolute path, or relative to the install dir, the user models dir (~/.localcoder/models), or the cwd. */
export function resolveModelPath(entry: ModelRegistryEntry, baseDir: string = installRoot()): string | null {
  const cands = path.isAbsolute(entry.file_path)
    ? [entry.file_path]
    : [path.join(baseDir, entry.file_path), path.join(userModelsDir(), path.basename(entry.file_path)), path.resolve(entry.file_path)];
  return cands.find((c) => existsSync(c)) ?? null;
}

/** True if the GGUF this entry points at is actually present on disk (vs. an un-downloaded placeholder). */
export function isDownloaded(entry: ModelRegistryEntry, baseDir?: string): boolean {
  return resolveModelPath(entry, baseDir) !== null;
}

/** Shipped registry + the user's own models (~/.localcoder/models.local.json), with file paths resolved to real absolute paths where the file exists. */
export function loadFullRegistry(): ModelRegistryEntry[] {
  const merged = new Map(loadRegistry(path.join(installRoot(), "registry", "models.json")).map((e) => [e.model_id, e] as const));
  const userFile = path.join(userDataDir(), "models.local.json");
  if (existsSync(userFile)) for (const e of JSON.parse(readFileSync(userFile, "utf8")) as ModelRegistryEntry[]) merged.set(e.model_id, e);
  return [...merged.values()].map((e) => { const r = resolveModelPath(e); return r ? { ...e, file_path: r } : e; });
}

export const installedOnly = (reg: ModelRegistryEntry[]): ModelRegistryEntry[] => reg.filter((e) => resolveModelPath(e) !== null);
