import assert from "node:assert/strict";
import path from "node:path";

// Extends ticket 11's manifest; this does not install an updater in the app.
const [manifestFile, installerFile, directory] = process.argv.slice(2);
assert.ok(manifestFile && installerFile && directory, "Usage: bun scripts/windows-app/release.ts linux-latest.json setup.exe output-directory");
const version = process.env.APP_VERSION;
const repository = process.env.GITHUB_REPOSITORY;
assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.match(repository ?? "", /^[\w.-]+\/[\w.-]+$/);
const manifest = await Bun.file(manifestFile).json();
assert.equal(typeof manifest, "object");
assert.ok(manifest && typeof manifest.platforms === "object", "Manifest platforms are required");
assert.ok(Number.isFinite(Date.parse(manifest.pub_date)), "Manifest publication date is required");
for (const entry of Object.values(manifest.platforms)) {
  assert.ok(entry && typeof entry === "object" && "url" in entry && "signature" in entry);
  assert.ok(typeof entry.url === "string" && new URL(entry.url).protocol === "https:");
  assert.ok(typeof entry.signature === "string" && entry.signature.trim(), "Updater signature is required");
}
assert.equal(manifest.version, version, "Linux and Windows must have the same app version");
assert.ok(manifest.platforms["linux-x86_64"], "Ticket 11 Linux release is required before Windows promotion");
assert.ok(!manifest.platforms["windows-x86_64"], "Windows entry already published; app releases are immutable");
assert.ok(await Bun.file(installerFile).size > 0, "NSIS installer is empty");
const signature = await Bun.file(`${installerFile}.sig`).text();
assert.ok(signature.trim(), "Tauri updater signature is required, including for unsigned previews");
const signed = process.env.WINDOWS_AUTHENTICODE_SIGNED === "true";
const name = `omarchy-bot_${version}_x64-${signed ? "signed" : "unsigned-preview"}-setup.exe`;
manifest.platforms["windows-x86_64"] = { url: `https://github.com/${repository}/releases/download/app-v${version}/${name}`, signature };
await Bun.write(path.join(directory, name), Bun.file(installerFile));
await Bun.write(path.join(directory, `${name}.sig`), signature);
await Bun.write(path.join(directory, `${name}.sha256`), `${new Bun.CryptoHasher("sha256").update(await Bun.file(installerFile).arrayBuffer()).digest("hex")}  ${name}\n`);
await Bun.write(path.join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write(path.join(directory, "release-notes.txt"), `Omarchy Bot ${version} Windows x64 ${signed ? "signed build" : "unsigned preview"}.\n${signed ? "Authenticode signed." : "Unsigned preview: Windows may show SmartScreen warnings; support requires a passing WebView2 smoke run."}\nIncludes the compiled Windows PowerShell Local Sidecar, NSIS installer, checksum and Tauri updater signature.\nLinux artifacts and release notes remain available in this release.\n`);
console.log(`Prepared ${name} and merged linux-x86_64/windows-x86_64 latest.json`);
