import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BotComputerRuntime } from "../../apps/daemon/src/modules/computer/botComputer.ts";
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
import { appendFileSync } from "node:fs";
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
appendFileSync(${JSON.stringify(swayStarts)}, "start\\n");
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
