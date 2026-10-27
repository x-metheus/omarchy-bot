import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zip, deb, elfFixture, interpreterPath } from "./helpers/browserPackFixture.ts";
import { extractRuntimeArchive, verifyChecksum } from "../../apps/cli/src/archive.ts";
import { prepareBrowserPack } from "../../apps/daemon/src/modules/computer/browserPack.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
test("builds an unpatched pack, verifies every input, and patches only for the installation path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "browser-pack-")); roots.push(root);
  const source = path.join(root, "repo/apps/daemon/src/modules/computer"); mkdirSync(source, { recursive: true });
  const inputs = path.join(root, "inputs"); mkdirSync(inputs);
  const bytes = [zip({ "chrome-linux64/chrome": elfFixture() }), deb("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "loader"), deb("usr/lib/x86_64-linux-gnu/pulseaudio/libpulsecommon.so", "pulse")];
  const pins = bytes.map((content, index) => ({ name: `input-${index}`, url: `https://fixture.invalid/${index}`, sha256: hash(content) }));
  bytes.forEach((content, index) => writeFileSync(path.join(inputs, pins[index]!.sha256), content));
  writeFileSync(path.join(source, "botComputerAssets.ts"), `export const BROWSER_ASSET=${JSON.stringify(pins[0])}; export const BROWSER_LIBRARY_ASSETS=${JSON.stringify(pins.slice(1))}; export const BROWSER_ASSETS_RELEASE="chrome-for-testing-156.0.8078.47-linux64";`);
  const build = (out: string) => Bun.spawnSync(["bash", "scripts/package-browser-pack.sh", path.join(root, "repo"), out, inputs], { stdout: "pipe", stderr: "pipe" });
  const out = path.join(root, "out");
  const result = build(out); expect(result.stderr.toString()).toBe(""); expect(result.exitCode).toBe(0);
  const archive = path.join(out, "omarchy-bot-browser-chrome-for-testing-156.0.8078.47-linux64-x86_64.tar.zst");
  expect(verifyChecksum(archive, `${archive}.sha256`)).toHaveLength(64);
  const staging = path.join(root, "stage"); extractRuntimeArchive(archive, staging);
  expect(interpreterPath(path.join(staging, "chrome-linux64/chrome")).path).toBe("/lib64/ld-linux-x86-64.so.2");
  const destination = path.join(root, "installed"); prepareBrowserPack(staging, destination);
  const interpreter = interpreterPath(path.join(staging, "chrome-linux64/chrome"));
  expect(interpreter).toMatchObject({ path: path.join(destination, "libs/ld-linux-x86-64.so.2"), mapped: true });
  expect(readFileSync(path.join(staging, "libs/libpulsecommon.so"), "utf8")).toBe("pulse");
  for (const pin of pins) {
    const file = path.join(inputs, pin.sha256); const original = readFileSync(file); writeFileSync(file, "tampered");
    const badOut = path.join(root, `bad-${pin.name}`); const refused = build(badOut);
    expect(refused.exitCode).not.toBe(0); expect(refused.stderr.toString()).toContain(`${pin.name}: checksum mismatch`);
    expect(existsSync(path.join(badOut, path.basename(archive)))).toBe(false); writeFileSync(file, original);
  }
});
