import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotComputerRuntime } from "../../apps/daemon/src/modules/computer/botComputer.ts";
import type { SwayRuntimeBinaries } from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";
import { writeFakeSwayIpcMode, writeFakeSwayTree } from "./helpers/fakeSwayIpc.ts";

interface FakeComputerBins {
  sway: string;
  swayStarts: string;
  wlrRandr: string;
  grim: string;
  input: string;
  capture: string;
  desktop: string;
  dbusDaemon: string;
}

interface ComputerState {
  generation: number;
  swayPid: number;
  dbusPid: number;
}

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

function installFakeComputerBins(directory: string): FakeComputerBins {
  mkdirSync(directory);
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
  const swayStarts = path.join(directory, "sway-starts");
  const sway = executable(directory, "sway", `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
appendFileSync(${JSON.stringify(swayStarts)}, "start\\n");
writeFileSync(${JSON.stringify(path.join(directory, "sway-env"))}, process.env.WLR_XWAYLAND ?? "");
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
const wayland = path.join(runtimeDir, "wayland-0");
const swaySock = process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock");
Bun.listen({ unix: wayland, socket: { data() {} } });
await serveFakeSwayIpc({
  socketPath: swaySock,
  controlDir: ${JSON.stringify(controlDir)},
});
`);
  const dbusDaemon = executable(directory, "dbus-daemon", `#!/usr/bin/env bun
const address = process.argv.find((argument) => argument.startsWith("--address=")) ?? "";
const socketPath = address.slice("--address=".length).replace("unix:path=", "");
Bun.listen({ unix: socketPath, socket: { data() {} } });
await new Promise(() => {});
`);
  return {
    sway,
    swayStarts,
    wlrRandr: executable(directory, "wlr-randr", "#!/bin/sh\nexit 0\n"),
    grim: executable(directory, "grim", "#!/bin/sh\nexit 1\n"),
    input: executable(directory, "input", "#!/bin/sh\nwhile :; do sleep 60; done\n"),
    capture: executable(directory, "capture", "#!/bin/sh\nwhile :; do sleep 60; done\n"),
    desktop: executable(directory, "bot-desktop", "#!/bin/sh\nprintf 'READY %s %s\\n' \"$1\" \"$2\"\nwhile :; do sleep 60; done\n"),
    dbusDaemon,
  };
}

function computerOptions(bin: FakeComputerBins) {
  return {
    runtimeRoot: path.join(root!, "runtime"),
    profileRoot: path.join(root!, "profiles"),
    swayBin: bin.sway,
    wlrRandrBin: bin.wlrRandr,
    grimBin: bin.grim,
    inputHelperBin: bin.input,
    captureHelperBin: bin.capture,
    botDesktopBin: bin.desktop,
    dbusDaemonBin: bin.dbusDaemon,
  };
}

test("passes a configured Xwayland override to the compositor without a supply", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-xwayland-"));
  const bin = installFakeComputerBins(path.join(root, "bin"));
  const xwayland = executable(path.dirname(bin.sway), "Xwayland", "#!/bin/sh\nexit 0\n");
  const runtime = new BotComputerRuntime({ ...computerOptions(bin), xwaylandBin: xwayland });

  const computer = await runtime.ensure();
  try {
    expect(computer.childEnv.DISPLAY).toBeUndefined();
    expect(readFileSync(path.join(path.dirname(bin.sway), "sway-env"), "utf8")).toBe(xwayland);
  } finally {
    await runtime.stop();
  }
});

test("rejects an unavailable Xwayland override without a supply", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-xwayland-missing-"));
  const bin = installFakeComputerBins(path.join(root, "bin"));
  const runtime = new BotComputerRuntime({
    ...computerOptions(bin),
    xwaylandBin: path.join(root, "missing", "Xwayland"),
  });

  await expect(runtime.ensure()).rejects.toThrow(
    `configured Xwayland executable is unavailable: ${path.join(root, "missing", "Xwayland")}`,
  );
  expect(existsSync(bin.swayStarts)).toBeFalse();
});

function readComputerState(): ComputerState {
  const stateFile = path.join(root!, "runtime", "computer", "computer.json");
  return JSON.parse(readFileSync(stateFile, "utf8")) as ComputerState;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("ensure starts one computer and a second ensure reuses the same generation", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-"));
  const bin = installFakeComputerBins(path.join(root, "bin"));
  const runtime = new BotComputerRuntime(computerOptions(bin));

  const first = await runtime.ensure();
  const state = readComputerState();
  expect(state.generation).toBe(first.generation);
  expect(first.running()).toBeTrue();
  expect(existsSync(path.join(first.runtimeDir, "wayland-0"))).toBeTrue();

  const second = await runtime.ensure();
  expect(second).toBe(first);
  expect(second.generation).toBe(first.generation);
  expect(readComputerState().generation).toBe(first.generation);
  expect(alive(state.swayPid)).toBeTrue();
  expect(readFileSync(bin.swayStarts, "utf8").trim().split("\n")).toHaveLength(1);

  await runtime.stop();
});

