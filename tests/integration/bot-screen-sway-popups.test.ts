import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SwayBotScreenRuntimeAdapter,
  type SwayAdapterOptions,
} from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import type {
  BotScreenProvision,
  BotScreenRuntime,
} from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import {
  listApplicationToplevels,
} from "../../apps/daemon/src/modules/computer/swayIpc.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import type { ComputerWindowListItem } from "../../packages/agent-contract/src/computer-protocol.ts";
import {
  mapFakeSwayWindow,
  readFakeSwayCommands,
  readFakeSwayEventDeliveries,
  readFakeSwaySubscriptions,
  writeFakeSwayIpcMode,
  writeFakeSwayTree,
  writeFakeSwayWindowEvent,
} from "./helpers/fakeSwayIpc.ts";
import { createFixtureAssetSupply } from "./helpers/botComputerAssetsFixture.ts";
import { ScreenInputLease } from "../../apps/daemon/src/modules/computer/screenInputLease.ts";
import { WindowOwnership, type OwnedWindow } from "../../apps/daemon/src/modules/computer/windowOwnership.ts";

const SURFACE_A = "surf_55555555555555555555555555555555" as SurfaceId;
const SURFACE_B = "surf_66666666666666666666666666666666" as SurfaceId;
const LAUNCHED_WINDOW_ID = 900;
const FORWARDED_WINDOW_ID = 901;
const POPUP_WINDOW_ID = 40;
const SECOND_POPUP_WINDOW_ID = 41;
const UNRELATED_WINDOW_ID = 50;
const UNRELATED_PID = 424242;
/** The CDP browser windows the fake pages live in; one per launched window. */
const FIRST_BROWSER_WINDOW = 701;
const SECOND_BROWSER_WINDOW = 702;
const FIRST_POPUP_WINDOW = 703;
const SECOND_POPUP_WINDOW = 704;

const SCREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWMQMgn7D8IAC5MDN627upEAAAAASUVORK5CYII=",
  "base64",
);

interface FakePage {
  targetId: string;
  title: string;
  url: string;
  windowId: number;
  /** Always `page`; stated so the fake's `Target.getTargets` reply matches Chromium. */
  type?: "page";
  openerId?: string;
  /** Window lookups that fail first, modelling a target Chromium has not placed yet. */
  failLookups?: number;
  /** Window lookups that never answer, modelling a hung CDP pipe. */
  hangLookups?: number;
  /** Window lookups answered late, modelling a browser that is slow to place a target. */
  slowLookups?: number;
  holdLookup?: boolean;
  refuseStamp?: boolean;
}

interface CdpControl {
  statePath: string;
  commandsPath: string;
  eventsPath: string;
  logPath: string;
  treePath: string;
}

function provision(surfaceId: SurfaceId): BotScreenProvision {
  return {
    surfaceId,
    geometryGeneration: 7,
    logicalWidth: 2,
    logicalHeight: 1,
    scale: 1,
    refreshRate: 15,
  };
}

function initialTree(surfaceIds: readonly SurfaceId[]): unknown {
  return {
    id: 1,
    type: "root",
    name: "root",
    nodes: [{
      id: 2,
      type: "output",
      name: "HEADLESS-1",
      nodes: surfaceIds.map((surfaceId, index) => ({
        id: 3 + index,
        type: "workspace",
        name: `bot-${surfaceId}`,
        nodes: [],
        floating_nodes: [],
      })),
      floating_nodes: [],
    }],
    floating_nodes: [],
  };
}

function executable(directory: string, name: string, body: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, body);
  chmodSync(target, 0o700);
  return target;
}

/**
 * A pack browser whose CDP state and events the test drives: it re-reads its
 * pages on every request and forwards appended `cdp-events.jsonl` lines as CDP
 * events, so a page can be opened long after the browser started. A second cold
 * launch of the same profile is Chromium's forwarding launch: it maps a new
 * window and adds its page, then exits without a pipe of its own.
 */
function browserScript(control: CdpControl, nativeTitleSuffix: string): string {
  return `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { runInNewContext } from "node:vm";
import { updateFakeSwayTree } from ${JSON.stringify(path.resolve(import.meta.dir, "helpers/fakeSwayIpc.ts"))};
const controlDir = ${JSON.stringify(path.dirname(control.treePath))};
const swayEventsPath = ${JSON.stringify(path.join(path.dirname(control.treePath), "events.jsonl"))};
const treePath = ${JSON.stringify(control.treePath)};
const statePath = ${JSON.stringify(control.statePath)};
const commandsPath = ${JSON.stringify(control.commandsPath)};
const eventsPath = ${JSON.stringify(control.eventsPath)};
const logPath = ${JSON.stringify(control.logPath)};
const children = (node, out) => {
  if (node === null || typeof node !== "object") return out;
  out.push(node);
  for (const key of ["nodes", "floating_nodes"]) {
    if (!Array.isArray(node[key])) continue;
    for (const child of node[key]) children(child, out);
  }
  return out;
};
const readTree = () => JSON.parse(readFileSync(treePath, "utf8"));
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const botWorkspace = (tree) => children(tree, []).find(
  (node) => node.type === "workspace" && typeof node.name === "string" && node.name.startsWith("bot-"),
);
const mapWindow = (_tree, id, title, workspace, pid) => {
  let container;
  updateFakeSwayTree(controlDir, tree => {
    const currentWorkspace = children(tree, []).find(node => node.type === "workspace" && node.name === workspace?.name);
    if (!currentWorkspace || !Array.isArray(currentWorkspace.nodes)) return tree;
    container = {
      id, type: "con", name: title, app_id: "chromium", pid,
      focused: true, visible: true, shell: "xdg_shell",
      rect: { x: 0, y: 0, width: 800, height: 600 }, nodes: [], floating_nodes: [],
    };
    currentWorkspace.nodes.push(container);
    return tree;
  });
  if (container) appendFileSync(swayEventsPath, JSON.stringify({ change: "new", container }) + "\\n");
};
appendFileSync(logPath, JSON.stringify(process.argv.slice(1)) + "\\n");
const mapped = children(readTree(), []).filter((node) => node.type === "con");
if (mapped.some((node) => node.id === ${FORWARDED_WINDOW_ID})) process.exit(0);
const running = mapped.find((node) => node.id === ${LAUNCHED_WINDOW_ID});
if (running !== undefined) {
  const state = readState();
  if (!state.pages.some((page) => page.targetId === "page-2")) {
    state.pages.push({ targetId: "page-2", type: "page", title: "about:blank", url: "about:blank", windowId: ${SECOND_BROWSER_WINDOW} });
    writeFileSync(statePath, JSON.stringify(state));
    appendFileSync(eventsPath, JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: state.pages.at(-1) } }) + "\\n");
  }
  // A forwarding launch opens the window in the running pack browser, under its pid.
  const forwarded = readTree();
  mapWindow(forwarded, ${FORWARDED_WINDOW_ID}, "about:blank - Chromium", botWorkspace(forwarded), running.pid);
  process.exit(0);
}
const launchedTree = readTree();
mapWindow(launchedTree, ${LAUNCHED_WINDOW_ID}, "about:blank", botWorkspace(launchedTree), process.pid);
const reply = (message) => writeSync(4, JSON.stringify(message) + String.fromCharCode(0));
const nativeIds = { ${FIRST_BROWSER_WINDOW}: ${LAUNCHED_WINDOW_ID}, ${SECOND_BROWSER_WINDOW}: ${FORWARDED_WINDOW_ID}, ${FIRST_POPUP_WINDOW}: ${POPUP_WINDOW_ID}, ${SECOND_POPUP_WINDOW}: ${SECOND_POPUP_WINDOW_ID} };
const propagateTitles = () => {
  const state = readState();
  updateFakeSwayTree(controlDir, tree => {
    for (const page of state.pages) {
      const node = children(tree, []).find(node => node.id === nativeIds[page.windowId]);
      const nativeTitle = page.title + ${JSON.stringify(nativeTitleSuffix)};
      if (!node || node.name === nativeTitle) continue;
      node.name = nativeTitle;
      appendFileSync(swayEventsPath, JSON.stringify({ change: "title", container: node }) + "\\n");
    }
    return tree;
  });
};
const handle = (command) => {
  const params = command.params ?? {};
  const pages = readState().pages;
  switch (command.method) {
    case "SystemInfo.getProcessInfo":
      return { processInfo: [{ type: "browser", id: process.pid }] };
    case "Target.setDiscoverTargets":
      for (const page of pages) reply({ method: "Target.targetCreated", params: { targetInfo: page } });
      return {};
    case "Target.getTargets":
      return { targetInfos: pages.map(({ windowId, ...page }) => page) };
    case "Browser.getWindowForTarget": {
      const page = pages.find((candidate) => candidate.targetId === params.targetId);
      if (page === undefined) throw new Error("No target with given id");
      const settle = (fields) => {
        Object.assign(page, fields);
        writeFileSync(statePath, JSON.stringify({ pages }));
      };
      if (page.holdLookup) {
        const timer = setInterval(() => {
          if (readState().pages.find(candidate => candidate.targetId === page.targetId)?.holdLookup) return;
          clearInterval(timer);
          reply({ id: command.id, result: { windowId: page.windowId, bounds: { width: 800, height: 600 } } });
        }, 10);
        return undefined;
      }
      if ((page.hangLookups ?? 0) > 0) {
        // No reply at all: the caller's deadline is the only escape.
        settle({ hangLookups: page.hangLookups - 1 });
        return undefined;
      }
      if ((page.slowLookups ?? 0) > 0) {
        settle({ slowLookups: page.slowLookups - 1 });
        setTimeout(() => reply({ id: command.id, result: { windowId: page.windowId, bounds: { left: 0, top: 0, width: 800, height: 600 } } }), 400);
        return undefined;
      }
      if ((page.failLookups ?? 0) > 0) {
        settle({ failLookups: page.failLookups - 1 });
        throw new Error("Browser window for target is not available yet");
      }
      return { windowId: page.windowId, bounds: { left: 0, top: 0, width: 800, height: 600 } };
    }
    case "Target.attachToTarget":
      return { sessionId: "session-" + params.targetId };
    case "Page.enable":
      return {};
    case "Page.getFrameTree":
      return { frameTree: { frame: { id: "frame-1", loaderId: "load-1" } } };
    case "Page.createIsolatedWorld":
      return { executionContextId: 1 };
    case "Runtime.evaluate": {
      const page = pages.find(page => command.sessionId === "session-" + page.targetId);
      if (!page) throw new Error("No target with given id");
      const expression = String(params.expression);
      if (expression.includes("document.visibilityState")) return { result: { value: true } };
      const document = {
        get title() { return page.title; },
        set title(value) { if (!page.refuseStamp) page.title = value; },
      };
      const value = runInNewContext(expression, { document });
      writeFileSync(statePath, JSON.stringify({ pages }));
      propagateTitles();
      return { result: { value } };
    }
    default:
      return {};
  }
};
let pending = "";
createReadStream(null, { fd: 3, autoClose: false })
  .on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let end = pending.indexOf(String.fromCharCode(0));
    while (end >= 0) {
      const raw = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (raw !== "") {
        const command = JSON.parse(raw);
        appendFileSync(commandsPath, JSON.stringify({ method: command.method, params: command.params ?? {} }) + "\\n");
        try {
          const result = handle(command);
          // A handler that returns nothing defers its own reply, or never sends one.
          if (result !== undefined) reply({ id: command.id, result });
        }
        catch (error) { reply({ id: command.id, error: { message: String(error?.message ?? error) } }); }
      }
      end = pending.indexOf(String.fromCharCode(0));
    }
  })
  .on("error", () => process.exit(0))
  .on("end", () => process.exit(0));
let eventsOffset = existsSync(eventsPath) ? readFileSync(eventsPath).byteLength : 0;
setInterval(() => {
  propagateTitles();
  if (!existsSync(eventsPath)) return;
  const bytes = readFileSync(eventsPath);
  if (bytes.byteLength <= eventsOffset) return;
  const chunk = bytes.subarray(eventsOffset);
  eventsOffset = bytes.byteLength;
  for (const line of chunk.toString("utf8").split("\\n")) {
    if (line === "") continue;
    writeSync(4, line + String.fromCharCode(0));
    appendFileSync(eventsPath + ".delivered", line + "\\n");
  }
}, 10);
`;
}

