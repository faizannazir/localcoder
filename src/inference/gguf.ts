import { openSync, readSync, closeSync, fstatSync } from "fs";
import path from "path";
import type { ModelRegistryEntry, Quantization, Capability } from "../types/index";

/**
 * Minimal GGUF (v2/v3) metadata reader: header + key/value section only, never the tensors.
 * Streams from disk, so multi-GB model files are never loaded into memory. Written from the
 * GGUF spec and validated against hand-built spec-conformant fixtures; real files are exercised
 * by `localcoder models add` / `localcoder verify` (no real GGUF was available when this was written).
 */
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12 };
const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const MAX_STRING = 16 * 1024 * 1024;

class Reader {
  private buf = Buffer.alloc(0);
  private bufStart = 0;
  private pos = 0;
  constructor(private fd: number, readonly size: number) {}

  private take(n: number): Buffer {
    if (this.pos + n > this.size) throw new Error("GGUF file truncated while reading metadata");
    const end = this.bufStart + this.buf.length;
    if (this.pos < this.bufStart || this.pos + n > end) {
      const chunk = Buffer.alloc(Math.min(Math.max(n, 256 * 1024), this.size - this.pos));
      const got = readSync(this.fd, chunk, 0, chunk.length, this.pos);
      this.buf = chunk.subarray(0, got);
      this.bufStart = this.pos;
      if (got < n) throw new Error("GGUF file truncated while reading metadata");
    }
    const o = this.pos - this.bufStart;
    this.pos += n;
    return this.buf.subarray(o, o + n);
  }
  skip(n: number) {
    if (this.pos + n > this.size) throw new Error("GGUF file truncated while skipping metadata");
    this.pos += n;
  }
  u8() { return this.take(1)[0]; }
  u32() { return this.take(4).readUInt32LE(0); }
  u64(): number { return Number(this.take(8).readBigUInt64LE(0)); }
  scalar(type: number): number | boolean {
    const b = this.take(FIXED_SIZE[type]);
    switch (type) {
      case T.U8: return b.readUInt8(0);
      case T.I8: return b.readInt8(0);
      case T.U16: return b.readUInt16LE(0);
      case T.I16: return b.readInt16LE(0);
      case T.U32: return b.readUInt32LE(0);
      case T.I32: return b.readInt32LE(0);
      case T.F32: return b.readFloatLE(0);
      case T.BOOL: return b.readUInt8(0) !== 0;
      case T.U64: return Number(b.readBigUInt64LE(0));
      case T.I64: return Number(b.readBigInt64LE(0));
      case T.F64: return b.readDoubleLE(0);
    }
    throw new Error(`unknown GGUF scalar type ${type}`);
  }
  string(): string {
    const len = this.u64();
    if (len > MAX_STRING) throw new Error(`implausible GGUF string length ${len} (corrupt file?)`);
    return this.take(len).toString("utf8");
  }
  skipString() { this.skip(this.u64()); }
}

export interface GgufMeta {
  version: number;
  tensor_count: number;
  kv_count: number;
  file_size: number;
  kv: Record<string, string | number | boolean | { array_len: number }>;
  has_fim_tokens: boolean;
  chat_template_mentions_tools: boolean;
}

export function readGgufMeta(file: string): GgufMeta {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const r = new Reader(fd, size);
    if (size < 24) throw new Error("not a GGUF file (too small)");
    const magic = Buffer.from([r.u8(), r.u8(), r.u8(), r.u8()]).toString("latin1");
    if (magic !== "GGUF") throw new Error(`not a GGUF file (magic "${magic.replace(/[^\x20-\x7e]/g, "?")}")`);
    const version = r.u32();
    if (version < 2 || version > 3) throw new Error(`unsupported GGUF version ${version} (this reader supports 2 and 3)`);
    const tensor_count = r.u64();
    const kv_count = r.u64();
    if (kv_count > 100_000) throw new Error(`implausible GGUF key count ${kv_count} (corrupt file?)`);
    const meta: GgufMeta = { version, tensor_count, kv_count, file_size: size, kv: {}, has_fim_tokens: false, chat_template_mentions_tools: false };
    for (let i = 0; i < kv_count; i++) {
      const key = r.string();
      readValue(r, key, r.u32(), meta, false);
    }
    return meta;
  } finally { closeSync(fd); }
}

