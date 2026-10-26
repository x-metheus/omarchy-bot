import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { SwayBotScreenRuntimeAdapter } from "../../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import type {
  BotScreenProvision,
  BotScreenRuntimeAdapter,
} from "../../../apps/daemon/src/modules/computer/botScreenManager.ts";
import type { ComputerWindowListItem } from "../../../packages/agent-contract/src/computer-protocol.ts";
import { writeFakeSwayIpcMode, writeFakeSwayTree } from "./fakeSwayIpc.ts";
import { createFixtureAssetSupply } from "./botComputerAssetsFixture.ts";
import { SWAY_RUNTIME_BUNDLE, SWAY_RUNTIME_RELEASE } from "../../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";

const LIVE_UNICODE_TITLE = "未保存 你好";

/** The single toplevel every scripted Sway Screen routes, in Screen coordinates. */
export function scriptedSwayWindows(surfaceId: string): ComputerWindowListItem[] {
  return [{
    id: "10",
    title: LIVE_UNICODE_TITLE,
    appId: "firefox",
    pid: 1001,
    focused: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workspace: `bot-${surfaceId}`,
    clientType: "wayland",
  }];
}


function liveSwayTree(title: string, surfaceIds: readonly string[]): unknown {
  return {
    id: 1,
    type: "root",
    name: "root",
    nodes: surfaceIds.map((surfaceId, index) => ({
      id: 2 + index * 3,
      type: "output",
      name: `HEADLESS-${index + 1}`,
      nodes: [{
        id: 3 + index * 3,
        type: "workspace",
        name: `bot-${surfaceId}`,
        nodes: [{
          id: 10 + index,
          type: "con",
          name: title,
          app_id: "firefox",
          pid: 1001 + index,
          focused: index === 0,
          shell: "xdg_shell",
          rect: { x: index * 8_192, y: 0, width: 800, height: 600 },
        }],
        floating_nodes: [],
      }],
    })),
    floating_nodes: [],
  };
}

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

export interface ScriptedSwayFixture {
  adapter: BotScreenRuntimeAdapter;
  runtimeRoot: string;
  profileRoot: string;
  starts: BotScreenProvision[];
  stops: Array<{ surfaceId: string; runtimeGeneration: number }>;
  failSurfacePath: string;
  wayvncBin: string;
  /** Application the scripted Screen can launch. */
  application: string;
  /** The scripted binaries, for a production adapter built outside this fixture. */
  binEnv: Record<string, string>;
  /** Scripted Sway IPC control directory. */
  controlDir: string;
  /** Windows the Screen routes in Screen coordinates, once it has started. */
  windowsFor: (surfaceId: string) => ComputerWindowListItem[];
  advanceLiveProgress: () => void;
  inputCommands: () => string[];
  wayvncStarts: () => number;
  wayvncArgvTokens: () => string[];
  wayvncEnv: () => string[];
  exitWayvnc: () => void;
  exitWayvncFor: (surfaceId: string, generation: number) => void;
  blockActions: () => void;
  waitForActions: (count: number) => Promise<void>;
  releaseActions: () => void;
  dispose: () => void;
}

