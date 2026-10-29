import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2];
assert.ok(directory, "Usage: bun scripts/app-release.ts asset-directory");
const version = process.env.APP_VERSION;
const repository = process.env.GITHUB_REPOSITORY;
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
const files = await readdir(directory);
const windows = files.filter((name) => /^omarchy-bot_[\d.]+_x64-(?:signed|unsigned-preview)-setup\.exe$/.test(name));
assert.equal(windows.length, 1, "Expected exactly one Windows NSIS installer");
assert.ok(windows[0]!.startsWith(`omarchy-bot_${version}_`), "Windows installer must match APP_VERSION");
const payloads: Record<string, string> = {
  "linux-x86_64": `omarchy-bot_${version}_amd64.AppImage`,
  "darwin-aarch64": `omarchy-bot_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `omarchy-bot_${version}_x64.app.tar.gz`,
  "windows-x86_64": windows[0]!,
};
const assets = [...Object.values(payloads), `omarchy-bot_${version}_aarch64.dmg`, `omarchy-bot_${version}_x64.dmg`];
for (const name of assets) {
  const file = Bun.file(path.join(directory, name));
  assert.ok(await file.size > 0, `Missing or empty release asset: ${name}`);
  const hash = new Bun.CryptoHasher("sha256").update(await file.arrayBuffer()).digest("hex");
  const checksum = (await Bun.file(path.join(directory, `${name}.sha256`)).text()).trim().replace(/^\uFEFF/, "");
  assert.equal(checksum, `${hash}  ${name}`, `Checksum mismatch: ${name}`);
}
const platforms: Record<string, { url: string; signature: string }> = {};
for (const [platform, name] of Object.entries(payloads)) {
  const signatureFile = path.join(directory, `${name}.sig`);
  const check = Bun.spawn([process.execPath, "scripts/linux-app/check-signature.ts", signatureFile, version!], { stdout: "inherit", stderr: "inherit" });
  assert.equal(await check.exited, 0, `Invalid updater key or signed version: ${name}`);
  const signature = await Bun.file(signatureFile).text();
  platforms[platform] = { url: `https://github.com/${repository}/releases/download/app-v${version}/${name}`, signature };
}
// Only emit the manifest after every installer, payload, checksum and signature passes.
await Bun.write(path.join(directory, "latest.json"), `${JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(`Prepared complete app-v${version} manifest for ${Object.keys(platforms).join(", ")}`);
