import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import { PortableSwayRuntimeSupply } from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";
import { waitScreenReady } from "./helpers/bot-screen-load-observe.ts";
import { api, makeBot, startDaemon } from "./helpers/harness.ts";
import { ProjectionClient } from "./helpers/projection-client.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { createFakeWayvncBin } from "./helpers/swayBotScreen.ts";
import { writeFakeSwayIpcMode, writeFakeSwayTree } from "./helpers/fakeSwayIpc.ts";

const SURFACE_A = "surf_11111111111111111111111111111111" as SurfaceId;
const SURFACE_B = "surf_22222222222222222222222222222222" as SurfaceId;

let root: string | undefined;
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;
const originalPath = process.env.PATH;
const originalSwaySock = process.env.SWAYSOCK;
const originalDbus = process.env.DBUS_SESSION_BUS_ADDRESS;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (originalWaylandDisplay === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = originalWaylandDisplay;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalSwaySock === undefined) delete process.env.SWAYSOCK;
  else process.env.SWAYSOCK = originalSwaySock;
  if (originalDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
  else process.env.DBUS_SESSION_BUS_ADDRESS = originalDbus;
});

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

const SCREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWMQMgn7D8IAC5MDN627upEAAAAASUVORK5CYII=",
  "base64",
);


function installFakeSwayBins(directory: string, options: {
  png: string;
  desktopPid?: string;
  swayPid?: string;
  waylandDisplay?: string;
}): {
  sway: string;
  wlrRandr: string;
  grim: string;
  input: string;
  capture: string;
  desktop: string;
} {
  const controlDir = path.join(directory, "ipc-control");
  mkdirSync(controlDir);
  writeFakeSwayTree(controlDir, {
    id: 1,
    type: "root",
    name: "root",
    nodes: [],
    floating_nodes: [],
  });
  writeFakeSwayIpcMode(controlDir, "ok");
  const helperPath = path.resolve(import.meta.dir, "helpers/fakeSwayIpc.ts");
  const sway = executable(directory, "sway", `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
const wayland = path.join(runtimeDir, ${JSON.stringify(options.waylandDisplay ?? "wayland-0")});
const swaySock = process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock");
const swayPid = ${JSON.stringify(options.swayPid ?? "")};
if (swayPid !== "") writeFileSync(swayPid, String(process.pid));
Bun.listen({ unix: wayland, socket: { data() {} } });
await serveFakeSwayIpc({
  socketPath: swaySock,
  controlDir: ${JSON.stringify(controlDir)},
});
`);
  const desktopLines = [
    "#!/bin/sh",
    ...(options.desktopPid === undefined ? [] : [`printf '%s' "$$" > ${JSON.stringify(options.desktopPid)}`]),
    "printf 'READY %s %s\\n' \"$1\" \"$2\"",
    "while :; do sleep 60; done",
    "",
  ];
  return {
    sway,
    wlrRandr: executable(directory, "wlr-randr", "#!/bin/sh\nexit 0\n"),
    grim: executable(directory, "grim", `#!/bin/sh\ncat ${JSON.stringify(options.png)}\n`),
    input: executable(directory, "input", [
      "#!/bin/sh",
      "printf 'READY\\n'",
      "while IFS=' ' read -r command request rest; do",
      "  printf 'OK %s\\n' \"$request\"",
      "done",
      "",
    ].join("\n")),
    capture: executable(directory, "capture", "#!/bin/sh\nprintf 'READY\\n'\nwhile read -r command; do [ \"$command\" = close ] && exit 0; done\n"),
    desktop: executable(directory, "bot-desktop", desktopLines.join("\n")),
  };
}

function provision(surfaceId: SurfaceId) {
  return {
    surfaceId,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  };
}