export function createFakeWayvncBin(directory: string, paths: {
  startsPath: string;
  argvPath: string;
  envPath: string;
  exitPath: string;
}): string {
  return executable(directory, "wayvnc", `#!/usr/bin/env bun
import { appendFileSync, chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
const startsPath = ${JSON.stringify(paths.startsPath)};
const argvPath = ${JSON.stringify(paths.argvPath)};
const envPath = ${JSON.stringify(paths.envPath)};
const exitPath = ${JSON.stringify(paths.exitPath)};
appendFileSync(startsPath, "1\\n");
const tokens = process.argv.slice(2);
writeFileSync(argvPath, tokens.join("\\n") + "\\n");
writeFileSync(envPath, [
  "WAYLAND_DISPLAY=" + (process.env.WAYLAND_DISPLAY ?? ""),
  "XDG_RUNTIME_DIR=" + (process.env.XDG_RUNTIME_DIR ?? ""),
  "SWAYSOCK=" + (process.env.SWAYSOCK ?? ""),
].join("\\n") + "\\n");
if (existsSync(exitPath)) process.exit(1);
const socketPath = (() => {
  const prefixed = tokens.find((token) => token.startsWith("unix:"));
  if (prefixed !== undefined) return prefixed.replace(/^unix:(?:path=)?/, "");
  // --socket <control> precedes the listen path, the last absolute argument.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.startsWith("/") && tokens[i - 1] !== "--output") return token;
  }
  return undefined;
})();
if (socketPath === undefined) {
  await new Promise(() => {});
}
try { unlinkSync(socketPath); } catch {}
Bun.listen({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.write("RFB 003.008\\n");
    },
    data(socket, data) {
      socket.write(data);
    },
  },
});
chmodSync(socketPath, 0o600);
for (;;) {
  if (existsSync(exitPath)) process.exit(1);
  const runtimeExit = path.join(process.env.XDG_RUNTIME_DIR ?? "", "wayvnc-exit");
  if (existsSync(runtimeExit)) process.exit(1);
  await Bun.sleep(20);
}
`);
}