interface PopupFixture {
  controlDir: string;
  cdp: CdpControl;
  options: SwayAdapterOptions;
  newAdapter(): SwayBotScreenRuntimeAdapter;
  /** Starts the fixture's Screens on one Bot Computer, in the given order. */
  start(surfaceIds?: readonly SurfaceId[]): Promise<Map<SurfaceId, BotScreenRuntime>>;
  browserPid(): number;
  /** Announces a page the browser opened and waits until it is a pending pop-up. */
  openPopup(page: FakePage & { openerId: string }): Promise<void>;
  /** Adds a page target without announcing an opener, e.g. a window nothing attributes. */
  addPage(page: FakePage, announce?: boolean): void;
  /** Changes a page's CDP behaviour, e.g. makes its window lookup hang. */
  patchPage(targetId: string, fields: Partial<FakePage>): void;
  /** Every CDP command the browser has received, in order. */
  cdpCommands(): Array<{ method: string; params: Record<string, unknown> }>;
  /** Window lookups the browser has served for one target, in any context. */
  windowLookups(targetId: string): number;
  workspaceWindowIds(surfaceId: SurfaceId): string[];
  stop(runtimes: Iterable<BotScreenRuntime>): Promise<void>;
  dispose(): void;
}

let root: string | undefined;
const runtimesToStop = new Set<BotScreenRuntime>();
const originalPath = process.env.PATH;
const originalDataDirs = process.env.XDG_DATA_DIRS;

afterEach(async () => {
  await Promise.allSettled([...runtimesToStop].map(runtime => runtime.stop()));
  runtimesToStop.clear();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalDataDirs === undefined) delete process.env.XDG_DATA_DIRS;
  else process.env.XDG_DATA_DIRS = originalDataDirs;
});