test("two Screens share one private Bot Computer session and persistent profile", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-runtime-"));
  const bin = path.join(root, "bin");
  const runtimeRoot = path.join(root, "runtime");
  const profileRoot = path.join(root, "profiles");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  process.env.WAYLAND_DISPLAY = "host-wayland-9";
  process.env.SWAYSOCK = "/host/sway-ipc.sock";
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
  const bins = installFakeSwayBins(bin, { png });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot,
    profileRoot,
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });

  const expectedReadiness = {
    compositor: "ready" as const,
    waylandSocket: "private" as const,
    output: {
      geometryGeneration: 7,
      logicalWidth: 2,
      logicalHeight: 1,
      scale: 1,
      refreshRate: 15,
    },
    desktopSurface: "ready" as const,
    capture: "ready" as const,
    input: "ready" as const,
  };
  const first = await adapter.start(provision(SURFACE_A));
  const second = await adapter.start(provision(SURFACE_B));
  expect(first.readiness).toEqual(expectedReadiness);
  expect(second.readiness).toEqual({
    ...expectedReadiness,
    output: { ...expectedReadiness.output, geometryGeneration: 7 },
  });
  expect(second.generation).toBe(first.generation);

  const computerGeneration = String(first.generation);
  const firstRuntime = path.join(runtimeRoot, SURFACE_A, computerGeneration);
  const secondRuntime = path.join(runtimeRoot, SURFACE_B, computerGeneration);
  const sharedProfile = path.join(profileRoot, "computer");
  expect(statSync(firstRuntime).mode & 0o777).toBe(0o700);
  expect(statSync(secondRuntime).mode & 0o777).toBe(0o700);
  for (const directory of ["home", "config", "data", "state", "cache"]) {
    expect(statSync(path.join(sharedProfile, directory)).mode & 0o777).toBe(0o700);
  }

  const sharedRuntime = first.sessionEnv.XDG_RUNTIME_DIR;
  expect(typeof sharedRuntime).toBe("string");
  expect(first.sessionEnv).toMatchObject({
    HOME: path.join(sharedProfile, "home"),
    XDG_RUNTIME_DIR: sharedRuntime,
    WAYLAND_DISPLAY: "wayland-0",
    SWAYSOCK: path.join(sharedRuntime!, "sway-ipc.sock"),
    XDG_CONFIG_HOME: path.join(sharedProfile, "config"),
    XDG_DATA_HOME: path.join(sharedProfile, "data"),
    XDG_STATE_HOME: path.join(sharedProfile, "state"),
    XDG_CACHE_HOME: path.join(sharedProfile, "cache"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(sharedRuntime!, "bus")}`,
  });
  expect(second.sessionEnv).toEqual(first.sessionEnv);
  expect(first.sessionEnv).not.toHaveProperty("WLR_BACKENDS");
  expect(first.sessionEnv.SWAYSOCK).not.toBe(process.env.SWAYSOCK);
  expect(first.sessionEnv.DBUS_SESSION_BUS_ADDRESS).not.toBe(process.env.DBUS_SESSION_BUS_ADDRESS);
  expect(first.sessionEnv.XDG_RUNTIME_DIR).not.toBe(firstRuntime);
  expect(second.sessionEnv.XDG_RUNTIME_DIR).not.toBe(secondRuntime);

  await first.stop();
  expect((await second.capture()).mediaType).toBe("image/png");
  await second.stop();
  expect(existsSync(sharedProfile)).toBeTrue();
  await adapter.destroy(SURFACE_A);
  await adapter.destroy(SURFACE_B);
});

test("shared compositor exit reports the same infrastructure failure to every Screen", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-shared-exit-"));
  const bin = path.join(root, "bin");
  const png = path.join(root, "screen.png");
  const swayPid = path.join(root, "sway.pid");
  mkdirSync(bin);
  writeFileSync(png, SCREEN_PNG);
  const bins = installFakeSwayBins(bin, { png, swayPid });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });
  const first = await adapter.start(provision(SURFACE_A));
  const second = await adapter.start(provision(SURFACE_B));
  try {
    process.kill(Number(readFileSync(swayPid, "utf8")), "SIGTERM");
    await expect(Promise.all([first.outcome, second.outcome])).resolves.toEqual([
      expect.objectContaining({ type: "compositor-exited" }),
      expect.objectContaining({ type: "compositor-exited" }),
    ]);
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
  }
});

test("Sway capture and private input succeed while missing WayVNC rejects expanded view", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-actions-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const bins = installFakeSwayBins(bin, { png });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });

  const runtime = await adapter.start(provision(SURFACE_A));
  const captureResult = await runtime.capture();
  expect(captureResult.mediaType).toBe("image/png");
  expect(captureResult.bytes.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const stream = await runtime.openCaptureStream();
  await stream.close();
  await expect(runtime.listWindows()).resolves.toEqual([]);
  await expect(runtime.acquireExpandedView()).rejects.toThrow("WayVNC executable is unavailable");
  await runtime.setInputAuthority(1);
  const context = {
    surfaceId: SURFACE_A,
    runtimeGeneration: runtime.generation,
    geometryGeneration: 7,
    controllerEpoch: 1,
  };
  await runtime.input({ ...context, sequence: 1, type: "motion", x: 10, y: 20 });
  await runtime.input({
    ...context,
    sequence: 2,
    type: "button",
    x: 10,
    y: 20,
    button: "left",
    state: "pressed",
  });
  await runtime.input({ ...context, sequence: 3, type: "scroll", x: 10, y: 20, deltaX: 0, deltaY: -120 });
  await runtime.input({ ...context, sequence: 4, type: "key", keyCode: 28, state: "pressed" });
  await runtime.input({ ...context, sequence: 5, type: "paste", text: "Sway paste" });
  await runtime.releaseInput(1);
  expect(runtime.readiness.desktopSurface).toBe("ready");
  await runtime.stop();
  await adapter.destroy(SURFACE_A);
});

test("Sway dependency and socket-path failures leave no Surface runtime or profile tree", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-preflight-"));
  const missing = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: path.join(root, "missing-sway"),
  });
  await expect(missing.start(provision(SURFACE_A))).rejects.toThrow("Sway executable is unavailable");
  expect(existsSync(path.join(root, "runtime", SURFACE_A))).toBeFalse();
  expect(existsSync(path.join(root, "profiles", SURFACE_A))).toBeFalse();

  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const swayStarted = path.join(root, "sway-started");
  const bins = installFakeSwayBins(bin, { png });
  writeFileSync(bins.sway, `#!/bin/sh\ntouch ${JSON.stringify(swayStarted)}\nexit 0\n`);
  chmodSync(bins.sway, 0o700);
  const overlong = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "x".repeat(80)),
    profileRoot: path.join(root, "profiles-long"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });
  await expect(overlong.start(provision(SURFACE_A))).rejects.toThrow("runtime path is too long for a private Wayland socket");
  expect(existsSync(swayStarted)).toBeFalse();
  expect(existsSync(path.join(root, "x".repeat(80), SURFACE_A))).toBeFalse();
});

