import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const modelDownloads = new Map([
  ["qwen3-0.6b-q8-0", {
    url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf",
    bytes: 639446688,
    sha256: "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031",
  }],
  ["qwen2.5-coder-0.5b-q4", {
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/ebb2015119c907b064c512bf053e945850b5875f/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf",
    bytes: 491400064,
    sha256: "1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32",
  }],
  ["qwen2.5-coder-1.5b-q4", {
    url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/f86cb2c1fa58255f8052cc32aeede1b7482d4361/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    bytes: 1117320768,
    sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
  }],
]);

export async function downloadModel(source: { url: string; bytes: number; sha256: string }, destination: string): Promise<void> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const scratch = await mkdtemp(path.join(directory, ".download-"));
  const partial = path.join(scratch, "model.gguf");
  try {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Model download failed (HTTP ${response.status}).`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > source.bytes) return callback(new Error("Model download exceeded the expected size."));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response.body, verify, createWriteStream(partial, { flags: "wx" }));
    if (bytes !== source.bytes || hash.digest("hex") !== source.sha256) {
      throw new Error("Model download failed size or SHA-256 verification.");
    }
    await rename(partial, destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