async function createPopupFixture(surfaceIds: readonly SurfaceId[] = [SURFACE_A], nativeTitleSuffix = ""): Promise<PopupFixture> {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-popups-"));
  root = rootDir;
  const bin = path.join(rootDir, "bin");
  const controlDir = path.join(rootDir, "ipc-control");
  const applicationCwd = path.join(rootDir, "workspace");
  const png = path.join(rootDir, "screen.png");
  mkdirSync(bin);
  mkdirSync(controlDir);
  mkdirSync(applicationCwd);
  writeFileSync(png, SCREEN_PNG);
  writeFakeSwayTree(controlDir, initialTree(surfaceIds));
  writeFakeSwayIpcMode(controlDir, "ok");
  process.env.XDG_DATA_DIRS = path.join(rootDir, "host-data");
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

  const cdp: CdpControl = {
    statePath: path.join(controlDir, "cdp.json"),
    commandsPath: path.join(controlDir, "cdp-commands.jsonl"),
    eventsPath: path.join(controlDir, "cdp-events.jsonl"),
    treePath: path.join(controlDir, "tree.json"),
    logPath: path.join(rootDir, "browser.log"),
  };
  writeFileSync(cdp.statePath, JSON.stringify({
    pages: [{ targetId: "page-1", type: "page", title: "about:blank", url: "about:blank", windowId: FIRST_BROWSER_WINDOW }],
  }));
  writeFileSync(cdp.eventsPath, "");

  const helperPath = path.resolve(import.meta.dir, "helpers/fakeSwayIpc.ts");
  const sway = executable(bin, "sway", `#!${process.execPath}
import path from "node:path";
import { serveFakeSwayIpc } from ${JSON.stringify(helperPath)};
const runtimeDir = process.env.XDG_RUNTIME_DIR ?? "";
const wayland = path.join(runtimeDir, "wayland-0");
const swaySock = process.env.SWAYSOCK ?? path.join(runtimeDir, "sway-ipc.sock");
Bun.listen({ unix: wayland, socket: { data() {} } });
await serveFakeSwayIpc({
  socketPath: swaySock,
  controlDir: ${JSON.stringify(controlDir)},
});
`);
  const assets = createFixtureAssetSupply({
    directory: path.join(rootDir, "assets"),
    browserScript: () => browserScript(cdp, nativeTitleSuffix),
  });
  const options: SwayAdapterOptions = {
    runtimeRoot: path.join(rootDir, "runtime"),
    profileRoot: path.join(rootDir, "profiles"),
    applicationCwd,
    assetSupply: assets,
    swayBin: sway,
    wlrRandrBin: executable(bin, "wlr-randr", "#!/bin/sh\nexit 0\n"),
    grimBin: executable(bin, "grim", `#!/bin/sh\ncat ${JSON.stringify(png)}\n`),
    inputHelperBin: executable(bin, "input", [
      "#!/bin/sh",
      "printf 'READY\\n'",
      "while IFS=' ' read -r command request rest; do",
      "  printf 'OK %s\\n' \"$request\"",
      "done",
      "",
    ].join("\n")),
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
  };
  const cdpCommands = (): Array<{ method: string; params: Record<string, unknown> }> =>
    !existsSync(cdp.commandsPath)
      ? []
      : readFileSync(cdp.commandsPath, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  const addPage = (page: FakePage, announce = false): void => {
    const state = JSON.parse(readFileSync(cdp.statePath, "utf8")) as { pages: FakePage[] };
    state.pages.push({ type: "page", ...page });
    writeFileSync(cdp.statePath, JSON.stringify(state));
    if (announce) emit({ method: "Target.targetCreated", params: { targetInfo: { type: "page", ...page } } });
  };
  const windowLookups = (targetId: string): number => cdpCommands().filter(
    (command) => command.method === "Browser.getWindowForTarget"
      && command.params.targetId === targetId,
  ).length;
  const emit = (event: Record<string, unknown>): void =>
    appendFileSync(cdp.eventsPath, `${JSON.stringify(event)}\n`);
  /** Announces a popup; stamp-write traffic is the pending-attribution barrier. */
  const openPopup = async (page: FakePage & { openerId: string }): Promise<void> => {
    addPage(page);
    emit({ method: "Target.targetCreated", params: { targetInfo: { type: "page", ...page } } });
    await waitFor(() => cdpCommands().some(command => command.method === "Target.attachToTarget"
      && command.params.targetId === page.targetId) ? true : undefined, `pending attribution for ${page.targetId}`);
  };
  return {
    controlDir,
    cdp,
    options,
    newAdapter: () => new SwayBotScreenRuntimeAdapter(options),
    start: async (targets = surfaceIds) => {
      const adapter = new SwayBotScreenRuntimeAdapter(options);
      const started = new Map<SurfaceId, BotScreenRuntime>();
      for (const surfaceId of targets) {
        const runtime = await adapter.start(provision(surfaceId));
        runtimesToStop.add(runtime);
        started.set(surfaceId, runtime);
      }
      return started;
    },
    browserPid: () => {
      const window = listApplicationToplevels(JSON.parse(readFileSync(cdp.treePath, "utf8")) as unknown)
        .find((candidate) => candidate.id === String(LAUNCHED_WINDOW_ID));
      if (window?.pid === undefined) throw new Error("fixture browser window is missing");
      return window.pid;
    },
    openPopup,
    addPage,
    cdpCommands,
    windowLookups,
    patchPage: (targetId, fields) => {
      const state = JSON.parse(readFileSync(cdp.statePath, "utf8")) as { pages: FakePage[] };
      const page = state.pages.find((candidate) => candidate.targetId === targetId);
      if (page === undefined) throw new Error(`fixture has no page ${targetId}`);
      Object.assign(page, fields);
      writeFileSync(cdp.statePath, JSON.stringify(state));
    },
    workspaceWindowIds: (surfaceId) => listApplicationToplevels(
      JSON.parse(readFileSync(cdp.treePath, "utf8")) as unknown,
    ).filter((window) => window.workspace === `bot-${surfaceId}`).map((window) => window.id),
    stop: async (runtimes) => {
      await Promise.allSettled([...runtimes].map((runtime) => runtime.stop()));
    },
    dispose: () => {
      rmSync(rootDir, { recursive: true, force: true });
      if (root === rootDir) root = undefined;
    },
  };
}

function windowContainer(
  id: number,
  pid: number,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "con",
    name: "about:blank",
    app_id: "chromium",
    pid,
    focused: false,
    visible: true,
    shell: "xdg_shell",
    rect: { x: 0, y: 0, width: 800, height: 600 },
    nodes: [],
    floating_nodes: [],
    ...fields,
  };
}

function popupContainer(id: number, pid: number, name: string): Record<string, unknown> {
  return windowContainer(id, pid, { type: "floating_con", name });
}

async function waitFor<T>(read: () => T | undefined, message: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${message}`);
}

function subscriptionLines(controlDir: string, kind: string): string[] {
  return readFakeSwaySubscriptions(controlDir).filter((line) => line === kind);
}

/** Lists the tabs one Screen's Browser Tool binds, failing the way the Agent sees it. */
async function tabs(runtime: BotScreenRuntime): Promise<string> {
  const result = await runtime.browser!(
    { name: "tabs", args: { operation: "list" } },
    async () => {},
    AbortSignal.timeout(10_000),
  );
  return result.text;
}

test("a browser window with no launch claim and no pending pop-up is parked unowned", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  try {
    await runtime.launch({ url: "about:blank" });
    const browserPid = fixture.browserPid();
    mapFakeSwayWindow(
      fixture.controlDir,
      popupContainer(POPUP_WINDOW_ID, browserPid, "Popup"),
      `bot-${SURFACE_A}`,
    );
    await waitFor(
      () => readFakeSwayCommands(fixture.controlDir).includes(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`)
        ? true
        : undefined,
      "the unowned window to reach the scratchpad",
    );
    expect(await runtime.listWindows()).not.toContainEqual(expect.objectContaining({ id: String(POPUP_WINDOW_ID) }));
    expect(runtime.browser).toBeDefined();
    const text = await tabs(runtime);
    expect(text).toContain("page-1");
    expect(text).not.toContain("popup-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
});

test("a launched window is claimed by its launch and appears in that Screen's tabs", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  try {
    await runtime.launch({ url: "about:blank" });
    // A successful launch returns only after the exact stamped window is bound.
    await waitFor(
      () => fixture.windowLookups("page-1") > 0 ? true : undefined,
      "the launch to bind its browser window",
    );
    const browserPid = fixture.browserPid();
    writeFakeSwayWindowEvent(fixture.controlDir, windowContainer(LAUNCHED_WINDOW_ID, browserPid));
    await waitFor(
      () => readFakeSwayEventDeliveries(fixture.controlDir).includes(String(LAUNCHED_WINDOW_ID)) ? true : undefined,
      "the launched window event to reach the subscription",
    );
    await Bun.sleep(100);
    expect(readFakeSwayCommands(fixture.controlDir))
      .toContain(`[con_id=${LAUNCHED_WINDOW_ID}] move scratchpad`);
    // The launch claim also binds the Chromium window, so the Browser Tool lists it.
    expect(await tabs(runtime)).toContain("page-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
});

test("a slow launch bind is awaited before the Browser Tool lists the Screen's tabs", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  try {
    // The bind's window lookup answers late, so a Browser Tool request that scoped
    // before the bind finished would find no owned window and fail.
    fixture.patchPage("page-1", { slowLookups: 1 });
    await runtime.launch({ url: "about:blank" });
    expect(await tabs(runtime)).toContain("page-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
});

test("cancelling a Browser Tool auto-launch cancels its stamp and forbids late registration", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  const caller = new AbortController();
  try {
    fixture.patchPage("page-1", { slowLookups: 1 });
    const listing = runtime.browser!(
      { name: "tabs", args: { operation: "list" } }, async () => {}, caller.signal,
    ).catch(error => error);
    await waitFor(() => fixture.windowLookups("page-1") === 1 ? true : undefined, "launch attribution's delayed liveness reply");
    caller.abort(new Error("caller stopped auto-launch"));
    expect((await listing).message).toBe("caller stopped auto-launch");
    // The fixture replies after 400ms. Let that authoritative late reply arrive;
    // cancellation must prevent attaching, stamping and registering afterwards.
    await Bun.sleep(500);
    expect(fixture.cdpCommands().filter(command => command.method === "Target.attachToTarget")).toEqual([]);
    expect(treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID))?.workspace).toBe("__i3_scratch");
    expect(readFakeSwayCommands(fixture.controlDir)).not.toContain(`[con_id=${LAUNCHED_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`);
    expect(treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID))?.title).toBe("about:blank");
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("a cancelled Browser Tool waiter does not wait for another call's pending launch binding", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  const caller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    fixture.patchPage("page-1", { refuseStamp: true });
    const launching = runtime.launch({ url: "about:blank" }).catch(error => error);
    await waitFor(() => fixture.cdpCommands().some(command => command.method === "Runtime.evaluate"
      && String(command.params.expression).startsWith('document.title = "omarchy-bot-window-')) ? true : undefined, "pending launch binding");
    const listing = runtime.browser!(
      { name: "tabs", args: { operation: "list" } }, async () => {}, caller.signal,
    ).catch(error => error);
    caller.abort(new Error("caller stopped waiting for launch"));
    const result = await Promise.race([
      listing,
      new Promise<Error>(resolve => { timer = setTimeout(() => resolve(new Error("waiter ignored cancellation")), 500); }),
    ]);
    expect(result.message).toBe("caller stopped waiting for launch");
    expect((await launching).retryable).toBe(true);
    expect(treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID))?.workspace).toBe("__i3_scratch");
  } finally { clearTimeout(timer); await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 10_000);

