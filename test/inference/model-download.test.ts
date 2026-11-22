import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadModel } from "../../src/router/model-download";

test("model downloads publish verified bytes and discard partial or corrupted files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "localcoder-download-"));
  const destination = path.join(dir, "model.gguf");
  const content = "test weights";
  const source = {
    url: `data:application/octet-stream,${encodeURIComponent(content)}`,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  try {
    await assert.rejects(downloadModel({ ...source, sha256: "wrong" }, destination), /verification/);
    await assert.rejects(downloadModel({ ...source, bytes: 1 }, destination), /exceeded/);
    await assert.deepEqual(await readdir(dir), []);
    await downloadModel(source, destination);
    assert.equal(await readFile(destination, "utf8"), content);
    assert.deepEqual(await readdir(dir), ["model.gguf"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