test("Sway mid-start failure removes the partial tree and a desktop exit reports outcome", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-failure-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const desktopPid = path.join(root, "bot-desktop-pid");
  const bins = installFakeSwayBins(bin, { png, desktopPid });
  const failingGrim = executable(bin, "failing-grim", "#!/bin/sh\necho capture failed >&2\nexit 1\n");
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: failingGrim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });
  await expect(adapter.start(provision(SURFACE_A))).rejects.toThrow("Sway Bot Screen capture failed");
  expect(existsSync(path.join(root, "runtime", SURFACE_A))).toBeFalse();
  expect(existsSync(path.join(root, "profiles", SURFACE_A))).toBeFalse();

  const ready = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });
  const runtime = await ready.start(provision(SURFACE_A));
  const outcome = runtime.outcome;
  process.kill(Number(readFileSync(desktopPid, "utf8")), "SIGTERM");
  await expect(outcome).resolves.toMatchObject({
    type: "desktop-exited",
    error: expect.objectContaining({ message: expect.stringContaining("Bot Desktop exited") }),
  });
  const profileDir = path.join(root, "profiles", "computer");
  await runtime.stop();
  expect(existsSync(path.join(root, "runtime", SURFACE_A))).toBeFalse();
  expect(existsSync(profileDir)).toBeTrue();
  await ready.destroy(SURFACE_A);
  expect(existsSync(profileDir)).toBeTrue();
});