test("an open_url window is bound by its launch and appears in the Screen's tabs", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  try {
    const url = "https://example.com/opened";
    await expect(runtime.launch({ url })).resolves.toEqual({ text: `opened ${url}` });
    const launches = readFileSync(path.join(fixture.cdp.logPath), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
    expect(launches.some((argv) => argv.includes(url))).toBe(true);
    expect(fixture.workspaceWindowIds(SURFACE_A)).toContain(String(LAUNCHED_WINDOW_ID));
    await waitFor(
      () => fixture.windowLookups("page-1") > 0 ? true : undefined,
      "the launch to bind its browser window",
    );
    expect(await tabs(runtime)).toContain("page-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
});

test("a window event for a non-pack-browser pid is ignored", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  try {
    mapFakeSwayWindow(
      fixture.controlDir,
      windowContainer(UNRELATED_WINDOW_ID, UNRELATED_PID, {
        name: "Editor",
        app_id: "fixture-editor",
        type: "floating_con",
      }),
      `bot-${SURFACE_A}`,
    );
    await waitFor(
      () => readFakeSwayEventDeliveries(fixture.controlDir).includes(String(UNRELATED_WINDOW_ID)) ? true : undefined,
      "the unrelated window event to reach the subscription",
    );
    await Bun.sleep(100);
    expect(readFakeSwayCommands(fixture.controlDir))
      .not.toContainEqual(expect.stringContaining(`[con_id=${UNRELATED_WINDOW_ID}]`));
    expect((await runtime.listWindows()).map((window) => window.id)).toContain(String(UNRELATED_WINDOW_ID));
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
});

test("window events are subscribed on start and reconcile and closed on teardown", async () => {
  const fixture = await createPopupFixture();
  const firstAdapter = fixture.newAdapter();
  const first = await firstAdapter.start(provision(SURFACE_A));
  runtimesToStop.add(first);
  const recovered = await fixture.newAdapter().reconcile?.(provision(SURFACE_A));
  if (recovered) runtimesToStop.add(recovered);
  expect(recovered).toBeDefined();
  await waitFor(
    () => subscriptionLines(fixture.controlDir, "subscribe").length === 2 ? true : undefined,
    "both adapters to subscribe to window events",
  );
  expect(subscriptionLines(fixture.controlDir, "close")).toHaveLength(0);
  await recovered!.stop();
  await waitFor(
    () => subscriptionLines(fixture.controlDir, "close").length > 0 ? true : undefined,
    "the stopped Bot Computer to close its window subscription",
  );
  await first.stop().catch(() => {});
  fixture.dispose();
});

/** Starts one Bot Computer with a launched browser window on each Screen. */
async function startTwoScreens(fixture: PopupFixture): Promise<{
  runtimes: Map<SurfaceId, BotScreenRuntime>;
  a: BotScreenRuntime;
  b: BotScreenRuntime;
}> {
  const runtimes = await fixture.start([SURFACE_A, SURFACE_B]);
  const a = runtimes.get(SURFACE_A)!;
  const b = runtimes.get(SURFACE_B)!;
  await a.launch({ url: "about:blank" });
  // The pack browser holds one profile, so the second Screen's open_url forwards
  // into it: a new window appears and the launch claims it onto B's workspace.
  await b.launch({ url: "about:blank" });
  expect(fixture.workspaceWindowIds(SURFACE_A)).toContain(String(LAUNCHED_WINDOW_ID));
  expect(fixture.workspaceWindowIds(SURFACE_B)).toContain(String(FORWARDED_WINDOW_ID));
  return { runtimes, a, b };
}

test("a pop-up opened from Screen A lands on Screen A while Screen B has focus", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    // B holds the shared seat, so Sway maps A's pop-up on B's workspace.
    await b.setInputAuthority(1);
    expect(readFakeSwayCommands(fixture.controlDir)).toContain(`workspace bot-${SURFACE_B}`);
    const before = readFakeSwayCommands(fixture.controlDir).length;
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Popup", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup"), `bot-${SURFACE_B}`);
    await waitFor(
      () => readFakeSwayCommands(fixture.controlDir)
        .includes(`[con_id=${POPUP_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`) ? true : undefined,
      "the pop-up to be routed to its opener's Screen",
    );
    expect(readFakeSwayCommands(fixture.controlDir))
      .toContain(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`);
    expect(fixture.workspaceWindowIds(SURFACE_B)).not.toContain(String(POPUP_WINDOW_ID));
    expect(await tabs(a)).toContain("popup-1");
    expect(await tabs(b)).not.toContain("popup-1");
    expect(fixture.workspaceWindowIds(SURFACE_A)).toContain(String(POPUP_WINDOW_ID));
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.title).toBe("Popup");
    expect(readFakeSwayCommands(fixture.controlDir).slice(before).filter(command => command.startsWith("workspace ") || command.endsWith("] focus"))).toEqual([]);
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 30_000);

test("pinned pack native title decoration attributes launches and popups and restores their real titles", async () => {
  const suffix = " - Google Chrome for Testing";
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B], suffix);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await b.setInputAuthority(1);
    const before = readFakeSwayCommands(fixture.controlDir).length;
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Popup", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), `Popup${suffix}`), `bot-${SURFACE_B}`);
    expect(await tabs(a)).toContain("popup-1");
    expect(await tabs(b)).not.toContain("popup-1");
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.title === `Popup${suffix}` ? true : undefined, "restored decorated native title");
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID)))
      .toMatchObject({ workspace: `bot-${SURFACE_A}`, title: `Popup${suffix}` });
    const state = JSON.parse(readFileSync(fixture.cdp.statePath, "utf8")) as { pages: FakePage[] };
    expect(state.pages.find(page => page.targetId === "popup-1")?.title).toBe("Popup");
    expect(state.pages.filter(page => page.targetId.startsWith("page-")).map(page => page.title)).toEqual(["about:blank", "about:blank"]);
    expect(readFakeSwayCommands(fixture.controlDir).slice(before)).toContain(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`);
    expect(readFakeSwayCommands(fixture.controlDir).slice(before).filter(command => command.startsWith("workspace ") || command.endsWith("] focus"))).toEqual([]);
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 30_000);

