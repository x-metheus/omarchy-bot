import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

const directory = process.argv[2];
assert.ok(directory, "Usage: bun tools/release/app-release.ts asset-directory");
const version = process.env.APP_VERSION;
const repository = process.env.GITHUB_REPOSITORY;
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
const files = await readdir(directory);
const windows = files.filter((name) => /^metheus_[\d.]+_x64-(?:signed|unsigned-preview)-setup\.exe$/.test(name));
assert.equal(windows.length, 1, "Expected exactly one Windows NSIS installer");
assert.ok(windows[0]!.startsWith(`metheus_${version}_`), "Windows installer must match APP_VERSION");
const payloads: Record<string, string> = {
  "linux-x86_64": `metheus_${version}_amd64.AppImage`,
  "darwin-aarch64": `metheus_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": `metheus_${version}_x64.app.tar.gz`,
  "windows-x86_64": windows[0]!,
};
const daemonTargets = ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];
const assets = [
  ...Object.values(payloads), `metheus_${version}_aarch64.dmg`, `metheus_${version}_x64.dmg`,
  ...daemonTargets.map(target => `metheus-agent-daemon_${version}_${target}.tar.gz`),
];
for (const name of assets) {
  const file: Bun.BunFile = Bun.file(path.join(directory, name));
  assert.ok(await file.size > 0, `Missing or empty release asset: ${name}`);
  const sha256 = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) sha256.update(chunk);
  const hash = sha256.digest("hex");
  const checksum: string = (await Bun.file(path.join(directory, `${name}.sha256`)).text()).trim().replace(/^\uFEFF/, "");
  assert.equal(checksum, `${hash}  ${name}`, `Checksum mismatch: ${name}`);
}
const platforms: Record<string, { url: string; signature: string }> = {};
const signatureCheck = path.join(import.meta.dirname, "linux-app/check-signature.ts");
for (const [platform, name] of Object.entries(payloads)) {
  const signatureFile = path.join(directory, `${name}.sig`);
  const check = Bun.spawn([process.execPath, signatureCheck, signatureFile, version!], { stdout: "inherit", stderr: "inherit" });
  assert.equal(await check.exited, 0, `Invalid updater key or signed version: ${name}`);
  const signature = await Bun.file(signatureFile).text();
  platforms[platform] = { url: `https://github.com/${repository}/releases/download/app-v${version}/${name}`, signature };
}
// Only emit the manifest after every installer, payload, checksum and signature passes.
await Bun.write(path.join(directory, "latest.json"), `${JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(`Prepared complete app-v${version} manifest for ${Object.keys(platforms).join(", ")}`);