export async function createScriptedSwayFixture(options?: {
  waylandDisplay?: string;
}): Promise<ScriptedSwayFixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-public-"));
  const bin = path.join(root, "bin");
  const runtimeRoot = path.join(root, "runtime");
  const profileRoot = path.join(root, "profiles");
  const failSurfacePath = path.join(root, "fail-surface");
  const controlDir = path.join(root, "ipc-control");
  const wayvncStartsPath = path.join(root, "wayvnc-starts");
  const wayvncArgvPath = path.join(root, "wayvnc-argv");
  const wayvncEnvPath = path.join(root, "wayvnc-env");
  const wayvncExitPath = path.join(root, "wayvnc-exit");
  mkdirSync(bin);
  mkdirSync(controlDir);
  const applicationCwd = path.join(root, "workspace");
  mkdirSync(applicationCwd);
  const application = executable(bin, "fixture-application", `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const tree = JSON.parse(readFileSync(${JSON.stringify(path.join(controlDir, "tree.json"))}, "utf8"));
const workspace = tree.nodes[0]?.nodes?.[0] ?? tree.nodes[0];
workspace.nodes.push({
  id: 900,
  type: "con",
  name: "Contract App",
  app_id: "fixture-application",
  pid: process.pid,
  focused: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(${JSON.stringify(path.join(controlDir, "tree.json"))}, JSON.stringify(tree));
await Promise.withResolvers<void>().promise;
`);
  writeFileSync(wayvncStartsPath, "");
  const wayvnc = createFakeWayvncBin(bin, {
    startsPath: wayvncStartsPath,
    argvPath: wayvncArgvPath,
    envPath: wayvncEnvPath,
    exitPath: wayvncExitPath,
  });
  let liveProgress = 0;
  const activeSurfaces = new Set<string>();
  writeFakeSwayTree(controlDir, liveSwayTree(LIVE_UNICODE_TITLE, []));
  writeFakeSwayIpcMode(controlDir, "ok");
  const png = path.join(root, "screen.png");
  const sharp = createRequire(
    path.resolve(import.meta.dir, "../../../apps/daemon/src/bootstrap/main.ts"),
  )("sharp") as (input: unknown) => { png: () => { toFile: (file: string) => Promise<unknown> } };
  await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  }).png().toFile(png);

  const helperPath = path.resolve(import.meta.dir, "fakeSwayIpc.ts");
  const sway = executable(bin, "sway", `#!/usr/bin/env bun
import path from "node:path";
import { writeFileSync } from "node:fs";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
const wayland = path.join(runtimeDir, ${JSON.stringify(options?.waylandDisplay ?? "wayland-0")});
const swaySock = process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock");
Bun.listen({ unix: wayland, socket: { data() {} } });
if (process.env.OMARCHY_BOT_DISPLAY_FILE !== undefined) {
  writeFileSync(process.env.OMARCHY_BOT_DISPLAY_FILE, ":123");
}
await serveFakeSwayIpc({
  socketPath: swaySock,
  controlDir: ${JSON.stringify(controlDir)},
});
`);
  const swaymsg = executable(bin, "swaymsg", "#!/bin/sh\nexit 0\n");
  const desktop = executable(bin, "bot-desktop", [
    "#!/bin/sh",
    "printf 'READY %s %s\\n' \"$1\" \"$2\"",
    "while :; do sleep 60; done",
    "",
  ].join("\n"));
  const assets = createFixtureAssetSupply({
    directory: path.join(root, "assets"),
    browserScript: (logPath) => `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
await Promise.withResolvers<void>().promise;
`,
  });
  const inner = new SwayBotScreenRuntimeAdapter({
    runtimeRoot,
    profileRoot,
    applicationCwd,
    assetSupply: assets,
    swayBin: sway,
    wlrRandrBin: executable(bin, "wlr-randr", "#!/bin/sh\nexit 0\n"),
    grimBin: executable(bin, "grim", `#!/bin/sh\ncat ${JSON.stringify(png)}\n`),
    inputHelperBin: executable(bin, "input", `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const logPath = ${JSON.stringify(path.join(root, "input.log"))};
process.stdout.write("READY\\n");
const decoder = new TextDecoder();
let buffer = "";
let highestEpoch = 0;
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    appendFileSync(logPath, line + "\\n");
    const parts = line.split(" ");
    const request = parts[1] ?? "0";
    if (parts[0] === "authority") {
      const epoch = Number(parts[parts.length - 1]);
      if (!Number.isSafeInteger(epoch) || epoch <= highestEpoch) {
        process.stdout.write("ERR " + request + " invalid-authority\\n");
        newline = buffer.indexOf("\\n");
        continue;
      }
      highestEpoch = epoch;
    }
    process.stdout.write("OK " + request + "\\n");
    newline = buffer.indexOf("\\n");
  }
}
`),
    captureHelperBin: executable(bin, "capture", "#!/bin/sh\nprintf 'READY\\n'\nwhile read -r command; do [ \"$command\" = close ] && exit 0; done\n"),
    botDesktopBin: desktop,
    wayvncBin: wayvnc,
    onLaunch: async () => {
      actionsStarted += 1;
      const ready = actionWaiters.filter((waiter) => actionsStarted >= waiter.count);
      actionWaiters = actionWaiters.filter((waiter) => actionsStarted < waiter.count);
      for (const waiter of ready) waiter.resolve();
      if (blockActions) await actionGate.promise;
    },
  });
  // A local extracted bundle supplies the two tools omitted from the explicit overrides.
  const bundleDir = path.join(root, "sway");
  const bundleBin = path.join(bundleDir, "bin");
  mkdirSync(bundleBin, { recursive: true });
  for (const [name, source] of Object.entries({
    sway,
    swaymsg,
    wayvnc,
    "wlr-randr": path.join(bin, "wlr-randr"),
    grim: path.join(bin, "grim"),
    "omarchy-bot-wayland-input": path.join(bin, "input"),
    "omarchy-bot-wayland-capture": path.join(bin, "capture"),
    "omarchy-bot-desktop": desktop,
  })) {
    executable(bundleBin, name, `#!/bin/sh\nexec ${JSON.stringify(source)} "$@"\n`);
  }
  executable(bundleBin, "Xwayland", "#!/bin/sh\nexit 0\n");
  executable(bundleBin, "dbus-daemon", `#!/usr/bin/env bun
const address = process.argv.find((arg) => arg.startsWith("--address=unix:path="));
if (address === undefined) throw new Error("missing private session bus address");
Bun.listen({ unix: address.slice("--address=unix:path=".length), socket: { data() {} } });
`);
  writeFileSync(path.join(bundleDir, ".omarchy-bot-runtime"), `${SWAY_RUNTIME_RELEASE}\n${SWAY_RUNTIME_BUNDLE.sha256}\n`);
  const starts: BotScreenProvision[] = [];
  const stops: Array<{ surfaceId: string; runtimeGeneration: number }> = [];
  let blockActions = false;
  let actionGate = Promise.withResolvers<void>();
  let actionsStarted = 0;
  let actionWaiters: Array<{ count: number; resolve: () => void }> = [];
  const updateLiveTree = (): void => {
    const suffix = liveProgress === 0 ? "" : ` · ${liveProgress}`;
    writeFakeSwayTree(controlDir, liveSwayTree(`${LIVE_UNICODE_TITLE}${suffix}`, [...activeSurfaces]));
  };
  const adapter: BotScreenRuntimeAdapter = {
    start: async (provision) => {
      starts.push(provision);
      await Bun.sleep(30);
      if (existsSync(failSurfacePath) && readFileSync(failSurfacePath, "utf8").trim() === provision.surfaceId) {
        throw new Error(`fake Sway Surface provision failed for ${provision.surfaceId}`);
      }
      activeSurfaces.add(provision.surfaceId);
      updateLiveTree();
      try {
        const runtime = await inner.start(provision);
        const stop = runtime.stop.bind(runtime);
        runtime.stop = async () => {
          stops.push({ surfaceId: provision.surfaceId, runtimeGeneration: runtime.generation });
          await stop();
        };
        return runtime;
      } catch (error) {
        activeSurfaces.delete(provision.surfaceId);
        updateLiveTree();
        throw error;
      }
    },
    reconcile: async (provision) => {
      activeSurfaces.add(provision.surfaceId);
      updateLiveTree();
      return inner.reconcile(provision);
    },
    destroy: async (surfaceId) => {
      activeSurfaces.delete(surfaceId);
      updateLiveTree();
      await inner.destroy(surfaceId);
    },
  };
  return {
    adapter,
    runtimeRoot,
    profileRoot,
    starts,
    stops,
    failSurfacePath,
    wayvncBin: wayvnc,
    application,
    binEnv: {
      OMARCHY_BOT_SWAY_BUNDLE_DIR: bundleDir,
      OMARCHY_BOT_SWAY_BIN: sway,
      OMARCHY_BOT_SWAYMSG_BIN: swaymsg,
      OMARCHY_BOT_WAYVNC_BIN: wayvnc,
      OMARCHY_BOT_WLR_RANDR_BIN: path.join(bin, "wlr-randr"),
      OMARCHY_BOT_GRIM_BIN: path.join(bin, "grim"),
      OMARCHY_BOT_INPUT_HELPER_BIN: path.join(bin, "input"),
      OMARCHY_BOT_CAPTURE_HELPER_BIN: path.join(bin, "capture"),
      OMARCHY_BOT_DESKTOP_BIN: desktop,
    },
    controlDir,
    windowsFor: scriptedSwayWindows,
    advanceLiveProgress: () => {
      liveProgress += 1;
      updateLiveTree();
    },
    inputCommands: () => {
      const logPath = path.join(root, "input.log");
      try {
        return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    wayvncStarts: () => {
      try {
        return readFileSync(wayvncStartsPath, "utf8").split("\n").filter((line) => line !== "").length;
      } catch {
        return 0;
      }
    },
    wayvncArgvTokens: () => {
      try {
        return readFileSync(wayvncArgvPath, "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    wayvncEnv: () => {
      try {
        return readFileSync(wayvncEnvPath, "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    exitWayvnc: () => {
      writeFileSync(wayvncExitPath, "1\n");
    },
    exitWayvncFor: (surfaceId, generation) => {
      writeFileSync(path.join(runtimeRoot, surfaceId, String(generation), "wayvnc-exit"), "1\n");
    },
    blockActions: () => {
      blockActions = true;
      actionGate = Promise.withResolvers<void>();
    },
    waitForActions: (count) => {
      if (actionsStarted >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      actionWaiters.push({ count, resolve });
      return promise;
    },
    releaseActions: () => {
      blockActions = false;
      actionGate.resolve();
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
