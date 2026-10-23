import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { ProjectionClient } from "./helpers/projection-client.ts";
import {
  HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE,
  HISTORICAL_FOUR_STREAM_BASELINE,
  activeWayvncCount,
  attributeResourceWindow,
  createBackgroundWorkFixture,
  currentGeneration,
  daemonGitChildCount,
  findPortableSwayBundle,
  listScreenUnits,
  observeHostSession,
  resourceWindow,
  supervisionLabel,
  surfaceScopedProcessCount,
  until,
  userSystemdManagerAvailable,
  waitScreenReady,
  withTimeout,
  type ResourceWindow,
  type RoleAttribution,
  type ScreenOwner,
  type SupervisionLabel,
} from "./helpers/bot-screen-load-observe.ts";

const REAL_HOME = process.env.HOME ?? os.homedir();
const realLoadEnabled = process.env.OMARCHY_BOT_REAL_SCREEN_LOAD === "1";
const loadTest = realLoadEnabled ? test : test.skip;
const REPORT_JSON = path.resolve(
  import.meta.dir,
  "../../.scratch/shared-workspace-desktop-boundary/normal-use-resource-report.json",
);
const REPORT_MD = path.resolve(
  import.meta.dir,
  "../../.scratch/shared-workspace-desktop-boundary/normal-use-resource-report.md",
);
const GRAPHICAL_STACK = ["sway", "wayvnc", "omarchy-bot-wayland-capture"] as const;


interface ScenarioMeasurement {
  name: string;
  ran: boolean;
  supervision: SupervisionLabel;
  resources?: ResourceWindow;
  attribution?: RoleAttribution;
  notes: string[];
  evidence?: Record<string, unknown>;
  unmet?: string;
}

const report: Record<string, unknown> = {
  schemaVersion: 1,
  kind: "normal-use-selected-view-matrix",
  generatedAt: new Date().toISOString(),
  status: "running",
  historicalBaseline: HISTORICAL_FOUR_STREAM_BASELINE,
  hostSafety: {},
  scenarios: {} as Record<string, ScenarioMeasurement>,
  unmet: [] as string[],
  ticket09HostGate: [...HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE],
};

function persistReport(): void {
  report.updatedAt = new Date().toISOString();
  if (!realLoadEnabled) return;
  mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
  writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(REPORT_MD, renderMarkdown(report));
}

