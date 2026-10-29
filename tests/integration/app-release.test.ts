import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Structural minisign fixtures exercise key/version binding; native updater smoke proves cryptography.
const publicPacket = Buffer.alloc(42, 1);
const signaturePacket = Buffer.alloc(74, 1);
const publicKey = Buffer.from(`untrusted comment: fixture\n${publicPacket.toString("base64")}\n`).toString("base64");
const signature = (version = "1.2.3") => Buffer.from(`untrusted comment: fixture\n${signaturePacket.toString("base64")}\ntrusted comment: timestamp:0\tfile:fixture\tversion:${version}\nfixture\n`).toString("base64");
const payloads = [
  "omarchy-bot_1.2.3_amd64.AppImage",
  "omarchy-bot_1.2.3_aarch64.app.tar.gz",
  "omarchy-bot_1.2.3_x64.app.tar.gz",
  "omarchy-bot_1.2.3_x64-unsigned-preview-setup.exe",
];
const installers = ["omarchy-bot_1.2.3_aarch64.dmg", "omarchy-bot_1.2.3_x64.dmg"];

test("release CLI prepares one complete four-platform manifest and refuses incomplete or inconsistent assets", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "app-release-"));
  const manifestFile = path.join(directory, "latest.json");
  const run = async (env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, "scripts/app-release.ts", directory], {
      env: { ...process.env, APP_VERSION: "1.2.3", GITHUB_REPOSITORY: "example/bot", TAURI_UPDATER_PUBKEY: publicKey, ...env },
      stdout: "pipe", stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    return { code: await child.exited, error };
  };
  try {
    for (const name of [...payloads, ...installers]) {
      await Bun.write(path.join(directory, name), `fixture ${name}`);
      const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(directory, name)).arrayBuffer()).digest("hex");
      await Bun.write(path.join(directory, `${name}.sha256`), `${hash}  ${name}\n`);
    }
    for (const name of payloads) await Bun.write(path.join(directory, `${name}.sig`), signature());
    // A failed assembly must not leave a partial manifest for the publication step.
    rmSync(path.join(directory, payloads[3]!));
    const missing = await run();
    expect(missing.code).not.toBe(0);
    expect(await Bun.file(manifestFile).exists()).toBe(false);
    await Bun.write(path.join(directory, payloads[3]!), `fixture ${payloads[3]}`);
    const complete = await run();
    expect(complete.code, complete.error).toBe(0);
    const manifest = await Bun.file(manifestFile).json();
    expect(manifest.version).toBe("1.2.3");
    expect(Object.keys(manifest.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
    expect(manifest.platforms["darwin-aarch64"]).toEqual({ url: "https://github.com/example/bot/releases/download/app-v1.2.3/omarchy-bot_1.2.3_aarch64.app.tar.gz", signature: signature() });
    expect(manifest.platforms["windows-x86_64"].url).toBe("https://github.com/example/bot/releases/download/app-v1.2.3/omarchy-bot_1.2.3_x64-unsigned-preview-setup.exe");
    expect(manifest.platforms["linux-x86_64"].url).toEndWith("/omarchy-bot_1.2.3_amd64.AppImage");
    expect(manifest.platforms["darwin-x86_64"].url).toEndWith("/omarchy-bot_1.2.3_x64.app.tar.gz");
    expect(Number.isFinite(Date.parse(manifest.pub_date))).toBe(true);
    await Bun.write(path.join(directory, installers[0]!), "tampered dmg");
    expect((await run()).code).not.toBe(0);
    await Bun.write(path.join(directory, installers[0]!), `fixture ${installers[0]}`);
    await Bun.write(path.join(directory, `${payloads[1]}.sig`), signature("1.2.2"));
    expect((await run()).code).not.toBe(0);
    await Bun.write(path.join(directory, `${payloads[1]}.sig`), signature());
    expect((await run({ TAURI_UPDATER_PUBKEY: Buffer.from(`fixture\n${Buffer.alloc(42, 2).toString("base64")}\n`).toString("base64") })).code).not.toBe(0);
    expect((await run({ APP_VERSION: "1.2.4" })).code).not.toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