test("WayVNC crash does not stop the Sway runtime", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-wayvnc-crash-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const bins = installFakeSwayBins(bin, { png });
  const wayvncStarts = path.join(root, "wayvnc-starts");
  writeFileSync(wayvncStarts, "");
  const wayvncExit = path.join(root, "wayvnc-exit");
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
    wayvncBin: createFakeWayvncBin(bin, {
      startsPath: wayvncStarts,
      argvPath: path.join(root, "wayvnc-argv"),
      envPath: path.join(root, "wayvnc-env"),
      exitPath: wayvncExit,
    }),
  });
  const runtime = await adapter.start(provision(SURFACE_A));
  let stops = 0;
  const stop = runtime.stop.bind(runtime);
  runtime.stop = async () => {
    stops += 1;
    await stop();
  };
  const view = await runtime.acquireExpandedView();
  await view.receive();
  writeFileSync(wayvncExit, "1\n");
  await expect(view.receive()).rejects.toThrow(/WayVNC/);
  expect(stops).toBe(0);
  expect(runtime.readiness.compositor).toBe("ready");
  expect((await runtime.capture()).mediaType).toBe("image/png");
  await runtime.stop();
  await adapter.destroy(SURFACE_A);
});

test("follows Sway when it binds wayland-1 instead of wayland-0", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-wayland-1-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const bins = installFakeSwayBins(bin, { png, waylandDisplay: "wayland-1" });
  const wayvncStarts = path.join(root, "wayvnc-starts");
  writeFileSync(wayvncStarts, "");
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
    wayvncBin: createFakeWayvncBin(bin, {
      startsPath: wayvncStarts,
      argvPath: path.join(root, "wayvnc-argv"),
      envPath: path.join(root, "wayvnc-env"),
      exitPath: path.join(root, "wayvnc-exit"),
    }),
  });
  const runtime = await adapter.start(provision(SURFACE_A));
  const computerRuntime = runtime.sessionEnv.XDG_RUNTIME_DIR;
  expect(runtime.sessionEnv.WAYLAND_DISPLAY).toBe("wayland-1");
  expect(existsSync(path.join(computerRuntime!, "wayland-1"))).toBeTrue();
  expect(existsSync(path.join(computerRuntime!, "wayland-0"))).toBeFalse();
  const view = await runtime.acquireExpandedView();
  expect(readFileSync(path.join(root, "wayvnc-env"), "utf8")).toContain("WAYLAND_DISPLAY=wayland-1");
  await view.close();
  await runtime.stop();
  await adapter.destroy(SURFACE_A);
});

test("a desktop exit fails only that Sway Screen and leaves the sibling runtime", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-desktop-sibling-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const desktopPid = path.join(root, "desktop-a.pid");
  const bins = installFakeSwayBins(bin, { png, desktopPid });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  });
  const affected = await adapter.start(provision(SURFACE_A));
  const affectedPid = Number(readFileSync(desktopPid, "utf8"));
  const sibling = await adapter.start(provision(SURFACE_B));
  const outcome = affected.outcome;
  process.kill(affectedPid, "SIGTERM");
  await expect(outcome).resolves.toMatchObject({
    type: "desktop-exited",
  });
  expect(sibling.readiness.compositor).toBe("ready");
  expect((await sibling.capture()).mediaType).toBe("image/png");
  expect(existsSync(path.join(root, "runtime", SURFACE_B, String(sibling.generation)))).toBeTrue();
  await affected.stop();
  await sibling.stop();
  await adapter.destroy(SURFACE_A);
  await adapter.destroy(SURFACE_B);
});

