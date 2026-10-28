import { afterEach, expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwayBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/swayBotScreenRuntime.ts";
import type { BotScreenActionResult } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import {
  PortableSwayRuntimeSupply,
  SWAY_RUNTIME_RELEASE,
} from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";
import type { ComputerWindowListItem } from "../../packages/agent-contract/src/computer-protocol.ts";
import type { ComputerAction } from "../../packages/domain/src/computer.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import {
  HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE,
  waitScreenReady,
} from "./helpers/bot-screen-load-observe.ts";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { ProjectionClient } from "./helpers/projection-client.ts";
import {
  CITED_FAKE_PROOFS,
  HUMAN_ONLY_HOST_CHECKS,
  PNG_SIGNATURE,
  REAL_SWAY_ENV,
  UNICODE_SAMPLE,
  createAppLauncher,
  createIsolationPage,
  digest,
  distribution,
  isolationUnchanged,
  kernelAndGpu,
  leftoverSurfaceProcesses,
  measureSwayCosts,
  persistConformanceReport,
  sha256File,
  snapshotHostIsolation,
  until,
  type CheckResult,
  type HostIsolationSnapshot,
  type SwayCostAttribution,
} from "./helpers/sway-conformance.ts";

const realTest = process.env[REAL_SWAY_ENV] === "1" ? test : test.skip;
const REPORT_JSON = path.resolve(import.meta.dir, "../../.scratch/sway-bot-desktop-runtime/conformance-report.json");
const REPORT_MD = path.resolve(import.meta.dir, "../../.scratch/sway-bot-desktop-runtime/conformance-report.md");
const COMMAND = `${REAL_SWAY_ENV}=1 bun test tests/integration/bot-screen-sway-conformance.test.ts`;
const RESOURCE_WINDOW_MS = 1_500;
const REQUIRED_CHECKS = [
  "two-real-sway-sessions",
  "distinct-apps-and-shared-state",
  "agent-without-viewer",
  "agent-open-url",
  "real-browser-projection",
  "preview-no-wayvnc",
  "rfb-view-only-and-broker",
  "multiple-viewers",
  "bot-switching",
  "component-failure-fallback",
  "background-and-unsaved",
  "delete-reprovision-cleanup",
  "complete-cleanup",
  "host-session-isolation",
] as const;

type Owner = { botId: string; surfaceId: SurfaceId };

interface ScenarioRow {
  ran: boolean;
  notes: string[];
  latency?: Record<string, unknown>;
  attribution?: SwayCostAttribution;
  network?: { rxBytes: number; txBytes: number };
  unmet?: string;
}

const originalHome = process.env.HOME;
const originalWayland = process.env.WAYLAND_DISPLAY;
const originalSwaySock = process.env.SWAYSOCK;

let harness: Harness | undefined;
let fixtureRoot: string | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.stop().catch(() => {});
    harness = undefined;
  }
  if (fixtureRoot !== undefined) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalWayland === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = originalWayland;
  if (originalSwaySock === undefined) delete process.env.SWAYSOCK;
  else process.env.SWAYSOCK = originalSwaySock;
});

function check(id: string, passed: boolean, evidence: string, leftover?: string): CheckResult {
  return leftover === undefined ? { id, passed, evidence } : { id, passed, evidence, leftover };
}

async function act(
  owner: Owner,
  action: ComputerAction,
  turnId: string,
): Promise<BotScreenActionResult> {
  // Input actions go through the input lease (svc.computer.agentToolAct); act() is for the rest.
  return harness!.svc.screens.act(owner, action);
}

async function screenshotBytes(owner: Owner): Promise<Uint8Array> {
  const result = await act(owner, { name: "screenshot", args: {} }, `shot-${owner.surfaceId}`);
  if (result.image === undefined) throw new Error(`screenshot missing for ${owner.surfaceId}`);
  return result.image.bytes;
}

async function waitPixels(owner: Owner, previous: Uint8Array, description: string, timeoutMs = 12_000): Promise<Uint8Array> {
  const before = digest(previous);
  return until(async () => {
    const current = await screenshotBytes(owner);
    return digest(current) !== before ? current : undefined;
  }, timeoutMs, description);
}

async function listedWindows(owner: Owner): Promise<ComputerWindowListItem[]> {
  const result = await act(owner, { name: "list_windows", args: {} }, `windows-${owner.surfaceId}`);
  return Array.isArray(result.windowList) ? result.windowList as ComputerWindowListItem[] : [];
}

async function waitWindows(owner: Owner, predicate: (windows: ComputerWindowListItem[]) => boolean, description: string): Promise<ComputerWindowListItem[]> {
  return until(async () => {
    const windows = await listedWindows(owner);
    return predicate(windows) ? windows : undefined;
  }, 25_000, description);
}

async function focusMatching(owner: Owner, match: RegExp): Promise<ComputerWindowListItem | undefined> {
  const windows = await listedWindows(owner);
  const target = windows.find((window) => match.test(window.title) || (window.appId !== undefined && match.test(window.appId)));
  if (target === undefined) return undefined;
  await act(owner, { name: "focus_window", args: { id: target.id } }, `focus-${owner.surfaceId}`);
  return target;
}

function isolationWindow(windows: ComputerWindowListItem[], label: string): ComputerWindowListItem | undefined {
  return windows.find((window) => window.title === label || window.title.startsWith(`${label} `));
}

interface BrowserFixtureState {
  windowId: string;
  value: string;
  counter: number;
}

