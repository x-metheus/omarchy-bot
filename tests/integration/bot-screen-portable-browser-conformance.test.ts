import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "bun";
import sharp from "../../apps/daemon/node_modules/sharp";
import { PortableBotComputerAssets } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import type { BotScreenActionResult } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import type { ComputerWindowListItem } from "../../packages/agent-contract/src/computer-protocol.ts";
import type { ComputerAction } from "../../packages/domain/src/computer.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { waitScreenReady } from "./helpers/bot-screen-load-observe.ts";
import { ensureBotDesktop } from "../../apps/daemon/native/bot-desktop/build.ts";
import { ensureCaptureHelper } from "../../apps/daemon/native/capture-helper/build.ts";
import { ensureInputHelper } from "../../apps/daemon/native/pointer-helper/build.ts";
import {
  GLYPH_CELL,
  GLYPH_CELLS,
  PORTABLE_BROWSER_ENV,
  PROBE_BACKGROUND,
  glyphProbeHtml,
  maskDistance,
  readGlyphProbe,
  type GlyphProbe,
} from "./helpers/portableBrowserGlyphs.ts";

const realTest = process.env[PORTABLE_BROWSER_ENV] === "1" ? test : test.skip;
const COMMAND = `${PORTABLE_BROWSER_ENV}=1 bun test tests/integration/bot-screen-portable-browser-conformance.test.ts`;
const MIN_GLYPH_INK = 800;
const MIN_DISTINCT_DISTANCE = 0.3;

type Owner = { botId: string; surfaceId: SurfaceId };

let harness: Harness | undefined;
let root: string | undefined;
let probe: Server<unknown> | undefined;
const savedEnvironment: Record<string, string | undefined> = {};

afterEach(async () => {
  probe?.stop(true);
  probe = undefined;
  await harness?.stop().catch(() => {});
  harness = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnvironment[key];
  }
});

