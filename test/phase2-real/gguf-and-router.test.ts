import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { readGgufMeta, summarizeGguf, entryFromGguf } from "../../src/inference/gguf";
import { addLocalModel, removeLocalModel } from "../../src/cli/models";
import { loadRegistry } from "../../src/router/registry";
import { DefaultModelRouter, exactKvCacheMb, fitsMemoryBudget } from "../../src/router/router";
import { isRejection, ModelRegistryEntry, ResourcePolicy } from "../../src/types/index";
import { readRssMb } from "../../src/inference/process-stats";
import { buildGguf, qwenLikeKvs } from "./gguf-fixture";

function tmp() { return mkdtempSync(path.join(os.tmpdir(), "lc-gguf-")); }
function write(dir: string, name: string, buf: Buffer) { const f = path.join(dir, name); writeFileSync(f, buf); return f; }

test("GGUF reader: scalars, strings, typed arrays, nested arrays, FIM tokens and tool-capable chat template are all read correctly", () => {
  const d = tmp();
  try {
    const f = write(d, "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf", buildGguf(qwenLikeKvs(), { tensorCount: 7, trailing: 4096 }));
    const m = readGgufMeta(f);
    assert.equal(m.version, 3);
    assert.equal(m.tensor_count, 7);
    assert.equal(m.kv["general.architecture"], "qwen2");
    assert.equal(m.kv["qwen2.block_count"], 28);
    assert.equal(m.kv["tokenizer.ggml.add_bos_token"], false);
    assert.ok(Math.abs((m.kv["qwen2.rope.freq_base"] as number) - 1000000) < 1);
    assert.deepEqual(m.kv["tokenizer.ggml.tokens"], { array_len: 6 });
    assert.equal(m.has_fim_tokens, true);
    assert.equal(m.chat_template_mentions_tools, true);
    assert.equal(m.file_size, readFileSync(f).length);
    assert.equal(readGgufMeta(write(d, "v2.gguf", buildGguf(qwenLikeKvs(), { version: 2 }))).version, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("GGUF reader: refuses non-GGUF, unsupported versions, truncation and implausible counts with clear errors", () => {
  const d = tmp();
  try {
    assert.throws(() => readGgufMeta(write(d, "a.gguf", Buffer.from("this is definitely not a model file at all, sorry"))), /not a GGUF file/);
    assert.throws(() => readGgufMeta(write(d, "tiny.gguf", Buffer.from("GGUF"))), /too small/);
    assert.throws(() => readGgufMeta(write(d, "v1.gguf", buildGguf(qwenLikeKvs(), { version: 1 }))), /unsupported GGUF version 1/);
    const whole = buildGguf(qwenLikeKvs());
    assert.throws(() => readGgufMeta(write(d, "cut.gguf", whole.subarray(0, whole.length - 20))), /truncated/);
    assert.throws(() => readGgufMeta(write(d, "huge.gguf", buildGguf([], { kvCountOverride: 5_000_000 }))), /implausible/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("GGUF reader streams a realistic 200k-token vocabulary across many read-chunk boundaries, quickly and correctly", () => {
  const d = tmp();
  try {
    const tokens = Array.from({ length: 200_000 }, (_, i) => `tok${i}_${"x".repeat(i % 13)}`);
    tokens.push("<|fim_prefix|>");
    const f = write(d, "big.gguf", buildGguf(qwenLikeKvs({ "tokenizer.ggml.tokens": { t: "arr_str", v: tokens }, "general.after": { t: "u32", v: 99 } }), { trailing: 8 * 1024 * 1024 }));
    const t0 = Date.now();
    const m = readGgufMeta(f);
    assert.ok(Date.now() - t0 < 4000, "header parse must not be proportional to tensor data");
    assert.equal(m.has_fim_tokens, true, "FIM token at the very end of a 200k vocab is found");
    assert.equal(m.kv["general.after"], 99, "keys AFTER the huge array are still read at the right offset");
    assert.deepEqual(m.kv["tokenizer.ggml.tokens"], { array_len: 200_001 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("entryFromGguf derives a registry entry with real architecture facts; MoE and missing-kv-heads cases", () => {
  const d = tmp();
  try {
    const e = entryFromGguf(write(d, "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf", buildGguf(qwenLikeKvs(), { trailing: 1024 })));
    assert.equal(e.model_id, "qwen2.5-coder-1.5b-instruct-q4-k-m");
    assert.deepEqual([e.layers, e.attention_heads, e.kv_heads, e.head_dim], [28, 12, 2, 128]);
    assert.equal(e.context_limit, 32768);
    assert.equal(e.quantization, "Q4_K_M");
    assert.deepEqual(e.parameter_count, { total: 1.5, active: undefined });
    assert.deepEqual(e.capabilities.sort(), ["fim", "tool_calling"]);
    assert.equal(e.architecture, "dense");
    assert.ok(path.isAbsolute(e.file_path));

    const moe = entryFromGguf(write(d, "m.gguf", buildGguf(qwenLikeKvs({
      "general.architecture": { t: "str", v: "qwen3moe" }, "general.size_label": { t: "str", v: "30B-A3B" }, "qwen3moe.expert_count": { t: "u32", v: 128 },
      "qwen3moe.context_length": { t: "u32", v: 262144 }, "qwen3moe.block_count": { t: "u32", v: 48 }, "qwen3moe.embedding_length": { t: "u32", v: 2048 },
      "qwen3moe.attention.head_count": { t: "u32", v: 32 }, "qwen3moe.attention.key_length": { t: "u32", v: 128 },
    }))));
    assert.equal(moe.architecture, "moe");
    assert.deepEqual(moe.parameter_count, { total: 30, active: 3 });
    assert.equal(moe.kv_heads, 32, "kv heads default to head_count when the key is absent");
    assert.equal(moe.head_dim, 128, "explicit key_length wins over embedding/head_count");
    assert.ok(moe.capabilities.includes("long_context"));
    assert.equal(summarizeGguf(readGgufMeta(path.join(d, "m.gguf"))).expert_count, 128);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("models add/remove: writes registry/models.local.json, the loader merges it, local entries override, remove works", () => {
  const d = tmp();
  try {
    const regDir = path.join(d, "registry");
    writeFileSync(path.join(d, "x"), "");
    require("fs").mkdirSync(regDir);
    writeFileSync(path.join(regDir, "models.json"), JSON.stringify([{ model_id: "base", architecture: "dense", parameter_count: { total: 7 }, quantization: "Q4_K_M", file_path: "a.gguf", context_limit: 8192, backend_requirements: ["cpu"], estimated_memory_gb: 5, capabilities: [] }]));
    const gg = write(d, "My-Model-7B-Q4_K_M.gguf", buildGguf(qwenLikeKvs()));
    const e = addLocalModel(regDir, gg);
    const merged = loadRegistry(path.join(regDir, "models.json"));
    assert.deepEqual(merged.map((m) => m.model_id).sort(), ["base", e.model_id].sort());
    assert.equal(merged.find((m) => m.model_id === e.model_id)!.layers, 28);
    addLocalModel(regDir, gg); // idempotent
    assert.equal(loadRegistry(path.join(regDir, "models.json")).length, 2);
    assert.equal(removeLocalModel(regDir, e.model_id), true);
    assert.equal(loadRegistry(path.join(regDir, "models.json")).length, 1);
    assert.equal(removeLocalModel(regDir, "nope"), false);
    assert.throws(() => addLocalModel(regDir, write(d, "junk.gguf", Buffer.from("not gguf, just text padding padding"))), /not a GGUF/);
    assert.ok(!existsSync(path.join(regDir, "junk")), "a failed add must not touch the registry");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

const qwen15: ModelRegistryEntry = {
  model_id: "q15", architecture: "dense", parameter_count: { total: 1.5 }, quantization: "Q4_K_M", file_path: "x.gguf", context_limit: 32768,
  backend_requirements: ["cpu"], estimated_memory_gb: 1.0, capabilities: ["fim"], layers: 28, attention_heads: 12, kv_heads: 2, head_dim: 128,
};
const pol = (gb: number, ctx = 32768): ResourcePolicy => ({ power_mode: "balanced", memory_budget_gb: gb, max_context_tokens: ctx, max_gpu_offload_fraction: 0.8, max_agent_wall_seconds: 300, max_tool_calls: 40, allow_background_indexing: true });

test("exact KV math: 2 x layers x kv_heads x head_dim x ctx x bytes (f16 / q8_0 / q4_0), null without metadata", () => {
  // Qwen2.5-Coder-1.5B shape: 28 layers, 2 KV heads, head_dim 128 -> 28,672 bytes/token at f16
  assert.equal(exactKvCacheMb(qwen15, 32768, "f16"), (28672 * 32768) / 1048576); // 896 MiB
  assert.ok(Math.abs(exactKvCacheMb(qwen15, 32768, "q8_0")! - 896 * (34 / 32) / 2) < 1e-6);
  assert.ok(exactKvCacheMb(qwen15, 4096, "q4_0")! < exactKvCacheMb(qwen15, 4096, "q8_0")!);
  assert.equal(exactKvCacheMb({ ...qwen15, layers: undefined }, 4096, "f16"), null);
});

test("router shrinks KV dtype then context to fit before rejecting; never below the agent floor; never violates the gate", () => {
  const r = new DefaultModelRouter();
  const roomy = r.route("hard_agent", pol(8), [qwen15]);
  assert.ok(!isRejection(roomy));
  if (!isRejection(roomy)) assert.deepEqual([roomy.ctx_window, roomy.kv_cache_dtype], [32768, "f16"], "plenty of RAM: keep the full-quality setting");

  const tight = r.route("hard_agent", pol(2.4), [qwen15]);
  assert.ok(!isRejection(tight));
  if (!isRejection(tight)) {
    assert.ok(tight.ctx_window < 32768 || tight.kv_cache_dtype !== "f16", "had to shrink something");
    assert.ok(fitsMemoryBudget(qwen15, tight, pol(2.4)));
  }

  const nope = r.route("hard_agent", pol(2.0), [qwen15]); // weights + overhead + margin already use the whole budget
  assert.ok(isRejection(nope));
  if (isRejection(nope)) assert.ok(nope.attempted[0].required_gb > 2.0);

  let lastCtx = 0;
  for (let gb = 1.5; gb <= 6; gb += 0.1) {
    const d = r.route("hard_agent", pol(gb), [qwen15]);
    if (isRejection(d)) { assert.equal(lastCtx, 0, "once something fits, more RAM must not make it stop fitting"); continue; }
    assert.ok(fitsMemoryBudget(qwen15, d, pol(gb)), `decision at ${gb.toFixed(1)}GB violates the memory gate`);
    assert.ok(d.ctx_window >= 4096, "agent floor");
    assert.ok(d.ctx_window >= lastCtx, "more budget never yields a smaller context");
    lastCtx = d.ctx_window;
  }
});

test("process stats: real RSS of this process and of a real child process via ps; undefined pid is null", async () => {
  const mine = readRssMb(process.pid);
  assert.ok(mine !== null && mine > 10, `own RSS should be tens of MB, got ${mine}`);
  const child = require("child_process").spawn("sleep", ["5"]);
  try {
    await new Promise((r) => setTimeout(r, 100));
    const c = readRssMb(child.pid);
    assert.ok(c !== null && c > 0 && c < mine!, `sleep RSS ${c} should be small and positive`);
  } finally { child.kill(); }
  assert.equal(readRssMb(undefined), null);
});