test("a fresh runtime reattaches the live computer at the same generation and profile", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-"));
  const bin = installFakeComputerBins(path.join(root, "bin"));
  const first = new BotComputerRuntime(computerOptions(bin));
  const started = await first.ensure();
  const state = readComputerState();

  const second = new BotComputerRuntime(computerOptions(bin));
  const reattached = await second.ensure();
  expect(reattached.generation).toBe(started.generation);
  expect(reattached.generation).toBe(state.generation);
  expect(reattached.profileDir).toBe(started.profileDir);
  expect(reattached.runtimeDir).toBe(started.runtimeDir);
  expect(reattached.running()).toBeTrue();
  expect(alive(state.swayPid)).toBeTrue();
  expect(readComputerState().generation).toBe(state.generation);

  await second.stop();
});

test("ensure discards the recorded computer and starts fresh when the compositor is gone", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-"));
  const bin = installFakeComputerBins(path.join(root, "bin"));
  const first = new BotComputerRuntime(computerOptions(bin));
  const started = await first.ensure();
  const state = readComputerState();

  process.kill(state.swayPid, "SIGKILL");
  await started.exited();
  expect(alive(state.swayPid)).toBeFalse();

  const second = new BotComputerRuntime(computerOptions(bin));
  const restarted = await second.ensure();
  expect(restarted.running()).toBeTrue();
  expect(restarted.generation).not.toBe(started.generation);
  expect(readComputerState().generation).toBe(restarted.generation);
  expect(existsSync(path.join(root, "runtime", "computer", String(started.generation)))).toBeFalse();
  expect(restarted.profileDir).toBe(started.profileDir);

  await second.stop();
});

test("invalid shared state removes private orphans without terminating unrelated processes", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-orphan-"));
  const runtimeComputerDir = path.join(root, "runtime", "computer");
  const orphanRuntimeDir = path.join(runtimeComputerDir, "123");
  mkdirSync(orphanRuntimeDir, { recursive: true });
  writeFileSync(path.join(runtimeComputerDir, "computer.json"), JSON.stringify({ generation: 123 }));
  const orphan = Bun.spawn(["sleep", "3600"], {
    env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: orphanRuntimeDir },
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  const victim = Bun.spawn(["sleep", "3600"], {
    env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: path.join(root, "victim") },
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  const runtime = new BotComputerRuntime(computerOptions(installFakeComputerBins(path.join(root, "bin"))));
  try {
    expect(await runtime.reattach()).toBeUndefined();
    expect(await Promise.race([
      orphan.exited.then(() => "exited"),
      Bun.sleep(1_000).then(() => "alive"),
    ])).toBe("exited");
    expect(await Promise.race([
      victim.exited.then(() => "exited"),
      Bun.sleep(50).then(() => "alive"),
    ])).toBe("alive");
    expect(existsSync(runtimeComputerDir)).toBeFalse();
  } finally {
    if (orphan.exitCode === null) orphan.kill("SIGKILL");
    if (victim.exitCode === null) victim.kill("SIGKILL");
    await Promise.all([orphan.exited, victim.exited]);
  }
});

test("stop terminates the compositor and session bus and clears current", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-"));
  const bin = installFakeComputerBins(path.join(root, "bin"));
  const runtime = new BotComputerRuntime(computerOptions(bin));
  await runtime.ensure();
  const state = readComputerState();

  await runtime.stop();

  expect(runtime.current()).toBeUndefined();
  expect(alive(state.swayPid)).toBeFalse();
  expect(alive(state.dbusPid)).toBeFalse();
  expect(existsSync(path.join(root, "runtime", "computer"))).toBeFalse();
});


function installBundleBins(
  root: string,
  swayBody: string,
): { bundleRoot: string; binDir: string; binaries: SwayRuntimeBinaries } {
  const bundleRoot = path.join(root, "bundle");
  const binDir = path.join(bundleRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(bundleRoot, "share", "X11", "xkb"), { recursive: true });
  const launchers: Record<string, string> = {
    sway: swayBody,
    "dbus-daemon": `#!/usr/bin/env bun
const address = process.argv.find((argument) => argument.startsWith("--address=")) ?? "";
Bun.listen({ unix: address.slice("--address=".length).replace("unix:path=", ""), socket: { data() {} } });
await new Promise(() => {});
`,
    grim: "#!/bin/sh\nexit 1\n",
    "omarchy-bot-wayland-input": "#!/bin/sh\nwhile :; do sleep 60; done\n",
    "omarchy-bot-wayland-capture": "#!/bin/sh\nwhile :; do sleep 60; done\n",
    "omarchy-bot-desktop": "#!/bin/sh\nprintf 'READY %s %s\\n' \"$1\" \"$2\"\nwhile :; do sleep 60; done\n",
  };
  for (const name of [
    "sway",
    "swaymsg",
    "wayvnc",
    "wlr-randr",
    "Xwayland",
    "grim",
    "dbus-daemon",
    "omarchy-bot-wayland-input",
    "omarchy-bot-wayland-capture",
    "omarchy-bot-desktop",
  ]) {
    executable(binDir, name, launchers[name] ?? "#!/bin/sh\nexit 0\n");
  }
  return {
    bundleRoot,
    binDir,
    binaries: {
      swayBin: path.join(binDir, "sway"),
      swaymsgBin: path.join(binDir, "swaymsg"),
      wayvncBin: path.join(binDir, "wayvnc"),
      wlrRandrBin: path.join(binDir, "wlr-randr"),
      xwaylandBin: path.join(binDir, "Xwayland"),
      grimBin: path.join(binDir, "grim"),
      dbusDaemonBin: path.join(binDir, "dbus-daemon"),
      inputHelperBin: path.join(binDir, "omarchy-bot-wayland-input"),
      captureHelperBin: path.join(binDir, "omarchy-bot-wayland-capture"),
      botDesktopBin: path.join(binDir, "omarchy-bot-desktop"),
    },
  };
}

