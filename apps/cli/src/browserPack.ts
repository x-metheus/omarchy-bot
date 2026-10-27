import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractRuntimeArchive, verifyChecksum } from "./archive.ts";
import { prepareBrowserPack } from "../../daemon/src/modules/computer/browserPack.ts";
import { BROWSER_ASSETS_RELEASE } from "../../daemon/src/modules/computer/botComputerAssets.ts";

export async function installBrowserPack(source: string, destination: string): Promise<void> {
  const temporary = mkdtempSync(path.join(tmpdir(), "omarchy-browser-"));
  const staging = `${destination}.staging-${process.pid}`;
  const previous = `${destination}.previous-${process.pid}`;
  try {
    let archive = source;
    if (/^https?:\/\//.test(source)) {
      if (!source.startsWith("https://")) throw new Error("browser pack URL must use HTTPS");
      archive = path.join(temporary, "browser.tar.zst");
      for (const suffix of ["", ".sha256"]) {
        const response = await fetch(`${source}${suffix}`, { signal: AbortSignal.timeout(600_000) });
        if (!response.ok) throw new Error(`browser pack download failed (HTTP ${response.status})`);
        if (!response.url.startsWith("https://")) throw new Error("browser pack redirect must use HTTPS");
        await Bun.write(`${archive}${suffix}`, response);
      }
    }
    verifyChecksum(archive, `${archive}.sha256`);
    mkdirSync(path.dirname(destination), { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    extractRuntimeArchive(archive, staging);
    prepareBrowserPack(staging, path.resolve(destination));
    if (existsSync(destination)) renameSync(destination, previous);
    try { renameSync(staging, destination); }
    catch (error) { if (existsSync(previous)) renameSync(previous, destination); throw error; }
    rmSync(previous, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function browserPackReleaseUrl(runtimeArchive: string): string {
  const version = /^omarchy-bot-runtime-(.+)-x86_64\.tar\.zst$/.exec(path.basename(runtimeArchive))?.[1];
  if (!version) throw new Error("Cannot infer browser pack release; pass --browser-pack <file-or-https-url> with its .sha256 sidecar");
  return `https://github.com/XMethues/omarchy-bot/releases/download/runtime-${version}/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst`;
}
