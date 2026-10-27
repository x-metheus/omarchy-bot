import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { extractRuntimeArchive } from "../../apps/cli/src/archive.ts";

const [archive, cache, staging] = process.argv.slice(2);
if (!archive || !cache || !staging) throw new Error("expected runtime archive, asset cache and staging directory");
const expected = readFileSync(`${archive}.sha256`, "utf8").trim().split(/\s+/)[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("invalid runtime checksum sidecar");
const bytes = await Bun.file(archive).bytes();
if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== expected) {
  throw new Error("runtime archive checksum mismatch");
}
const runtime = path.join(staging, "runtime");
extractRuntimeArchive(archive, runtime);
for (const required of ["scripts/serve.sh", "sway/.omarchy-bot-runtime", "fonts", "apps/web/dist", "workers/pi/src/worker.ts"]) {
  if (!existsSync(path.join(runtime, required))) {
    throw new Error(`runtime archive is missing ${required}`);
  }
}
// Browser pins come from the supplied archive; the builder verifies every copied input.
const assets = [
  { name: "bun", url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip", sha256: "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913" },
];
// The caller-selected runtime archive supplies the exact browser pins to package.
const { BROWSER_ASSET, BROWSER_LIBRARY_ASSETS } = await import(path.join(runtime, "apps/daemon/src/modules/computer/botComputerAssets.ts"));
const packInputs = path.join(staging, "browser-pack", "inputs");
mkdirSync(packInputs, { recursive: true });
for (const asset of [BROWSER_ASSET, ...BROWSER_LIBRARY_ASSETS]) {
  const cached = path.join(cache, asset.sha256);
  if (existsSync(cached)) copyFileSync(cached, path.join(packInputs, asset.sha256));
}
mkdirSync(path.join(staging, "assets"), { recursive: true });
for (const asset of assets) {
  const cached = path.join(cache, asset.sha256);
  if (!await Bun.file(cached).exists()) {
    console.error(`Downloading ${asset.name}`);
    const partial = `${cached}.partial-${process.pid}`;
    try {
      const download = Bun.spawn(["curl", "--fail", "--location", "--silent", "--show-error", "--max-time", "600", "--output", partial, asset.url], { stdout: "inherit", stderr: "inherit" });
      if (await download.exited !== 0) throw new Error(`${asset.name}: download failed`);
      if (new Bun.CryptoHasher("sha256").update(await Bun.file(partial).bytes()).digest("hex") !== asset.sha256) {
        throw new Error(`${asset.name}: checksum mismatch`);
      }
      renameSync(partial, cached);
    } finally {
      rmSync(partial, { force: true });
    }
  }
  if (new Bun.CryptoHasher("sha256").update(await Bun.file(cached).bytes()).digest("hex") !== asset.sha256) {
    throw new Error(`${asset.name}: cached checksum mismatch at ${cached}`);
  }
  copyFileSync(cached, path.join(staging, "assets", asset.sha256));
}
const unzip = Bun.spawnSync(["unzip", "-q", path.join(cache, assets[0]!.sha256), "-d", staging]);
if (unzip.exitCode !== 0) throw new Error(`Bun extraction failed: ${unzip.stderr.toString()}`);
copyFileSync(path.join(staging, "bun-linux-x64/bun"), path.join(staging, "bun"));
rmSync(path.join(staging, "bun-linux-x64"), { recursive: true });
const pack = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../package-browser-pack.ts"), runtime, path.join(staging, "browser-pack")], { stdout: "pipe", stderr: "pipe" });
if (pack.exitCode !== 0) throw new Error(`browser pack build failed: ${pack.stderr.toString()}`);
rmSync(packInputs, { recursive: true, force: true });