test("a scope snapshot preserves popup ownership completed while its CDP lookup is held", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  const completePendingTarget = WindowOwnership.prototype.completePendingTarget;
  let registration: { ownership: WindowOwnership; window: OwnedWindow } | undefined;
  const completed = spyOn(WindowOwnership.prototype, "completePendingTarget").mockImplementation(function (this: WindowOwnership, ...args) {
    const window = completePendingTarget.apply(this, args);
    if (window.targetId === "popup-1") registration = { ownership: this, window };
    return window;
  });
  let staleScope: Promise<string> | undefined;
  try {
    // Hold B's existing target after A's native snapshot, leaving A's opener
    // lookup free for the popup's independent attribution job.
    fixture.patchPage("page-2", { holdLookup: true });
    const before = fixture.windowLookups("page-2");
    staleScope = tabs(a);
    await waitFor(() => fixture.windowLookups("page-2") > before ? true : undefined, "scope lookup held after its native snapshot");
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Concurrent popup", url: "https://popup.example/concurrent", windowId: FIRST_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Concurrent popup"), `bot-${SURFACE_B}`);
    const registered = await waitFor(() => registration, "popup registration completed through the opener and stamp path");
    expect(registered.window).toEqual({ surfaceId: SURFACE_A, swayWindowId: String(POPUP_WINDOW_ID), browserWindowId: FIRST_POPUP_WINDOW, targetId: "popup-1" });
    expect(registered.ownership.ownerOfBrowserWindow(FIRST_POPUP_WINDOW)).toEqual(registered.window);
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))).toMatchObject({ workspace: `bot-${SURFACE_A}`, title: "Concurrent popup" });
    expect(readFakeSwayCommands(fixture.controlDir)).toContain(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`);

    fixture.patchPage("page-2", { holdLookup: false });
    await staleScope;
    expect(registered.ownership.ownerOfBrowserWindow(FIRST_POPUP_WINDOW)).toEqual(registered.window);
    expect(await tabs(a)).toContain("popup-1");
    expect(await tabs(b)).not.toContain("popup-1");
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))).toMatchObject({ workspace: `bot-${SURFACE_A}`, title: "Concurrent popup" });
  } finally {
    fixture.patchPage("page-2", { holdLookup: false });
    await staleScope?.catch(() => {});
    completed.mockRestore();
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 15_000);

test("a popup opened by a still-pending popup inherits its Screen before either window maps", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Pending opener", url: "https://popup.example/parent", windowId: FIRST_POPUP_WINDOW });
    // Neither native popup exists yet: the opener has only a pending owner.
    expect(treeWindows(fixture).some(window => window.id === String(POPUP_WINDOW_ID))).toBe(false);
    await fixture.openPopup({ targetId: "popup-2", openerId: "popup-1", title: "Child", url: "https://popup.example/child", windowId: SECOND_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Child"), `bot-${SURFACE_B}`);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Pending opener"), `bot-${SURFACE_B}`);
    await waitFor(() => [POPUP_WINDOW_ID, SECOND_POPUP_WINDOW_ID].every(id => fixture.workspaceWindowIds(SURFACE_A).includes(String(id))) ? true : undefined, "both pending-opener popup windows on A");
    const ownTabs = await tabs(a);
    const otherTabs = await tabs(b);
    for (const targetId of ["popup-1", "popup-2"]) {
      expect(ownTabs).toContain(targetId);
      expect(otherTabs).not.toContain(targetId);
    }
    for (const id of [POPUP_WINDOW_ID, SECOND_POPUP_WINDOW_ID]) {
      expect(fixture.workspaceWindowIds(SURFACE_B)).not.toContain(String(id));
      expect(readFakeSwayCommands(fixture.controlDir)).toContain(`[con_id=${id}] move scratchpad`);
    }
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.title).toBe("Pending opener");
    expect(treeWindows(fixture).find(window => window.id === String(SECOND_POPUP_WINDOW_ID))?.title).toBe("Child");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 30_000);

test("nested popup discovery waits for its opener's in-flight owner lookup", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    fixture.patchPage("page-1", { holdLookup: true });
    const before = fixture.windowLookups("page-1");
    fixture.addPage({ targetId: "popup-1", openerId: "page-1", title: "Parent", url: "about:blank", windowId: FIRST_POPUP_WINDOW }, true);
    fixture.addPage({ targetId: "popup-2", openerId: "popup-1", title: "Child", url: "about:blank", windowId: SECOND_POPUP_WINDOW }, true);
    await waitFor(() => fixture.windowLookups("page-1") > before && fixture.windowLookups("popup-1") > 0 ? true : undefined, "child lookup answered while parent lookup is held");
    expect(fixture.cdpCommands().filter(command => command.method === "Target.attachToTarget" && String(command.params.targetId).startsWith("popup-"))).toHaveLength(0);
    fixture.patchPage("page-1", { holdLookup: false });
    await waitFor(() => fixture.cdpCommands().filter(command => command.method === "Target.attachToTarget" && String(command.params.targetId).startsWith("popup-")).length === 2 ? true : undefined, "independent parent and child stamps");
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Child"), `bot-${SURFACE_B}`);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Parent"), `bot-${SURFACE_B}`);
    const own = await tabs(a);
    const other = await tabs(b);
    for (const target of ["popup-1", "popup-2"]) { expect(own).toContain(target); expect(other).not.toContain(target); }
    for (const [id, title] of [[POPUP_WINDOW_ID, "Parent"], [SECOND_POPUP_WINDOW_ID, "Child"]] as const) {
      expect(treeWindows(fixture).find(window => window.id === String(id))).toMatchObject({ workspace: `bot-${SURFACE_A}`, title });
      expect(readFakeSwayCommands(fixture.controlDir)).toContain(`[con_id=${id}] move scratchpad`);
      expect(fixture.workspaceWindowIds(SURFACE_B)).not.toContain(String(id));
    }
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("Screen closure cancels a nested popup's in-flight opener dependency", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    fixture.patchPage("page-1", { holdLookup: true });
    const before = fixture.windowLookups("page-1");
    fixture.addPage({ targetId: "popup-1", openerId: "page-1", title: "Parent", url: "about:blank", windowId: FIRST_POPUP_WINDOW }, true);
    fixture.addPage({ targetId: "popup-2", openerId: "popup-1", title: "Child", url: "about:blank", windowId: SECOND_POPUP_WINDOW }, true);
    await waitFor(() => fixture.windowLookups("page-1") > before && fixture.windowLookups("popup-1") > 0 ? true : undefined, "nested owner dependency");
    await a.stop();
    fixture.patchPage("page-1", { holdLookup: false });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Parent"), `bot-${SURFACE_B}`);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Child"), `bot-${SURFACE_B}`);
    expect(await tabs(b)).not.toMatch(/popup-[12]/);
    await waitFor(() => [POPUP_WINDOW_ID, SECOND_POPUP_WINDOW_ID].every(id => treeWindows(fixture).find(window => window.id === String(id))?.workspace === "__i3_scratch") ? true : undefined, "both cancelled popup windows parked");
    expect(fixture.cdpCommands().filter(command => command.method === "Target.attachToTarget" && String(command.params.targetId).startsWith("popup-"))).toEqual([]);
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("a pop-up target that resolves only on a retry is still attributed to its Screen", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({
      targetId: "popup-1",
      openerId: "page-1",
      title: "Popup",
      url: "https://popup.example/",
      windowId: FIRST_POPUP_WINDOW,
      failLookups: 1,
    });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup"), `bot-${SURFACE_B}`);
    await waitFor(
      () => fixture.workspaceWindowIds(SURFACE_A).includes(String(POPUP_WINDOW_ID)) ? true : undefined,
      "the pop-up to be confirmed and routed after a retry",
    );
    expect(readFakeSwayCommands(fixture.controlDir))
      .toContain(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`);
    expect(await tabs(a)).toContain("popup-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
});

