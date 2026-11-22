const { createHash } = require("node:crypto");
const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8" });
const outputArg = process.argv[2];
if (!outputArg || process.argv.length !== 3) throw new Error("Usage: node scripts/package-release.cjs <new-output-directory>");
if (run("git", ["status", "--porcelain"]).trim()) throw new Error("Package releases from a clean checkout.");

const output = path.resolve(outputArg);
const { name, version, description, license, bin, engines } = require("../package.json");
const release = `${name}-v${version}`;
const scratch = mkdtempSync(path.join(os.tmpdir(), "localcoder-package-"));
try {
  const folder = path.join(scratch, release);
  mkdirSync(folder);
  run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--outDir", path.join(folder, "dist")]);
  for (const file of [
    "LICENSE", "README.md", "SECURITY.md", "CONTRIBUTING.md", "registry/models.json",
    "docs/INSTALL.md", "docs/USAGE.md", "docs/MODELS.md", "docs/SETUP-WINDOWS-LINUX-MAC.md",
    "docs/DEMO.md", "docs/TECHNICAL-NOTES.md", "docs/VERIFICATION.md", "docs/verification-report.json",
    "docs/trained-model-validation.json", "scripts/demo.cjs",
  ]) {
    const destination = path.join(folder, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, file), destination);
  }
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name, version, description, license, bin, engines }, null, 2) + "\n");
  writeFileSync(path.join(folder, "localcoder"), '#!/bin/sh\nroot=$(CDPATH="" cd "$(dirname "$0")" && pwd) || exit 1\nexec node "$root/dist/cli/index.js" "$@"\n', { mode: 0o755 });
  writeFileSync(path.join(folder, "localcoder.cmd"), '@echo off\r\nnode "%~dp0dist\\cli\\index.js" %*\r\n');

  mkdirSync(output);
  const mac = `${release}-macos.tar.gz`;
  const linux = `${release}-linux.tar.gz`;
  const windows = `${release}-windows.zip`;
  const source = `${release}-source.zip`;
  run("tar", ["-czf", path.join(output, mac), release], scratch);
  cpSync(path.join(output, mac), path.join(output, linux));
  run("zip", ["-q", "-r", path.join(output, windows), release], scratch);
  run("git", ["archive", "--format=zip", `--prefix=${release}/`, `--output=${path.join(output, source)}`, "HEAD"]);
  const sums = [mac, linux, windows, source].map((file) => {
    const sha = createHash("sha256").update(readFileSync(path.join(output, file))).digest("hex");
    return `${sha}  ${file}`;
  });
  writeFileSync(path.join(output, "SHA256SUMS"), sums.join("\n") + "\n");
  process.stdout.write(`Packaged ${release} from ${run("git", ["rev-parse", "--short", "HEAD"]).trim()} in ${output}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
