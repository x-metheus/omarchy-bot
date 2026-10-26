import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import sharp from "../../apps/daemon/node_modules/sharp";
import os from "node:os";
import path from "node:path";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import type {
  BotScreenProvision,
  BotScreenRuntime,
} from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import {
  PortableSwayRuntimeSupply,
  SWAY_RUNTIME_RELEASE,
} from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { PNG_SIGNATURE, until } from "./helpers/sway-conformance.ts";

/**
 * Seam 3 for ticket 04: the Bot Computer runs only from the published bundle.
 *
 * Gated on OMARCHY_BOT_SWAY_BUNDLE, the path to the built
 * `omarchy-bot-sway-runtime-<release>-x86_64.tar.gz`. scripts/sway-runtime/conformance/run.sh
 * runs this suite inside an Ubuntu 22.04 container that has no Sway, grim,
 * D-Bus daemon, Xwayland, or compiler, so every tool it exercises must come
 * from the archive.
 */
const BUNDLE_ENV = "OMARCHY_BOT_SWAY_BUNDLE";
const X11_FIXTURE_ENV = "OMARCHY_BOT_X11_FIXTURE";
const bundleOnly = process.env[BUNDLE_ENV] === undefined ? test.skip : test;

/** Host tools the bundle must replace; their absence is the point of the suite. */
const FORBIDDEN_HOST_TOOLS = [
  "sway",
  "swaymsg",
  "wayvnc",
  "wlr-randr",
  "Xwayland",
  "grim",
  "dbus-daemon",
  "dbus-send",
] as const;
const FORBIDDEN_HOST_COMPILERS = [
  "cc",
  "gcc",
  "clang",
  "pkg-config",
  "wayland-scanner",
] as const;

const BUNDLE_ENTRIES = [
  "sway",
  "swaymsg",
  "wayvnc",
  "wlr-randr",
  "Xwayland",
  "grim",
  "dbus-daemon",
  "dbus-send",
  "omarchy-bot-wayland-input",
  "omarchy-bot-wayland-capture",
  "omarchy-bot-desktop",
  // Not a SwayRuntimeBinaries field: Xwayland launches it by name.
  "xkbcomp",
] as const;

const SURFACE_A = "surf_04040404040404040404040404040404" as SurfaceId;
const SURFACE_B = "surf_05050505050505050505050505050505" as SurfaceId;
const WIDTH = 1_024;
const HEIGHT = 768;
const MAGENTA = { r: 255, g: 0, b: 255 };
const CYAN = { r: 0, g: 255, b: 255 };
const GREEN = { r: 0, g: 255, b: 0 };
const COLOR_TOLERANCE = 24;

interface Rgba {
  width: number;
  height: number;
  bytes: Uint8Array;
}

function provision(surfaceId: SurfaceId): BotScreenProvision {
  return {
    surfaceId,
    geometryGeneration: 1,
    logicalWidth: WIDTH,
    logicalHeight: HEIGHT,
    scale: 1,
    refreshRate: 60,
  };
}

/** Decodes a PNG to straight RGBA. grim emits 8-bit RGB/RGBA PNGs. */
async function decodePng(bytes: Uint8Array): Promise<Rgba> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`unexpected decoded channel count ${info.channels}`);
  return { width: info.width, height: info.height, bytes: new Uint8Array(data) };
}

/**
 * Share of pixels matching the color inside `region` (default: the whole frame).
 * The X11 fixture fills its window, so its own bounds are the honest region.
 */
function colorShare(
  frame: Rgba,
  expected: { r: number; g: number; b: number },
  region: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: frame.width,
    height: frame.height,
  },
): number {
  const left = Math.max(0, Math.floor(region.x));
  const top = Math.max(0, Math.floor(region.y));
  const right = Math.min(frame.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(frame.height, Math.ceil(region.y + region.height));
  let matched = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * frame.width + column) * 4;
      total += 1;
      if (
        Math.abs(frame.bytes[offset]! - expected.r) <= COLOR_TOLERANCE
        && Math.abs(frame.bytes[offset + 1]! - expected.g) <= COLOR_TOLERANCE
        && Math.abs(frame.bytes[offset + 2]! - expected.b) <= COLOR_TOLERANCE
      ) matched += 1;
    }
  }
  return total === 0 ? 0 : matched / total;
}

