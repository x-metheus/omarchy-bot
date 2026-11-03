import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import { listApplicationToplevels } from "../../apps/daemon/src/modules/computer/swayIpc.ts";
import type { BotScreenInputAction, BotScreenRuntime } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import {
  readFakeSwayCommands,
  writeFakeSwayIpcMode,
  writeFakeSwayTree,
} from "./helpers/fakeSwayIpc.ts";
import {
  createFixtureAssetSupply,
  type FixtureAssetSupply,
} from "./helpers/botComputerAssetsFixture.ts";
import { BROWSER_PACK_MISSING, PortableBotComputerAssets } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";

const SURFACE_ID = "surf_33333333333333333333333333333333" as SurfaceId;
const SURFACE_B = "surf_44444444444444444444444444444444" as SurfaceId;

const SCREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWMQMgn7D8IAC5MDN627upEAAAAASUVORK5CYII=",
  "base64",
);

const TWO_TOPLEVEL_TREE = {
  id: 1,
  type: "root",
  name: "root",
  nodes: [
    {
      id: 2,
      type: "output",
      name: "HEADLESS-1",
      nodes: [
        {
          id: 3,
          type: "workspace",
          name: `bot-${SURFACE_ID}`,
          nodes: [
            {
              id: 4,
              type: "con",
              name: null,
              layout: "splith",
              nodes: [
                {
                  id: 10,
                  type: "con",
                  name: "Firefox",
                  app_id: "firefox",
                  pid: 1001,
                  focused: false,
                  shell: "xdg_shell",
                  rect: { x: 0, y: 0, width: 800, height: 600 },
                },
              ],
            },
          ],
          floating_nodes: [
            {
              id: 20,
              type: "floating_con",
              name: "Dialog",
              window: 42,
              pid: 2002,
              focused: true,
              shell: "xwayland",
              rect: { x: 100, y: 80, width: 400, height: 300 },
            },
          ],
        },
      ],
    },
  ],
};

const EXPECTED_WINDOWS = [
  {
    id: "10",
    title: "Firefox",
    appId: "firefox",
    pid: 1001,
    focused: false,
    visible: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workspace: `bot-${SURFACE_ID}`,
    clientType: "wayland" as const,
  },
  {
    id: "20",
    title: "Dialog",
    pid: 2002,
    focused: true,
    visible: true,
    bounds: { x: 100, y: 80, width: 400, height: 300 },
    workspace: `bot-${SURFACE_ID}`,
    clientType: "x11" as const,
  },
];

test("native window data includes available XWayland application identity", () => {
  expect(listApplicationToplevels({
    id: 1,
    type: "root",
    nodes: [{
      id: 2,
      type: "workspace",
      name: "1",
      nodes: [{
        id: 20,
        type: "con",
        name: "Dialog",
        window: 42,
        window_properties: { class: "FixtureDialog" },
        pid: 2002,
        focused: true,
        shell: "xwayland",
        rect: { x: 100, y: 80, width: 400, height: 300 },
      }],
      floating_nodes: [],
    }],
  })).toMatchObject([{
    id: "20",
    appId: "FixtureDialog",
    clientType: "x11",
  }]);
});

test("native window data excludes the Bot Desktop infrastructure surface", () => {
  expect(listApplicationToplevels({
    id: 1,
    type: "root",
    nodes: [{
      id: 2,
      type: "workspace",
      name: "1",
      nodes: [
        {
          id: 5,
          type: "con",
          name: "Bot Desktop",
          app_id: "dev.omarchy.BotDesktop",
          focused: true,
          shell: "xdg_shell",
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
        },
        {
          id: 10,
          type: "con",
          name: "Brave",
          app_id: "brave-browser",
          focused: false,
          shell: "xdg_shell",
          rect: { x: 0, y: 0, width: 0, height: 0 },
        },
      ],
      floating_nodes: [],
    }],
  })).toMatchObject([{
    id: "10",
    appId: "brave-browser",
  }]);
});

let root: string | undefined;
const originalPath = process.env.PATH;
const originalDataDirs = process.env.XDG_DATA_DIRS;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalDataDirs === undefined) delete process.env.XDG_DATA_DIRS;
  else process.env.XDG_DATA_DIRS = originalDataDirs;
});

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