async function browserFixtureState(owner: Owner, label: string): Promise<BrowserFixtureState | undefined> {
  const window = isolationWindow(await listedWindows(owner), label);
  const prefix = `${label} state:`;
  if (window === undefined || !window.title.startsWith(prefix)) return undefined;
  const state: unknown = JSON.parse(window.title.slice(prefix.length));
  if (state === null || typeof state !== "object" || !("value" in state) || typeof state.value !== "string"
    || !("counter" in state) || typeof state.counter !== "number") return undefined;
  return { windowId: window.id, value: state.value, counter: state.counter };
}

async function focusFixtureEditor(owner: Owner, label: string): Promise<void> {
  const window = isolationWindow(await listedWindows(owner), label);
  if (window === undefined) throw new Error(`missing ${label} browser fixture`);
  await act(owner, { name: "focus_window", args: { id: window.id } }, `focus-editor-${label}`);
  await harness!.svc.computer.agentToolAct(
    owner,
    `conformance-key-${label}`,
    `conformance-key-${label}`,
    { name: "key", args: { key: "Tab" } },
    new AbortController().signal,
  );
  await until(() => browserFixtureState(owner, label), 8_000, `${label} editor focus`);
}

function persist(report: Record<string, unknown>): void {
  persistConformanceReport(REPORT_JSON, REPORT_MD, report);
}

