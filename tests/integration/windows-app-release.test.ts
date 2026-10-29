import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("release CLI preserves the Linux updater entry and labels an unsigned Windows installer preview", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "windows-release-"));
  try {
    await Bun.write(path.join(dir, "linux.json"), JSON.stringify({ version: "1.2.3", pub_date: "2026-10-29T00:00:00Z", platforms: { "linux-x86_64": { url: "https://github.com/example/bot/releases/download/app-v1.2.3/bot.AppImage", signature: "linux-signature" } } }));
    await Bun.write(path.join(dir, "setup.exe"), "installer fixture");
    await Bun.write(path.join(dir, "setup.exe.sig"), "windows-signature\n");
    const command = [process.execPath, "scripts/windows-app/release.ts", path.join(dir, "linux.json"), path.join(dir, "setup.exe"), dir];
    const env = { ...process.env, APP_VERSION: "1.2.3", GITHUB_REPOSITORY: "example/bot" };
    const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const manifest = await Bun.file(path.join(dir, "latest.json")).json();
    expect(manifest.platforms["linux-x86_64"].signature).toBe("linux-signature");
    expect(manifest.platforms["windows-x86_64"]).toEqual({ url: "https://github.com/example/bot/releases/download/app-v1.2.3/omarchy-bot_1.2.3_x64-unsigned-preview-setup.exe", signature: "windows-signature\n" });
    expect(await Bun.file(path.join(dir, "release-notes.txt")).text()).toContain("unsigned preview");
    expect(await Bun.file(path.join(dir, "omarchy-bot_1.2.3_x64-unsigned-preview-setup.exe")).text()).toBe("installer fixture");
    await Bun.write(path.join(dir, "linux.json"), JSON.stringify({ ...manifest, version: "1.2.2" }));
    const mismatch = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
    expect(await mismatch.exited).not.toBe(0);
    expect(await new Response(mismatch.stderr).text()).toContain("same app version");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