function setEnvironment(key: string, value: string | undefined): void {
  if (!(key in savedEnvironment)) savedEnvironment[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function executableFixture(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o755);
  return target;
}

function desktopEntry(directory: string, name: string, exec: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${exec}`,
    "",
  ].join("\n"));
}

/**
 * A browser-less fixture host: the PATH has no browser, only the `snap` command a
 * launcher failing to filter snaps would run.
 */
function browserlessPath(bin: string, snapMarker: string): string {
  for (const name of ["sh", "env", "dirname"]) {
    const host = Bun.which(name);
    if (host !== null) symlinkSync(host, path.join(bin, name));
  }
  executableFixture(bin, "snap", [
    "#!/bin/sh",
    `printf '%s' "$*" > ${JSON.stringify(snapMarker)}`,
    "exit 127",
    "",
  ].join("\n"));
  return bin;
}

function readFontConfig(configFile: string): { dirs: string[]; cacheDirs: string[] } {
  const xml = readFileSync(configFile, "utf8");
  const collect = (tag: string): string[] =>
    [...xml.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, "g"))].map((match) => match[1]!);
  return { dirs: collect("dir"), cacheDirs: collect("cachedir") };
}

/**
 * The browser process that opened `url`, found by its own command line. Chromium
 * rewrites its environment after startup, so only the argv is trustworthy here.
 */
function browserProcess(url: string): { binary: string; userDataDir: string } {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const commandLine = readFileSync(`/proc/${entry}/cmdline`).toString()
        .split("\0").filter((part) => part !== "").join(" ");
      if (!commandLine.includes(url)) continue;
      const profile = /--user-data-dir=(\S+)/.exec(commandLine);
      if (profile === null) continue;
      return { binary: commandLine.slice(0, commandLine.indexOf(" ")), userDataDir: profile[1]! };
    } catch {
      // Processes may exit while /proc is sampled.
    }
  }
  throw new Error(`no portable browser process opened ${url}`);
}

function profileWindows(windows: ComputerWindowListItem[], label: string): ComputerWindowListItem[] {
  return windows.filter((window) => window.title.startsWith(label));
}

/** The page's stored counter, which the browser title carries before Chromium's own suffix. */
function titleCount(title: string): number | undefined {
  const match = / count:(\d+)/.exec(title);
  return match === null ? undefined : Number(match[1]);
}

// Deterministic self-check for the capture analysis: synthetic pixels, no browser or fonts.
test("glyph analysis finds the page inside a desktop capture and separates shapes from a placeholder", async () => {
  const width = 700;
  const height = 300;
  const pageX = 40;
  const pageY = 30;
  const raw = Buffer.alloc(width * height * 3, 40);
  for (let y = pageY; y < pageY + 120; y += 1) {
    for (let x = pageX; x < pageX + 490; x += 1) {
      const offset = (y * width + x) * 3;
      raw[offset] = PROBE_BACKGROUND[0];
      raw[offset + 1] = PROBE_BACKGROUND[1];
      raw[offset + 2] = PROBE_BACKGROUND[2];
    }
  }
  const ink = (x: number, y: number): void => {
    const offset = (y * width + x) * 3;
    raw[offset] = 0;
    raw[offset + 1] = 0;
    raw[offset + 2] = 0;
  };
  const bar = (cellX: number, cellY: number, vertical: boolean): void => {
    for (let step = 0; step < 60; step += 1) {
      for (let thickness = 0; thickness < 20; thickness += 1) {
        ink(pageX + cellX + (vertical ? 38 + thickness : 18 + step), pageY + cellY + (vertical ? 18 + step : 38 + thickness));
      }
    }
  };
  const tofuBox = (cellX: number, cellY: number): void => {
    for (let step = 0; step < 36; step += 1) {
      for (let thickness = 0; thickness < 4; thickness += 1) {
        ink(pageX + cellX + 30 + step, pageY + cellY + 20 + thickness);
        ink(pageX + cellX + 30 + step, pageY + cellY + 72 - thickness);
        ink(pageX + cellX + 30 + thickness, pageY + cellY + 20 + step);
        ink(pageX + cellX + 62 - thickness, pageY + cellY + 20 + step);
      }
    }
  };
  for (const cell of GLYPH_CELLS) {
    if (cell.id === "tofu") tofuBox(cell.x, cell.y);
    else {
      bar(cell.x, cell.y, cell.id === "latin");
      if (cell.id === "ja" || cell.id === "ko") bar(cell.x + 12, cell.y + 12, cell.id === "ko");
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const probe = await readGlyphProbe(new Uint8Array(png));
  const byId = new Map(probe.cells.map((cell) => [cell.id, cell]));
  expect(probe.bounds).toEqual({ x: pageX, y: pageY, width: 490, height: 120 });
  for (const id of ["latin", "zh", "ja", "ko", "tofu"]) {
    expect(byId.get(id)!.count).toBeGreaterThan(0);
  }
  expect(maskDistance(byId.get("latin")!, byId.get("tofu")!)).toBeGreaterThan(MIN_DISTINCT_DISTANCE);
  expect(maskDistance(byId.get("zh")!, byId.get("tofu")!)).toBeGreaterThan(MIN_DISTINCT_DISTANCE);
  expect(maskDistance(byId.get("latin")!, byId.get("zh")!)).toBeGreaterThan(MIN_DISTINCT_DISTANCE);
});

realTest.each(["default", "host"])("installed browser pack renders CJK and shares one profile with browser selection %s", async selection => {
  const swayBin = process.env.OMARCHY_BOT_SWAY_BIN;
  const wlrRandrBin = process.env.OMARCHY_BOT_WLR_RANDR_BIN;
  const grimBin = process.env.OMARCHY_BOT_GRIM_BIN ?? Bun.which("grim") ?? undefined;
  const dbusDaemonBin = process.env.OMARCHY_BOT_DBUS_DAEMON_BIN ?? Bun.which("dbus-daemon") ?? undefined;
  if (swayBin === undefined || wlrRandrBin === undefined || grimBin === undefined || dbusDaemonBin === undefined) {
    throw new Error(`prerequisites: set OMARCHY_BOT_SWAY_BIN and OMARCHY_BOT_WLR_RANDR_BIN, and provide grim and dbus-daemon. Run: ${COMMAND}`);
  }

  // Resolve bundled helpers before the browser-less fixture hides the host PATH.
  const [inputHelperBin, captureHelperBin, botDesktopBin] = await Promise.all([
    process.env.OMARCHY_BOT_INPUT_HELPER_BIN ?? ensureInputHelper(),
    process.env.OMARCHY_BOT_CAPTURE_HELPER_BIN ?? ensureCaptureHelper(),
    process.env.OMARCHY_BOT_DESKTOP_BIN ?? ensureBotDesktop(),
  ]);

  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-portable-browser-"));
  const bin = path.join(root, "bin");
  const emptyDataDirs = path.join(root, "data-dirs");
  const snapMarker = path.join(root, "snap-ran");
  const applicationCwd = path.join(root, "workspace");
  const profileRoot = path.join(root, "profiles");
  mkdirSync(bin);
  mkdirSync(emptyDataDirs);
  mkdirSync(applicationCwd);

  // The fixture host has no browser: PATH resolves none, and the host's desktop
  // entries are hidden, since a host entry with an absolute `Exec=` would otherwise
  // be found even with no browser on PATH.
  setEnvironment("PATH", browserlessPath(bin, snapMarker));
  setEnvironment("XDG_DATA_DIRS", emptyDataDirs);
  setEnvironment("OMARCHY_BOT_BROWSER", selection === "host" ? "host" : undefined);
  // Bun caches PATH at startup, so resolution must be asked with the fixture PATH.
  const fixturePath = process.env.PATH ?? "";
  expect(Bun.which("brave", { PATH: fixturePath })).toBeNull();
  expect(Bun.which("chromium", { PATH: fixturePath })).toBeNull();

  const html = glyphProbeHtml();
  probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => new URL(request.url).pathname === "/glyphs"
      ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("not found", { status: 404 }),
  });
  const probeUrl = (label: string): string => `http://127.0.0.1:${probe!.port}/glyphs?label=${label}`;

  const fontDir = process.env.OMARCHY_BOT_FONT_DIR
    ?? path.join(process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"), "runtime", "current", "fonts");
  const browserPackDir = process.env.OMARCHY_BOT_BROWSER_PACK_DIR
    ?? path.join(process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"), "runtime", "browser");
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot,
    fontDir,
    browserPackDir,
    capacity: 2,
    applicationCwd,
    swayBin,
    swaymsgBin: process.env.OMARCHY_BOT_SWAYMSG_BIN ?? swayBin,
    wlrRandrBin,
    ...(process.env.OMARCHY_BOT_WAYVNC_BIN === undefined ? {} : { wayvncBin: process.env.OMARCHY_BOT_WAYVNC_BIN }),
    inputHelperBin,
    captureHelperBin,
    botDesktopBin,
    grimBin,
    dbusDaemonBin,
  });
  const nativeMarker = path.join(root, "host-browser-ran");
  if (selection === "default") {
    const native = executableFixture(bin, "brave", `#!/bin/sh\nprintf called > ${JSON.stringify(nativeMarker)}\nexit 1\n`);
    desktopEntry(path.join(profileRoot, "computer", "data", "applications"), "brave-browser.desktop", `"${native}" %U`);
  }

  harness = await startDaemon(path.join(root, "home"), { botScreenAdapter: adapter, botScreenCapacity: 2 });
  const botIds = await Promise.all([
    makeBot(harness, "Portable browser A"),
    makeBot(harness, "Portable browser B"),
  ]);
  const bots = await Promise.all(botIds.map((botId) => api<{ surfaceId: SurfaceId }>(harness!, "GET", `/api/bots/${botId}`)));
  const owners: Owner[] = botIds.map((botId, index) => ({ botId, surfaceId: bots[index]!.surfaceId }));

  const act = (owner: Owner, action: ComputerAction, turnId: string): Promise<BotScreenActionResult> =>
    harness!.svc.screens.act(owner, action, undefined);
  const windows = async (owner: Owner): Promise<ComputerWindowListItem[]> => {
    const result = await act(owner, { name: "list_windows", args: {} }, `windows-${owner.surfaceId}`);
    return Array.isArray(result.windowList) ? result.windowList as ComputerWindowListItem[] : [];
  };
  // Real browser windows and font loading are wall-clock events with no in-process signal.
  const waitForTitle = async (owner: Owner, label: string): Promise<ComputerWindowListItem> => {
    const deadline = performance.now() + 90_000;
    for (;;) {
      const match = profileWindows(await windows(owner), label)[0];
      if (match !== undefined) return match;
      if (performance.now() >= deadline) {
        // Report the compositor's real window list: a missing window and a misrouted
        // window are different defects and only this distinguishes them.
        const processes = readdirSync("/proc")
          .filter((entry) => /^\d+$/.test(entry))
          .flatMap((entry) => {
            try {
              const commandLine = readFileSync(`/proc/${entry}/cmdline`).toString().split("\0").join(" ");
              return commandLine.includes(browserPackDir) && commandLine.includes("--user-data-dir")
                ? [`${entry}:${commandLine.slice(0, 400)}`]
                : [];
            } catch {
              return [];
            }
          });
        throw new Error(
          `${label} window never reached ${owner.surfaceId}; windows=${JSON.stringify(await windows(owner))}; browser=${JSON.stringify(processes)}`,
        );
      }
      await Bun.sleep(250);
    }
  };
  const captureProbe = async (owner: Owner): Promise<GlyphProbe> => {
    const deadline = performance.now() + 30_000;
    for (;;) {
      const result = await act(owner, { name: "screenshot", args: {} }, `capture-${owner.surfaceId}`);
      if (result.image !== undefined) {
        // A mapped window paints after its title changes, so retry until the page shows.
        try {
          return await readGlyphProbe(result.image.bytes);
        } catch (error) {
          if (performance.now() >= deadline) throw error;
        }
      }
      if (performance.now() >= deadline) throw new Error(`probe page never painted on ${owner.surfaceId}`);
      await Bun.sleep(250);
    }
  };

  try {
    for (const owner of owners) await waitScreenReady(harness, owner);

    // The supply's own executable must be runnable: an unpublished loader mode or a
    // missing library otherwise surfaces only much later as a window that never maps.
    const { browserBin } = await new PortableBotComputerAssets({
      profileDir: path.join(profileRoot, "computer"),
      browserPackDir,
    }).ensureBrowser();
    expect(statSync(browserBin).mode & 0o111).toBeGreaterThan(0);
    const version = Bun.spawnSync([browserBin, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toContain("Google Chrome for Testing 156.0.8078.47");

    // No browser on the fixture host, so the portable browser must open the URL.
    await act(owners[0]!, { name: "open_url", args: { url: probeUrl("GLYPH-A") } }, "open-a");
    const windowA = await waitForTitle(owners[0]!, "GLYPH-A");
    expect({ title: windowA.title, count: titleCount(windowA.title) })
      .toMatchObject({ count: 1 });
    expect(browserProcess(probeUrl("GLYPH-A")).binary).toBe(path.join(path.resolve(browserPackDir), "chrome-linux64/chrome"));
    expect(browserProcess(probeUrl("GLYPH-A")).userDataDir
      .startsWith(path.join(profileRoot, "computer"))).toBeTrue();

    // Runtime fonts have no host directories or includes; fontconfig keeps its
    // cache inside the profile. Glyph pixels below prove the faces are used.
    const { fontConfigFile } = await new PortableBotComputerAssets({
      profileDir: path.join(profileRoot, "computer"),
      fontDir,
    }).ensureFonts();
    expect(fontConfigFile.startsWith(path.join(profileRoot, "computer"))).toBeTrue();
    expect(readFileSync(fontConfigFile, "utf8")).not.toContain("<include");
    const fonts = readFontConfig(fontConfigFile);
    expect(fonts.dirs).toEqual([path.resolve(fontDir)]);
    expect(fonts.cacheDirs.length).toBeGreaterThan(0);
    expect(fonts.cacheDirs.every((dir) => dir.startsWith(path.join(profileRoot, "computer")))).toBeTrue();
    expect(fonts.cacheDirs.some((dir) => readdirSync(dir).length > 0)).toBeTrue();

    const probeA = await captureProbe(owners[0]!);
    const byId = new Map(probeA.cells.map((cell) => [cell.id, cell]));
    const tofu = byId.get("tofu")!;
    // The noncharacter is absent from every supplied font, so its cell is the control:
    // a visible placeholder below the glyph threshold, which every real glyph must differ from.
    expect(tofu.count).toBeGreaterThan(0);
    expect(tofu.count).toBeLessThan(MIN_GLYPH_INK);
    for (const id of ["latin", "zh", "ja", "ko"]) {
      const mask = byId.get(id)!;
      expect(mask.count).toBeGreaterThan(MIN_GLYPH_INK);
      expect(maskDistance(mask, tofu)).toBeGreaterThan(MIN_DISTINCT_DISTANCE);
    }
    const cjk = ["zh", "ja", "ko"].map((id) => byId.get(id)!);
    for (let index = 0; index < cjk.length; index += 1) {
      for (let other = index + 1; other < cjk.length; other += 1) {
        expect(maskDistance(cjk[index]!, cjk[other]!)).toBeGreaterThan(MIN_DISTINCT_DISTANCE);
      }
    }
    expect(probeA.bounds.width).toBeGreaterThan(GLYPH_CELL * 4);

    // Second Screen, second URL: the page's stored counter increments, which only a
    // shared profile produces, and the new window routes to the requesting Screen only.
    await act(owners[1]!, { name: "open_url", args: { url: probeUrl("GLYPH-B") } }, "open-b");
    const windowB = await waitForTitle(owners[1]!, "GLYPH-B");
    expect(titleCount(windowB.title)).toBe(2);
    expect(profileWindows(await windows(owners[0]!), "GLYPH-B")).toEqual([]);
    for (const id of ["zh", "ja", "ko"]) {
      const mask = (await captureProbe(owners[1]!)).cells.find((cell) => cell.id === id)!;
      expect(mask.count).toBeGreaterThan(MIN_GLYPH_INK);
    }

    // Snap-only fixture: a snap desktop entry and a `snap` command exist, and neither runs.
    const profileApplications = path.join(profileRoot, "computer", "data", "applications");
    desktopEntry(profileApplications, "brave-browser.desktop", `"${path.join(bin, "snap")}" run brave %U`);
    desktopEntry(profileApplications, "chromium.desktop", "/snap/bin/chromium %U");
    await act(owners[0]!, { name: "open_url", args: { url: probeUrl("GLYPH-C") } }, "open-c");
    const windowC = await waitForTitle(owners[0]!, "GLYPH-C");
    expect(titleCount(windowC.title)).toBe(3);
    expect(existsSync(snapMarker)).toBeFalse();
    expect(existsSync(nativeMarker)).toBeFalse();
  } finally {
    await harness?.stop().catch(() => {});
    harness = undefined;
  }
}, 600_000);
