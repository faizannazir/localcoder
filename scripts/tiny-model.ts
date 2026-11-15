/**
 * Writes a REAL, loadable GGUF: a 2-layer llama-architecture model with RANDOM weights and a byte-level tokenizer
 * (plus FIM tokens and a chat template). llama-server loads and runs it for real, but its output is gibberish — it
 * exists to exercise the true server plumbing (load, health, tokenizer, streaming chat, /infill, KV flags, memory),
 * NOT to judge model quality. Usage: tsx scripts/tiny-model.ts out.gguf
 */
import { writeFileSync } from "fs";

const N_LAYER = 2, N_HEAD = 4, N_KV = 2;

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const f32 = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const gstr = (s: string) => { const d = Buffer.from(s, "utf8"); return Buffer.concat([u64(d.length), d]); };

type KV = [string, Buffer];
const kvU32 = (k: string, v: number): KV => [k, Buffer.concat([u32(4), u32(v)])];
const kvF32 = (k: string, v: number): KV => [k, Buffer.concat([u32(6), f32(v)])];
const kvStr = (k: string, v: string): KV => [k, Buffer.concat([u32(8), gstr(v)])];
const kvArrStr = (k: string, v: string[]): KV => [k, Buffer.concat([u32(9), u32(8), u64(v.length), ...v.map(gstr)])];
const kvArrF32 = (k: string, v: number[]): KV => [k, Buffer.concat([u32(9), u32(6), u64(v.length), ...v.map(f32)])];
const kvArrI32 = (k: string, v: number[]): KV => [k, Buffer.concat([u32(9), u32(5), u64(v.length), ...v.map(i32)])];

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function writeTinyModel(file: string, opts: { headDim?: number } = {}): { vocab: number; tensors: number; bytes: number } {
  const HEAD_DIM = opts.headDim ?? 16, N_EMBD = N_HEAD * HEAD_DIM, N_FF = N_EMBD * 2, KV_DIM = N_KV * HEAD_DIM;
  const tokens: string[] = ["<unk>", "<s>", "</s>"];
  const types: number[] = [2, 3, 3];
  for (let i = 0; i < 256; i++) { tokens.push(`<0x${i.toString(16).toUpperCase().padStart(2, "0")}>`); types.push(6); }
  const FIM_PRE = tokens.length; tokens.push("<|fim_prefix|>"); types.push(3);
  const FIM_SUF = tokens.length; tokens.push("<|fim_suffix|>"); types.push(3);
  const FIM_MID = tokens.length; tokens.push("<|fim_middle|>"); types.push(3);
  const V = tokens.length;

  const kvs: KV[] = [
    kvStr("general.architecture", "llama"), kvStr("general.name", "tiny-random-test-model"), kvU32("general.file_type", 0),
    kvU32("llama.context_length", 2048), kvU32("llama.embedding_length", N_EMBD), kvU32("llama.block_count", N_LAYER),
    kvU32("llama.feed_forward_length", N_FF), kvU32("llama.attention.head_count", N_HEAD), kvU32("llama.attention.head_count_kv", N_KV),
    kvU32("llama.rope.dimension_count", HEAD_DIM), kvF32("llama.attention.layer_norm_rms_epsilon", 1e-5), kvU32("llama.vocab_size", V),
    kvStr("tokenizer.ggml.model", "llama"), kvArrStr("tokenizer.ggml.tokens", tokens), kvArrF32("tokenizer.ggml.scores", tokens.map(() => 0)),
    kvArrI32("tokenizer.ggml.token_type", types), kvU32("tokenizer.ggml.bos_token_id", 1), kvU32("tokenizer.ggml.eos_token_id", 2), kvU32("tokenizer.ggml.unknown_token_id", 0),
    kvU32("tokenizer.ggml.fim_pre_token_id", FIM_PRE), kvU32("tokenizer.ggml.fim_suf_token_id", FIM_SUF), kvU32("tokenizer.ggml.fim_mid_token_id", FIM_MID),
    kvStr("tokenizer.chat_template", "{% for m in messages %}{{ m['role'] }}: {{ m['content'] }}\n{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}"),
  ];

  const rand = rng(1234);
  const normal = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const tensors: { name: string; dims: number[]; data: Buffer }[] = [];
  const mat = (name: string, ne0: number, ne1: number) => {
    const a = new Float32Array(ne0 * ne1);
    for (let i = 0; i < a.length; i++) a[i] = normal() * 0.05;
    tensors.push({ name, dims: [ne0, ne1], data: Buffer.from(a.buffer) });
  };
  const vec = (name: string, n: number) => tensors.push({ name, dims: [n], data: Buffer.from(new Float32Array(n).fill(1).buffer) });
  mat("token_embd.weight", N_EMBD, V);
  vec("output_norm.weight", N_EMBD);
  for (let l = 0; l < N_LAYER; l++) {
    vec(`blk.${l}.attn_norm.weight`, N_EMBD);
    mat(`blk.${l}.attn_q.weight`, N_EMBD, N_EMBD);
    mat(`blk.${l}.attn_k.weight`, N_EMBD, KV_DIM);
    mat(`blk.${l}.attn_v.weight`, N_EMBD, KV_DIM);
    mat(`blk.${l}.attn_output.weight`, N_EMBD, N_EMBD);
    vec(`blk.${l}.ffn_norm.weight`, N_EMBD);
    mat(`blk.${l}.ffn_gate.weight`, N_EMBD, N_FF);
    mat(`blk.${l}.ffn_up.weight`, N_EMBD, N_FF);
    mat(`blk.${l}.ffn_down.weight`, N_FF, N_EMBD);
  }

  const ALIGN = 32;
  const pad = (n: number) => (ALIGN - (n % ALIGN)) % ALIGN;
  let off = 0;
  const infos: Buffer[] = [];
  const blobs: Buffer[] = [];
  for (const t of tensors) {
    infos.push(Buffer.concat([gstr(t.name), u32(t.dims.length), ...t.dims.map(u64), u32(0), u64(off)]));
    blobs.push(t.data, Buffer.alloc(pad(t.data.length)));
    off += t.data.length + pad(t.data.length);
  }
  const head = Buffer.concat([Buffer.from("GGUF", "latin1"), u32(3), u64(tensors.length), u64(kvs.length), ...kvs.flatMap(([k, v]) => [gstr(k), v]), ...infos]);
  const out = Buffer.concat([head, Buffer.alloc(pad(head.length)), ...blobs]);
  writeFileSync(file, out);
  return { vocab: V, tensors: tensors.length, bytes: out.length };
}

if (require.main === module) {
  const f = process.argv[2];
  if (!f) { console.error("usage: tsx scripts/tiny-model.ts out.gguf [headDim]"); process.exit(1); }
  console.log(JSON.stringify(writeTinyModel(f, { headDim: process.argv[3] ? parseInt(process.argv[3], 10) : undefined })));
}