async function startControlRuntime(options?: {
  tree?: unknown;
  failPastePath?: string;
  assets?: FixtureAssetSupply;
}): Promise<{
  runtime: BotScreenRuntime;
  adapter: SwayBotScreenRuntimeAdapter;
  controlDir: string;
  inputLog: string;
  failPastePath: string;
  expandedViewCalls: number;
  application: string;
  applicationMarker: string;
  assets: FixtureAssetSupply;
  /** A fake host browser on the daemon PATH and in the host data dirs; it only leaves this marker. */
  hostBrowserMarker: string;
  /** The PATH the fake Sway itself was started with. */
  swayPath: () => string;
  unlinkIpc: () => void;
}> {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-control-"));
  const bin = path.join(root, "bin");
  const controlDir = path.join(root, "ipc-control");
  const inputLog = path.join(root, "input.log");
  const failPastePath = options?.failPastePath ?? path.join(root, "fail-paste");
  const applicationCwd = path.join(root, "workspace");
  const applicationMarker = path.join(root, "application.env");
  const png = path.join(root, "screen.png");
  mkdirSync(bin);
  mkdirSync(controlDir);
  mkdirSync(applicationCwd);
  writeFileSync(png, SCREEN_PNG);
  writeFakeSwayTree(controlDir, options?.tree ?? TWO_TOPLEVEL_TREE);
  writeFakeSwayIpcMode(controlDir, "ok");
  writeFileSync(inputLog, "");
  // Hide the real host's desktop entries; the fixture host has only a fake brave.
  process.env.XDG_DATA_DIRS = path.join(root, "host-data");
  for (const [name, target] of Object.entries({
    bun: process.execPath,
    "dbus-daemon": Bun.which("dbus-daemon"),
    env: Bun.which("env"),
    sleep: Bun.which("sleep"),
    cat: Bun.which("cat"),
  })) {
    if (typeof target === "string") symlinkSync(target, path.join(bin, name));
  }
  process.env.PATH = bin;

  const helperPath = path.resolve(import.meta.dir, "helpers/fakeSwayIpc.ts");
  const sway = executable(bin, "sway", `#!${process.execPath}
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
const wayland = path.join(runtimeDir, "wayland-0");
const swaySock = process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock");
await Bun.write(${JSON.stringify(path.join(controlDir, "sway-path"))}, process.env.PATH ?? "");
Bun.listen({ unix: wayland, socket: { data() {} } });
await serveFakeSwayIpc({
  socketPath: swaySock,
  controlDir: ${JSON.stringify(controlDir)},
});
`);
  const input = executable(bin, "input", `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const logPath = ${JSON.stringify(inputLog)};
const failPastePath = ${JSON.stringify(failPastePath)};
process.stdout.write("READY\\n");
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    appendFileSync(logPath, line + "\\n");
    const [command, request] = line.split(" ");
    if (command === "paste" && existsSync(failPastePath)) {
      process.stdout.write("ERR " + request + " paste failed\\n");
    } else {
      process.stdout.write("OK " + request + "\\n");
    }
    newline = buffer.indexOf("\\n");
  }
}
`);
  const application = executable(bin, "fixture-app", `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(controlDir, "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
tree.nodes[0].nodes[0].nodes.push({
  id: 30,
  type: "con",
  name: "Shared App",
  app_id: "fixture-app",
  pid: process.pid,
  focused: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
writeFileSync(${JSON.stringify(applicationMarker)}, [
  process.env.HOME,
  process.env.XDG_CONFIG_HOME,
  process.cwd(),
].join("|"));
await Promise.withResolvers<void>().promise;
`);
  // A fake host browser: on the daemon PATH, in the host data dirs, and the host's
  // default URL handler. It must never run inside the Bot Computer.
  const hostBrowserMarker = path.join(root, "host-brave-ran");
  const hostBrave = executable(bin, "brave", `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(hostBrowserMarker)}\n`);
  const hostApplications = path.join(root, "host-data", "applications");
  mkdirSync(hostApplications, { recursive: true });
  writeFileSync(path.join(hostApplications, "brave-browser.desktop"), [
    "[Desktop Entry]", "Type=Application", "Name=Brave", `Exec=${hostBrave} %U`, "",
  ].join("\n"));
  writeFileSync(path.join(hostApplications, "mimeapps.list"), [
    "[Default Applications]",
    "x-scheme-handler/http=brave-browser.desktop",
    "x-scheme-handler/https=brave-browser.desktop",
    "text/html=brave-browser.desktop",
    "",
  ].join("\n"));
  const assets = options?.assets ?? createFixtureAssetSupply({
    directory: path.join(root, "assets"),
    browserScript: (logPath) => `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { serveControlBrowserCdp } from ${JSON.stringify(path.resolve(import.meta.dir, "helpers/controlBrowserCdp.ts"))};
const treePath = ${JSON.stringify(path.join(controlDir, "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const ids = [];
let sharedPid;
const collect = (node) => {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node === null || typeof node !== "object") return;
  if (typeof node.id === "number") ids.push(node.id);
  if (node.app_id === "chromium") sharedPid ??= node.pid;
  collect(node.nodes);
  collect(node.floating_nodes);
};
collect(tree);
const workspace = tree.nodes[0].nodes[0];
workspace.nodes.push({
  id: Math.max(0, ...ids) + 1,
  type: "con",
  name: "Portable Browser",
  app_id: "chromium",
  pid: sharedPid ?? process.pid,
  focused: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(1),
  fontConfigFile: process.env.FONTCONFIG_FILE ?? null,
  home: process.env.HOME ?? null,
  configHome: process.env.XDG_CONFIG_HOME ?? null,
}) + "\\n", { flag: "a" });
if (sharedPid !== undefined) process.exit(0);
serveControlBrowserCdp(treePath);
await Promise.withResolvers<void>().promise;
`,
  });

  const adapter = new SwayBotScreenRuntimeAdapter({
    runtimeRoot: path.join(root, "runtime"),
    profileRoot: path.join(root, "profiles"),
    applicationCwd,
    assetSupply: assets,
    swayBin: sway,
    wlrRandrBin: executable(bin, "wlr-randr", "#!/bin/sh\nexit 0\n"),
    grimBin: executable(bin, "grim", `#!/bin/sh\ncat ${JSON.stringify(png)}\n`),
    inputHelperBin: input,
    captureHelperBin: executable(
      bin,
      "capture",
      "#!/bin/sh\nprintf 'READY\\n'\nwhile read -r command; do [ \"$command\" = close ] && exit 0; done\n",
    ),
    botDesktopBin: executable(bin, "bot-desktop", [
      "#!/bin/sh",
      "printf 'READY %s %s\\n' \"$1\" \"$2\"",
      "while :; do sleep 60; done",
      "",
    ].join("\n")),
  });

  const runtime = await adapter.start({
    surfaceId: SURFACE_ID,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  let expandedViewCalls = 0;
  const originalExpanded = runtime.acquireExpandedView.bind(runtime);
  runtime.acquireExpandedView = async () => {
    expandedViewCalls += 1;
    return originalExpanded();
  };
  writeFileSync(path.join(controlDir, "commands.log"), "");
  return {
    adapter,
    runtime,
    controlDir,
    inputLog,
    failPastePath,
    application,
    applicationMarker,
    assets,
    hostBrowserMarker,
    swayPath: () => readFileSync(path.join(controlDir, "sway-path"), "utf8"),
    get expandedViewCalls() {
      return expandedViewCalls;
    },
    unlinkIpc: () => {
      const socket = runtime.sessionEnv.SWAYSOCK;
      if (socket === undefined) throw new Error("Bot Computer socket is missing");
      rmSync(socket, { force: true });
    },
  };
}

test("listWindows returns ordinary and floating toplevels without a Screen Projection", async () => {
  const fixture = await startControlRuntime();
  try {
    const windowList = await fixture.runtime.listWindows();
    expect(windowList).toEqual(EXPECTED_WINDOWS);
    expect(fixture.expandedViewCalls).toBe(0);
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([]);
  } finally {
    await fixture.runtime.stop();
  }
});

test("capture and window routing compose without a Screen Projection", async () => {
  const fixture = await startControlRuntime();
  try {
    const windowList = await fixture.runtime.listWindows();
    const image = await fixture.runtime.capture();
    expect(windowList).toEqual(EXPECTED_WINDOWS);
    expect(image.mediaType).toBe("image/png");
    expect(image.bytes.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(fixture.expandedViewCalls).toBe(0);
  } finally {
    await fixture.runtime.stop();
  }
});

test("listing windows throws when the private Sway IPC socket is missing", async () => {
  const fixture = await startControlRuntime();
  try {
    fixture.unlinkIpc();
    await expect(fixture.runtime.listWindows()).rejects.toThrow(/Sway IPC/);
  } finally {
    await fixture.runtime.stop();
  }
});

test("focusWindow sends a private focus command and succeeds only after the tree confirms it", async () => {
  const fixture = await startControlRuntime();
  try {
    await fixture.runtime.focusWindow(EXPECTED_WINDOWS[0]!);
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([
      `workspace bot-${SURFACE_ID}`,
      "[con_id=10] focus",
    ]);
    const listed = await fixture.runtime.listWindows();
    expect(listed).toEqual([
      { ...EXPECTED_WINDOWS[0]!, focused: true },
      { ...EXPECTED_WINDOWS[1]!, focused: false },
    ]);
  } finally {
    await fixture.runtime.stop();
  }
});

test("focusWindow throws for refusals, unconfirmed focus, and hung IPC", async () => {
  const fixture = await startControlRuntime();
  try {
    writeFakeSwayIpcMode(fixture.controlDir, "refuse");
    await expect(fixture.runtime.focusWindow(EXPECTED_WINDOWS[0]!)).rejects.toThrow(/refused/);
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([
      `workspace bot-${SURFACE_ID}`,
    ]);

    writeFakeSwayIpcMode(fixture.controlDir, "ack");
    await expect(fixture.runtime.focusWindow(EXPECTED_WINDOWS[0]!)).rejects.toThrow(/not confirmed/);
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([
      `workspace bot-${SURFACE_ID}`,
      `workspace bot-${SURFACE_ID}`,
      "[con_id=10] focus",
    ]);

    writeFakeSwayIpcMode(fixture.controlDir, "hang");
    await expect(fixture.runtime.focusWindow(EXPECTED_WINDOWS[0]!)).rejects.toThrow(/timed out/);
  } finally {
    await fixture.runtime.stop();
  }
});

function inputHelperLines(logPath: string): string[] {
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
}

function pasteTexts(logPath: string): string[] {
  return inputHelperLines(logPath).flatMap((line) => {
    const [command, , , , , , , payload] = line.split(" ");
    if (command !== "paste" || payload === undefined) return [];
    return [Buffer.from(payload, "base64").toString("utf8")];
  });
}

function inputEnvelope(
  runtime: BotScreenRuntime,
  epoch: number,
  sequence: number,
  event: BotScreenInputAction,
): Parameters<BotScreenRuntime["input"]>[0] {
  return {
    surfaceId: SURFACE_ID,
    runtimeGeneration: runtime.generation,
    geometryGeneration: 7,
    controllerEpoch: epoch,
    sequence,
    ...event,
  };
}

test("input without the input lease is rejected before the helper is touched", async () => {
  const fixture = await startControlRuntime();
  try {
    await expect(
      fixture.runtime.input(inputEnvelope(fixture.runtime, 1, 1, { type: "motion", x: 4, y: 5 })),
    ).rejects.toThrow();
    expect(inputHelperLines(fixture.inputLog)).toEqual([]);
  } finally {
    await fixture.runtime.stop();
  }
});

test("leased pointer, key, and paste events drive the private virtual-input helper", async () => {
  const fixture = await startControlRuntime();
  try {
    const epoch = await fixture.runtime.setInputAuthority(1);
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 1, { type: "motion", x: 4, y: 5 }));
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 2, {
      type: "button",
      x: 4,
      y: 5,
      button: "left",
      state: "pressed",
    }));
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 3, {
      type: "button",
      x: 4,
      y: 5,
      button: "left",
      state: "released",
    }));
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 4, {
      type: "scroll",
      x: 4,
      y: 5,
      deltaX: 1,
      deltaY: -120,
    }));
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 5, { type: "key", keyCode: 28, state: "pressed" }));
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 6, { type: "key", keyCode: 28, state: "released" }));
    await fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 7, { type: "paste", text: "你好, world" }));
    await fixture.runtime.releaseInput(epoch);

    const lines = inputHelperLines(fixture.inputLog);
    expect(lines.some((line) => line.startsWith("motion ") && line.endsWith(" 4 5"))).toBeTrue();
    expect(lines.some((line) => line.startsWith("button ") && line.includes(" 4 5 272 1"))).toBeTrue();
    expect(lines.some((line) => line.startsWith("button ") && line.includes(" 4 5 272 0"))).toBeTrue();
    expect(lines.some((line) => line.startsWith("scroll ") && line.endsWith(" 4 5 1 -120"))).toBeTrue();
    expect(lines.some((line) => line.startsWith("key ") && line.endsWith(" 28 1"))).toBeTrue();
    expect(lines.some((line) => line.startsWith("key ") && line.endsWith(" 28 0"))).toBeTrue();
    expect(pasteTexts(fixture.inputLog)).toEqual(["你好, world"]);
    expect(lines.filter((line) => line.startsWith("authority ")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("release ")).length).toBe(1);
  } finally {
    await fixture.runtime.stop();
  }
});