test("pop-ups opened from two Screens each land on their own Screen", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    // Sequential routing is also supported; overlap has its own barrier test below.
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Popup A", url: "https://popup.example/a", windowId: FIRST_POPUP_WINDOW });
    // Sway maps it on B's workspace (the focused one); it must follow its opener.
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup A"), `bot-${SURFACE_B}`);
    await waitFor(
      () => readFakeSwayCommands(fixture.controlDir)
        .includes(`[con_id=${POPUP_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`) ? true : undefined,
      "the first pop-up to be routed to Screen A",
    );
    await fixture.openPopup({ targetId: "popup-2", openerId: "page-2", title: "Popup B", url: "https://popup.example/b", windowId: SECOND_POPUP_WINDOW });
    // Sway maps the second pop-up on the first Screen's workspace; it must follow its opener.
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Popup B"), `bot-${SURFACE_A}`);
    await waitFor(
      () => fixture.workspaceWindowIds(SURFACE_B).includes(String(SECOND_POPUP_WINDOW_ID)) ? true : undefined,
      "the second pop-up on Screen B's workspace",
    );
    expect(fixture.workspaceWindowIds(SURFACE_A)).toEqual(expect.arrayContaining([String(LAUNCHED_WINDOW_ID), String(POPUP_WINDOW_ID)]));
    expect(fixture.workspaceWindowIds(SURFACE_A)).not.toContain(String(SECOND_POPUP_WINDOW_ID));
    const aTabs = await tabs(a);
    const bTabs = await tabs(b);
    expect(aTabs).toContain("popup-1");
    expect(aTabs).not.toContain("popup-2");
    expect(bTabs).toContain("popup-2");
    expect(bTabs).not.toContain("popup-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 30_000);

test("a refusing page stays parked and errors the waiting Bot while every scope excludes it", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Refusing page", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW, refuseStamp: true });
    const waiting = tabs(a).then(() => undefined, error => error);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Refusing page"), `bot-${SURFACE_B}`);
    const error = await waiting;
    expect(error?.retryable).toBe(true);
    expect(error?.message).toMatch(/attribution failed.*retry/i);
    const stamps = fixture.cdpCommands().filter(command => command.method === "Runtime.evaluate"
      && String(command.params.expression).startsWith('document.title = "omarchy-bot-window-'));
    // Two launch stamps and precisely two refused popup attempts.
    expect(stamps).toHaveLength(4);
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.workspace).toBe("__i3_scratch");
    for (const runtime of [a, b]) expect(await tabs(runtime)).not.toContain("popup-1");
    expect(readFakeSwayCommands(fixture.controlDir)).not.toContainEqual(expect.stringContaining(`[con_id=${POPUP_WINDOW_ID}] move container`));
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

/** The Sway containers the fixture's tree holds, for pid evidence. */
function treeWindows(fixture: PopupFixture): ComputerWindowListItem[] {
  return listApplicationToplevels(JSON.parse(readFileSync(fixture.cdp.treePath, "utf8")) as unknown);
}

test("a pop-up that maps during a Browser Tool auto-launch is not bound to that Screen", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const runtimes = await fixture.start([SURFACE_A, SURFACE_B]);
  const a = runtimes.get(SURFACE_A)!;
  const b = runtimes.get(SURFACE_B)!;
  try {
    await b.launch({ url: "about:blank" });
    await waitFor(() => fixture.windowLookups("page-1") > 0 ? true : undefined, "Screen B's launch to bind its window");
    // A page Screen B owns opens a pop-up before Screen A launches a browser of
    // its own; the pop-up's Sway window maps while that launch is in flight.
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Popup", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW });
    const listing = a.browser!(
      { name: "tabs", args: { operation: "list" } },
      async () => {},
      AbortSignal.timeout(20_000),
    );
    await waitFor(
      () => readFakeSwayCommands(fixture.controlDir)
        .includes(`[con_id=${FORWARDED_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`) ? true : undefined,
      "the Browser Tool to launch and route a window onto Screen A",
    );
    // A's launch focused its workspace, so that is the one Sway maps the pop-up on.
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup"), `bot-${SURFACE_A}`);
    const listed = await listing;
    await waitFor(
      () => fixture.workspaceWindowIds(SURFACE_B).includes(String(POPUP_WINDOW_ID)) ? true : undefined,
      "the pop-up to follow its opener to Screen B",
    );
    // The launch bound its own window, and only that one.
    expect(listed.text).toContain("page-2");
    expect(listed.text).not.toContain("popup-1");
    expect(readFakeSwayCommands(fixture.controlDir))
      .toContain(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`);
    expect(fixture.workspaceWindowIds(SURFACE_A)).not.toContain(String(POPUP_WINDOW_ID));
    expect(await tabs(a)).not.toContain("popup-1");
    expect(await tabs(b)).toContain("popup-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 30_000);

test("a second fresh ownerless target does not prevent an exact popup stamp", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Same", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW });
    fixture.addPage({ targetId: "fresh-1", title: "Same", url: "about:blank", windowId: SECOND_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Same"), `bot-${SURFACE_A}`);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Same"), `bot-${SURFACE_B}`);
    expect(await tabs(a)).toContain("popup-1");
    for (const runtime of [a, b]) expect(await tabs(runtime)).not.toContain("fresh-1");
    expect(treeWindows(fixture).find(window => window.id === String(SECOND_POPUP_WINDOW_ID))?.workspace).toBe("__i3_scratch");
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("a hung opener lookup is retried and the pop-up still follows its opener", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a } = await startTwoScreens(fixture);
  try {
    // The opener's window lookup never answers once: only the attribution's own
    // deadline and retry can record the popup without an event-age gate.
    fixture.patchPage("page-1", { hangLookups: 1 });
    const lookups = fixture.windowLookups("page-1");
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Popup", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW });
    // Exactly one announcement: the next lookup for the same opener can only be
    // the retry after the hung attempt's own deadline.
    await waitFor(() => fixture.windowLookups("page-1") > lookups + 1 ? true : undefined, "the attribution retry", 5_000);
    await Bun.sleep(50);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup"), `bot-${SURFACE_B}`);
    await waitFor(
      () => fixture.workspaceWindowIds(SURFACE_A).includes(String(POPUP_WINDOW_ID)) ? true : undefined,
      "the pop-up to be attributed after the hung lookup",
      10_000,
    );
    expect(readFakeSwayCommands(fixture.controlDir))
      .toContain(`[con_id=${POPUP_WINDOW_ID}] move scratchpad`);
    expect(await tabs(a)).toContain("popup-1");
  } finally {
    await fixture.stop(runtimes.values());
    fixture.dispose();
  }
}, 30_000);

test("scratchpad refusal is surfaced and later events progress after recovery", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Popup", url: "https://popup.example/", windowId: FIRST_POPUP_WINDOW });
    writeFakeSwayIpcMode(fixture.controlDir, "refuse-scratchpad");
    const waiting = tabs(a).then(() => undefined, error => error);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup"), `bot-${SURFACE_B}`);
    const error = await waiting;
    expect(error?.retryable).toBe(true);
    expect(error?.message).toMatch(/could not park window 40.*scratchpad/);
    expect(fixture.workspaceWindowIds(SURFACE_B)).toContain(String(POPUP_WINDOW_ID));
    for (const runtime of [a, b]) expect(await tabs(runtime)).not.toContain("popup-1");
    writeFakeSwayIpcMode(fixture.controlDir, "ok");
    writeFakeSwayWindowEvent(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Popup"));
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "failed parking to retry on a later event");
    await fixture.openPopup({ targetId: "popup-2", openerId: "page-2", title: "Next", url: "https://popup.example/next", windowId: SECOND_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Next"), `bot-${SURFACE_A}`);
    expect(await tabs(b)).toContain("popup-2");
    expect(await tabs(a)).not.toContain("popup-2");
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("two simultaneous equal-title popups from A and B are stamped onto their own Screens", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    const before = fixture.cdpCommands().length;
    await Promise.all([
      fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Identical", url: "https://popup.example/a", windowId: FIRST_POPUP_WINDOW }),
      fixture.openPopup({ targetId: "popup-2", openerId: "page-2", title: "Identical", url: "https://popup.example/b", windowId: SECOND_POPUP_WINDOW }),
    ]);
    // Each stamp write requires its live pending candidate; no Sway popup event
    // has been emitted yet. Both tasks now await distinct exact native titles.
    await waitFor(() => fixture.cdpCommands().slice(before).filter(command => command.method === "Runtime.evaluate"
      && String(command.params.expression).startsWith('document.title = "omarchy-bot-window-')).length === 2 ? true : undefined, "both pending popup stamp writes before either native event");
    expect(readFakeSwayEventDeliveries(fixture.controlDir)).not.toContain(String(POPUP_WINDOW_ID));
    expect(readFakeSwayEventDeliveries(fixture.controlDir)).not.toContain(String(SECOND_POPUP_WINDOW_ID));
    const browserPid = fixture.browserPid();
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, browserPid, "Identical"), `bot-${SURFACE_A}`);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, browserPid, "Identical"), `bot-${SURFACE_B}`);
    const [aTabs, bTabs] = await Promise.all([tabs(a), tabs(b)]);
    expect(aTabs).toContain("popup-1"); expect(aTabs).not.toContain("popup-2");
    expect(bTabs).toContain("popup-2"); expect(bTabs).not.toContain("popup-1");
    const windows = treeWindows(fixture);
    for (const [id, surfaceId] of [[POPUP_WINDOW_ID, SURFACE_A], [SECOND_POPUP_WINDOW_ID, SURFACE_B]] as const) {
      const window = windows.find(window => window.id === String(id));
      expect(window?.pid).toBe(browserPid);
      expect(window?.workspace).toBe(`bot-${surfaceId}`);
      expect(window?.title).toBe("Identical");
      const commands = readFakeSwayCommands(fixture.controlDir);
      expect(commands.indexOf(`[con_id=${id}] move scratchpad`)).toBeLessThan(commands.indexOf(`[con_id=${id}] move container to workspace bot-${surfaceId}`));
    }
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("Web Control lease identifies human windows; release and Bot leases confer no human owner", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  const lease = new ScreenInputLease({
    grant: (surfaceId, epoch, generation, kind) => {
      const runtime = runtimes.get(surfaceId)!;
      if (runtime.generation !== generation) throw new Error("stale generation");
      return runtime.setInputAuthority(epoch, kind);
    },
    deliver: async () => {},
    release: async (surfaceId, epoch) => runtimes.get(surfaceId)!.releaseInput(epoch),
    capture: async () => ({}),
  });
  try {
    await lease.runtimeReady(SURFACE_A, a.generation);
    const human = await lease.acquireWebControl({ surfaceId: SURFACE_A, runtimeGeneration: a.generation });
    fixture.addPage({ targetId: "human-page", title: "Human title", url: "about:blank", windowId: FIRST_POPUP_WINDOW }, true);
    await waitFor(() => fixture.cdpCommands().some(command => command.method === "Target.attachToTarget" && command.params.targetId === "human-page") ? true : undefined, "human candidate to await its native window");
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Human title"), `bot-${SURFACE_B}`);
    expect(await tabs(a)).toContain("human-page");
    expect(await tabs(b)).not.toContain("human-page");
    await expect(a.releaseInput(human.epoch + 1)).rejects.toThrow(/stale/);
    await human.release();
    await expect(a.setInputAuthority(human.epoch, "web")).rejects.toThrow(/stale/);
    fixture.addPage({ targetId: "after-release", title: "Ownerless", url: "about:blank", windowId: SECOND_POPUP_WINDOW }, true);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Ownerless"), `bot-${SURFACE_A}`);
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(SECOND_POPUP_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "ownerless window after human release");
    await b.setInputAuthority(1, "bot");
    fixture.addPage({ targetId: "during-bot", title: "Ownerless", url: "about:blank", windowId: SECOND_POPUP_WINDOW }, true);
    await waitFor(() => {
      const delivered = fixture.cdp.eventsPath + ".delivered";
      return existsSync(delivered) && readFileSync(delivered, "utf8").includes('"targetId":"during-bot"') ? true : undefined;
    }, "ownerless target event delivered while the Bot holds the lease");
    for (const runtime of [a, b]) {
      const text = await tabs(runtime);
      expect(text).not.toContain("after-release");
      expect(text).not.toContain("during-bot");
    }
    await b.releaseInput(1);
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("a native window arriving before the opener target is parked and later stamped", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Late"), `bot-${SURFACE_B}`);
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "parking before target discovery");
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Late", url: "about:blank", windowId: FIRST_POPUP_WINDOW });
    expect(await tabs(a)).toContain("popup-1");
    expect(await tabs(b)).not.toContain("popup-1");
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.title).toBe("Late");
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("the same adapter resubscribes after its window subscription drops", async () => {
  const fixture = await createPopupFixture();
  const adapter = fixture.newAdapter();
  const runtime = await adapter.start(provision(SURFACE_A));
  runtimesToStop.add(runtime);
  try {
    appendFileSync(path.join(fixture.controlDir, "drop-subscriptions"), "drop\n");
    await waitFor(() => subscriptionLines(fixture.controlDir, "close").length === 1 ? true : undefined, "dropped subscription");
    expect(await adapter.reconcile(provision(SURFACE_A))).toBe(runtime);
    await waitFor(() => subscriptionLines(fixture.controlDir, "subscribe").length === 2 ? true : undefined, "same-adapter resubscription");
    await runtime.launch({ url: "about:blank" });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Ownerless"), `bot-${SURFACE_A}`);
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "event from reopened subscription");
    expect(await tabs(runtime)).toContain("page-1");
  } finally { await runtime.stop(); fixture.dispose(); }
});

test("resubscription parks windows mapped during the gap without another new event", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const adapter = fixture.newAdapter();
  const a = await adapter.start(provision(SURFACE_A));
  const b = await adapter.start(provision(SURFACE_B));
  runtimesToStop.add(a); runtimesToStop.add(b);
  try {
    await a.launch({ url: "about:blank" });
    await b.launch({ url: "about:blank" });
    appendFileSync(path.join(fixture.controlDir, "drop-subscriptions"), "drop\n");
    await waitFor(() => subscriptionLines(fixture.controlDir, "close").length === 1 ? true : undefined, "subscription gap");
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Missed", url: "about:blank", windowId: FIRST_POPUP_WINDOW });
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Missed"), `bot-${SURFACE_B}`);
    mapFakeSwayWindow(fixture.controlDir, popupContainer(SECOND_POPUP_WINDOW_ID, fixture.browserPid(), "Ownerless"), `bot-${SURFACE_B}`);
    // Wait for the fake compositor to consume both new events with no listener.
    await waitFor(() => readFakeSwayEventDeliveries(fixture.controlDir).includes(String(SECOND_POPUP_WINDOW_ID)) ? true : undefined, "missed native events consumed");
    expect(await adapter.reconcile(provision(SURFACE_A))).toBe(a);
    expect(await tabs(a)).toContain("popup-1");
    expect(await tabs(b)).not.toContain("popup-1");
    for (const id of [POPUP_WINDOW_ID, SECOND_POPUP_WINDOW_ID]) expect(readFakeSwayCommands(fixture.controlDir)).toContain(`[con_id=${id}] move scratchpad`);
    expect(treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))).toMatchObject({ workspace: `bot-${SURFACE_A}`, title: "Missed" });
    expect(treeWindows(fixture).find(window => window.id === String(SECOND_POPUP_WINDOW_ID))?.workspace).toBe("__i3_scratch");
    expect((await b.listWindows()).map(window => window.id)).not.toContain(String(SECOND_POPUP_WINDOW_ID));
  } finally { await fixture.stop([a, b]); fixture.dispose(); }
}, 15_000);

test("a cold prepared browser handler during Web Control adopts the daemon pipe", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const runtimes = await fixture.start();
  const a = runtimes.get(SURFACE_A)!; const b = runtimes.get(SURFACE_B)!;
  try {
    expect(existsSync(fixture.cdp.logPath)).toBe(false);
    expect(fixture.cdpCommands()).toEqual([]);
    await a.setInputAuthority(1, "web");
    expect(existsSync(fixture.cdp.logPath)).toBe(false);
    const child = Bun.spawn(["/bin/sh", "-c", '\"$BROWSER\" https://human.example/'], { env: a.sessionEnv, stdout: "pipe", stderr: "pipe" });
    try {
      expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
      expect(JSON.parse(readFileSync(fixture.cdp.logPath, "utf8").trim())).toContain("--remote-debugging-pipe");
      expect(await tabs(a)).toContain("page-1");
      const window = treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID));
      expect(window).toMatchObject({ workspace: `bot-${SURFACE_A}`, title: "about:blank" });
      const commands = readFakeSwayCommands(fixture.controlDir);
      expect(commands.indexOf(`[con_id=${LAUNCHED_WINDOW_ID}] move scratchpad`)).toBeLessThan(commands.indexOf(`[con_id=${LAUNCHED_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`));
      expect(fixture.cdpCommands().some(command => command.method === "Runtime.evaluate" && String(command.params.expression).startsWith('document.title = "omarchy-bot-window-'))).toBe(true);
      expect((await b.listWindows()).map(window => window.id)).not.toContain(String(LAUNCHED_WINDOW_ID));
      await a.releaseInput(1);
      expect(await tabs(b)).not.toContain("page-1");
    } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("a cold application handler inherits its live Bot launch without an extra blank window", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const runtimes = await fixture.start();
  const a = runtimes.get(SURFACE_A)!; const b = runtimes.get(SURFACE_B)!;
  const app = executable(path.dirname(fixture.cdp.logPath), "link-app", '#!/bin/sh\nexec "$BROWSER" https://application.example/\n');
  try {
    expect(existsSync(fixture.cdp.logPath)).toBe(false);
    await expect(a.launch({ app })).resolves.toEqual({ text: `launched ${app}` });
    expect(await tabs(a)).toContain("page-1");
    expect(fixture.workspaceWindowIds(SURFACE_B)).not.toContain(String(LAUNCHED_WINDOW_ID));
    const launches = readFileSync(fixture.cdp.logPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain("--remote-debugging-pipe");
    expect(launches[0]?.at(-1)).toBe("https://application.example/");
    expect(await tabs(b)).not.toContain("page-1");
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("the prepared handler refuses a cold request without launch or Web Control authority", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const a = runtimes.get(SURFACE_A)!;
  try {
    const child = Bun.spawn([a.sessionEnv.BROWSER!, "https://ownerless.example/"], { env: a.sessionEnv, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("requires an active Bot launch or Web Control lease");
    expect(existsSync(fixture.cdp.logPath)).toBe(false);
    expect(fixture.cdpCommands()).toEqual([]);
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("closing a Screen cancels a cold handler binding and the last Screen removes its socket", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const runtimes = await fixture.start();
  const a = runtimes.get(SURFACE_A)!; const b = runtimes.get(SURFACE_B)!;
  const socket = path.join(a.sessionEnv.XDG_RUNTIME_DIR!, "browser.sock");
  try {
    fixture.patchPage("page-1", { holdLookup: true });
    await a.setInputAuthority(1, "web");
    const child = Bun.spawn([a.sessionEnv.BROWSER!, "https://cancelled.example/"], { env: a.sessionEnv, stdout: "pipe", stderr: "pipe" });
    try {
      await waitFor(() => fixture.windowLookups("page-1") > 0 ? true : undefined, "cold handler binding in flight");
      await a.stop();
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("Screen closed");
      fixture.patchPage("page-1", { holdLookup: false });
      await waitFor(() => treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "cancelled handler window parked");
      expect(readFakeSwayCommands(fixture.controlDir)).not.toContain(`[con_id=${LAUNCHED_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`);
      expect(existsSync(socket)).toBe(true);
      expect(await tabs(b)).not.toContain("page-1");
      await b.stop();
      expect(existsSync(socket)).toBe(false);
    } finally { if (child.exitCode === null) child.kill(); await child.exited; }
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("closing a Screen while a stamp waits restores the title and cannot register late", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Original", url: "about:blank", windowId: FIRST_POPUP_WINDOW });
    await a.stop();
    await waitFor(() => {
      const state = JSON.parse(readFileSync(fixture.cdp.statePath, "utf8")) as { pages: FakePage[] };
      return state.pages.find(page => page.targetId === "popup-1")?.title === "Original" ? true : undefined;
    }, "title restored after Screen closure");
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Original"), `bot-${SURFACE_B}`);
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "late native window parked after Screen closure");
    expect(await tabs(b)).not.toContain("popup-1");
    expect(readFakeSwayCommands(fixture.controlDir)).not.toContain(`[con_id=${POPUP_WINDOW_ID}] move container to workspace bot-${SURFACE_A}`);
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("a refused open_url stamp errors both launch and Browser Tool waiters and a fresh launch can retry", async () => {
  const fixture = await createPopupFixture();
  const runtimes = await fixture.start();
  const runtime = runtimes.get(SURFACE_A)!;
  try {
    fixture.patchPage("page-1", { refuseStamp: true });
    const launching = runtime.launch({ url: "about:blank" }).catch(error => error);
    await waitFor(() => fixture.cdpCommands().some(command => command.method === "Runtime.evaluate" && String(command.params.expression).startsWith('document.title = "omarchy-bot-window-')) ? true : undefined, "launch stamp before concurrent Browser Tool wait");
    const listing = tabs(runtime).catch(error => error);
    const [launchError, browserError] = await Promise.all([launching, listing]);
    for (const error of [launchError, browserError]) {
      expect(error.retryable).toBe(true);
      expect(error.message).toMatch(/attribution failed.*retry/i);
    }
    expect(treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID))?.workspace).toBe("__i3_scratch");
    expect(treeWindows(fixture).find(window => window.id === String(LAUNCHED_WINDOW_ID))?.title).toBe("about:blank");
    expect((await runtime.listWindows()).map(window => window.id)).not.toContain(String(LAUNCHED_WINDOW_ID));
    await runtime.launch({ url: "about:blank" });
    const text = await tabs(runtime);
    expect(text).toContain("page-2");
    expect(text).not.toContain("page-1");
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 15_000);

test("target destruction cancels the stamp and its retry preflight returns a retryable Bot error", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Original", url: "about:blank", windowId: FIRST_POPUP_WINDOW });
    await waitFor(() => {
      const state = JSON.parse(readFileSync(fixture.cdp.statePath, "utf8")) as { pages: FakePage[] };
      return state.pages.find(page => page.targetId === "popup-1")?.title.startsWith("omarchy-bot-window-") ? true : undefined;
    }, "live target stamp");
    const waiting = tabs(a).catch(error => error);
    appendFileSync(fixture.cdp.eventsPath, JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "popup-1" } }) + "\n");
    const error = await waiting;
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("retry liveness preflight confirms the target is gone");
    expect(fixture.cdpCommands().filter(command => command.method === "Target.attachToTarget" && command.params.targetId === "popup-1")).toHaveLength(1);
    const state = JSON.parse(readFileSync(fixture.cdp.statePath, "utf8")) as { pages: FakePage[] };
    expect(state.pages.find(page => page.targetId === "popup-1")?.title).toBe("Original");
    // A late native event and stale CDP metadata cannot revive the destroyed job.
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Original"), `bot-${SURFACE_B}`);
    appendFileSync(fixture.cdp.eventsPath, JSON.stringify({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "popup-1", type: "page", openerId: "page-2" } } }) + "\n");
    await waitFor(() => treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID))?.workspace === "__i3_scratch" ? true : undefined, "late destroyed window parked");
    for (const runtime of [a, b]) expect(await tabs(runtime)).not.toContain("popup-1");
    expect(readFakeSwayCommands(fixture.controlDir)).not.toContainEqual(expect.stringContaining(`[con_id=${POPUP_WINDOW_ID}] move container`));
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
});

test("an acknowledged but unverified move restores and reparks with a retryable error", async () => {
  const fixture = await createPopupFixture([SURFACE_A, SURFACE_B]);
  const { runtimes, a, b } = await startTwoScreens(fixture);
  try {
    await fixture.openPopup({ targetId: "popup-1", openerId: "page-1", title: "Original", url: "about:blank", windowId: FIRST_POPUP_WINDOW });
    writeFakeSwayIpcMode(fixture.controlDir, "ack-route");
    mapFakeSwayWindow(fixture.controlDir, popupContainer(POPUP_WINDOW_ID, fixture.browserPid(), "Original"), `bot-${SURFACE_B}`);
    const error = await tabs(a).catch(error => error);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("move was not verified within 2000ms");
    const window = treeWindows(fixture).find(window => window.id === String(POPUP_WINDOW_ID));
    expect(window?.workspace).toBe("__i3_scratch");
    expect(window?.title).toBe("Original");
    for (const runtime of [a, b]) expect(await tabs(runtime)).not.toContain("popup-1");
    expect(readFakeSwayCommands(fixture.controlDir).filter(command => command === `[con_id=${POPUP_WINDOW_ID}] move scratchpad`)).toHaveLength(2);
  } finally { await fixture.stop(runtimes.values()); fixture.dispose(); }
}, 10_000);