function fakeBundleSway(root: string, recordDisplay: string): string {
  const controlDir = path.join(root, "ipc-control");
  mkdirSync(controlDir, { recursive: true });
  writeFakeSwayTree(controlDir, { id: 1, type: "root", name: "root", nodes: [], floating_nodes: [] });
  writeFakeSwayIpcMode(controlDir, "ok");
  const helperPath = path.resolve(import.meta.dir, "helpers/fakeSwayIpc.ts");
  return `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
${recordDisplay}
Bun.listen({ unix: path.join(runtimeDir, "wayland-0"), socket: { data() {} } });
await serveFakeSwayIpc({ socketPath: process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock"), controlDir: ${JSON.stringify(controlDir)} });
`;
}

function bundleRuntime(root: string, binaries: SwayRuntimeBinaries): BotComputerRuntime {
  return new BotComputerRuntime({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    runtimeSupply: { ensure: async () => binaries },
  });
}

test("takes every runtime tool from the bundle and exports its launchers and DISPLAY", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-bundle-"));
  const bundle = installBundleBins(
    root,
    fakeBundleSway(root, 'writeFileSync(path.join(runtimeDir, "x11-display"), ":99");'),
  );
  const runtime = bundleRuntime(root, bundle.binaries);

  const computer = await runtime.ensure();
  try {
    expect(computer.grim).toBe(bundle.binaries.grimBin);
    expect(computer.inputHelper).toBe(bundle.binaries.inputHelperBin);
    expect(computer.captureHelper).toBe(bundle.binaries.captureHelperBin);
    expect(computer.botDesktop).toBe(bundle.binaries.botDesktopBin);
    expect(computer.wlrRandr).toBe(bundle.binaries.wlrRandrBin);
    expect(computer.childEnv.PATH!.split(":")[0]).toBe(bundle.binDir);
    expect(computer.childEnv.DISPLAY).toBe(":99");
    expect(computer.childEnv.XKB_CONFIG_ROOT!).toBe(path.join(bundle.bundleRoot, "share", "X11", "xkb"));
  } finally {
    await runtime.stop();
  }
});

test("waits for a complete private display instead of accepting a partial file", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-display-"));
  const bundle = installBundleBins(
    root,
    fakeBundleSway(root, `
const displayFile = path.join(runtimeDir, "x11-display");
writeFileSync(displayFile, "");
setTimeout(() => writeFileSync(displayFile, ":1"), 150);`),
  );
  const runtime = bundleRuntime(root, bundle.binaries);

  const computer = await runtime.ensure();
  try {
    expect(computer.childEnv.DISPLAY!).toBe(":1");
  } finally {
    await runtime.stop();
  }
});

test("fails startup when bundle Xwayland never records a private display", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-no-display-"));
  const bundle = installBundleBins(
    root,
    fakeBundleSway(root, 'writeFileSync(path.join(runtimeDir, "x11-display"), "");'),
  );
  const runtime = bundleRuntime(root, bundle.binaries);

  await expect(runtime.ensure()).rejects.toThrow(
    "Bot Computer Xwayland did not record a private DISPLAY",
  );
  expect(existsSync(path.join(root, "runtime", "computer"))).toBeFalse();
}, 20_000);

test("reattaching a bundle computer without its private display reprovisions", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-computer-reattach-display-"));
  const bundle = installBundleBins(
    root,
    fakeBundleSway(root, 'writeFileSync(path.join(runtimeDir, "x11-display"), ":42");'),
  );
  const first = bundleRuntime(root, bundle.binaries);
  const computer = await first.ensure();
  try {
    const displayFile = path.join(computer.runtimeDir, "x11-display");
    writeFileSync(displayFile, "garbage");
    expect(await bundleRuntime(root, bundle.binaries).reattach()).toBeUndefined();
    expect(existsSync(computer.runtimeDir)).toBeFalse();

    const provisioned = await bundleRuntime(root, bundle.binaries).ensure();
    try {
      expect(provisioned.generation).not.toBe(computer.generation);
      expect(provisioned.childEnv.DISPLAY!).toBe(":42");
    } finally {
      await provisioned.stop();
    }
  } finally {
    await first.stop().catch(() => {});
  }
}, 20_000);
