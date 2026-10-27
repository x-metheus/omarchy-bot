import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { extractDeb, extractZip } from "./browser-pack-inputs.ts";

const [repository, output, suppliedInputs] = process.argv.slice(2);
if (!repository || !output) throw new Error("Usage: package-browser-pack.sh <repo-root> <out-dir> [input-dir]");
// The supplied runtime checkout selects its own pins; fixtures and release archives differ.
const { BROWSER_ASSET, BROWSER_LIBRARY_ASSETS, BROWSER_ASSETS_RELEASE } = await import(pathToFileURL(path.resolve(repository, "apps/daemon/src/modules/computer/botComputerAssets.ts")).href);
const out = path.resolve(output);
mkdirSync(out, { recursive: true });
const inputs = path.resolve(suppliedInputs ?? path.join(out, "inputs"));
if (suppliedInputs === undefined) mkdirSync(inputs, { recursive: true });
const pins = [BROWSER_ASSET, ...BROWSER_LIBRARY_ASSETS];
for (const pin of pins) {
  const file = path.join(inputs, pin.sha256);
  if (!await Bun.file(file).exists() && suppliedInputs === undefined) {
    if (!pin.url.startsWith("https://")) throw new Error(`${pin.name}: HTTPS required`);
    try {
      const download = Bun.spawnSync(["curl", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--silent", "--show-error", "--max-time", "600", "--output", `${file}.partial`, pin.url]);
      if (download.exitCode !== 0) throw new Error(`${pin.name}: download failed: ${download.stderr.toString()}`);
      const bytes = readFileSync(`${file}.partial`);
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== pin.sha256) throw new Error(`${pin.name}: checksum mismatch`);
      writeFileSync(file, bytes);
    } finally { rmSync(`${file}.partial`, { force: true }); }
  }
  if (new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex") !== pin.sha256) throw new Error(`${pin.name}: checksum mismatch`);
}
const staging = mkdtempSync(path.join(out, ".browser-pack-"));
try {
  extractZip(path.join(inputs, BROWSER_ASSET.sha256), staging);
  const libs = path.join(staging, "libs"); mkdirSync(libs);
  for (const pin of BROWSER_LIBRARY_ASSETS) extractDeb(path.join(inputs, pin.sha256), libs);
  for (const required of ["chrome-linux64/chrome", "libs/ld-linux-x86-64.so.2"]) {
    if (!await Bun.file(path.join(staging, required)).exists()) throw new Error(`browser pack is missing ${required}`);
  }
  writeFileSync(path.join(staging, ".omarchy-bot-browser-pack"), `${BROWSER_ASSETS_RELEASE}\n`);
  const tar = Bun.spawnSync(["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", "-", "-C", staging, "."], { maxBuffer: 1024 * 1024 * 1024 });
  if (tar.exitCode !== 0) throw new Error(`browser pack archive failed: ${tar.stderr.toString()}`);
  const archive = path.join(out, `omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst`);
  const bytes = Bun.zstdCompressSync(tar.stdout);
  writeFileSync(archive, bytes);
  writeFileSync(`${archive}.sha256`, `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}  ${path.basename(archive)}\n`);
  console.log(archive);
} finally { rmSync(staging, { recursive: true, force: true }); }