function readValue(r: Reader, key: string, type: number, meta: GgufMeta, inArray: boolean): void {
  if (type === T.STR) {
    const s = r.string();
    if (!inArray) {
      if (key === "tokenizer.chat_template") { meta.chat_template_mentions_tools = /\btools?\b/.test(s); meta.kv[key] = s.slice(0, 80); }
      else meta.kv[key] = s;
    }
    return;
  }
  if (type === T.ARR) {
    const elType = r.u32();
    const len = r.u64();
    if (elType === T.STR) {
      const scan = key === "tokenizer.ggml.tokens";
      for (let j = 0; j < len; j++) {
        if (scan) { if (/fim[_-]?(prefix|pre)\b|<PRE>/i.test(r.string())) meta.has_fim_tokens = true; }
        else r.skipString();
      }
    } else if (elType === T.ARR) {
      for (let j = 0; j < len; j++) readValue(r, key, T.ARR, meta, true);
    } else if (FIXED_SIZE[elType] !== undefined) {
      r.skip(len * FIXED_SIZE[elType]);
    } else throw new Error(`unknown GGUF array element type ${elType} for "${key}"`);
    if (!inArray) meta.kv[key] = { array_len: len };
    return;
  }
  if (FIXED_SIZE[type] === undefined) throw new Error(`unknown GGUF value type ${type} for "${key}"`);
  const v = r.scalar(type);
  if (!inArray) meta.kv[key] = v;
}

const FILE_TYPE: Record<number, Quantization> = { 0: "F32", 1: "F16", 2: "Q4_0", 7: "Q8_0", 10: "Q2_K", 12: "Q3_K_M", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K" };

export interface GgufSummary {
  architecture: string;
  name?: string;
  size_label?: string;
  context_length?: number;
  layers?: number;
  embedding_length?: number;
  head_count?: number;
  kv_heads?: number;
  head_dim?: number;
  expert_count?: number;
  quantization: Quantization;
}

export function summarizeGguf(m: GgufMeta): GgufSummary {
  const arch = String(m.kv["general.architecture"] ?? "unknown");
  const num = (k: string) => (typeof m.kv[`${arch}.${k}`] === "number" ? (m.kv[`${arch}.${k}`] as number) : undefined);
  const head_count = num("attention.head_count");
  const embedding_length = num("embedding_length");
  const ft = m.kv["general.file_type"];
  return {
    architecture: arch,
    name: typeof m.kv["general.name"] === "string" ? (m.kv["general.name"] as string) : undefined,
    size_label: typeof m.kv["general.size_label"] === "string" ? (m.kv["general.size_label"] as string) : undefined,
    context_length: num("context_length"),
    layers: num("block_count"),
    embedding_length,
    head_count,
    kv_heads: num("attention.head_count_kv") ?? head_count,
    head_dim: num("attention.key_length") ?? (embedding_length && head_count ? Math.floor(embedding_length / head_count) : undefined),
    expert_count: num("expert_count"),
    quantization: (typeof ft === "number" && FILE_TYPE[ft]) || "other",
  };
}

function paramsFrom(label: string | undefined, fileName: string): { total: number; active?: number } | null {
  for (const src of [label, fileName]) {
    if (!src) continue;
    const m = src.match(/(\d+(?:\.\d+)?)[Bb](?:[-_]?A(\d+(?:\.\d+)?)[Bb])?(?![a-z])/);
    if (m) return { total: parseFloat(m[1]), active: m[2] ? parseFloat(m[2]) : undefined };
  }
  return null;
}

/**
 * Builds a registry entry from a real GGUF. `estimated_memory_gb` is file size + ~8% (mmapped weights + small buffers):
 * an ESTIMATE until `localcoder verify` measures real RSS. Parameter count comes from the GGUF size label or filename,
 * falling back to a ~4.8 bits/weight guess from file size (labelled in docs/TECHNICAL-NOTES.md).
 */
export function entryFromGguf(file: string, meta: GgufMeta = readGgufMeta(file)): ModelRegistryEntry {
  const s = summarizeGguf(meta);
  const abs = path.resolve(file);
  const base = path.basename(abs).replace(/\.gguf$/i, "");
  const params = paramsFrom(s.size_label, base) ?? { total: Math.round(((meta.file_size * 8) / 4.8e9) * 10) / 10 };
  const caps: Capability[] = [];
  if (meta.has_fim_tokens) caps.push("fim");
  if (meta.chat_template_mentions_tools) caps.push("tool_calling");
  if ((s.context_length ?? 0) >= 100_000) caps.push("long_context");
  const entry: ModelRegistryEntry = {
    model_id: base.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, ""),
    architecture: (s.expert_count ?? 0) > 1 ? "moe" : "dense",
    parameter_count: params,
    quantization: s.quantization,
    file_path: abs,
    context_limit: s.context_length ?? 4096,
    backend_requirements: ["cpu", "metal", "cuda", "vulkan"],
    estimated_memory_gb: Math.round((meta.file_size / 1024 ** 3) * 1.08 * 100) / 100,
    capabilities: caps,
  };
  if (s.layers) entry.layers = s.layers;
  if (s.head_count) entry.attention_heads = s.head_count;
  if (s.kv_heads) entry.kv_heads = s.kv_heads;
  if (s.head_dim) entry.head_dim = s.head_dim;
  return entry;
}