test("a fresh adapter reattaches a persisted live Sway tree without spawning a second compositor", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-disk-reattach-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const swayStarts = path.join(root, "sway-starts");
  writeFileSync(swayStarts, "");
  const wayvncStarts = path.join(root, "wayvnc-starts");
  writeFileSync(wayvncStarts, "");
  const wayvnc = createFakeWayvncBin(bin, {
    startsPath: wayvncStarts,
    argvPath: path.join(root, "wayvnc-argv"),
    envPath: path.join(root, "wayvnc-env"),
    exitPath: path.join(root, "wayvnc-exit"),
  });
  const bins = installFakeSwayBins(bin, { png });
  const realSway = path.join(bin, "sway.real");
  writeFileSync(realSway, readFileSync(bins.sway));
  chmodSync(realSway, 0o700);
  writeFileSync(bins.sway, `#!/bin/sh
printf '1\\n' >> ${JSON.stringify(swayStarts)}
exec ${JSON.stringify(realSway)} "$@"
`);
  chmodSync(bins.sway, 0o700);
  const options = {
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
    wayvncBin: wayvnc,
  };
  const first = new SwayBotScreenRuntimeAdapter(options);
  const started = await first.start(provision(SURFACE_A));
  expect(readFileSync(swayStarts, "utf8").trim().split("\n")).toHaveLength(1);
  expect((await started.capture()).mediaType).toBe("image/png");
  const staleView = await started.acquireExpandedView();
  await expect(staleView.receive()).resolves.toEqual(expect.any(Uint8Array));
  const staleWayvncSocket = path.join(root, "runtime", `wv-${SURFACE_A.slice("surf_".length)}.sock`);
  expect(existsSync(staleWayvncSocket)).toBeTrue();
  const second = new SwayBotScreenRuntimeAdapter(options);
  const recovered = await second.reconcile(provision(SURFACE_A));
  expect(recovered).toBeDefined();
  expect(existsSync(staleWayvncSocket)).toBeFalse();
  await staleView.close();
  expect(recovered!.readiness).toMatchObject({
    compositor: "ready",
    waylandSocket: "private",
    desktopSurface: "ready",
    capture: "ready",
    input: "ready",
  });
  expect(readFileSync(swayStarts, "utf8").trim().split("\n")).toHaveLength(1);
  expect(recovered!.generation).toBe(started.generation);
  expect((await recovered!.capture()).mediaType).toBe("image/png");
  expect(existsSync(path.join(root, "runtime", SURFACE_A, String(started.generation)))).toBeTrue();
  await recovered!.stop();
  expect(existsSync(path.join(root, "runtime", SURFACE_A))).toBeFalse();
  expect(existsSync(path.join(root, "profiles", "computer"))).toBeTrue();
  await second.destroy(SURFACE_A);
});

test("a replacement Screen does not take an output a live unreconciled Screen still owns", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-retained-output-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const bins = installFakeSwayBins(bin, { png });
  const options = {
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway,
    wlrRandrBin: bins.wlrRandr,
    grimBin: bins.grim,
    inputHelperBin: bins.input,
    captureHelperBin: bins.capture,
    botDesktopBin: bins.desktop,
  };
  const first = new SwayBotScreenRuntimeAdapter(options);
  const retained = await first.start(provision(SURFACE_A));

  // A second adapter sees the first Screen's live desktop on disk but has not reattached it yet.
  const second = new SwayBotScreenRuntimeAdapter(options);
  const replacement = await second.start(provision(SURFACE_B));
  expect(replacement.generation).toBe(retained.generation);
  const retainedState = JSON.parse(
    readFileSync(
      path.join(root, "runtime", SURFACE_A, String(retained.generation), "surface.json"),
      "utf8",
    ),
  ) as { outputName: string };
  const replacementState = JSON.parse(
    readFileSync(
      path.join(root, "runtime", SURFACE_B, String(replacement.generation), "surface.json"),
      "utf8",
    ),
  ) as { outputName: string };
  expect(replacementState.outputName).not.toBe(retainedState.outputName);

  await replacement.stop();
  await retained.stop();
  await second.destroy(SURFACE_B);
  await first.destroy(SURFACE_A);
});