realTest("two real Sway Bot Screens prove isolation, Agent control, RFB Web Control, and cost", async () => {
  const generatedAt = new Date().toISOString();
  const checks: CheckResult[] = [];
  const limitations: string[] = [];
  const resourceScenarios: Record<string, ScenarioRow> = {};
  const latencies = {
    coldReadyMs: [] as number[],
    firstPreviewMs: [] as number[],
    firstExpandedMs: [] as number[],
    reconnectMs: [] as number[],
    inputToVisibleMs: [] as number[],
    cleanupMs: [] as number[],
  };
  let hostBefore: HostIsolationSnapshot | undefined;
  let hostAfter: HostIsolationSnapshot | undefined;
  let cutover: "go" | "blocked" | "not-run" = "not-run";
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "sway-two-bot-conformance",
    generatedAt,
    status: "running",
    cutover,
    command: COMMAND,
    checks,
    limitations,
    resourceScenarios,
    citedFakeProofs: CITED_FAKE_PROOFS,
    humanOnlyHostChecks: HUMAN_ONLY_HOST_CHECKS,
  };

  const record = (result: CheckResult): void => {
    checks.push(result);
    persist(report);
  };

  try {
    hostBefore = await snapshotHostIsolation();
    const host = kernelAndGpu();
    const browser = Bun.which("brave") ?? Bun.which("chromium") ?? Bun.which("firefox");
    const terminal = Bun.which("alacritty") ?? Bun.which("ghostty") ?? Bun.which("foot");
    report.environment = {
      kernel: host.kernel,
      gpu: host.gpu,
      hostname: os.hostname(),
      hostHyprlandRunning: hostBefore.compositorPid !== null,
      hostCompositorPid: hostBefore.compositorPid,
      hostWAYLAND_DISPLAY: hostBefore.waylandDisplay,
      hostSWAYSOCK: hostBefore.swaySock,
      browser,
      terminal,
      compare: Bun.which("compare"),
    };
    persist(report);

    if (browser === null) {
      record(check("prerequisites", false, "no browser on PATH", "firefox/chromium/brave missing; no package install was attempted"));
      throw new Error("a host Wayland browser is required");
    }
    if (terminal === null) {
      record(check("prerequisites", false, "no terminal on PATH", "foot/alacritty/ghostty missing; no package install was attempted"));
      throw new Error("a host Wayland terminal is required");
    }

    const supplyRoot = process.env.OMARCHY_BOT_SWAY_BUNDLE_DIR
      ?? path.join(process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"), "runtime", "current", "sway");
    const supply = new PortableSwayRuntimeSupply({ rootDir: supplyRoot });
    const binaries = await supply.ensure();
    const swayVersion = Bun.spawnSync([binaries.swayBin, "-v"], { stdout: "pipe", stderr: "pipe" });
    report.artifacts = {
      SWAY_RUNTIME_RELEASE,
      supplyRoot,
      swayBin: binaries.swayBin,
      swaymsgBin: binaries.swaymsgBin,
      wayvncBin: binaries.wayvncBin,
      wlrRandrBin: binaries.wlrRandrBin,
      grimBin: binaries.grimBin,
      dbusDaemonBin: binaries.dbusDaemonBin,
      xwaylandBin: binaries.xwaylandBin,
      swayWrapperSha256: sha256File(binaries.swayBin),
      wayvncWrapperSha256: sha256File(binaries.wayvncBin),
      swayVersion: `${swayVersion.stdout.toString().trim()} ${swayVersion.stderr.toString().trim()}`.trim(),
    };
    persist(report);

    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-conformance-"));
    const daemonHome = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-home-"));
    const applicationCwd = path.join(daemonHome, "workspace");
    mkdirSync(applicationCwd, { recursive: true, mode: 0o700 });
    const previousProfile = process.env.OMARCHY_BOT_SCREEN_PROFILE;
    process.env.OMARCHY_BOT_SCREEN_PROFILE = process.env.OMARCHY_BOT_SCREEN_PROFILE ?? "720p";
    const adapter = new SwayBotScreenRuntimeAdapter({
      runtimeRoot: path.join(daemonHome, "r"),
      profileRoot: path.join(daemonHome, "screens"),
      fontDir: process.env.OMARCHY_BOT_FONT_DIR
        ?? path.join(process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"), "runtime", "current", "fonts"),
      applicationCwd,
      runtimeSupply: supply,
    });

    try {
      harness = await startDaemon(daemonHome, {
        botScreenAdapter: adapter,
        botScreenCapacity: 2,
      });
    } finally {
      if (previousProfile === undefined) delete process.env.OMARCHY_BOT_SCREEN_PROFILE;
      else process.env.OMARCHY_BOT_SCREEN_PROFILE = previousProfile;
    }

    const zeroGraphical = await measureSwayCosts([], RESOURCE_WINDOW_MS);
    resourceScenarios.zeroGraphicalUse = {
      ran: true,
      notes: ["Bots not yet created; daemon/harness only."],
      attribution: zeroGraphical.attribution,
      network: zeroGraphical.network,
    };
    persist(report);

    const botIds = await Promise.all([
      makeBot(harness, "Sway conformance A"),
      makeBot(harness, "Sway conformance B"),
    ]);
    const bots = await Promise.all(botIds.map((botId) => api<{ surfaceId: SurfaceId }>(harness!, "GET", `/api/bots/${botId}`)));
    const owners: Owner[] = botIds.map((botId, index) => ({ botId, surfaceId: bots[index]!.surfaceId }));
    const pageA = createIsolationPage(fixtureRoot, "BOT-A", "#8b1e3f");
    const pageB = createIsolationPage(fixtureRoot, "BOT-B", "#14532d");
    const braveFlags = [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--password-store=basic",
      "--ozone-platform=wayland",
      "--disable-gpu",
      "--in-process-gpu",
    ].join(" ");
    const waylandAppEnv = "export LIBGL_ALWAYS_SOFTWARE=1 WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland HISTFILE=/dev/null";
    const launchers = [
      createAppLauncher(fixtureRoot, "bot-a-term", `${waylandAppEnv}; printf '%s|%s|%s' "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" "$WAYLAND_DISPLAY" > "$XDG_CONFIG_HOME/isolation-profile-a"; exec ${JSON.stringify(terminal)} ${path.basename(terminal) === "ghostty" ? "--title=BOT-A-TERM" : '-t BOT-A-TERM -o colors.primary.background="\'#8b1e3f\'"'} -e bash --noprofile --norc`),
      createAppLauncher(fixtureRoot, "bot-b-term", `${waylandAppEnv}; printf '%s|%s|%s' "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" "$WAYLAND_DISPLAY" > "$XDG_CONFIG_HOME/isolation-profile-b"; exec ${JSON.stringify(terminal)} ${path.basename(terminal) === "ghostty" ? "--title=BOT-B-TERM" : '-t BOT-B-TERM -o colors.primary.background="\'#14532d\'"'} -e bash --noprofile --norc`),
      createAppLauncher(fixtureRoot, "bot-a-browser", `${waylandAppEnv}; exec ${JSON.stringify(browser)} ${braveFlags} --app="file://${pageA}"`),
      createAppLauncher(fixtureRoot, "bot-b-browser", `${waylandAppEnv}; exec ${JSON.stringify(browser)} ${braveFlags} --app="file://${pageB}"`),
    ];

    const readySamples: number[] = [];
    let startError: string | undefined;
    try {
      for (const owner of owners) {
        readySamples.push(await waitScreenReady(harness, owner));
      }
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
      record(check(
        "two-real-sway-sessions",
        false,
        "Sway Bot Desktop Sessions did not become ready",
        startError,
      ));
      limitations.push(`Isolated real Sway did not start: ${startError}`);
      throw error;
    }
    latencies.coldReadyMs.push(...readySamples);
    record(check(
      "two-real-sway-sessions",
      owners.every((owner) => harness!.svc.screens.status(owner).state === "ready"),
      `both Screens ready in ${readySamples.join("ms, ")}ms`,
    ));

    const retainedUnviewed = await measureSwayCosts(owners, RESOURCE_WINDOW_MS);
    resourceScenarios.retainedUnviewedDesktops = {
      ran: true,
      notes: ["Two Sway sessions ready, no Computer Preview or expanded viewer."],
      attribution: retainedUnviewed.attribution,
      network: retainedUnviewed.network,
      latency: { coldRequestToReadyMs: distribution(latencies.coldReadyMs) },
    };
    persist(report);

    const neutrals = await Promise.all(owners.map((owner) => screenshotBytes(owner)));
    expect(neutrals.every((image) => image.slice(0, 8).every((byte, index) => byte === PNG_SIGNATURE[index]))).toBeTrue();

    await act(owners[0]!, { name: "open_app", args: { app: launchers[0] } }, "open-a-term");
    await act(owners[1]!, { name: "open_app", args: { app: launchers[1] } }, "open-b-term");
    const windowsA = await waitWindows(owners[0]!, (windows) => windows.some((window) => /BOT-A-TERM/i.test(window.title)), "Bot A terminal window");
    const windowsB = await waitWindows(owners[1]!, (windows) => windows.some((window) => /BOT-B-TERM/i.test(window.title)), "Bot B terminal window");
    await focusMatching(owners[0]!, /BOT-A-TERM/i);
    await focusMatching(owners[1]!, /BOT-B-TERM/i);
    const pixelsA = await waitPixels(owners[0]!, neutrals[0]!, "Bot A terminal pixels", 20_000);
    const pixelsB = await waitPixels(owners[1]!, neutrals[1]!, "Bot B terminal pixels", 20_000);
    await act(owners[0]!, { name: "open_app", args: { app: launchers[2] } }, "open-a-browser");
    await act(owners[1]!, { name: "open_app", args: { app: launchers[3] } }, "open-b-browser");
    await waitWindows(owners[0]!, (windows) => isolationWindow(windows, "BOT-A") !== undefined, "Bot A browser window");
    await waitWindows(owners[1]!, (windows) => isolationWindow(windows, "BOT-B") !== undefined, "Bot B browser window");
    const listedA = await listedWindows(owners[0]!);
    const listedB = await listedWindows(owners[1]!);
    const titlesA = listedA.map((window) => window.title);
    const titlesB = listedB.map((window) => window.title);
    const sharedConfigDir = path.join(harness.svc.cfg.botScreenProfileDir, "computer", "config");
    const profileA = path.join(sharedConfigDir, "isolation-profile-a");
    const profileB = path.join(sharedConfigDir, "isolation-profile-b");
    await until(() => existsSync(profileA) && existsSync(profileB) ? true : undefined, 15_000, "shared profile markers");
    const markerA = readFileSync(profileA, "utf8");
    const markerB = readFileSync(profileB, "utf8");
    const computerRuntime = path.join(harness.svc.cfg.botScreenRuntimeDir, "computer");
    const sharedPaths = markerA === markerB
      && markerA.includes(sharedConfigDir)
      && markerA.includes(computerRuntime);
    record(check(
      "distinct-apps-and-shared-state",
      digest(pixelsA) !== digest(pixelsB) && sharedPaths && titlesA.some((title) => /BOT-A-TERM/i.test(title)) && titlesB.some((title) => /BOT-B-TERM/i.test(title)),
      `distinct pixels=${digest(pixelsA) !== digest(pixelsB)}; shared markers=${sharedPaths}; A windows=${titlesA.join("|")}; B windows=${titlesB.join("|")}; markers=${markerA} || ${markerB}`,
      digest(pixelsA) !== digest(pixelsB) && sharedPaths ? undefined : "pixels were not distinct or application environments were not shared",
    ));

    const observeA = await act(owners[0]!, { name: "observe", args: {} }, "observe-a");
    const observeB = await act(owners[1]!, { name: "observe", args: {} }, "observe-b");
    const observedA = Array.isArray(observeA.windowList) ? observeA.windowList as ComputerWindowListItem[] : [];
    const observedB = Array.isArray(observeB.windowList) ? observeB.windowList as ComputerWindowListItem[] : [];
    const browserA = isolationWindow(observedA, "BOT-A");
    const browserB = isolationWindow(observedB, "BOT-B");
    if (browserA?.bounds === undefined || browserB === undefined) throw new Error("real browser windows are unavailable");
    await act(owners[0]!, { name: "focus_window", args: { id: browserA.id } }, "focus-a");
    const beforeClick = await screenshotBytes(owners[0]!);
    const clickStarted = performance.now();
    await act(owners[0]!, { name: "click", args: {
      x: browserA.bounds.x + Math.min(120, browserA.bounds.width / 2),
      y: browserA.bounds.y + Math.min(150, browserA.bounds.height / 2), button: "left",
    } }, "click-a");
    await until(async () => {
      const title = isolationWindow(await listedWindows(owners[0]!), "BOT-A")?.title;
      return title !== undefined && title !== browserA.title && title.includes(" click:") ? title : undefined;
    }, 8_000, "Agent click reached Bot A browser");
    await waitPixels(owners[0]!, beforeClick, "Bot A click pixels");
    latencies.inputToVisibleMs.push(Number((performance.now() - clickStarted).toFixed(2)));
    const siblingAfterClick = await listedWindows(owners[1]!);
    const siblingStableAfterClick = isolationWindow(siblingAfterClick, "BOT-B")?.title === browserB.title;
    await act(owners[0]!, { name: "scroll", args: { x: browserA.bounds.x + 120, y: browserA.bounds.y + 200, deltaX: 0, deltaY: -720 } }, "scroll-a");

    await focusMatching(owners[1]!, /^BOT-B-TERM$/);
    const terminalOutput = path.join(fixtureRoot, "terminal-unicode.txt");
    const terminalCommand = `printf '%s' ${JSON.stringify(UNICODE_SAMPLE)} > ${JSON.stringify(terminalOutput)}`;
    await act(owners[1]!, { name: "type", args: { text: terminalCommand } }, "terminal-unicode-command");
    await act(owners[1]!, { name: "key", args: { key: "Enter" } }, "terminal-unicode-enter");
    const terminalExact = await until(() => existsSync(terminalOutput)
      && readFileSync(terminalOutput, "utf8") === UNICODE_SAMPLE ? true : undefined, 8_000, "literal terminal Unicode");

    await focusFixtureEditor(owners[1]!, "BOT-B");
    await act(owners[1]!, { name: "key", args: { key: "Ctrl+A" } }, "select-browser-text");
    await act(owners[1]!, { name: "type", args: { text: UNICODE_SAMPLE } }, "type-unicode");
    const browserExact = await until(async () => {
      const state = await browserFixtureState(owners[1]!, "BOT-B");
      return state?.value === UNICODE_SAMPLE ? state : undefined;
    }, 8_000, "literal browser Unicode");
    record(check(
      "agent-without-viewer",
      observeA.image !== undefined && observeB.image !== undefined && siblingStableAfterClick
        && terminalExact && browserExact.value === UNICODE_SAMPLE,
      `observe/list/focus/click/scroll/chord passed; sibling title preserved under the shared seat; exact browser and terminal Unicode=${UNICODE_SAMPLE}`,
    ));

    const viewer = await ProjectionClient.connect(harness.baseUrl, owners[0]!, "sway-conformance-viewer", harness.token);
    let rfbReady = false;
    try {
      expect(viewer.session.security).toEqual({ authentication: "none", httpsRequired: false });
      const previewStarted = performance.now();
      await viewer.setMode("preview");
      const previewFrame = await viewer.waitForPreviewFrame();
      latencies.firstPreviewMs.push(Number((performance.now() - previewStarted).toFixed(2)));
      const previewOnly = await measureSwayCosts([owners[0]!, owners[1]!], 200);
      resourceScenarios.previewOnly = {
        ran: true,
        notes: ["Compact preview PNG delivered on the control WebSocket; WayVNC stayed down."],
        attribution: previewOnly.attribution,
        network: previewOnly.network,
        latency: { firstPreviewMs: distribution(latencies.firstPreviewMs) },
      };
      const wayvncDuringPreview = previewOnly.processes.filter((process) => process.executable.toLowerCase() === "wayvnc");
      const previewIsPng = previewFrame.bytes.slice(0, PNG_SIGNATURE.length)
        .every((byte, index) => byte === PNG_SIGNATURE[index]);
      record(check(
        "preview-no-wayvnc",
        previewIsPng && wayvncDuringPreview.length === 0,
        `preview sequence=${previewFrame.sequence} bytes=${previewFrame.bytes.byteLength}; wayvnc processes=${wayvncDuringPreview.length}`,
      ));

      const focusedIsolation = await until(async () => {
        await focusMatching(owners[0]!, /^BOT-A$|^BOT-A click:|brave|Brave/i);
        const window = isolationWindow(await listedWindows(owners[0]!), "BOT-A");
        return window?.focused === true && window.bounds !== undefined ? window : undefined;
      }, 8_000, "focus Bot A isolation page");
      const titleBeforeRfb = focusedIsolation.title;
      const clickX = focusedIsolation.bounds!.x + Math.floor(focusedIsolation.bounds!.width / 2);
      const clickY = focusedIsolation.bounds!.y + Math.floor(focusedIsolation.bounds!.height / 2);

      const expandedStarted = performance.now();
      const auth = await viewer.setMode("expanded");
      const rfb = viewer.rfb;
      if (rfb === undefined || rfb.serverInit === undefined || auth === undefined) {
        throw new Error("expanded projection did not complete RFB negotiation and Broker authority");
      }
      rfb.requestFramebufferUpdate(rfb.serverInit.width, rfb.serverInit.height);
      await rfb.waitForServerMessageType(0);
      latencies.firstExpandedMs.push(Number((performance.now() - expandedStarted).toFixed(2)));
      rfbReady = rfb.serverInit.width === viewer.session.videoWidth
        && rfb.serverInit.height === viewer.session.videoHeight;

      rfb.sendPointer(1, clickX, clickY);
      rfb.sendPointer(0, clickX, clickY);
      await Bun.sleep(250);
      const titleAfterRfb = isolationWindow(await listedWindows(owners[0]!), "BOT-A")?.title ?? "";
      const rfbDidNotMutate = titleAfterRfb === titleBeforeRfb;

      await focusMatching(owners[0]!, /^BOT-A$|^BOT-A click:|brave|Brave/i);
      const brokerStarted = performance.now();
      viewer.sendInput("pointer-motion", { x: clickX, y: clickY });
      viewer.sendInput("pointer-button", { x: clickX, y: clickY, button: "left", state: "pressed" });
      viewer.sendInput("pointer-button", { x: clickX, y: clickY, button: "left", state: "released" });
      const titleAfterBroker = await until(
        async () => {
          const title = isolationWindow(await listedWindows(owners[0]!), "BOT-A")?.title ?? "";
          return title !== titleAfterRfb ? title : undefined;
        },
        8_000,
        "Broker click title",
      ).catch(async () => isolationWindow(await listedWindows(owners[0]!), "BOT-A")?.title ?? titleAfterRfb);
      latencies.inputToVisibleMs.push(Number((performance.now() - brokerStarted).toFixed(2)));
      const brokerMutated = titleAfterBroker !== titleAfterRfb && /click:/i.test(titleAfterBroker);
      const rfbBytes = rfb.messages.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      record(check(
        "rfb-view-only-and-broker",
        rfbReady && rfbDidNotMutate && brokerMutated,
        `RFB negotiated=${rfbReady} bytes=${rfbBytes}; RFB mutation rejected=${rfbDidNotMutate}; Broker mutated=${brokerMutated}; titles=${titleBeforeRfb} -> ${titleAfterRfb} -> ${titleAfterBroker}`,
        rfbDidNotMutate && brokerMutated ? undefined : "RFB view-only or Broker mutation was not proven",
      ));

      const secondViewer = await ProjectionClient.connect(harness.baseUrl, owners[0]!, "sway-conformance-second-viewer", harness.token);
      try {
        await secondViewer.setMode("expanded");
        const secondReady = secondViewer.rfb?.serverInit !== undefined;
        const wayvncCount = (await measureSwayCosts([owners[0]!], 400)).processes
          .filter((process) => process.executable.toLowerCase() === "wayvnc").length;
        await secondViewer.close();
        const firstViewerPreserved = await until(() => {
          const media = harness!.svc.projections.surfaceMedia(owners[0]!.surfaceId);
          return media.expandedViewers === 1 && media.rfbActive ? true : undefined;
        }, 5_000, "closing the second viewer tore down the first viewer").catch(() => false);
        record(check(
          "multiple-viewers",
          secondReady && wayvncCount === 1 && firstViewerPreserved,
          `second viewer negotiated=${secondReady}; wayvnc processes=${wayvncCount}; first viewer preserved=${firstViewerPreserved}`,
        ));
      } finally {
        await secondViewer.close().catch(() => {});
      }

      const expandedCosts = await measureSwayCosts([owners[0]!, owners[1]!], RESOURCE_WINDOW_MS);
      resourceScenarios.oneExpandedProjection = {
        ran: true,
        notes: ["Bot A negotiated bidirectional RFB, Bot B retained unviewed."],
        attribution: expandedCosts.attribution,
        network: expandedCosts.network,
        latency: { firstExpandedMs: distribution(latencies.firstExpandedMs) },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      limitations.push(message);
      if (!checks.some((item) => item.id === "rfb-view-only-and-broker")) {
        record(check("rfb-view-only-and-broker", false, "expanded RFB aborted", message));
      }
      if (!checks.some((item) => item.id === "multiple-viewers")) {
        record(check("multiple-viewers", false, "not exercised on real WayVNC", message));
      }
      resourceScenarios.oneExpandedProjection = {
        ran: false,
        notes: ["Expanded RFB did not complete protocol negotiation."],
        unmet: message,
      };
    } finally {
      await viewer.close().catch(() => {});
    }

    try {
      const switchViewer = await ProjectionClient.connect(harness.baseUrl, owners[1]!, "sway-conformance-switch-b", harness.token);
      try {
        await switchViewer.setMode("expanded");
        const switchedToB = switchViewer.rfb?.serverInit !== undefined;
        const pixelsAfterA = await screenshotBytes(owners[0]!);
        const pixelsAfterB = await screenshotBytes(owners[1]!);
        record(check(
          "bot-switching",
          switchedToB && digest(pixelsAfterA) !== digest(pixelsAfterB),
          `Bot B RFB negotiated=${switchedToB}; Bot A and Bot B screenshots stayed distinct`,
        ));
      } finally {
        await switchViewer.close().catch(() => {});
      }
    } catch (error) {
      record(check("bot-switching", false, "switch check aborted", error instanceof Error ? error.message : String(error)));
    }

    if (rfbReady) {
      const fallback = await ProjectionClient.connect(harness.baseUrl, owners[0]!, "sway-conformance-fallback", harness.token);
      try {
        const failed = fallback.waitForFailure().catch((error: Error) => {
          limitations.push(`projection-failure was not observed: ${error.message}`);
          return { reason: "none", snapshotFallback: false };
        });
        await fallback.setMode("expanded");
        const wayvnc = (await measureSwayCosts([owners[0]!], 200)).processes
          .find((process) => process.executable.toLowerCase() === "wayvnc");
        if (wayvnc !== undefined) process.kill(wayvnc.pid, "SIGKILL");
        const failure = await failed;
        const stillReady = harness.svc.screens.status(owners[0]!).state === "ready";
        record(check(
          "component-failure-fallback",
          failure.snapshotFallback && stillReady,
          `projection failure=${failure.reason}; snapshotFallback=${failure.snapshotFallback}; desktop=${harness.svc.screens.status(owners[0]!).state}; wayvncPid=${wayvnc?.pid ?? "none"}`,
        ));
      } finally {
        await fallback.close().catch(() => {});
      }
    } else {
      record(check(
        "component-failure-fallback",
        false,
        "skipped because RFB negotiation did not complete",
        "WayVNC-kill fallback runs only after view-only RFB and Broker are proven.",
      ));
    }

    const background = await measureSwayCosts([owners[0]!, owners[1]!], RESOURCE_WINDOW_MS, async () => {
      await act(owners[1]!, { name: "click", args: { x: 160, y: 220, button: "left" } }, "background-b");
      await Bun.sleep(RESOURCE_WINDOW_MS);
    });
    resourceScenarios.backgroundWork = {
      ran: true,
      notes: ["Bot B received Agent input while both desktops stayed alive."],
      attribution: background.attribution,
      network: background.network,
    };
    const switchCosts = await measureSwayCosts([owners[0]!, owners[1]!], RESOURCE_WINDOW_MS, async () => {
      for (let index = 0; index < 4; index += 1) {
        const owner = owners[index % 2]!;
        const client = await ProjectionClient.connect(harness!.baseUrl, owner, `sway-conformance-switch-${index}`, harness!.token);
        const startedAt = performance.now();
        await client.setMode("preview");
        await client.waitForPreviewFrame();
        latencies.reconnectMs.push(Number((performance.now() - startedAt).toFixed(2)));
        await client.close();
      }
    });
    resourceScenarios.repeatedSwitching = {
      ran: true,
      notes: ["Four preview attach/detach cycles across the two Bots."],
      attribution: switchCosts.attribution,
      network: switchCosts.network,
      latency: { reconnectMs: distribution(latencies.reconnectMs) },
    };
    resourceScenarios.severalRetainedOneSelected = {
      ran: true,
      notes: ["Two retained Sway sessions; measurements taken while one had been expanded earlier."],
      attribution: background.attribution,
      network: background.network,
      latency: { inputToVisibleMs: distribution(latencies.inputToVisibleMs) },
    };
    persist(report);

    const webBrowser = await chromium.launch({ headless: true });
    try {
      const page = await webBrowser.newPage();
      await page.addInitScript(
        ({ token, serviceUrl }) => {
          localStorage.setItem("omarchy-bot.device-token", token);
          localStorage.setItem("omarchy-bot.service-url", serviceUrl);
        },
        { token: harness.token, serviceUrl: harness.baseUrl },
      );
      await page.goto(`${harness.baseUrl}/?bot=${owners[0]!.botId}`);
      await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
      await page.getByRole("button", { name: "Open Web Control", exact: true }).waitFor();
      const firstPaintStarted = performance.now();
      await page.getByRole("button", { name: "Open Web Control", exact: true }).click();
      const canvas = page.getByTestId("computer-expanded-view").locator("canvas");
      await canvas.waitFor({ state: "visible" });
      const hasColor = (color: number[]): Promise<boolean> => canvas.evaluate((element, expected) => {
        const target = element as HTMLCanvasElement;
        const context = target.getContext("2d");
        if (context === null || target.width === 0 || target.height === 0) return false;
        const data = context.getImageData(0, 0, target.width, target.height).data;
        let matched = 0;
        for (let offset = 0; offset < data.length; offset += 32) {
          if (Math.abs(data[offset]! - expected[0]!) < 8 && Math.abs(data[offset + 1]! - expected[1]!) < 8
            && Math.abs(data[offset + 2]! - expected[2]!) < 8 && ++matched >= 100) return true;
        }
        return false;
      }, color);
      await until(async () => await hasColor([139, 30, 63]) ? true : undefined, 10_000, "real noVNC Bot A pixels");
      const firstBrowserPaintMs = performance.now() - firstPaintStarted;
      const targetWindow = isolationWindow(await listedWindows(owners[0]!), "BOT-A");
      if (targetWindow?.bounds === undefined) throw new Error("missing real browser input target");
      const beforeClicks = Number(/click:(\d+)$/.exec(targetWindow.title)?.[1] ?? 0);
      const expectedColor = (beforeClicks + 1) % 2 ? [255, 128, 0] : [0, 200, 255];
      const content = await canvas.boundingBox();
      if (content === null) throw new Error("real RFB canvas has no bounds");
      const screenshotSize = await canvas.evaluate((element) => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
      const browserInputStarted = performance.now();
      await page.mouse.click(
        content.x + (targetWindow.bounds.x + Math.min(120, targetWindow.bounds.width / 2)) / screenshotSize.width * content.width,
        content.y + (targetWindow.bounds.y + Math.min(150, targetWindow.bounds.height / 2)) / screenshotSize.height * content.height,
      );
      await until(async () => await hasColor(expectedColor) ? true : undefined, 10_000, "Broker input visible through real noVNC");
      const browserInputToPaintMs = performance.now() - browserInputStarted;
      const screenshotPath = process.env.OMARCHY_BOT_SWAY_SCREENSHOT;
      if (screenshotPath !== undefined) await page.screenshot({ path: screenshotPath });
      report.realBrowser = { firstPaintMs: firstBrowserPaintMs, inputToPaintMs: browserInputToPaintMs, transport: "WebSocket + noVNC", measuredBy: "specific canvas pixel colors" };
      record(check("real-browser-projection", true, `actual noVNC painted Bot A and Broker-driven marker change; first paint ${firstBrowserPaintMs.toFixed(2)}ms, input-to-paint ${browserInputToPaintMs.toFixed(2)}ms`));
      const done = page.getByRole("button", { name: "I'm done", exact: true });
      if (await done.isVisible()) await done.click();
    } finally {
      await webBrowser.close();
    }

    await focusFixtureEditor(owners[1]!, "BOT-B");
    await act(owners[1]!, { name: "key", args: { key: "Ctrl+A" } }, "select-unsaved-field");
    const unsavedValue = `UNSAVED-STATE ${UNICODE_SAMPLE}`;
    await act(owners[1]!, { name: "type", args: { text: unsavedValue } }, "unsaved");
    const beforeDetach = await until(async () => {
      const state = await browserFixtureState(owners[1]!, "BOT-B");
      return state?.value === unsavedValue ? state : undefined;
    }, 8_000, "unsaved browser field");
    const detachedViewer = await ProjectionClient.connect(harness.baseUrl, owners[1]!, "unsaved-before-detach", harness.token);
    await detachedViewer.setMode("expanded");
    const retainedGeneration = detachedViewer.session.runtimeGeneration;
    await detachedViewer.close();
    await until(async () => {
      const state = await browserFixtureState(owners[1]!, "BOT-B");
      return state !== undefined && state.counter > beforeDetach.counter + 1 ? state : undefined;
    }, 8_000, "background counter while all viewers are closed");
    const reopenedViewer = await ProjectionClient.connect(harness.baseUrl, owners[1]!, "unsaved-after-reopen", harness.token);
    await reopenedViewer.setMode("preview");
    await reopenedViewer.waitForPreviewFrame();
    const afterReopen = await browserFixtureState(owners[1]!, "BOT-B");
    record(check(
      "background-and-unsaved",
      afterReopen?.value === unsavedValue && afterReopen.windowId === beforeDetach.windowId
        && afterReopen.counter > beforeDetach.counter && reopenedViewer.session.runtimeGeneration === retainedGeneration,
      `same window/generation and exact unsaved field retained; counter ${beforeDetach.counter} -> ${afterReopen?.counter}`,
    ));
    await reopenedViewer.close();

    const urlPage = createIsolationPage(fixtureRoot, "URL-A", "#123456");
    const siblingIds = (await listedWindows(owners[1]!)).map((window) => window.id).sort();
    const urlServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(Bun.file(urlPage)) });
    try {
      await act(owners[0]!, { name: "open_url", args: { url: `http://127.0.0.1:${urlServer.port}/` } }, "open-url-a");
      const urlWindow = await until(async () => isolationWindow(await listedWindows(owners[0]!), "URL-A"), 15_000, "private URL launch");
      const siblingIdsAfter = (await listedWindows(owners[1]!)).map((window) => window.id).sort();
      record(check("agent-open-url", urlWindow !== undefined && JSON.stringify(siblingIds) === JSON.stringify(siblingIdsAfter),
        "open_url displayed the requested local page in Bot A without adding a Bot B window"));
    } finally {
      await urlServer.stop(true);
    }

    const deleteStarted = performance.now();
    const deleted = await api<{ status: string }>(harness, "DELETE", `/api/bots/${owners[0]!.botId}`, {});
    const runtimeA = path.join(harness.svc.cfg.botScreenRuntimeDir, owners[0]!.surfaceId);
    const sharedProfileDir = path.join(harness.svc.cfg.botScreenProfileDir, "computer");
    const siblingStillReady = harness.svc.screens.status(owners[1]!).state === "ready";
    const replacementId = await makeBot(harness, "Sway conformance replacement");
    const replacement = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${replacementId}`);
    const replacementOwner = { botId: replacementId, surfaceId: replacement.surfaceId };
    await waitScreenReady(harness, replacementOwner);
    latencies.cleanupMs.push(Number((performance.now() - deleteStarted).toFixed(2)));
    record(check(
      "delete-reprovision-cleanup",
      deleted.status === "deleted"
        && !existsSync(runtimeA)
        && existsSync(sharedProfileDir)
        && siblingStillReady
        && harness.svc.screens.status(replacementOwner).state === "ready",
      `deleted A; sibling ready=${siblingStillReady}; replacement ready; runtime gone=${!existsSync(runtimeA)}`,
    ));

    const cleanupStarted = performance.now();
    await api<{ status: string }>(harness, "DELETE", `/api/bots/${owners[1]!.botId}`, {});
    await api<{ status: string }>(harness, "DELETE", `/api/bots/${replacementId}`, {});
    await harness.stop();
    harness = undefined;
    latencies.cleanupMs.push(Number((performance.now() - cleanupStarted).toFixed(2)));
    const leftovers = leftoverSurfaceProcesses([
      owners[0]!.surfaceId,
      owners[1]!.surfaceId,
      replacement.surfaceId,
    ]);
    record(check(
      "complete-cleanup",
      leftovers.length === 0,
      leftovers.length === 0 ? "no leftover surface-scoped processes" : leftovers.join(", "),
    ));
    resourceScenarios.cleanup = {
      ran: true,
      notes: ["Delete/reprovision and final stop."],
      latency: { cleanupMs: distribution(latencies.cleanupMs) },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    limitations.push(message);
    if (!checks.some((item) => item.id === "two-real-sway-sessions")) {
      record(check("two-real-sway-sessions", false, "harness aborted", message));
    }
  } finally {
    hostAfter = await snapshotHostIsolation();
    const isolation = hostBefore === undefined || hostAfter === undefined
      ? { ok: false, deltas: ["host snapshot missing"] }
      : isolationUnchanged(hostBefore, hostAfter);
    const testWaylandUnchanged = process.env.WAYLAND_DISPLAY === originalWayland
      || (originalWayland === undefined && process.env.WAYLAND_DISPLAY === undefined);
    const testSwaySockUnchanged = process.env.SWAYSOCK === originalSwaySock
      || (originalSwaySock === undefined && process.env.SWAYSOCK === undefined);
    record(check(
      "host-session-isolation",
      isolation.ok && testWaylandUnchanged && testSwaySockUnchanged,
      isolation.ok
        ? `host compositor PID ${hostAfter?.compositorPid} and WAYLAND_DISPLAY/SWAYSOCK unchanged`
        : isolation.deltas.join("; "),
      isolation.ok ? undefined : "host compositor or session endpoints changed",
    ));
    report.hostIsolation = {
      before: hostBefore,
      after: hostAfter,
      unchanged: isolation.ok && testWaylandUnchanged && testSwaySockUnchanged,
      deltas: isolation.deltas,
    };
    report.latencies = {
      coldRequestToReadyMs: distribution(latencies.coldReadyMs),
      firstPreviewMs: distribution(latencies.firstPreviewMs),
      rfbHandshakeMs: distribution(latencies.firstExpandedMs),
      reconnectMs: distribution(latencies.reconnectMs),
      inputToVisibleMs: distribution(latencies.inputToVisibleMs),
      cleanupMs: distribution(latencies.cleanupMs),
    };
    for (const id of REQUIRED_CHECKS) {
      if (!checks.some((item) => item.id === id)) {
        record(check(id, false, "not reached", "harness stopped before this check ran"));
      }
    }
    const correctnessFailed = REQUIRED_CHECKS.some((id) => checks.find((item) => item.id === id)?.passed !== true);
    cutover = correctnessFailed ? "blocked" : "go";
    report.cutover = cutover;
    report.status = "complete";
    report.limitations = [
      ...limitations,
      "Daemon and test harness share one process; daemon cost is not a split.",
      "Host /proc/net/dev is whole-host interface counters, not WayVNC-unix attribution.",
      "RFB frame/drop accounting is message-byte presence on the view channel, not an H.264 encoder pipeline.",
      "Historical Cage/Xvnc numeric rows were not compared.",
      ...HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE.map((item) => `Human-only: ${item}`),
    ];
    persist(report);
  }

  expect(existsSync(REPORT_MD)).toBeTrue();
  expect(report.cutover).toBe("go");
  const isolationCheck = checks.find((item) => item.id === "host-session-isolation");
  expect(isolationCheck?.passed).toBeTrue();
  expect(checks.filter((item) => !item.passed).map((item) => item.id)).toEqual([]);
}, 240_000);