async function run(argv: string[], env: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

let workRoot: string | undefined;

afterAll(() => {
  if (workRoot !== undefined) rmSync(workRoot, { recursive: true, force: true });
  workRoot = undefined;
});

function work(): string {
  if (workRoot === undefined) workRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-bundle-conformance-"));
  return workRoot;
}

bundleOnly("the conformance host has no Sway, grim, D-Bus, Xwayland, or compiler", () => {
  const present = [...FORBIDDEN_HOST_TOOLS, ...FORBIDDEN_HOST_COMPILERS]
    .filter((name) => Bun.which(name) !== null);
  expect(present).toEqual([]);
});

bundleOnly("the published bundle carries executable, relocatable launchers", async () => {
  const archive = process.env[BUNDLE_ENV]!;
  expect(existsSync(archive)).toBeTrue();
  const extract = path.join(work(), "launcher-check");
  mkdirSync(extract, { recursive: true, mode: 0o700 });
  const extracted = await run(["tar", "--extract", "--gzip", "--file", archive, "--directory", extract], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  });
  expect({ status: extracted.status, error: /error|cannot|failed/i.test(extracted.stderr) })
    .toEqual({ status: 0, error: false });

  // The archive root is the bundle root (build contract); no wrapper directory.
  const binDir = path.join(extract, "bin");
  for (const entry of BUNDLE_ENTRIES) {
    const launcher = path.join(binDir, entry);
    expect({ entry, exists: existsSync(launcher) }).toEqual({ entry, exists: true });
    expect({ entry, executable: (statSync(launcher).mode & 0o111) !== 0 })
      .toEqual({ entry, executable: true });
  }

  // Every launcher must start from an arbitrary directory under a minimal
  // PATH: a broken relocation shows up as a loader or interpreter error.
  for (const [entry, argv] of [
    ["sway", ["-v"]],
    ["swaymsg", ["--help"]],
    ["dbus-daemon", ["--version"]],
    ["dbus-send", ["--help"]],
    ["wlr-randr", ["--help"]],
    ["wayvnc", ["--help"]],
    ["grim", ["-h"]],
    ["Xwayland", ["-version"]],
    ["xkbcomp", ["-version"]],
  ] as const) {
    const result = await run([path.join(binDir, entry), ...argv], { PATH: "/usr/bin:/bin" });
    const output = `${result.stdout}${result.stderr}`;
    expect({ entry, loaderError: /error while loading shared libraries|command not found|No such file/i.test(output) })
      .toEqual({ entry, loaderError: false });
    expect({ entry, status: result.status }).not.toEqual({ entry, status: 127 });
  }
});