const realSway = process.env.OMARCHY_BOT_REAL_SWAY === "1" ? test : test.skip;
realSway("real pinned Sway delivers an RFB banner through acquireExpandedView", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "obw-"));
  const supply = new PortableSwayRuntimeSupply({
    rootDir: process.env.OMARCHY_BOT_SWAY_SUPPLY_DIR
      ?? path.join(os.tmpdir(), "omarchy-bot-sway-runtime-supply"),
  });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    runtimeSupply: supply,
  });
  const runtime = await adapter.start({
    ...provision(SURFACE_A),
    logicalWidth: 1280,
    logicalHeight: 720,
    refreshRate: 30,
  });
  expect(runtime.sessionEnv.WAYLAND_DISPLAY).toMatch(/^wayland-[1-9]\d*$/);
  try {
    const view = await runtime.acquireExpandedView();
    const banner = await Promise.race([
      view.receive(),
      Bun.sleep(5_000).then(() => {
        throw new Error("RFB receive timed out");
      }),
    ]);
    expect(banner.subarray(0, 3)).toEqual(new Uint8Array([0x52, 0x46, 0x42]));
    await view.close();
  } catch (error) {
    throw new Error(
      `real WayVNC failed WAYLAND_DISPLAY=${runtime.sessionEnv.WAYLAND_DISPLAY} XDG_RUNTIME_DIR=${runtime.sessionEnv.XDG_RUNTIME_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await runtime.stop();
    await adapter.destroy(SURFACE_A);
  }
}, 30_000);

realSway("daemon-wrapped real Sway projection source delivers an RFB banner", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "obd-"));
  const supply = new PortableSwayRuntimeSupply({
    rootDir: process.env.OMARCHY_BOT_SWAY_SUPPLY_DIR
      ?? path.join(os.tmpdir(), "omarchy-bot-sway-runtime-supply"),
  });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "r"),
    profileRoot: path.join(root, "screens"),
    runtimeSupply: supply,
  });
  const harness = await startDaemon(root, {
    botScreenAdapter: adapter,
    botScreenCapacity: 1,
  });
  try {
    const botId = await makeBot(harness, "Real Sway RFB source");
    const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
    const owner = { botId, surfaceId: bot.surfaceId };
    await waitScreenReady(harness, owner);
    const source = await harness.svc.screens.projectionSource(owner);
    if (source === undefined) throw new Error("projection source missing");
    expect(source.expandedProjection).toBe("rfb");
    const view = await source.acquireExpandedView();
    const banner = await Promise.race([
      view.receive(),
      Bun.sleep(5_000).then(() => {
        throw new Error("daemon-wrapped RFB receive timed out");
      }),
    ]);
    expect(banner.subarray(0, 3)).toEqual(new Uint8Array([0x52, 0x46, 0x42]));
    await view.close();
  } finally {
    await harness.stop();
  }
}, 40_000);

realSway("WebSocket expanded view negotiates a real WayVNC RFB session", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "obp-"));
  const supply = new PortableSwayRuntimeSupply({
    rootDir: process.env.OMARCHY_BOT_SWAY_SUPPLY_DIR
      ?? path.join(os.tmpdir(), "omarchy-bot-sway-runtime-supply"),
  });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "r"),
    profileRoot: path.join(root, "screens"),
    runtimeSupply: supply,
  });
  const harness = await startDaemon(root, {
    botScreenAdapter: adapter,
    botScreenCapacity: 1,
  });
  let peer: ProjectionClient | undefined;
  let owner: { botId: string; surfaceId: SurfaceId } | undefined;
  try {
    const botId = await makeBot(harness, "Real Sway RFB WebSocket");
    const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
    owner = { botId, surfaceId: bot.surfaceId };
    await waitScreenReady(harness, owner);
    peer = await ProjectionClient.connect(harness.baseUrl, owner, "real-sway-rfb-websocket");
    await peer.setMode("expanded");
    expect(peer.rfb?.serverInit).toMatchObject({
      width: peer.session.videoWidth,
      height: peer.session.videoHeight,
    });
  } catch (error) {
    const diagnostic = owner === undefined || peer === undefined
      ? undefined
      : harness.svc.projections.failureDiagnostic(owner, peer.session.sessionId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(diagnostic)}`,
    );
  } finally {
    if (peer !== undefined) await peer.close();
    await harness.stop();
  }
}, 40_000);