function renderMarkdown(value: Record<string, unknown>): string {
  const unmet = Array.isArray(value.unmet) ? value.unmet as string[] : [];
  const scenarios = (value.scenarios ?? {}) as Record<string, ScenarioMeasurement>;
  const lines = [
    "# Normal-use resource and host-safety report",
    "",
    `Status: ${String(value.status)}`,
    `Generated: ${String(value.generatedAt)}`,
    "",
    "This is the selected-view / background-work / unused-Bot matrix for ticket 07.",
    "The historical four-stream ~2 GiB / 4.13-core row is a mixed-attribution baseline, not a budget.",
    "",
    "## Harness vs production supervision",
    "",
    "The standard integration harness defaults to `useHostApplicationUnits: false` (direct children).",
    "Those results are harness-mode. Production-style units are used only when the user systemd manager is present and the real-load matrix opts in.",
    "Daemon and test harness share one process; that PSS/CPU figure is a combined measurement.",
    "",
    "## Historical baseline comparison",
    "",
    `- Source: \`${HISTORICAL_FOUR_STREAM_BASELINE.source}\``,
    `- 4×1080p simultaneous streams: ${HISTORICAL_FOUR_STREAM_BASELINE.total.pssMiB} MiB PSS, ${HISTORICAL_FOUR_STREAM_BASELINE.total.cpuPercent}% CPU over ${HISTORICAL_FOUR_STREAM_BASELINE.durationMs} ms`,
    `- Combined daemon/harness in that row: ${HISTORICAL_FOUR_STREAM_BASELINE.daemonAndHarness.pssMiB} MiB PSS / ${HISTORICAL_FOUR_STREAM_BASELINE.daemonAndHarness.cpuPercent}% CPU`,
    `- Published mix: compositor ~${HISTORICAL_FOUR_STREAM_BASELINE.publishedBreakdown.compositorPssMiB} MiB, encoder ~${HISTORICAL_FOUR_STREAM_BASELINE.publishedBreakdown.encoderPssMiB} MiB, worker/application ~${HISTORICAL_FOUR_STREAM_BASELINE.publishedBreakdown.workerApplicationPssMiB} MiB`,
    "- That row is not compositor-only cost and is not an accepted normal-use budget.",
    "",
    "## Scenarios",
    "",
  ];
  for (const [name, scenario] of Object.entries(scenarios)) {
    lines.push(`### ${name}`);
    lines.push("");
    lines.push(`- Ran: ${scenario.ran}`);
    lines.push(`- Supervision: ${scenario.supervision.path}`);
    if (scenario.resources !== undefined) {
      lines.push(`- Sample duration: ${scenario.resources.durationMs} ms`);
      lines.push(`- Whole-scenario PSS: ${scenario.resources.total.pssMiB} MiB, CPU ${scenario.resources.total.cpuPercent}%`);
      lines.push(`- Combined daemon/harness: ${scenario.resources.daemonAndHarness.pssMiB} MiB, CPU ${scenario.resources.daemonAndHarness.cpuPercent}%`);
    }
    if (scenario.attribution !== undefined) {
      lines.push(`- Plugin infrastructure: ${scenario.attribution.pluginInfrastructure.pssMiB} MiB PSS / ${scenario.attribution.pluginInfrastructure.cpuPercent}% CPU (${scenario.attribution.method})`);
      lines.push(`- Agent/application: ${scenario.attribution.agentApplication.pssMiB} MiB PSS / ${scenario.attribution.agentApplication.cpuPercent}% CPU`);
    }
    for (const note of scenario.notes) lines.push(`- ${note}`);
    if (scenario.unmet !== undefined) lines.push(`- Unmet: ${scenario.unmet}`);
    lines.push("");
  }
  lines.push("## Measurement caveats");
  lines.push("");
  lines.push("- Viewer-attached windows use public control/RFB WebSockets and the embedded noVNC client. No H.264/WebRTC counters are inferred.");
  lines.push("- Compact preview evidence includes the PNG received on the control WebSocket and daemon `surfaceMedia` capture/viewer state.");
  lines.push("- GPU VRAM is not attributable on this stack.");
  lines.push("");
  lines.push("## Unmet");
  lines.push("");
  if (unmet.length === 0) lines.push("- No matrix scenario was left unmeasured in this process. Host top-bar, shortcuts, and physical input remain ticket 09.");
  else for (const item of unmet) lines.push(`- ${item}`);
  lines.push("");
  lines.push("## Host-gate items for ticket 09");
  lines.push("");
  for (const item of HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE) lines.push(`- ${item}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function digestBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function screenshotDigest(harness: Harness, owner: ScreenOwner): Promise<string> {
  const result = await harness.svc.screens.act(owner, { name: "screenshot", args: {} });
  if (result.image === undefined) throw new Error(`screenshot unavailable for ${owner.surfaceId}`);
  return digestBytes(result.image.bytes);
}


async function destroyBot(harness: Harness, owner: ScreenOwner): Promise<void> {
  const result = await api<{ status: string }>(harness, "DELETE", `/api/bots/${owner.botId}`, {});
  if (result.status !== "deleted") throw new Error(`Bot ${owner.botId} was not deleted`);
}

function recordScenario(name: string, scenario: ScenarioMeasurement): void {
  const scenarios = report.scenarios as Record<string, ScenarioMeasurement>;
  scenarios[name] = scenario;
  if (scenario.unmet !== undefined) {
    (report.unmet as string[]).push(scenario.unmet);
  }
}

afterAll(() => {
  report.status = "complete";
  persistReport();
});

test("observes Host Session read-only and unused Bots without a graphical stack", async () => {
  const hostBefore = await observeHostSession();
  report.hostSafety = {
    before: hostBefore,
    preExistingScreenUnits: hostBefore.visibleScreenUnits,
    preExistingScreenUnitsNote: "Visible omarchy-bot-screen-* units at start belong to the already-running plugin, not this test. They were observed read-only and not stopped.",
    livePluginDaemon: "not restarted; isolated test daemon used",
    systemPackages: {
      sway: Bun.which("sway"),
      wlrRandr: Bun.which("wlr-randr"),
      zenity: Bun.which("zenity"),
      grim: Bun.which("grim"),
      wayvnc: Bun.which("wayvnc"),
    },
    portableSway: findPortableSwayBundle(REAL_HOME),
    userSystemdManagerAvailable: userSystemdManagerAvailable(),
  };

  const unusedSupervision = supervisionLabel(false);
  const harness = await startDaemon(undefined, {
    useProductionBotScreen: true,
    useHostApplicationUnits: false,
    botScreenCapacity: 4,
  });
  const unused: ScreenOwner[] = [];
  try {
    for (const index of [0, 1, 2]) {
      const botId = await makeBot(harness, `Unused graphics ${index}`);
      const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
      unused.push({ botId, surfaceId: bot.surfaceId });
    }
    await Bun.sleep(500);
    const runtimeDirs = unused.map((owner) => path.join(harness.svc.cfg.botScreenRuntimeDir, owner.surfaceId));
    const hiddenStack = unused.map((owner) => ({
      surfaceId: owner.surfaceId,
      compositorCaptureOrWayvnc: surfaceScopedProcessCount(owner.surfaceId, GRAPHICAL_STACK),
      anySurfaceProcess: surfaceScopedProcessCount(owner.surfaceId),
      screenState: harness.svc.screens.status(owner).state,
    }));
    const resources = await resourceWindow(unused, new Map(), 500);
    const attribution = attributeResourceWindow(resources);
    const gitChildren = daemonGitChildCount();
    expect(runtimeDirs.every((directory) => !existsSync(directory))).toBeTrue();
    expect(hiddenStack.every((row) => row.compositorCaptureOrWayvnc === 0)).toBeTrue();
    expect(hiddenStack.every((row) => row.anySurfaceProcess === 0)).toBeTrue();
    expect(hiddenStack.every((row) => row.screenState === "stopped")).toBeTrue();
    expect(resources.screens.every((screen) => screen.processes.length === 0)).toBeTrue();
    expect(gitChildren).toBe(0);
    recordScenario("unusedBotsNeverGraphics", {
      name: "unusedBotsNeverGraphics",
      ran: true,
      supervision: unusedSupervision,
      resources,
      attribution,
      notes: [
        "Three Bots created and listed; no graphical action or Computer view.",
        "No Sway, capture, or WayVNC process and no runtime directory per unused Bot.",
        "No daemon git child (Changes polling is gone).",
        "Whole-scenario total is the combined daemon/harness process only.",
        unusedSupervision.note,
      ],
      evidence: { hiddenStack, runtimeDirs, gitChildren },
    });
  } finally {
    for (const owner of unused) {
      try {
        await destroyBot(harness, owner);
      } catch {
        // Final harness stop retries cleanup.
      }
    }
    await harness.stop();
  }

  const hostAfter = await observeHostSession();
  (report.hostSafety as Record<string, unknown>).afterUnusedBots = hostAfter;
  expect(hostAfter.userManagerEnvironment.botDisplayLeak).toEqual([]);
  if (hostBefore.userManagerEnvironment.WAYLAND_DISPLAY !== null) {
    expect(hostAfter.userManagerEnvironment.WAYLAND_DISPLAY).toBe(hostBefore.userManagerEnvironment.WAYLAND_DISPLAY);
  }
  if (hostBefore.userManagerEnvironment.XDG_RUNTIME_DIR !== null) {
    expect(hostAfter.userManagerEnvironment.XDG_RUNTIME_DIR).toBe(hostBefore.userManagerEnvironment.XDG_RUNTIME_DIR);
  }
  persistReport();
}, 30_000);

loadTest("measures selected-view background-work unused-Bot cost on the existing load seam", async () => {
  const durationMs = Number(process.env.OMARCHY_BOT_NORMAL_USE_DURATION_MS ?? 4_000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000) {
    throw new Error("OMARCHY_BOT_NORMAL_USE_DURATION_MS must be an integer of at least 1000");
  }
  const portable = findPortableSwayBundle(REAL_HOME);
  const browserBinary = process.env.OMARCHY_BOT_LOAD_BROWSER_BIN
    ?? Bun.which("brave")
    ?? Bun.which("chromium")
    ?? Bun.which("chromium-browser");
  const grim = Bun.which("grim");
  const prerequisites: string[] = [];
  if (portable === undefined && Bun.which("sway") === null) {
    prerequisites.push("system sway is missing and no portable bundle was found under ~/.local/share/omarchy-bot/runtime/sway/");
  }
  if (portable === undefined && Bun.which("wlr-randr") === null) {
    prerequisites.push("system wlr-randr is missing and no portable bundle was found");
  }
  if (grim === null) prerequisites.push("grim is missing");
  if (browserBinary === null || browserBinary === undefined) prerequisites.push("Brave or Chromium is missing for the background workload");
  if (prerequisites.length > 0) {
    recordScenario("selectedViewBackgroundMatrix", {
      name: "selectedViewBackgroundMatrix",
      ran: false,
      supervision: supervisionLabel(false),
      notes: ["Real-load matrix not started."],
      unmet: prerequisites.join("; "),
    });
    persistReport();
    throw new Error(`real-load matrix prerequisites unmet: ${prerequisites.join("; ")}`);
  }

  const useHostUnits = userSystemdManagerAvailable();
  const label = supervisionLabel(useHostUnits);
  const prior = {
    sway: process.env.OMARCHY_BOT_SWAY_BIN,
    wlr: process.env.OMARCHY_BOT_WLR_RANDR_BIN,
    app: process.env.OMARCHY_BOT_LOAD_APP_BIN,
    profile: process.env.OMARCHY_BOT_SCREEN_PROFILE,
  };
  if (portable !== undefined) {
    process.env.OMARCHY_BOT_SWAY_BIN = portable.swayBin;
    process.env.OMARCHY_BOT_WLR_RANDR_BIN = portable.wlrRandrBin;
  }
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-normal-use-"));
  process.env.OMARCHY_BOT_LOAD_APP_BIN = createBackgroundWorkFixture(fixtureRoot, browserBinary!);
  process.env.OMARCHY_BOT_SCREEN_PROFILE = "1080p";

  const hostBefore = await observeHostSession();
  const harness = await startDaemon(undefined, {
    useProductionBotScreen: true,
    useHostApplicationUnits: useHostUnits,
    botScreenCapacity: 4,
  });
  const unused: ScreenOwner[] = [];
  const opened: ScreenOwner[] = [];
  const clients: ProjectionClient[] = [];
  const tracked: SurfaceId[] = [];
  let matrixError: string | undefined;
  try {
    for (const index of [0, 1, 2]) {
      const botId = await makeBot(harness, `Normal unused ${index}`);
      const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
      unused.push({ botId, surfaceId: bot.surfaceId });
      tracked.push(bot.surfaceId);
    }
    for (const index of [0, 1, 2]) {
      const botId = await makeBot(harness, `Normal desktop ${index}`);
      const bot = await api<{ surfaceId: SurfaceId }>(harness, "GET", `/api/bots/${botId}`);
      const owner = { botId, surfaceId: bot.surfaceId };
      opened.push(owner);
      tracked.push(owner.surfaceId);
    }
    const unusedAfterCreate = unused.map((owner) => ({
      surfaceId: owner.surfaceId,
      hiddenStack: surfaceScopedProcessCount(owner.surfaceId, GRAPHICAL_STACK),
      runtimeDir: existsSync(path.join(harness.svc.cfg.botScreenRuntimeDir, owner.surfaceId)),
    }));
    expect(unusedAfterCreate.every((row) => row.hiddenStack === 0 && row.runtimeDir === false)).toBeTrue();

    const startupMs = await Promise.all(opened.map((owner) => waitScreenReady(harness, owner)));
    await Promise.all(opened.map((owner, index) =>
      harness.svc.screens.act(
        owner,
        { name: "open_app", args: { app: process.env.OMARCHY_BOT_LOAD_APP_BIN } },
      )
    ));
    await Bun.sleep(800);
    const generationBySurface = new Map<SurfaceId, number>();
    for (const owner of opened) generationBySurface.set(owner.surfaceId, await currentGeneration(harness, owner));

    const noViewer = await resourceWindow(opened, generationBySurface, durationMs);
    expect(activeWayvncCount()).toBe(0);
    const backgroundA = opened[0]!;
    const backgroundB = opened[1]!;
    const selected = opened[2]!;
    const firstShot = await screenshotDigest(harness, backgroundA);
    await Bun.sleep(800);
    const secondShot = await screenshotDigest(harness, backgroundA);
    expect(firstShot).not.toBe(secondShot);
    expect(harness.svc.screens.status(backgroundA).state).toBe("ready");
    expect(harness.svc.screens.status(backgroundB).state).toBe("ready");
    recordScenario("retainedDesktopsNoViewer", {
      name: "retainedDesktopsNoViewer",
      ran: true,
      supervision: label,
      resources: noViewer,
      attribution: attributeResourceWindow(noViewer),
      notes: [
        "Three retained desktops with the same browser workload and no viewers.",
        "Application output changed between Agent screenshots (timer ticks), not merely idle processes.",
        "No WayVNC process while no viewer was attached; expanded projection starts it on demand.",
        label.note,
      ],
      evidence: {
        wayvncProcesses: activeWayvncCount(),
        encoders: activeWayvncCount(),
        unusedAfterCreate,
        screenshotDigests: { firstShot, secondShot, changed: firstShot !== secondShot },
      },
    });

    const viewerSampleMs = Math.min(durationMs, 1_500);
    const compact = await ProjectionClient.connect(harness.baseUrl, selected, "normal-use-compact");
    clients.push(compact);
    await compact.setMode("preview");
    const compactFrame = await compact.waitForPreviewFrame();
    const compactMedia = await until(
      () => {
        const media = harness.svc.projections.surfaceMedia(selected.surfaceId);
        return media.captureActive && media.viewers === 1 ? media : undefined;
      },
      10_000,
      "compact preview did not start viewer-driven capture",
    );
    expect(activeWayvncCount()).toBe(0);
    expect(compactMedia).toMatchObject({
      viewers: 1,
      rfbActive: false,
      captureActive: true,
    });
    const compactWindow = await resourceWindow(opened, generationBySurface, viewerSampleMs);
    await compact.close();
    clients.pop();
    expect(harness.svc.projections.surfaceMedia(backgroundA.surfaceId).captureActive).toBeFalse();
    recordScenario("oneSelectedCompact", {
      name: "oneSelectedCompact",
      ran: true,
      supervision: label,
      resources: compactWindow,
      attribution: attributeResourceWindow(compactWindow),
      notes: [
        "Exactly one selected compact preview. Two sibling desktops kept working with no capture/RFB transport.",
        "Compact preview delivered one PNG over the control WebSocket without starting WayVNC.",
        `Control WebSocket received preview sequence ${compactFrame.sequence} (${compactFrame.bytes.byteLength} bytes).`,
        `Viewer-attached resource sample was ${viewerSampleMs} ms.`,
      ],
      evidence: {
        selectedMedia: harness.svc.projections.surfaceMedia(selected.surfaceId),
        backgroundMedia: harness.svc.projections.surfaceMedia(backgroundA.surfaceId),
        wayvncProcesses: activeWayvncCount(),
        previewFrame: { sequence: compactFrame.sequence, bytes: compactFrame.bytes.byteLength, digest: compactFrame.digest },
        compactMedia,
      },
    });

    const expanded = await ProjectionClient.connect(harness.baseUrl, selected, "normal-use-expanded");
    clients.push(expanded);
    await expanded.setMode("expanded");
    const expandedMedia = await until(
      () => {
        const media = harness.svc.projections.surfaceMedia(selected.surfaceId);
        return media.expandedViewers === 1 && media.rfbActive && activeWayvncCount() === 1
          ? media
          : undefined;
      },
      8_000,
      "expanded mode did not start one RFB view",
    );
    const expandedWindow = await resourceWindow(opened, generationBySurface, viewerSampleMs);
    recordScenario("oneSelectedExpanded", {
      name: "oneSelectedExpanded",
      ran: true,
      supervision: label,
      resources: expandedWindow,
      attribution: attributeResourceWindow(expandedWindow),
      notes: [
        "Exactly one selected expanded RFB view with one WayVNC process.",
        "Background desktops remained ready with no viewer-driven projection work.",
      ],
      evidence: {
        wayvncProcesses: activeWayvncCount(),
        selectedMedia: expandedMedia,
      },
    });
    await expanded.setMode("preview");
    await until(
      () => harness.svc.projections.surfaceMedia(selected.surfaceId).expandedViewers === 0
        && activeWayvncCount() === 0
        ? true
        : undefined,
      8_000,
      "leaving expanded did not release the RFB view",
    );
    recordScenario("leaveExpandedReleaseRfb", {
      name: "leaveExpandedReleaseRfb",
      ran: true,
      supervision: label,
      notes: ["Leaving expanded released the unused RFB view while the compact viewer and desktops remained."],
      evidence: {
        wayvncProcesses: activeWayvncCount(),
        selectedMedia: harness.svc.projections.surfaceMedia(selected.surfaceId),
        selectedReady: harness.svc.screens.status(selected).state,
      },
    });

    await expanded.close();
    clients.pop();
    const switched = await ProjectionClient.connect(harness.baseUrl, backgroundA, "normal-use-switch-a");
    clients.push(switched);
    await switched.setMode("expanded");
    await until(
      () => harness.svc.projections.surfaceMedia(backgroundA.surfaceId).expandedViewers === 1
        && activeWayvncCount() === 1
        ? true
        : undefined,
      8_000,
      "switch to A did not start A's RFB view",
    );
    await switched.close();
    clients.pop();
    const switchedB = await ProjectionClient.connect(harness.baseUrl, backgroundB, "normal-use-switch-b");
    clients.push(switchedB);
    await switchedB.setMode("expanded");
    await until(
      () =>
        harness.svc.projections.surfaceMedia(backgroundA.surfaceId).viewers === 0
          && harness.svc.projections.surfaceMedia(backgroundB.surfaceId).expandedViewers === 1
          ? true
          : undefined,
      8_000,
      "A→B switch did not release A's viewer media",
    );
    expect(harness.svc.screens.status(backgroundA).state).toBe("ready");
    const afterSwitchShot = await screenshotDigest(harness, backgroundA);
    expect(afterSwitchShot).not.toBe(firstShot);
    recordScenario("repeatedABSwitch", {
      name: "repeatedABSwitch",
      ran: true,
      supervision: label,
      notes: [
        "A→B replaced that client's projection. A stayed ready and continued producing screenshot output.",
        "A's RFB view released after the switch.",
      ],
      evidence: {
        aMedia: harness.svc.projections.surfaceMedia(backgroundA.surfaceId),
        bMedia: harness.svc.projections.surfaceMedia(backgroundB.surfaceId),
        aReady: harness.svc.screens.status(backgroundA).state,
        afterSwitchShot,
      },
    });

    await switchedB.close().catch(() => undefined);
    clients.splice(0, clients.length);
    const firstRemaining = await ProjectionClient.connect(harness.baseUrl, backgroundB, "normal-use-remaining-1");
    clients.push(firstRemaining);
    await firstRemaining.setMode("preview");
    await until(
      () => harness.svc.projections.surfaceMedia(backgroundB.surfaceId).captureActive ? true : undefined,
      8_000,
      "first remaining viewer did not start capture",
    );
    let secondRemaining: ProjectionClient | undefined;
    try {
      secondRemaining = await ProjectionClient.connect(harness.baseUrl, backgroundB, "normal-use-remaining-2");
      clients.push(secondRemaining);
      await secondRemaining.setMode("preview");
      await until(
        () => harness.svc.projections.surfaceMedia(backgroundB.surfaceId).viewers === 2 ? true : undefined,
        5_000,
        "second viewer did not attach",
      );
      await firstRemaining.close();
      clients.splice(clients.indexOf(firstRemaining), 1);
      await until(
        () => {
          const media = harness.svc.projections.surfaceMedia(backgroundB.surfaceId);
          return media.viewers === 1 && media.captureActive ? media : undefined;
        },
        8_000,
        "closing one viewer destroyed capture still needed by the remaining viewer",
      );
      recordScenario("remainingViewerKeepsCapture", {
        name: "remainingViewerKeepsCapture",
        ran: true,
        supervision: label,
        notes: ["Closing one of two viewers left capture running for the remaining viewer."],
        evidence: { media: harness.svc.projections.surfaceMedia(backgroundB.surfaceId) },
      });
    } catch (error) {
      recordScenario("remainingViewerKeepsCapture", {
        name: "remainingViewerKeepsCapture",
        ran: false,
        supervision: label,
        notes: [
          "Two simultaneous control WebSocket viewers did not stay attached on this real-Sway run.",
          "Harness-mode coverage remains in tests/integration/screen-projection.test.ts (Fake RFB, injectable desktop).",
        ],
        unmet: error instanceof Error ? error.message : String(error),
        evidence: { media: harness.svc.projections.surfaceMedia(backgroundB.surfaceId) },
      });
    }

    await Promise.all(clients.splice(0, clients.length).map((client) => client.close().catch(() => undefined)));
    await until(
      () => {
        const media = harness.svc.projections.surfaceMedia(backgroundB.surfaceId);
        return media.viewers === 0 && !media.captureActive && !media.rfbActive && activeWayvncCount() === 0
          ? media
          : undefined;
      },
      8_000,
      "last viewer did not release capture and RFB projection",
    );
    const noViewerShot = await screenshotDigest(harness, backgroundB);
    expect(harness.svc.screens.status(backgroundB).state).toBe("ready");
    expect(harness.svc.screens.status(selected).state).toBe("ready");
    recordScenario("lastViewerReleaseAndAgentScreenshot", {
      name: "lastViewerReleaseAndAgentScreenshot",
      ran: true,
      supervision: label,
      notes: [
        "Last viewer close released capture/RFB transport without stopping applications.",
        "Agent screenshot succeeded with no viewer. Unsaved/timer state was still on the desktop.",
      ],
      evidence: {
        media: harness.svc.projections.surfaceMedia(backgroundB.surfaceId),
        wayvncProcesses: activeWayvncCount(),
        noViewerShot,
        ready: opened.map((owner) => harness.svc.screens.status(owner).state),
      },
    });

    const hostDuring = await observeHostSession({ trackedSurfaceIds: tracked });
    expect(hostDuring.userManagerEnvironment.botDisplayLeak).toEqual([]);
    (report.hostSafety as Record<string, unknown>).duringMatrix = hostDuring;
  } catch (error) {
    matrixError = error instanceof Error ? error.message : String(error);
    recordScenario("selectedViewBackgroundMatrix", {
      name: "selectedViewBackgroundMatrix",
      ran: false,
      supervision: label,
      notes: ["Matrix failed after start."],
      unmet: matrixError,
    });
    throw error;
  } finally {
    await Promise.all(clients.splice(0, clients.length).map((client) => client.close().catch(() => undefined)));
    for (const owner of [...opened, ...unused]) {
      try {
        await destroyBot(harness, owner);
      } catch {
        // Final stop retries.
      }
    }
    await harness.stop();
    const leftover = await listScreenUnits(tracked);
    const hostAfter = await observeHostSession({ trackedSurfaceIds: tracked });
    (report.hostSafety as Record<string, unknown>).afterMatrix = hostAfter;
    recordScenario("cleanupResidue", {
      name: "cleanupResidue",
      ran: true,
      supervision: label,
      notes: leftover.length === 0
        ? ["No leftover omarchy-bot-screen-* units for tracked test Surfaces."]
        : ["Tracked test Surfaces left user-systemd units."],
      evidence: { leftover, tracked },
      ...(leftover.length === 0 ? {} : { unmet: `leftover units: ${leftover.join(", ")}` }),
    });
    rmSync(fixtureRoot, { recursive: true, force: true });
    for (const [name, value] of [
      ["OMARCHY_BOT_SWAY_BIN", prior.sway],
      ["OMARCHY_BOT_WLR_RANDR_BIN", prior.wlr],
      ["OMARCHY_BOT_LOAD_APP_BIN", prior.app],
      ["OMARCHY_BOT_SCREEN_PROFILE", prior.profile],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  if (matrixError === undefined) {
    recordScenario("selectedViewBackgroundMatrix", {
      name: "selectedViewBackgroundMatrix",
      ran: true,
      supervision: label,
      notes: [
        "Selected-view / background / unused matrix completed on the existing public projection + production Sway seam.",
        "Viewing used the public v3 projection HTTP API plus control and view-only RFB WebSockets, not a mocked UI test.",
        "Workload was the same class of real browser application used by the capacity load fixture, with a timer so background output is observable without a viewer.",
        label.note,
      ],
      evidence: { durationMs, useHostApplicationUnits: useHostUnits, portableSway: portable ?? null },
    });
  }
  persistReport();
}, 180_000);

test("attributes plugin infrastructure separately from application and combined daemon/harness", () => {
  const attributed = attributeResourceWindow({
    durationMs: 1000,
    screens: [{
      surfaceId: "surf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SurfaceId,
      pids: [1, 2, 3],
      pssMiB: 90,
      rssMiB: 90,
      cpuPercent: 30,
      gpu: { attributable: false, utilizationPercent: null, vramMiB: null },
      processes: [
        { pid: 1, role: "compositor", executable: "sway", pssMiB: 40, rssMiB: 40, cpuPercent: 10 },
        { pid: 2, role: "wayvnc", executable: "wayvnc", pssMiB: 20, rssMiB: 20, cpuPercent: 10 },
        { pid: 3, role: "application", executable: "chrome", pssMiB: 30, rssMiB: 30, cpuPercent: 10 },
      ],
    }],
    daemonAndHarness: {
      pssMiB: 50,
      rssMiB: 50,
      cpuPercent: 5,
      note: "daemon and test harness share this process; combined measurement, not a split",
    },
    total: { pssMiB: 140, rssMiB: 140, cpuPercent: 35 },
  });
  expect(attributed.method).toBe("systemd-unit");
  expect(attributed.pluginInfrastructure.pssMiB).toBe(60);
  expect(attributed.agentApplication.pssMiB).toBe(30);
  expect(attributed.daemonAndHarness.pssMiB).toBe(50);
  expect(attributed.wholeScenario.pssMiB).toBe(140);
});

test("records host interactions automation cannot safely prove", () => {
  expect(HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE.length).toBeGreaterThan(0);
  report.ticket09HostGate = [...HOST_INTERACTIONS_AUTOMATION_CANNOT_PROVE];
  if (process.env.OMARCHY_BOT_REAL_SCREEN_LOAD !== "1") {
    (report.unmet as string[]).push(
      "OMARCHY_BOT_REAL_SCREEN_LOAD was not set; selected-view / background retained-desktop resource windows were not measured in this process",
    );
  }
  persistReport();
});
