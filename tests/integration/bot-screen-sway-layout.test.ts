import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "../../apps/daemon/node_modules/sharp";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import type {
  BotScreenProvision,
  BotScreenRuntime,
} from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import { PortableSwayRuntimeSupply } from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";
import type { ComputerWindowListItem } from "../../packages/agent-contract/src/computer-protocol.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { REAL_SWAY_ENV, until } from "./helpers/sway-conformance.ts";

const realTest = process.env[REAL_SWAY_ENV] === "1" ? test : test.skip;
const SURFACE_A = "surf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SurfaceId;
const SURFACE_B = "surf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SurfaceId;
const WIDTH = 1280;
const HEIGHT = 720;
const EVIDENCE_DIR = path.resolve(import.meta.dir, "../../.lane/layout-evidence");
const FIXTURE_SOURCE = path.resolve(import.meta.dir, "helpers/sway-layout.c");

let root: string | undefined;
let adapter: SwayBotScreenRuntimeAdapter | undefined;
const started: SurfaceId[] = [];

afterEach(async () => {
  for (const surfaceId of started.splice(0)) {
    await adapter?.destroy(surfaceId).catch(() => {});
  }
  adapter = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function provision(surfaceId: SurfaceId): BotScreenProvision {
  return {
    surfaceId,
    geometryGeneration: 1,
    logicalWidth: WIDTH,
    logicalHeight: HEIGHT,
    scale: 1,
    refreshRate: 30,
  };
}

/** Compiles the Wayland fixture and returns a launcher that titles its window. */
function buildFixture(directory: string): (title: string, dialogDelayMs?: number, dialogTitle?: string, appId?: string, bodyColor?: string) => string {
  const flags = Bun.spawnSync(["pkg-config", "--cflags", "--libs", "wayland-client"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (flags.exitCode !== 0) {
    throw new Error("Wayland client development files are required for the real-Sway layout fixture");
  }
  const protocol = path.join(directory, "xdg-shell-client-protocol");
  const scanner = Bun.which("wayland-scanner") ?? "wayland-scanner";
  const xml = "/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml";
  for (const [kind, output] of [["client-header", `${protocol}.h`], ["private-code", `${protocol}.c`]] as const) {
    const generated = Bun.spawnSync([scanner, kind, xml, output], { stdout: "pipe", stderr: "pipe" });
    if (generated.exitCode !== 0) {
      throw new Error(`xdg-shell protocol failed to generate: ${generated.stderr.toString().trim()}`);
    }
  }
  const binary = path.join(directory, "sway-layout-fixture");
  const build = Bun.spawnSync([
    Bun.which("cc") ?? "cc",
    "-O1",
    "-I",
    directory,
    "-o",
    binary,
    FIXTURE_SOURCE,
    `${protocol}.c`,
    ...flags.stdout.toString().split(/\s+/).filter((flag) => flag !== ""),
  ], { stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    throw new Error(`layout fixture failed to build: ${build.stderr.toString().trim()}`);
  }
  return (title, dialogDelayMs = 0, dialogTitle = "", appId = "", bodyColor = "0xfff2f2f2") => {
    const launcher = path.join(directory, `launch-${title.replaceAll(/\W+/g, "-")}-${Date.now()}`);
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        `exec ${JSON.stringify(binary)} ${JSON.stringify(title)} ${dialogDelayMs} ${JSON.stringify(dialogTitle)} "" ${JSON.stringify(appId)} ${bodyColor}`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    return launcher;
  };
}

async function listed(runtime: BotScreenRuntime): Promise<ComputerWindowListItem[]> {
  return runtime.listWindows();
}

async function waitWindow(
  runtime: BotScreenRuntime,
  title: string,
): Promise<ComputerWindowListItem> {
  return until(async () => {
    const window = (await listed(runtime)).find((candidate) => candidate.title === title);
    return window;
  }, 20_000, `window "${title}"`);
}

async function capture(runtime: BotScreenRuntime, label: string): Promise<Uint8Array> {
  const image = (await runtime.capture()).bytes;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await Bun.write(path.join(EVIDENCE_DIR, `${label}.png`), image);
  return image;
}

const ALPHA_BODY = [0x33, 0x66, 0xcc] as const;
const BETA_BODY = [0xcc, 0x66, 0x33] as const;
const BRAVO_BODY = [0x22, 0xaa, 0x22] as const;

function argb(color: readonly [number, number, number]): string {
  return `0xff${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Rows of one strip: total, and how many are a single run of `color` across the Screen. A tab paints one full-width body; a split paints half. */
async function bodyRows(
  image: Uint8Array,
  top: number,
  height: number,
  color: readonly [number, number, number],
): Promise<{ rows: number; spanned: number }> {
  const { data, info } = await sharp(image)
    .extract({ left: 0, top, width: WIDTH, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let spanned = 0;
  for (let row = 0; row < info.height; row += 1) {
    let runs = 0;
    let left = WIDTH;
    let right = -1;
    let inside = false;
    for (let column = 0; column < WIDTH; column += 1) {
      const offset = (row * WIDTH + column) * info.channels;
      const matches = Math.abs(data[offset]! - color[0]) <= 8
        && Math.abs(data[offset + 1]! - color[1]) <= 8
        && Math.abs(data[offset + 2]! - color[2]) <= 8;
      if (!matches) {
        inside = false;
        continue;
      }
      if (!inside) {
        runs += 1;
        inside = true;
        left = column;
      }
      right = column;
    }
    if (runs === 1 && left < 40 && right > WIDTH - 40) spanned += 1;
  }
  return { rows: info.height, spanned };
}

/** Bright pixels per equal column of one strip. */
async function brightColumns(image: Uint8Array, top: number, height: number, columns: number): Promise<number[]> {
  const greyscale = await sharp(image)
    .extract({ left: 0, top, width: WIDTH, height })
    .greyscale()
    .raw()
    .toBuffer();
  const counts = Array.from({ length: columns }, () => 0);
  for (let index = 0; index < greyscale.length; index += 1) {
    if (greyscale[index]! < 200) continue;
    const column = Math.min(columns - 1, Math.floor((index % WIDTH) / (WIDTH / columns)));
    counts[column] = (counts[column] ?? 0) + 1;
  }
  return counts;
}

realTest("two Screen workspaces render full-width tabbed windows with readable titles and a centered dialog", async () => {
  const grim = Bun.which("grim");
  if (grim === null) throw new Error("host grim is required");
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-layout-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const launch = buildFixture(root);
  const binaries = await new PortableSwayRuntimeSupply({
    rootDir: process.env.OMARCHY_BOT_SWAY_BUNDLE_DIR
      ?? path.join(process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"), "runtime", "current", "sway"),
  }).ensure();
  adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "screens"),
    fontDir: process.env.OMARCHY_BOT_FONT_DIR
      ?? path.join(process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"), "runtime", "current", "fonts"),
    applicationCwd: workspace,
    swayBin: binaries.swayBin,
    swaymsgBin: binaries.swaymsgBin,
    wayvncBin: binaries.wayvncBin,
    wlrRandrBin: binaries.wlrRandrBin,
    grimBin: grim,
    // Unused headless outputs stay at the origin and paint over the Screen.
    capacity: 2,
  });
  const runtimeA = await adapter.start(provision(SURFACE_A));
  started.push(SURFACE_A);
  const runtimeB = await adapter.start(provision(SURFACE_B));
  started.push(SURFACE_B);

  await runtimeA.launch({ app: launch("Screen A Alpha", 0, "", "", argb(ALPHA_BODY)) });
  await runtimeA.launch({ app: launch("Screen A Beta", 0, "", "", argb(BETA_BODY)) });
  await runtimeB.launch({ app: launch("Screen B Bravo", 0, "", "", argb(BRAVO_BODY)) });
  const alpha = await waitWindow(runtimeA, "Screen A Alpha");
  const beta = await waitWindow(runtimeA, "Screen A Beta");
  const bravo = await waitWindow(runtimeB, "Screen B Bravo");

  // The first window keeps the whole Screen behind a tab instead of sharing a split.
  // A split reports about half the Screen width; a tab reports the whole width and a
  // strip of title above the content.
  expect(alpha.bounds?.x).toBe(0);
  expect(alpha.bounds?.width).toBe(WIDTH);
  expect(beta.bounds?.x).toBe(0);
  expect(beta.bounds?.width).toBe(WIDTH);
  const tabStripHeight = alpha.bounds?.y ?? 0;
  expect(tabStripHeight).toBeGreaterThanOrEqual(10);
  expect(tabStripHeight).toBeLessThanOrEqual(60);
  expect(alpha.bounds?.height).toBeGreaterThanOrEqual(HEIGHT - 60);
  expect(beta.bounds?.y).toBe(tabStripHeight);

  // Routing and listing stay per Screen workspace.
  const titlesA = (await listed(runtimeA)).map((window) => window.title);
  const titlesB = (await listed(runtimeB)).map((window) => window.title);
  expect(titlesA.sort()).toEqual(["Screen A Alpha", "Screen A Beta"]);
  expect(titlesB).toEqual(["Screen B Bravo"]);
  expect(bravo.bounds?.width).toBe(WIDTH);
  // Activation focuses the requested window; the visible tab switches with it.
  await runtimeA.focusWindow(alpha);
  const focusedAlpha = await until(async () => {
    const windows = await listed(runtimeA);
    return windows.find((window) => window.title === "Screen A Alpha")?.focused === true
      ? windows
      : undefined;
  }, 8_000, "focus on Screen A Alpha");
  expect(focusedAlpha.find((window) => window.title === "Screen A Beta")?.focused).toBeFalse();

  // The focused window fills the Screen and both tab titles are in the strip.
  // A tab paints one body: exactly one full-width run of Alpha's color. A split
  // paints Alpha's color over half the Screen and Beta's over the other half.
  const bodyHeight = HEIGHT - tabStripHeight;
  const alphaImage = await until(async () => {
    const image = await capture(runtimeA, "two-tabs-alpha-focused");
    const body = await bodyRows(image, tabStripHeight, bodyHeight, ALPHA_BODY);
    const titles = await brightColumns(image, 0, tabStripHeight, 2);
    return body.spanned > body.rows * 0.8
      && (titles[0] ?? 0) > 50 && (titles[1] ?? 0) > 50
      ? image
      : undefined;
  }, 8_000, "tabbed Screen capture");
  const body = await bodyRows(alphaImage, tabStripHeight, bodyHeight, ALPHA_BODY);
  expect(body.spanned).toBeGreaterThan(body.rows * 0.8);
  // The hidden tab's body is not painted anywhere: a tab shows one body only.
  expect(await bodyRows(alphaImage, tabStripHeight, bodyHeight, BETA_BODY)).toEqual({
    rows: bodyHeight,
    spanned: 0,
  });
  const titles = await brightColumns(alphaImage, 0, tabStripHeight, 2);
  expect(titles[0]).toBeGreaterThan(50);
  expect(titles[1]).toBeGreaterThan(50);

  // A transient dialog whose parent is set before it maps floats smaller than
  // its parent and centered over it.
  await runtimeA.launch({ app: launch("Screen A Dialog Owner", 900, "Approve") });
  const owner = await waitWindow(runtimeA, "Screen A Dialog Owner");
  const dialog = await waitWindow(runtimeA, "Approve");
  const dialogBounds = dialog.bounds!;
  const ownerBounds = owner.bounds!;
  expect(dialogBounds.width).toBeLessThan(ownerBounds.width);
  expect(dialogBounds.height).toBeLessThan(ownerBounds.height);
  expect(Math.abs(dialogBounds.x + dialogBounds.width / 2 - (ownerBounds.x + ownerBounds.width / 2))).toBeLessThanOrEqual(32);
  expect(Math.abs(dialogBounds.y + dialogBounds.height / 2 - (ownerBounds.y + ownerBounds.height / 2))).toBeLessThanOrEqual(32);
  // Listing still reports the dialog on this Screen, not the other one.
  expect((await listed(runtimeA)).map((window) => window.title)).toContain("Approve");
  expect((await listed(runtimeB)).map((window) => window.title)).not.toContain("Approve");

  // The dialog is white and the window behind it is light grey, so only the dialog crosses this.
  await until(async () => {
    const image = await capture(runtimeA, "centered-dialog");
    const pixels = await sharp(image)
      .extract({ left: dialogBounds.x, top: dialogBounds.y, width: dialogBounds.width, height: dialogBounds.height })
      .removeAlpha()
      .raw()
      .toBuffer();
    let white = 0;
    for (let index = 0; index < pixels.length; index += 3) {
      if (pixels[index]! > 250 && pixels[index + 1]! > 250 && pixels[index + 2]! > 250) white += 1;
    }
    return white > dialogBounds.width * dialogBounds.height / 4 ? true : undefined;
  }, 8_000, "painted dialog");
}, 90_000);