realSway("WebSocket RFB survives preview teardown before expand", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "obp-"));
  const supply = new PortableSwayRuntimeSupply({
    rootDir: process.env.OMARCHY_BOT_SWAY_SUPPLY_DIR
      ?? path.join(os.tmpdir(), "omarchy-bot-sway-runtime-supply"),
  });
  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "r"),
    profileRoot: path.join(root, "screens"),
    runtimeSupply: supply,
  });
  const harness = await startDaemon(root, {
    botScreenAdapter: adapter,
    botScreenCapacity: 1,
  });
  let preview: ProjectionClient | undefined;
  let expanded: ProjectionClient | undefined;
  let owner: { botId: string; surfaceId: SurfaceId } | undefined;
  try {
    const botId = await makeBot(harness, "Real Sway preview then RFB");
    const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
    owner = { botId, surfaceId: bot.surfaceId };
    await waitScreenReady(harness, owner);
    await harness.svc.computer.agentToolAct(
      owner,
      "turn_preview_then_rfb",
      "turn_preview_then_rfb",
      { name: "click", args: { x: 40, y: 50 } },
      new AbortController().signal,
    );
    preview = await ProjectionClient.connect(harness.baseUrl, owner, "real-sway-preview-then-rfb");
    await preview.setMode("preview");
    await preview.waitForPreviewFrame(0, 8_000);
    await preview.close();
    preview = undefined;
    expanded = await ProjectionClient.connect(harness.baseUrl, owner, "real-sway-expand-after-preview");
    await expanded.setMode("expanded");
    expect(expanded.rfb?.serverInit).toMatchObject({
      width: expanded.session.videoWidth,
      height: expanded.session.videoHeight,
    });
  } catch (error) {
    const diagnostic = owner === undefined || expanded === undefined
      ? undefined
      : harness.svc.projections.failureDiagnostic(owner, expanded.session.sessionId);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(diagnostic)}`,
    );
  } finally {
    if (preview !== undefined) await preview.close();
    if (expanded !== undefined) await expanded.close();
    await harness.stop();
  }
}, 40_000);

test("partial Sway startup is not Cage and private orphan processes are cleaned", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "ob-partial-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const png = path.join(root, "screen.png");
  writeFileSync(png, SCREEN_PNG);
  const bins = installFakeSwayBins(bin, { png });
  const options = {
    runtimeRoot: path.join(root, "r"), profileRoot: path.join(root, "profiles"),
    swayBin: bins.sway, wlrRandrBin: bins.wlrRandr, grimBin: bins.grim,
    inputHelperBin: bins.input, captureHelperBin: bins.capture, botDesktopBin: bins.desktop,
  };
  // Hold startup before Desktop readiness/session.json, after the compositor binds.
  const desktopEntered = path.join(root, "desktop-entered");
  writeFileSync(bins.desktop, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(desktopEntered)}\nexec sleep 3600\n`);
  const adapter = new SwayBotScreenRuntimeAdapter(options);
  const starting = adapter.start(provision(SURFACE_A)).then(() => "ready", () => "failed");
  try {
    const deadline = Date.now() + 3_000;
    while (!existsSync(desktopEntered)) {
      if (Date.now() > deadline) throw new Error("partial startup never reached Desktop");
      await Bun.sleep(10);
    }
    const computerState: unknown = JSON.parse(
      readFileSync(path.join(options.runtimeRoot, "computer", "computer.json"), "utf8"),
    );
    if (typeof computerState !== "object" || computerState === null || !("generation" in computerState)) {
      throw new Error("Bot Computer state has no generation");
    }
    const computerGeneration = computerState.generation;
    expect(typeof computerGeneration).toBe("number");
    const runtimeDir = path.join(options.runtimeRoot, SURFACE_A, String(computerGeneration));
    expect(existsSync(path.join(runtimeDir, "session.json"))).toBeFalse();
    const recovered = new SwayBotScreenRuntimeAdapter(options);
    expect(await recovered.reconcile(provision(SURFACE_A))).toBeUndefined();
    expect(await starting).toBe("failed");
    expect(existsSync(runtimeDir)).toBeFalse();
  } finally {
    await starting;
    await adapter.destroy(SURFACE_A);
  }
}, 15_000);