bundleOnly("two bundle-only Bot Screens isolate X11 clients, input, and projection", async () => {
  const archive = process.env[BUNDLE_ENV]!;
  const root = work();
  const x11Fixture = process.env[X11_FIXTURE_ENV];
  expect(x11Fixture).toBeDefined();
  expect((statSync(x11Fixture!).mode & 0o111) !== 0).toBeTrue();

  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex");
  const supplyDir = path.join(root, "supply");
  mkdirSync(supplyDir, { recursive: true, mode: 0o700 });
  const extracted = await run(["tar", "--extract", "--gzip", "--file", archive, "--directory", supplyDir], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  });
  expect({ status: extracted.status, stderr: extracted.stderr }).toEqual({ status: 0, stderr: "" });
  writeFileSync(path.join(supplyDir, ".omarchy-bot-runtime"), `${SWAY_RUNTIME_RELEASE}\n${digest}\n`);
  const supply = new PortableSwayRuntimeSupply({
    rootDir: supplyDir,
    bundle: {
      release: SWAY_RUNTIME_RELEASE,
      sha256: digest,
    },
  });
  const binaries = await supply.ensure();
  const binDir = path.dirname(binaries.swayBin);
  expect(binDir.startsWith(path.join(root, "supply"))).toBeTrue();
  expect(readdirSync(binDir)).toEqual(expect.arrayContaining([...BUNDLE_ENTRIES]));

  const applicationCwd = path.join(root, "workspace");
  mkdirSync(applicationCwd, { recursive: true, mode: 0o700 });
  const launcher = (name: string, title: string, color: string): string => {
    const target = path.join(applicationCwd, name);
    writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(x11Fixture)} ${title} ${color}\n`, { mode: 0o755 });
    return target;
  };
  const appA = launcher("x11-a", "X11-ONLY-A", "ff00ff");
  const appB = launcher("x11-b", "X11-ONLY-B", "00ff00");

  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    applicationCwd,
    runtimeSupply: supply,
  });
  // Starts live inside the try so a failed second start still tears the first
  // Screen down; the adapter owns the shared compositor and session bus.
  let runtimeA: BotScreenRuntime | undefined;
  let runtimeB: BotScreenRuntime | undefined;
  try {
    runtimeA = await adapter.start(provision(SURFACE_A));
    runtimeB = await adapter.start(provision(SURFACE_B));
    const screenA = runtimeA;
    const screenB = runtimeB;
    for (const runtime of [screenA, screenB]) {
      expect(runtime.readiness).toMatchObject({
        compositor: "ready",
        waylandSocket: "private",
        desktopSurface: "ready",
        capture: "ready",
        input: "ready",
      });
    }

    // The private session bus and X server come from the bundle, not the host.
    const sessionEnv = screenA.sessionEnv;
    const busAddress = sessionEnv.DBUS_SESSION_BUS_ADDRESS;
    expect(busAddress).toBeDefined();
    expect(busAddress!).toStartWith("unix:path=");
    expect(busAddress!).toContain(path.join(root, "runtime"));
    expect(existsSync(busAddress!.slice("unix:path=".length))).toBeTrue();
    expect(sessionEnv.DISPLAY).toBeDefined();
    expect(sessionEnv.DISPLAY).not.toBe(process.env.DISPLAY ?? "");
    expect(sessionEnv.PATH!.split(":")).toContain(binDir);

    // The processes that serve the Screen come from the bundle, not the host.
    // Launchers may exec a bundled loader with an absolute libexec path, so
    // match any argv token inside the bundle root rather than bin/sway itself.
    const bundleRoot = path.dirname(binDir);
    const bundleExecutables = new Set<string>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        for (const argument of readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")) {
          if (argument.startsWith(`${bundleRoot}/`)) bundleExecutables.add(path.basename(argument));
        }
      } catch {
        // Processes exit while /proc is sampled.
      }
    }
    expect({ sway: bundleExecutables.has("sway"), desktop: bundleExecutables.has("omarchy-bot-desktop") })
      .toEqual({ sway: true, desktop: true });

    // Bundled grim produces each Screen's PNG at its configured geometry.
    const emptyA = await screenA.capture();
    const emptyB = await screenB.capture();
    for (const empty of [emptyA, emptyB]) {
      expect(empty.mediaType).toBe("image/png");
      expect(Array.from(empty.bytes.subarray(0, 8))).toEqual(Array.from(PNG_SIGNATURE));
      const pixels = await decodePng(empty.bytes);
      expect({ width: pixels.width, height: pixels.height }).toEqual({ width: WIDTH, height: HEIGHT });
    }

    // The bundled native capture helper streams each Screen as raw RGBA.
    const streamA = await screenA.openCaptureStream();
    const streamB = await screenB.openCaptureStream();
    for (const stream of [streamA, streamB]) {
      const frame = await stream.next();
      expect({ width: frame.width, height: frame.height, format: frame.pixelFormat })
        .toEqual({ width: WIDTH, height: HEIGHT, format: "rgba" });
      expect(frame.bytes.byteLength).toBe(WIDTH * HEIGHT * 4);
    }

    // A live method call on the private session bus, made with the bundled client.
    const busCall = await run([
      path.join(binDir, "dbus-send"),
      `--bus=${busAddress}`,
      "--print-reply",
      "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus.ListNames",
    ], sessionEnv);
    expect({ status: busCall.status, error: /error|failed|cannot/i.test(busCall.stderr) })
      .toEqual({ status: 0, error: false });
    expect(busCall.stdout).toContain("org.freedesktop.DBus");

    // An X11-only client on each Screen: mapped through the bundled Xwayland.
    // Launch one at a time so the lazy Xwayland start cannot race the other
    // Screen's workspace focus.
    await screenA.launch({ app: appA });
    const windowA = await until(async () => {
      const windows = await screenA.listWindows();
      return windows.find((candidate) => candidate.title === "X11-ONLY-A");
    }, 30_000, "X11-only fixture window was never mapped on Screen A");
    await screenB.launch({ app: appB });
    const windowB = await until(async () => {
      const windows = await screenB.listWindows();
      return windows.find((candidate) => candidate.title === "X11-ONLY-B");
    }, 30_000, "X11-only fixture window was never mapped on Screen B");
    expect({ clientType: windowA.clientType, bounds: windowA.bounds !== undefined })
      .toEqual({ clientType: "x11", bounds: true });
    expect({ clientType: windowB.clientType, bounds: windowB.bounds !== undefined })
      .toEqual({ clientType: "x11", bounds: true });

    // Routing isolation: each Screen routes only its own client.
    const titlesA = (await screenA.listWindows()).map((window) => window.title);
    const titlesB = (await screenB.listWindows()).map((window) => window.title);
    expect({ a: titlesA.includes("X11-ONLY-A"), b: titlesA.includes("X11-ONLY-B") })
      .toEqual({ a: true, b: false });
    expect({ a: titlesB.includes("X11-ONLY-B"), b: titlesB.includes("X11-ONLY-A") })
      .toEqual({ a: true, b: false });

    // Their pixels arrive through the bundled native capture, not merely their
    // processes, and each Screen shows only its own fixture.
    const boundsA = windowA.bounds!;
    const boundsB = windowB.bounds!;
    const frameA = await until(async () => {
      const frame = await streamA.next();
      return colorShare(frame, MAGENTA, boundsA) > 0.9 ? frame : undefined;
    }, 20_000, "X11-only fixture pixels were never captured on Screen A");
    const frameB = await until(async () => {
      const frame = await streamB.next();
      return colorShare(frame, GREEN, boundsB) > 0.9 ? frame : undefined;
    }, 20_000, "X11-only fixture pixels were never captured on Screen B");
    expect({ a: colorShare(frameA, CYAN, boundsA) < 0.01, b: colorShare(frameA, GREEN, boundsA) < 0.01 })
      .toEqual({ a: true, b: true });
    expect({ a: colorShare(frameB, MAGENTA, boundsB) < 0.01, b: colorShare(frameB, CYAN, boundsB) < 0.01 })
      .toEqual({ a: true, b: true });

    const shotA = await decodePng((await screenA.capture()).bytes);
    const shotB = await decodePng((await screenB.capture()).bytes);
    expect(colorShare(shotA, MAGENTA, boundsA)).toBeGreaterThan(0.9);
    expect(colorShare(shotA, GREEN)).toBeLessThan(0.01);
    expect(colorShare(shotB, GREEN, boundsB)).toBeGreaterThan(0.9);
    expect(colorShare(shotB, MAGENTA)).toBeLessThan(0.01);

    // Input through the bundled virtual-input helper reaches Screen A's X11
    // window and leaves its sibling untouched.
    const x = boundsA.x + Math.floor(boundsA.width / 2);
    const y = boundsA.y + Math.floor(boundsA.height / 2);
    const epoch = await screenA.setInputAuthority(1);
    const envelope = (sequence: number) => ({
      surfaceId: SURFACE_A,
      runtimeGeneration: screenA.generation,
      geometryGeneration: provision(SURFACE_A).geometryGeneration,
      controllerEpoch: epoch,
      sequence,
    });
    await screenA.input({ ...envelope(1), type: "motion", x, y });
    await screenA.input({ ...envelope(2), type: "button", x, y, button: "left", state: "pressed" });
    await screenA.input({ ...envelope(3), type: "button", x, y, button: "left", state: "released" });
    await screenA.releaseInput(epoch);

    const cyanFrame = await until(async () => {
      const frame = await streamA.next();
      return colorShare(frame, CYAN, boundsA) > 0.9 ? frame : undefined;
    }, 20_000, "input did not reach the X11-only fixture on Screen A");
    expect(colorShare(cyanFrame, MAGENTA, boundsA)).toBeLessThan(0.01);
    const afterInput = await decodePng((await screenA.capture()).bytes);
    expect(colorShare(afterInput, CYAN, boundsA)).toBeGreaterThan(0.9);
    const siblingAfter = await decodePng((await screenB.capture()).bytes);
    expect(colorShare(siblingAfter, GREEN, boundsB)).toBeGreaterThan(0.9);
    await streamA.close();
    await streamB.close();

    // View-only RFB from the bundled WayVNC, per Screen.
    for (const runtime of [screenA, screenB]) {
      const view = await runtime.acquireExpandedView();
      try {
        // The banner is the awaited event; the sleep is only a deadline.
        const banner = await Promise.race([
          view.receive(),
          Bun.sleep(20_000).then(() => {
            throw new Error("bundled WayVNC never sent an RFB banner");
          }),
        ]);
        expect(new TextDecoder().decode(banner.subarray(0, 12))).toBe("RFB 003.008\n");
      } finally {
        await view.close();
      }
    }

    const titlesAfter = (await screenA.listWindows()).map((candidate) => candidate.title);
    expect({ own: titlesAfter.includes("X11-ONLY-A"), sibling: titlesAfter.includes("X11-ONLY-B") })
      .toEqual({ own: true, sibling: false });
  } finally {
    await runtimeB?.stop().catch(() => {});
    await runtimeA?.stop().catch(() => {});
    await adapter.destroy(SURFACE_B).catch(() => {});
    await adapter.destroy(SURFACE_A).catch(() => {});
  }

  // Targeted teardown: no Screen tree, no shared computer tree (compositor and
  // session bus only carry the runtime dir, not a surface id), and no process
  // whose argv or environment points into this test's private root.
  const runtimeRoot = path.join(root, "runtime");
  expect(existsSync(path.join(runtimeRoot, SURFACE_A))).toBeFalse();
  expect(existsSync(path.join(runtimeRoot, SURFACE_B))).toBeFalse();
  expect(existsSync(path.join(runtimeRoot, "computer"))).toBeFalse();
  const leftovers = await until(async () => {
    const found: string[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        const environ = readFileSync(`/proc/${entry}/environ`, "utf8");
        if (cmdline.includes(SURFACE_A) || environ.includes(SURFACE_A)
          || cmdline.includes(SURFACE_B) || environ.includes(SURFACE_B)
          || cmdline.includes(runtimeRoot) || environ.includes(runtimeRoot)) found.push(entry);
      } catch {
        // Processes exit while /proc is sampled.
      }
    }
    return found.length === 0 ? [] : undefined;
  }, 10_000, "processes from this test's private runtime root survived teardown");
  expect(leftovers).toEqual([]);
}, 300_000);
