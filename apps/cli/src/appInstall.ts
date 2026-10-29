import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyChecksum } from "./archive.ts";
import { verifyAppSignature } from "./appSignature.ts";
import { parseDesktopEntry } from "../../daemon/src/modules/computer/desktopEntry.ts";
import type { Layout } from "./layout.ts";

const desktopId = "omarchy-bot.desktop";
const marker = "# Omarchy Bot installed desktop entry\n";
const scheme = "x-scheme-handler/omarchy-bot";
const manifestUrl = "https://github.com/XMethues/omarchy-bot/releases/download/app-latest/latest.json";

export function graphicalSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

function text(file: string): string {
  try { return readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

function ownedDesktop(layout: Layout): boolean {
  try { const stat = lstatSync(layout.desktopEntry); return stat.isFile() && stat.uid === process.getuid?.() && text(layout.desktopEntry).startsWith(marker); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function executable(file: string): boolean {
  try { const stat = statSync(file); return stat.isFile() && stat.size > 0 && Boolean(stat.mode & 0o111); } catch { return false; }
}

function ownedImage(layout: Layout): boolean {
  try {
    const receipt = lstatSync(`${layout.appImage}.installed`);
    return receipt.isFile() && receipt.uid === process.getuid?.() && text(`${layout.appImage}.installed`) === "Omarchy Bot installed AppImage\n" && (!existsSync(layout.appImage) || lstatSync(layout.appImage).isFile());
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

const schemeAssignment = /^\s*x-scheme-handler\/omarchy-bot\s*=\s*(.*)$/;
function defaults(source: string, install: boolean): string {
  const lines = source.split(/\r?\n/);
  let section = "";
  let found = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*\[.*\]\s*$/.test(line)) section = line.trim();
    const assignment = schemeAssignment.exec(line);
    if (section !== "[Default Applications]" || !assignment) continue;
    const others = assignment[1]!.split(";").map(id => id.trim()).filter(id => id && id !== desktopId);
    lines[index] = `${scheme}=${[...(install ? [desktopId] : []), ...others].join(";")};`;
    if (!install && !others.length) lines.splice(index--, 1);
    found = true;
  }
  if (install && !found) {
    const index = lines.findIndex(line => line.trim() === "[Default Applications]");
    if (index === -1) lines.push("[Default Applications]", `${scheme}=${desktopId};`, "");
    else lines.splice(index + 1, 0, `${scheme}=${desktopId};`);
  }
  return lines.join("\n");
}

function mimePaths(layout: Layout, directories = [dirname(layout.mimeappsPath)]): string[] {
  const desktops = (layout.env.XDG_CURRENT_DESKTOP || "").split(":").filter(name => /^[a-zA-Z0-9_-]+$/.test(name)).map(name => name.toLowerCase());
  return directories.flatMap(directory => [...new Set(desktops.map(name => join(directory, `${name}-mimeapps.list`))), join(directory, "mimeapps.list")]);
}

function publish(file: string, contents: string): void {
  try { if (!lstatSync(file).isFile()) throw new Error(`Refusing to replace non-file: ${file}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  try { writeFileSync(temporary, contents, { flag: "wx", mode: 0o644 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

async function download(url: string): Promise<Response> {
  if (new URL(url).protocol !== "https:") throw new Error("AppImage URL must use HTTPS");
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`AppImage download failed (HTTP ${response.status})`);
  if (!response.url.startsWith("https://")) throw new Error("AppImage redirect must use HTTPS");
  return response;
}

export async function installApp(layout: Layout, env: NodeJS.ProcessEnv): Promise<void> {
  if (existsSync(layout.desktopEntry) && !ownedDesktop(layout)) throw new Error(`Refusing to replace existing desktop entry: ${layout.desktopEntry}`);
  const receipt = `${layout.appImage}.installed`;
  if (existsSync(layout.appImage) && !ownedImage(layout)) throw new Error(`Refusing to replace existing AppImage: ${layout.appImage}`);
  if (!executable(layout.appImage)) {
    const temporary = mkdtempSync(join(tmpdir(), "omarchy-app-"));
    const staging = `${layout.appImage}.tmp-${process.pid}`;
    try {
      let source = env.OMARCHY_BOT_APP_IMAGE;
      if (!source) {
        const manifest = await (await download(manifestUrl)).json() as { platforms?: Record<string, { url?: string }> };
        source = manifest.platforms?.["linux-x86_64"]?.url;
        if (typeof source !== "string" || !source.startsWith("https://")) throw new Error("App release manifest has no HTTPS linux-x86_64 AppImage");
      }
      let image = source;
      try {
        if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
          let publicKey: string;
          try { publicKey = readFileSync(new URL("./release-public-key", import.meta.url), "utf8"); }
          catch { throw new Error("This installer has no release public key; use a release runtime with a provisioned updater key"); }
          image = join(temporary, "app.AppImage");
          for (const suffix of ["", ".sha256", ".sig"]) await Bun.write(`${image}${suffix}`, await download(`${source}${suffix}`));
          verifyAppSignature(readFileSync(image), readFileSync(`${image}.sig`, "utf8"), publicKey);
        }
        // Explicit local artifacts are trusted development input, never a network fallback.
        verifyChecksum(image, `${image}.sha256`);
      } catch (error) { throw new Error(`AppImage verification failed: ${error instanceof Error ? error.message : String(error)}`); }
      mkdirSync(dirname(layout.appImage), { recursive: true });
      copyFileSync(image, staging);
      chmodSync(staging, 0o755);
      renameSync(staging, layout.appImage);
      writeFileSync(receipt, "Omarchy Bot installed AppImage\n", { mode: 0o644 });
    } finally { rmSync(staging, { force: true }); rmSync(temporary, { recursive: true, force: true }); }
  }
  // Desktop Exec has both field-code and quoted-argument escaping, then desktop string escaping.
  const exec = layout.appImage.replace(/%/g, "%%").replace(/[\\"`$]/g, "\\$&").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  publish(layout.desktopEntry, `${marker}[Desktop Entry]\nType=Application\nName=Omarchy Bot\nExec="${exec}" %u\nTerminal=false\nMimeType=${scheme};\n`);
  for (const file of mimePaths(layout)) publish(file, defaults(text(file), true));
}

export function uninstallApp(layout: Layout): void {
  const managedImage = ownedImage(layout);
  if (managedImage) {
    rmSync(layout.appImage, { force: true });
    rmSync(`${layout.appImage}.installed`, { force: true });
  }
  if (ownedDesktop(layout) || (!existsSync(layout.desktopEntry) && managedImage)) {
    rmSync(layout.desktopEntry, { force: true });
    const directory = dirname(layout.mimeappsPath);
    const files = existsSync(directory) ? readdirSync(directory).filter(name => name === "mimeapps.list" || name.endsWith("-mimeapps.list")) : [];
    for (const name of files) {
      const file = join(directory, name);
      const source = text(file);
      const updated = defaults(source, false);
      if (updated !== source) publish(file, updated);
    }
  }
}

export function appDiagnostics(layout: Layout): string[] {
  const lines: string[] = [];
  if (!executable(layout.appImage)) lines.push("app: Omarchy Bot AppImage is missing or not executable; run the installer");
  if (!ownedDesktop(layout)) lines.push("app desktop: managed desktop entry is missing; run the installer");
  let handler: string | undefined;
  const applicationDirs = [dirname(layout.desktopEntry), ...(layout.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean).map(directory => join(directory, "applications"))];
  const applications = applicationDirs.map(directory => {
    const entries = new Map<string, string>();
    if (existsSync(directory)) for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".desktop")) continue;
      const file = join(entry.parentPath, entry.name);
      entries.set(file.slice(directory.length + 1).replaceAll("/", "-"), file);
    }
    return entries;
  });
  const configDirs = (layout.env.XDG_CONFIG_DIRS || "/etc/xdg").split(":").filter(Boolean);
  for (const file of mimePaths(layout, [dirname(layout.mimeappsPath), ...configDirs, ...applicationDirs])) {
    let section = "";
    for (const line of text(file).split(/\r?\n/)) {
      if (/^\s*\[.*\]\s*$/.test(line)) section = line.trim();
      const assignment = schemeAssignment.exec(line);
      if (section === "[Default Applications]" && assignment) {
        handler = assignment[1]!.split(";").map(id => id.trim()).find(id => {
          if (!id.endsWith(".desktop") || id.includes("/")) return false;
          for (const entries of applications) {
            const file = entries.get(id);
            if (!file) continue;
            const entry = text(file);
            if (!entry) continue;
            const keys = parseDesktopEntry(entry);
            return keys.get("Type") === "Application" && Boolean(keys.get("Exec")) && keys.get("Hidden") !== "true";
          }
          return false;
        });
      }
    }
    if (handler) break;
  }
  if (handler !== desktopId) lines.push("app scheme: omarchy-bot URL scheme is not registered; run the installer");
  return lines;
}
