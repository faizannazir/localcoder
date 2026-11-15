/** Writes spec-conformant GGUF bytes (header + KV section) so the reader can be tested without a multi-GB download. This is a FILE FORMAT fixture, not a stand-in for any service. */
type V =
  | { t: "u32"; v: number } | { t: "u64"; v: number } | { t: "f32"; v: number } | { t: "bool"; v: boolean }
  | { t: "str"; v: string } | { t: "arr_u32"; v: number[] } | { t: "arr_f32"; v: number[] } | { t: "arr_str"; v: string[] } | { t: "arr_arr_u32"; v: number[][] };

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => { const d = Buffer.from(s, "utf8"); return Buffer.concat([u64(d.length), d]); };

function value(x: V): Buffer {
  switch (x.t) {
    case "u32": return Buffer.concat([u32(4), u32(x.v)]);
    case "u64": return Buffer.concat([u32(10), u64(x.v)]);
    case "f32": { const b = Buffer.alloc(4); b.writeFloatLE(x.v); return Buffer.concat([u32(6), b]); }
    case "bool": return Buffer.concat([u32(7), Buffer.from([x.v ? 1 : 0])]);
    case "str": return Buffer.concat([u32(8), str(x.v)]);
    case "arr_u32": return Buffer.concat([u32(9), u32(4), u64(x.v.length), ...x.v.map(u32)]);
    case "arr_f32": return Buffer.concat([u32(9), u32(6), u64(x.v.length), ...x.v.map((n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; })]);
    case "arr_str": return Buffer.concat([u32(9), u32(8), u64(x.v.length), ...x.v.map(str)]);
    case "arr_arr_u32": return Buffer.concat([u32(9), u32(9), u64(x.v.length), ...x.v.map((a) => Buffer.concat([u32(4), u64(a.length), ...a.map(u32)]))]);
  }
}

export function buildGguf(kvs: [string, V][], opts: { version?: number; tensorCount?: number; trailing?: number; kvCountOverride?: number } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF", "latin1"), u32(opts.version ?? 3), u64(opts.tensorCount ?? 0), u64(opts.kvCountOverride ?? kvs.length)];
  for (const [k, v] of kvs) parts.push(str(k), value(v));
  if (opts.trailing) parts.push(Buffer.alloc(opts.trailing)); // stands in for the tensor data we never read
  return Buffer.concat(parts);
}

export function qwenLikeKvs(over: Record<string, V> = {}): [string, V][] {
  const base: Record<string, V> = {
    "general.architecture": { t: "str", v: "qwen2" },
    "general.name": { t: "str", v: "Qwen2.5 Coder 1.5B Instruct" },
    "general.size_label": { t: "str", v: "1.5B" },
    "general.file_type": { t: "u32", v: 15 },
    "general.quantization_version": { t: "u32", v: 2 },
    "qwen2.context_length": { t: "u32", v: 32768 },
    "qwen2.block_count": { t: "u32", v: 28 },
    "qwen2.embedding_length": { t: "u32", v: 1536 },
    "qwen2.attention.head_count": { t: "u32", v: 12 },
    "qwen2.attention.head_count_kv": { t: "u32", v: 2 },
    "qwen2.rope.freq_base": { t: "f32", v: 1000000 },
    "tokenizer.ggml.add_bos_token": { t: "bool", v: false },
    "tokenizer.ggml.tokens": { t: "arr_str", v: ["<|endoftext|>", "hello", "world", "<|fim_prefix|>", "<|fim_middle|>", "<|fim_suffix|>"] },
    "tokenizer.ggml.token_type": { t: "arr_u32", v: [3, 1, 1, 4, 4, 4] },
    "tokenizer.ggml.scores": { t: "arr_f32", v: [0, 0, 0, 0, 0, 0] },
    "tokenizer.ggml.nested": { t: "arr_arr_u32", v: [[1, 2], [3]] },
    "tokenizer.chat_template": { t: "str", v: "{%- if tools %}tools are available{%- endif %}" },
  };
  return Object.entries({ ...base, ...over });
}