test("human input authority serializes the shared seat across Screen workspaces", async () => {
  const fixture = await startControlRuntime();
  const second = await fixture.adapter.start({
    surfaceId: SURFACE_B,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  writeFileSync(path.join(fixture.controlDir, "commands.log"), "");
  writeFakeSwayTree(fixture.controlDir, {
    id: 1,
    type: "root",
    name: "root",
    nodes: [{
      id: 2,
      type: "workspace",
      name: `bot-${SURFACE_B}`,
      nodes: [{
        id: 30,
        type: "con",
        name: "Second Screen",
        app_id: "fixture",
        focused: true,
        shell: "xdg_shell",
        rect: { x: 8_292, y: 80, width: 400, height: 300 },
      }],
      floating_nodes: [],
    }],
    floating_nodes: [],
  });
  let firstEpoch: number | undefined;
  let secondEpoch: number | undefined;
  try {
    await expect(second.listWindows()).resolves.toMatchObject([{
      title: "Second Screen",
      bounds: { x: 100, y: 80, width: 400, height: 300 },
    }]);
    firstEpoch = await fixture.runtime.setInputAuthority(1);
    const secondAuthority = second.setInputAuthority(1).then((epoch) => {
      secondEpoch = epoch;
      return "acquired";
    });
    expect(await Promise.race([
      secondAuthority,
      Bun.sleep(30).then(() => "waiting"),
    ])).toBe("waiting");
    await fixture.runtime.releaseInput(firstEpoch);
    firstEpoch = undefined;
    expect(await secondAuthority).toBe("acquired");
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([
      `workspace bot-${SURFACE_ID}`,
      `workspace bot-${SURFACE_B}`,
    ]);
  } finally {
    if (firstEpoch !== undefined) await fixture.runtime.releaseInput(firstEpoch).catch(() => {});
    if (secondEpoch !== undefined) await second.releaseInput(secondEpoch).catch(() => {});
    await Promise.allSettled([fixture.runtime.stop(), second.stop()]);
  }
});

test("a paste the private helper cannot perform fails the Screen input", async () => {
  const fixture = await startControlRuntime();
  writeFileSync(fixture.failPastePath, "1\n");
  try {
    const epoch = await fixture.runtime.setInputAuthority(1);
    await expect(
      fixture.runtime.input(inputEnvelope(fixture.runtime, epoch, 1, { type: "paste", text: "你好, world" })),
    ).rejects.toThrow();
    expect(pasteTexts(fixture.inputLog)).toEqual(["你好, world"]);
  } finally {
    await fixture.runtime.stop();
  }
});

test("shared runtime launches applications into the requesting Screen workspace", async () => {
  const fixture = await startControlRuntime();
  const browserCalls = fixture.assets.browserCalls();
  fixture.assets.ensureBrowser = () => { throw new Error("browser pack unavailable"); };
  try {
    const shot = await fixture.runtime.capture();
    expect(shot.bytes.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(await fixture.runtime.listWindows()).toEqual(EXPECTED_WINDOWS);

    await expect(
      fixture.runtime.launch({ app: fixture.application }),
    ).resolves.toEqual({ text: `launched ${fixture.application}` });
    expect(fixture.assets.browserCalls()).toBe(browserCalls);
    expect(existsSync(path.join(root!, "assets", "browser.log"))).toBe(false);
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([
      `workspace bot-${SURFACE_ID}`,
      "[con_id=30] move container to workspace bot-surf_33333333333333333333333333333333",
      `workspace bot-${SURFACE_ID}`,
      "[con_id=30] focus",
      `[app_id="^dev[.]omarchy[.]BotDesktop$" workspace="^bot-${SURFACE_ID}$"] move scratchpad`,
    ]);
    expect(await Bun.file(fixture.applicationMarker).text()).toBe([
      path.join(root!, "profiles", "computer", "home"),
      path.join(root!, "profiles", "computer", "config"),
      path.join(root!, "workspace"),
    ].join("|"));
    expect(fixture.runtime.sessionEnv.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(fixture.runtime.sessionEnv.SWAYSOCK).toContain(path.join(root!, "runtime", "computer"));
    expect(fixture.expandedViewCalls).toBe(0);
  } finally {
    await fixture.runtime.stop();
  }
});

test("launch routes only windows owned by the launched process", async () => {
  const foreign = Bun.spawn(["sleep", "3600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const tree = {
    id: 1,
    type: "root",
    name: "root",
    nodes: [
      {
        id: 2,
        type: "output",
        name: "HEADLESS-1",
        nodes: [{
          id: 3,
          type: "workspace",
          name: `bot-${SURFACE_ID}`,
          nodes: [],
          floating_nodes: [],
        }],
      },
      {
        id: 4,
        type: "output",
        name: "HEADLESS-2",
        nodes: [{
          id: 5,
          type: "workspace",
          name: "bot-other-screen",
          nodes: [],
          floating_nodes: [],
        }],
      },
    ],
    floating_nodes: [],
  };
  const fixture = await startControlRuntime({ tree });
  const application = executable(path.join(root!, "bin"), "concurrent-app", `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
// A foreign window appears during this launch, owned by no process of ours.
tree.nodes[1].nodes[0].nodes.push({
  id: 77,
  type: "con",
  name: "Foreign",
  app_id: "foreign-app",
  pid: ${foreign.pid},
  focused: false,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 320, height: 200 },
  nodes: [],
  floating_nodes: [],
});
tree.nodes[0].nodes[0].nodes.push({
  id: 76,
  type: "con",
  name: "Launched",
  app_id: "fixture-app",
  pid: process.pid,
  focused: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
await Promise.withResolvers<void>().promise;
`);
  try {
    await expect(fixture.runtime.launch({ app: application }))
      .resolves.toEqual({ text: `launched ${application}` });
    const commands = readFakeSwayCommands(fixture.controlDir);
    expect(commands).toContain(`[con_id=76] move container to workspace bot-${SURFACE_ID}`);
    expect(commands).not.toContain(`[con_id=77] move container to workspace bot-${SURFACE_ID}`);
    expect((await fixture.runtime.listWindows()).map((window) => window.id)).toEqual(["76"]);
  } finally {
    await fixture.runtime.stop();
    foreign.kill("SIGKILL");
    await foreign.exited;
  }
}, 20_000);

test("a shared browser launch claims only its forwarded browser window across Screens", async () => {
  const fixture = await startControlRuntime();
  const second = await fixture.adapter.start({
    surfaceId: SURFACE_B,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  writeFakeSwayTree(fixture.controlDir, {
    id: 1,
    type: "root",
    name: "root",
    nodes: [
      {
        id: 2,
        type: "output",
        name: "HEADLESS-1",
        nodes: [{
          id: 3,
          type: "workspace",
          name: `bot-${SURFACE_ID}`,
          nodes: [],
          floating_nodes: [],
        }],
      },
      {
        id: 4,
        type: "output",
        name: "HEADLESS-2",
        nodes: [{
          id: 5,
          type: "workspace",
          name: `bot-${SURFACE_B}`,
          nodes: [],
          floating_nodes: [],
        }],
      },
    ],
    floating_nodes: [],
  });
  const appPidFile = path.join(root!, "app.pid");
  const sharedPidFile = path.join(root!, "shared-browser.pid");
  const forwardedIdsFile = path.join(root!, "forwarded-windows.json");
  const application = executable(path.join(root!, "bin"), "non-browser-app", `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const workspace = tree.nodes[0].nodes[0];
workspace.nodes.push({
  id: 55,
  type: "con",
  name: "App Window",
  app_id: "non-browser-app",
  pid: process.pid,
  focused: true,
  visible: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
writeFileSync(${JSON.stringify(appPidFile)}, String(process.pid));
await Promise.withResolvers<void>().promise;
`);
  // A forwarding browser child: it maps the other Screen's app window (the app
  // pid is ours, but the window appears on the other Screen) before the browser
  // window itself, so a first-match claim steals it.
  const forwardBrowser = executable(path.join(root!, "bin"), "forward-browser", `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const appPid = Number(readFileSync(${JSON.stringify(appPidFile)}, "utf8"));
const sharedPid = Number(readFileSync(${JSON.stringify(sharedPidFile)}, "utf8"));
const ids = [];
const collect = (node) => {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node === null || typeof node !== "object") return;
  if (typeof node.id === "number") ids.push(node.id);
  collect(node.nodes);
  collect(node.floating_nodes);
};
collect(tree);
const otherWorkspace = tree.nodes[1].nodes[0];
const appWindow = Math.max(0, ...ids) + 1;
otherWorkspace.nodes.push({
  id: appWindow,
  type: "con",
  name: "Stray App Window",
  app_id: "non-browser-app",
  pid: appPid,
  focused: false,
  visible: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
const browserWindow = appWindow + 1;
otherWorkspace.nodes.push({
  id: browserWindow,
  type: "con",
  name: "Forwarded Browser Window",
  app_id: "chromium",
  pid: sharedPid,
  focused: true,
  visible: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
writeFileSync(${JSON.stringify(forwardedIdsFile)}, JSON.stringify({ appWindow, browserWindow }));
process.exit(0);
`);
  try {
    await expect(fixture.runtime.launch({ app: application }))
      .resolves.toEqual({ text: `launched ${application}` });
    // The first pack launch owns its own window and leaves the shared browser running.
    const firstUrl = "https://example.com/first";
    await expect(fixture.runtime.launch({ url: firstUrl })).resolves.toEqual({ text: `opened ${firstUrl}` });
    const sharedPid = (await fixture.runtime.listWindows())
      .find((window) => window.appId === "chromium")?.pid;
    expect(sharedPid).toBeNumber();
    writeFileSync(sharedPidFile, String(sharedPid));

    fixture.assets.ensureBrowser = async () => ({ browserBin: forwardBrowser });
    const forwardUrl = "https://example.com/forward";
    await expect(fixture.runtime.launch({ url: forwardUrl }))
      .resolves.toEqual({ text: `opened ${forwardUrl}` });

    const { appWindow, browserWindow } = JSON.parse(
      readFileSync(forwardedIdsFile, "utf8"),
    ) as { appWindow: number; browserWindow: number };
    const commands = readFakeSwayCommands(fixture.controlDir);
    expect(commands).toContain(
      `[con_id=${browserWindow}] move container to workspace bot-${SURFACE_ID}`,
    );
    expect(commands).not.toContain(
      `[con_id=${appWindow}] move container to workspace bot-${SURFACE_ID}`,
    );
    expect(commands).not.toContain(`[con_id=${browserWindow}] focus`);
    expect(commands).not.toContain(`[con_id=${appWindow}] focus`);
    const launchedSurface = (await fixture.runtime.listWindows()).map((window) => window.id);
    expect(launchedSurface).toContain(String(browserWindow));
    expect(launchedSurface).not.toContain(String(appWindow));
    // The other Screen's window stays exactly where it was.
    expect((await second.listWindows()).map((window) => window.id)).toContain(String(appWindow));
  } finally {
    await Promise.allSettled([fixture.runtime.stop(), second.stop()]);
  }
}, 20_000);

const TWO_SCREEN_TREE = {
  id: 1,
  type: "root",
  name: "root",
  nodes: [
    {
      id: 2,
      type: "output",
      name: "HEADLESS-1",
      nodes: [{
        id: 3,
        type: "workspace",
        name: `bot-${SURFACE_ID}`,
        nodes: [],
        floating_nodes: [],
      }],
    },
    {
      id: 4,
      type: "output",
      name: "HEADLESS-2",
      nodes: [{
        id: 5,
        type: "workspace",
        name: `bot-${SURFACE_B}`,
        nodes: [],
        floating_nodes: [],
      }],
    },
  ],
  floating_nodes: [],
};

test("a forwarded open_url that creates no new window leaves the other Screen's browser window in place", async () => {
  const fixture = await startControlRuntime();
  const second = await fixture.adapter.start({
    surfaceId: SURFACE_B,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  writeFakeSwayTree(fixture.controlDir, TWO_SCREEN_TREE);
  // The running browser instance receives the forwarded URL and reuses its own
  // window: no new toplevel appears for the second Screen.
  const forwardNothing = executable(
    path.join(root!, "bin"),
    "forward-no-window",
    `#!${process.execPath}\nprocess.exit(0);\n`,
  );
  try {
    const firstUrl = "https://example.com/first";
    await expect(fixture.runtime.launch({ url: firstUrl }))
      .resolves.toEqual({ text: `opened ${firstUrl}` });
    const browserWindow = (await fixture.runtime.listWindows())
      .find((window) => window.appId === "chromium");
    expect(browserWindow?.id).toBeString();
    expect(browserWindow?.pid).toBeNumber();

    fixture.assets.ensureBrowser = async () => ({ browserBin: forwardNothing });
    const secondUrl = "https://example.com/second";
    await expect(second.launch({ url: secondUrl })).rejects.toThrow(
      `; the shared browser window ${browserWindow!.id} on Screen ${SURFACE_ID} was left in place`,
    );

    // The other Screen's window is still there, still visible, and still routable.
    const keptWindow = (await fixture.runtime.listWindows())
      .find((window) => window.id === browserWindow!.id);
    expect(keptWindow).toMatchObject({
      visible: true,
      workspace: `bot-${SURFACE_ID}`,
      pid: browserWindow!.pid,
    });
    await expect(fixture.runtime.focusWindow(keptWindow!)).resolves.toBeUndefined();
    const commands = readFakeSwayCommands(fixture.controlDir);
    expect(commands).toContain(`[con_id=${browserWindow!.id}] focus`);
    expect(commands).not.toContain(
      `[con_id=${browserWindow!.id}] move container to workspace bot-${SURFACE_B}`,
    );
    expect(await second.listWindows()).toEqual([]);
  } finally {
    await Promise.allSettled([fixture.runtime.stop(), second.stop()]);
  }
}, 40_000);

test("a forwarded open_url moves only the window it created off the other Screen's workspace", async () => {
  const fixture = await startControlRuntime();
  const second = await fixture.adapter.start({
    surfaceId: SURFACE_B,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  writeFakeSwayTree(fixture.controlDir, TWO_SCREEN_TREE);
  const sharedPidFile = path.join(root!, "shared-browser.pid");
  const forwardedIdFile = path.join(root!, "forwarded-window.json");
  // The forwarding child only asks the running browser for a new window. Sway
  // maps it on the Screen that already shows the browser, next to that Screen's
  // own window, so the claiming launch must pick exactly the new container.
  const forwardNewWindow = executable(path.join(root!, "bin"), "forward-new-window", `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const sharedPid = Number(readFileSync(${JSON.stringify(sharedPidFile)}, "utf8"));
const ids = [];
const collect = (node) => {
  if (Array.isArray(node)) return node.forEach(collect);
  if (node === null || typeof node !== "object") return;
  if (typeof node.id === "number") ids.push(node.id);
  collect(node.nodes);
  collect(node.floating_nodes);
};
collect(tree);
const id = Math.max(0, ...ids) + 1;
tree.nodes[0].nodes[0].nodes.push({
  id,
  type: "con",
  name: "Forwarded Browser Window",
  app_id: "chromium",
  pid: sharedPid,
  focused: true,
  visible: true,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
writeFileSync(${JSON.stringify(forwardedIdFile)}, String(id));
process.exit(0);
`);
  try {
    const firstUrl = "https://example.com/first";
    await expect(fixture.runtime.launch({ url: firstUrl }))
      .resolves.toEqual({ text: `opened ${firstUrl}` });
    const browserWindow = (await fixture.runtime.listWindows())
      .find((window) => window.appId === "chromium");
    expect(browserWindow?.pid).toBeNumber();
    writeFileSync(sharedPidFile, String(browserWindow!.pid));

    fixture.assets.ensureBrowser = async () => ({ browserBin: forwardNewWindow });
    // The first Screen's own launch already focused the browser window, so only
    // commands logged by the forwarded launch are attributable to it.
    const commandsBeforeForward = readFakeSwayCommands(fixture.controlDir);
    const secondUrl = "https://example.com/second";
    await expect(second.launch({ url: secondUrl }))
      .resolves.toEqual({ text: `opened ${secondUrl}` });

    const forwardedId = readFileSync(forwardedIdFile, "utf8").trim();
    expect(forwardedId).not.toBe(browserWindow!.id);
    expect((await second.listWindows()).map((window) => window.id)).toEqual([forwardedId]);
    const commands = readFakeSwayCommands(fixture.controlDir);
    expect(commands).toContain(
      `[con_id=${forwardedId}] move container to workspace bot-${SURFACE_B}`,
    );
    expect(commands).not.toContain(
      `[con_id=${browserWindow!.id}] move container to workspace bot-${SURFACE_B}`,
    );
    const forwardedCommands = commands.slice(commandsBeforeForward.length);
    expect(forwardedCommands).not.toContain(`[con_id=${forwardedId}] focus`);
    expect(forwardedCommands).not.toContain(`[con_id=${browserWindow!.id}] focus`);
    expect((await fixture.runtime.listWindows()).map((window) => window.id))
      .toEqual([browserWindow!.id]);
  } finally {
    await Promise.allSettled([fixture.runtime.stop(), second.stop()]);
  }
}, 20_000);

test("a handoff into the running pack claims only the pack's forwarded window across Screens", async () => {
  const fixture = await startControlRuntime();
  const second = await fixture.adapter.start({
    surfaceId: SURFACE_B,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  writeFakeSwayTree(fixture.controlDir, TWO_SCREEN_TREE);
  // A process that is not the pack but maps a window with a Chromium app id.
  const impostor = Bun.spawn(["sleep", "3600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const packPidFile = path.join(root!, "pack.pid");
  // An application that hands a URL to the running pack (as a link handoff or a
  // shim does): the running pack maps the new window, then the handoff exits.
  const handoff = executable(path.join(root!, "bin"), "pack-handoff", `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const screenA = tree.nodes[0].nodes[0];
for (const [id, pid] of [[71, ${impostor.pid}], [72, Number(readFileSync(${JSON.stringify(packPidFile)}, "utf8"))]]) {
  screenA.nodes.push({
    id,
    type: "con",
    name: "Handed Off",
    app_id: "chromium",
    pid,
    focused: true,
    visible: true,
    shell: "xdg_shell",
    rect: { x: 0, y: 0, width: 640, height: 480 },
    nodes: [],
    floating_nodes: [],
  });
}
writeFileSync(treePath, JSON.stringify(tree));
process.exit(0);
`);
  const applications = path.join(root!, "profiles", "computer", "data", "applications");
  writeFileSync(
    path.join(applications, "pack-handoff.desktop"),
    ["[Desktop Entry]", "Type=Application", "Name=Handoff", `Exec=${handoff}`, ""].join("\n"),
  );
  try {
    await expect(fixture.runtime.launch({ url: "https://example.com/first" }))
      .resolves.toEqual({ text: "opened https://example.com/first" });
    const packWindow = (await fixture.runtime.listWindows())[0]!;
    writeFileSync(packPidFile, String(packWindow.pid));
    const commandsBeforeHandoff = readFakeSwayCommands(fixture.controlDir);
    await expect(second.launch({ app: "pack-handoff.desktop" }))
      .resolves.toEqual({ text: "launched pack-handoff.desktop" });

    const commands = readFakeSwayCommands(fixture.controlDir).slice(commandsBeforeHandoff.length);
    expect(commands).toContain(`[con_id=72] move container to workspace bot-${SURFACE_B}`);
    expect(commands).not.toContain(`[con_id=71] move container to workspace bot-${SURFACE_B}`);
    expect(commands).not.toContain(`[con_id=${packWindow.id}] move container to workspace bot-${SURFACE_B}`);
    const forwarded = await second.listWindows();
    expect(forwarded.map((window) => window.id)).toEqual(["72"]);
    expect(forwarded[0]?.pid).toBe(packWindow.pid);
    expect((await fixture.runtime.listWindows()).map((window) => window.id).sort())
      .toEqual([packWindow.id, "71"].sort());
  } finally {
    await Promise.allSettled([fixture.runtime.stop(), second.stop()]);
    impostor.kill("SIGKILL");
    await impostor.exited;
  }
}, 20_000);

test("a launch waits for a window Sway maps visibly after routing", async () => {
  const fixture = await startControlRuntime();
  const application = executable(
    path.join(root!, "bin"),
    "late-visible-app",
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const workspace = tree.nodes.find((node) => node.type === "output").nodes[0];
workspace.nodes.push({
  id: 91,
  type: "con",
  name: "Late App",
  app_id: "late-visible-app",
  pid: process.pid,
  focused: true,
  visible: false,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
// Like Sway announcing a container before it maps it: the first tree reads see
// it on the right workspace but inert, and a later read shows it visible.
setTimeout(() => {
  const later = JSON.parse(readFileSync(treePath, "utf8"));
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node === null || typeof node !== "object") return;
    if (node.id === 91) node.visible = true;
    collect(node.nodes);
    collect(node.floating_nodes);
  };
  collect(later);
  writeFileSync(treePath, JSON.stringify(later));
}, 150);
await Promise.withResolvers<void>().promise;
`,
  );
  try {
    await expect(fixture.runtime.launch({ app: application })).resolves.toEqual({
      text: `launched ${application}`,
    });
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);

test("a launch whose window is hidden on the Surface workspace reports failure", async () => {
  const fixture = await startControlRuntime();
  const application = executable(
    path.join(root!, "bin"),
    "hidden-app",
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const treePath = ${JSON.stringify(path.join(root!, "ipc-control", "tree.json"))};
const tree = JSON.parse(readFileSync(treePath, "utf8"));
const workspace = tree.nodes.find((node) => node.type === "output").nodes[0];
workspace.nodes.push({
  id: 90,
  type: "con",
  name: "Hidden App",
  app_id: "hidden-app",
  pid: process.pid,
  focused: true,
  visible: false,
  shell: "xdg_shell",
  rect: { x: 0, y: 0, width: 640, height: 480 },
  nodes: [],
  floating_nodes: [],
});
writeFileSync(treePath, JSON.stringify(tree));
await Promise.withResolvers<void>().promise;
`,
  );
  try {
    // On the right workspace but hidden by Sway (scratchpad): not a launch.
    await expect(fixture.runtime.launch({ app: application })).rejects.toThrow(
      "is not visible on workspace",
    );
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);

test("a launch whose window never appears on the Surface workspace reports failure", async () => {
  const fixture = await startControlRuntime();
  const application = executable(
    path.join(root!, "bin"),
    "no-window-app",
    "#!/bin/sh\nwhile :; do sleep 60; done\n",
  );
  try {
    await expect(fixture.runtime.launch({ app: application })).rejects.toThrow(
      `Launched application ${application} but no window owned by the launched process appeared on workspace bot-${SURFACE_ID}`,
    );
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);

test("Bot Desktop is hidden even when the launch throws", async () => {
  const fixture = await startControlRuntime();
  try {
    fixture.assets.ensureBrowser = () => {
      throw new Error("browser pack unavailable");
    };
    await expect(fixture.runtime.launch({ url: "https://example.com/launch-throws" }))
      .rejects.toThrow("browser pack unavailable");
    expect(readFakeSwayCommands(fixture.controlDir)).toContain(
      `[app_id="^dev[.]omarchy[.]BotDesktop$" workspace="^bot-${SURFACE_ID}$"] move scratchpad`,
    );
  } finally {
    await fixture.runtime.stop();
  }
});

test("a failed Bot Desktop hide does not replace the launch error", async () => {
  const fixture = await startControlRuntime();
  try {
    fixture.assets.ensureBrowser = () => {
      // The hide command fails too, after the launch has already failed.
      writeFakeSwayIpcMode(fixture.controlDir, "refuse");
      throw new Error("browser pack unavailable");
    };
    await expect(fixture.runtime.launch({ url: "https://example.com/hide-fails" }))
      .rejects.toThrow("browser pack unavailable");
  } finally {
    writeFakeSwayIpcMode(fixture.controlDir, "ok");
    await fixture.runtime.stop();
  }
});

test("open_url uses the browser pack even on a host whose default browser is brave", async () => {
  const fixture = await startControlRuntime();
  const url = "https://example.com/pack-default";
  try {
    expect(await fixture.runtime.launch({ url })).toEqual({ text: `opened ${url}` });
    expect(fixture.assets.browserLaunches()).toHaveLength(1);
    expect(fixture.assets.fontCalls()).toBe(1);
    expect(existsSync(fixture.hostBrowserMarker)).toBeFalse();
  } finally { await fixture.runtime.stop(); }
});

test("open_app refuses host browsers by name, desktop id and desktop command without running them", async () => {
  const fixture = await startControlRuntime();
  const applications = path.join(root!, "profiles", "computer", "data", "applications");
  writeFileSync(path.join(applications, "web.desktop"), [
    "[Desktop Entry]", "Type=Application", "Name=Web",
    `Exec=env BROWSER_FIXTURE=1 ${path.join(root!, "bin", "brave")} %U`, "",
  ].join("\n"));
  try {
    for (const app of ["brave", path.join(root!, "bin", "brave"), "brave-browser.desktop", "firefox", "google-chrome-stable", "web.desktop"]) {
      await expect(fixture.runtime.launch({ app }), app).rejects.toThrow(
        `open_app cannot start ${app}: Bots use only the bundled browser. Use open_url to open a page in it, or the browser tool to operate it.`,
      );
    }
    expect(existsSync(fixture.hostBrowserMarker)).toBeFalse();
    expect(readFakeSwayCommands(fixture.controlDir).filter((command) => command.includes("move container"))).toEqual([]);
  } finally {
    await fixture.runtime.stop();
  }
});

test("every browser path in the Screen environment ends at the pack", async () => {
  const fixture = await startControlRuntime();
  const env = fixture.runtime.sessionEnv;
  const shimDir = path.join(root!, "profiles", "computer", "browser-shims");
  try {
    // The Service shims lead both the Screen PATH and Sway's own PATH (`swaymsg exec`).
    expect(env.PATH!.split(":")[0]).toBe(shimDir);
    expect(fixture.swayPath().split(":")[0]).toBe(shimDir);
    expect(env.BROWSER).toBe(path.join(shimDir, "omarchy-bot-browser"));
    // Guard before running anything: `brave` must resolve to the shim, never a host binary.
    expect(Bun.which("brave", { PATH: env.PATH! })).toBe(path.join(shimDir, "brave"));
    const xdgMime = Bun.which("xdg-mime", { PATH: env.PATH! });
    if (xdgMime !== null) {
      for (const type of ["x-scheme-handler/http", "x-scheme-handler/https", "text/html"]) {
        const query = Bun.spawnSync([xdgMime, "query", "default", type], { env, stdout: "pipe", stderr: "pipe" });
        expect(query.stdout.toString().trim(), type).toBe("omarchy-bot-browser.desktop");
      }
    }
    await fixture.runtime.setInputAuthority(1, "web");
    const shim = Bun.spawn(["/bin/sh", "-c", "brave https://x.example/"], { env, stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !existsSync(path.join(root!, "assets", "browser.log"))) await Bun.sleep(20);
      expect(await shim.exited).toBe(0);
      expect(fixture.assets.browserLaunches().map((launch) => launch.argv.slice(1))).toEqual([[
        `--user-data-dir=${path.join(root!, "profiles", "computer", "config", "omarchy-bot-browser")}`,
        "--ozone-platform=wayland", "--disable-gpu", "--no-first-run",
        "--no-default-browser-check", "--disable-sync", "--password-store=basic",
        "--remote-debugging-pipe", "--new-window", "https://x.example/",
      ]]);
    } finally {
      if (shim.exitCode === null) shim.kill("SIGKILL");
      await shim.exited;
    }
    await fixture.runtime.releaseInput(1);
    expect(existsSync(fixture.hostBrowserMarker)).toBeFalse();
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);

test("open_url opens the pack with its private profile and the CDP pipe", async () => {
  const fixture = await startControlRuntime();
  const url = "https://example.com/portable";
  try {
    await expect(
      fixture.runtime.launch({ url }),
    ).resolves.toEqual({ text: `opened ${url}` });
    expect(readFakeSwayCommands(fixture.controlDir)).toEqual([
      `workspace bot-${SURFACE_ID}`,
      expect.stringMatching(new RegExp(`^\\[con_id=\\d+\\] move scratchpad$`)),
      expect.stringMatching(
        new RegExp(`^\\[con_id=\\d+\\] move container to workspace bot-${SURFACE_ID}$`),
      ),
      `[app_id="^dev[.]omarchy[.]BotDesktop$" workspace="^bot-${SURFACE_ID}$"] move scratchpad`,
    ]);
    const [launch] = fixture.assets.browserLaunches();
    expect(launch!.argv).toEqual([
      path.join(root!, "assets", "portable-browser"),
      `--user-data-dir=${path.join(root!, "profiles", "computer", "config", "omarchy-bot-browser")}`,
      "--ozone-platform=wayland", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--disable-sync", "--password-store=basic",
      "--remote-debugging-pipe",
      "--new-window", url,
    ]);
    expect(launch!.fontConfigFile).toBe(fixture.assets.fontConfigFile);
    expect(fixture.runtime.sessionEnv.FONTCONFIG_FILE).toBe(fixture.assets.fontConfigFile);
    expect(launch!.home).toBe(path.join(root!, "profiles", "computer", "home"));
    expect(launch!.configHome).toBe(path.join(root!, "profiles", "computer", "config"));
  } finally {
    await fixture.runtime.stop();
  }
});

test("open_url, the browser tool and request_takeover report a missing pack with no fallback", async () => {
  const fixture = await startControlRuntime();
  const missing = new PortableBotComputerAssets({ profileDir: path.join(root!, "unused-profile") });
  fixture.assets.ensureBrowser = () => missing.ensureBrowser();
  try {
    await expect(fixture.runtime.launch({ url: "https://example.com/missing-pack" })).rejects.toThrow(BROWSER_PACK_MISSING);
    for (const action of [{ name: "snapshot", args: {} }, { name: "request_takeover", args: { reason: "Please log in" } }]) {
      await expect(fixture.runtime.browser!(
        action as Parameters<NonNullable<BotScreenRuntime["browser"]>>[0],
        async () => { throw new Error("unexpected input"); },
        new AbortController().signal,
      )).rejects.toThrow(BROWSER_PACK_MISSING);
    }
    expect(existsSync(fixture.hostBrowserMarker)).toBeFalse();
  } finally { await fixture.runtime.stop(); }
});

test("repeated open_url calls across Screens share one browser profile and route each window", async () => {
  const fixture = await startControlRuntime();
  const second = await fixture.adapter.start({
    surfaceId: SURFACE_B,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  });
  try {
    await expect(
      fixture.runtime.launch({ url: "https://example.com/first" }),
    ).resolves.toEqual({ text: "opened https://example.com/first" });
    await expect(
      second.launch({ url: "https://example.com/second" }),
    ).resolves.toEqual({ text: "opened https://example.com/second" });

    const launches = fixture.assets.browserLaunches();
    expect(launches).toHaveLength(2);
    const profileDirs = launches.map((launch) =>
      launch.argv.find((argument) => argument.startsWith("--user-data-dir="))
    );
    expect(profileDirs).toEqual([
      `--user-data-dir=${path.join(root!, "profiles", "computer", "config", "omarchy-bot-browser")}`,
      `--user-data-dir=${path.join(root!, "profiles", "computer", "config", "omarchy-bot-browser")}`,
    ]);
    expect(launches.map((launch) => launch.argv.at(-1))).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
    const commands = readFakeSwayCommands(fixture.controlDir);
    expect(commands).toContainEqual(
      expect.stringMatching(
        new RegExp(`^\\[con_id=\\d+\\] move container to workspace bot-${SURFACE_ID}$`),
      ),
    );
    expect(commands).toContainEqual(
      expect.stringMatching(
        new RegExp(`^\\[con_id=\\d+\\] move container to workspace bot-${SURFACE_B}$`),
      ),
    );
  } finally {
    await Promise.allSettled([fixture.runtime.stop(), second.stop()]);
  }
});

/** The fake pack binary: a bun script at `<root>/pack/<name>`. */
function packBinary(name: string, body: string): string {
  const directory = path.join(root!, "pack");
  mkdirSync(directory, { recursive: true });
  return executable(directory, name, `#!${process.execPath}\n${body}`);
}

/** A copy of a real shell, so a live process can be the pack by `/proc/<pid>/exe`. */
function packIdentity(): string {
  const shell = Bun.which("bash", { PATH: "/usr/bin:/bin" });
  if (shell === null) throw new Error("the fixture needs bash");
  const target = path.join(root!, "pack", "pack-identity");
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(shell, target);
  chmodSync(target, 0o755);
  return target;
}

/** Whether a spawned child ended within `waitMs`; a signalled child settles `exited`. */
async function settled(child: { exited: Promise<number> }, waitMs = 2_000): Promise<"exited" | "alive"> {
  return await Promise.race([
    child.exited.then(() => "exited" as const),
    Bun.sleep(waitMs).then(() => "alive" as const),
  ]);
}

/** Polls `read` until it has a value, so a wait for a process state never becomes a sleep. */
async function waitFor<T>(read: () => T | undefined, message: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${message}`);
}

/**
 * Pids whose command line names `--user-data-dir=<profile>`: the pack launches
 * that hold the profile, as opposed to the windows they map.
 */
function profileHolders(profile: string): number[] {
  const argument = `--user-data-dir=${profile}`;
  const holders: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline: string;
    try { cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8"); } catch { continue; }
    if (cmdline.split("\0").includes(argument)) holders.push(Number(entry));
  }
  return holders;
}

test("a browser tool call replaces the pipe-less pack that holds the profile singleton", async () => {
  const fixture = await startControlRuntime();
  const identity = packIdentity();
  // The replacement pack is the fixture's stamp-capable browser. `identity` is only
  // the executable the orphan sweep recognises as the pack, so the pipe-less process
  // holding the profile below is the one it must stop.
  const { browserBin } = await fixture.assets.ensureBrowser();
  fixture.assets.ensureBrowser = async () => ({ browserBin, executable: identity });
  const profile = path.join(root!, "profiles", "computer", "config", "omarchy-bot-browser");
  mkdirSync(profile, { recursive: true });
  // What a Service restart leaves behind: a pack holding the profile with no CDP pipe.
  const pipeLess = Bun.spawn([identity, "-c", "sleep 60 & wait", "sh", `--user-data-dir=${profile}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const result = await fixture.runtime.browser!(
      { name: "tabs", args: {} } as Parameters<NonNullable<BotScreenRuntime["browser"]>>[0],
      async () => { throw new Error("unexpected input"); },
      new AbortController().signal,
    );
    // The orphan was replaced by the piped pack, and the tool lists its page.
    expect(result.text).toMatch(/control-page-\d+/);
    expect(await settled(pipeLess)).toBe("exited");
  } finally {
    pipeLess.kill("SIGKILL");
    await pipeLess.exited;
    await fixture.runtime.stop();
  }
}, 20_000);

test("a pack that exits during startup reports its stderr at once instead of waiting out the timeout", async () => {
  const fixture = await startControlRuntime();
  fixture.assets.ensureBrowser = async () => ({
    browserBin: packBinary("doomed-pack", `
process.stderr.write("boom\\n");
process.exit(1);
`),
  });
  try {
    const started = Date.now();
    const outcome = await fixture.runtime.launch({ url: "https://example.com/doomed" }).then(
      () => "launched",
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/^The browser exited during startup \(code 1\): boom$/);
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);

test("a forwarding child that exits after the running pack claims its window is not a startup failure", async () => {
  const fixture = await startControlRuntime();
  const profile = path.join(root!, "profiles", "computer", "config", "omarchy-bot-browser");
  try {
    await expect(fixture.runtime.launch({ url: "https://example.com/running" }))
      .resolves.toEqual({ text: "opened https://example.com/running" });
    const running = (await fixture.runtime.listWindows()).filter((window) => window.title === "Portable Browser");
    expect(running).toHaveLength(1);
    const packPid = running[0]!.pid!;
    // Chromium hands the URL to the running pack and this launch exits by design.
    // Observe the exit while the launch is still pending: a fast-fail that ignored
    // pipe ownership would reject this launch instead of letting it resolve.
    const forwarded = fixture.runtime.launch({ url: "https://example.com/handoff" })
      .then((value) => ({ value }), (error: Error) => ({ error }));
    expect(await waitFor(() => {
      const holders = profileHolders(profile);
      return holders.length === 1 ? holders : undefined;
    }, "the forwarding child to exit")).toEqual([packPid]);
    expect(await forwarded).toEqual({ value: { text: "opened https://example.com/handoff" } });
    expect(fixture.assets.browserLaunches()).toHaveLength(2);
    const packWindows = (await fixture.runtime.listWindows()).filter((window) => window.pid === packPid);
    expect(packWindows.map((window) => window.title)).toEqual(["Portable Browser", "Portable Browser"]);
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);

test("a second open_url leaves the pack launched by the first one running", async () => {
  const fixture = await startControlRuntime();
  const { browserBin } = await fixture.assets.ensureBrowser();
  fixture.assets.ensureBrowser = async () => ({
    browserBin,
    // The pack identity makes the orphan sweep able to see this pack at all.
    executable: packIdentity(),
  });
  try {
    await expect(fixture.runtime.launch({ url: "https://example.com/first" }))
      .resolves.toEqual({ text: "opened https://example.com/first" });
    const running = (await fixture.runtime.listWindows()).filter((window) => window.title === "Portable Browser");
    expect(running).toHaveLength(1);
    const packPid = running[0]!.pid!;
    // Every piped launch sweeps orphan packs first, and this Service's own live pack
    // holds the CDP pipe, so the sweep must leave it alone: the second open_url hands
    // off to it and answers normally instead of replacing it.
    const second = await fixture.runtime.launch({ url: "https://example.com/second" }).catch(
      (error: unknown) => error,
    );
    expect(() => process.kill(packPid, 0)).not.toThrow();
    expect(second).toEqual({ text: "opened https://example.com/second" });
  } finally {
    await fixture.runtime.stop();
  }
}, 20_000);
