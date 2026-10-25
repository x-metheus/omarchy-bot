import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { SurfaceId } from "@omarchy-bot/domain";
import type { ComputerWindowListItem } from "@omarchy-bot/agent-contract";
import {
  ApplicationUnits,
  applicationUnitName,
} from "../../supervision/applicationUnits.ts";
import {
  BotComputerRuntime,
  swayRuntimeOverrides,
  type BotComputer,
  type BotComputerOptions,
} from "./botComputer.ts";
import {
  BotScreenInputRejectedError,
  type BotScreenCapture,
  type BotScreenCaptureStream,
  type BotScreenExpandedView,
  type BotScreenLaunchRequest,
  type BotScreenProvision,
  type BotScreenRuntime,
  type BotScreenRuntimeAdapter,
  type BotScreenRuntimeOutcome,
} from "./botScreenManager.ts";
import {
  command,
  executable,
  ProcessLineReader,
  settleOwnedChild,
  spawnDetachedChild,
  terminateOwnedChild,
  waitForSocket,
  WaylandCaptureStream,
  WaylandVirtualInput,
  type DetachedProcess,
  type OwnedChild,
} from "./botScreenWaylandHelpers.ts";
import {
  ownedProcessIdentity,
  ownedProcessRunning,
  ownedSessionAt,
  readOwnedIdentity,
  terminateOwnedProcess,
  terminateOwnedSession,
  watchOwnedProcess,
  type OwnedProcessIdentity,
  type OwnedSession,
} from "../../supervision/ownedProcesses.ts";
import { BOT_DESKTOP_APP_ID, listApplicationToplevels, SwayIpcClient } from "./swayIpc.ts";
import { resolveSwayRuntimeBinaries } from "./swayRuntimeSupply.ts";

export interface SwayAdapterOptions extends BotComputerOptions {
  /** Test hook. The scripted fixture blocks here so an in-flight launch stays pending. */
  onLaunch?: () => Promise<void>;
  applicationCwd?: string;
}

type SwayProcess = DetachedProcess;

const SURFACE_STATE_FILE = "surface.json";
const BOT_DESKTOP_SWAY_CRITERIA = `[app_id="^${BOT_DESKTOP_APP_ID.replaceAll(".", "[.]")}$"]`;
const OUTPUT_SLOT_WIDTH = 8_192;

/** Listen and control sockets short enough for sockaddr_un, one pair per Screen. */
function wayvncSockets(runtimeRoot: string, surfaceId: string): { listen: string; control: string } {
  const stem = path.join(runtimeRoot, `wv-${surfaceId.slice("surf_".length)}`);
  return { listen: `${stem}.sock`, control: `${stem}.ctl` };
}

interface SwaySurfaceState {
  /** The Bot Computer generation this Screen attached under. */
  generation: number;
  outputName: string;
  workspaceName: string;
  desktopPid?: number;
  desktopIdentity?: OwnedProcessIdentity | undefined;
}

interface SwaySession {
  provision: BotScreenProvision;
  computer: BotComputer;
  runtimeSurfaceDir: string;
  runtimeDir: string;
  outputName: string;
  workspaceName: string;
  videoWidth: number;
  videoHeight: number;
  desktopProcess?: SwayProcess;
  desktopPid?: number;
  desktopSession?: OwnedSession;
  desktopIdentity?: OwnedProcessIdentity | undefined;
  virtualInput?: WaylandVirtualInput;
  cleanup?: (() => Promise<void>) | undefined;
}

function parseDesktopExec(value: string): string[] {
  const argv: string[] = [];
  let argument = "";
  let quoted = false;
  let escaped = false;
  const finishArgument = (): void => {
    if (argument !== "") argv.push(argument);
    argument = "";
  };
  for (const character of value.trim()) {
    if (escaped) {
      argument += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "\"") {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(character)) {
      finishArgument();
    } else {
      argument += character;
    }
  }
  if (escaped || quoted) throw new Error("application desktop entry has an invalid Exec command");
  finishArgument();
  return argv
    .filter((entry) => !/^%[fFuUick]$/.test(entry))
    .map((entry) => entry.replaceAll("%%", "%"));
}

function desktopApplicationCommand(
  application: string,
  environment: Record<string, string>,
): string[] {
  if (!application.endsWith(".desktop")) return [application];
  const dataHomes = [
    environment.XDG_DATA_HOME ?? path.join(environment.HOME ?? "", ".local", "share"),
    ...(environment.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
  ];
  const entryPath = dataHomes
    .map((directory) => path.join(directory, "applications", application))
    .find((candidate) => existsSync(candidate));
  if (entryPath === undefined) throw new Error(`application desktop entry not found: ${application}`);
  const lines = readFileSync(entryPath, "utf8").split(/\r?\n/);
  let inDesktopEntry = false;
  let type: string | undefined;
  let exec: string | undefined;
  for (const line of lines) {
    if (line.startsWith("[")) {
      inDesktopEntry = line === "[Desktop Entry]";
    } else if (inDesktopEntry && line.startsWith("Type=")) {
      type = line.slice("Type=".length);
    } else if (inDesktopEntry && line.startsWith("Exec=")) {
      exec = line.slice("Exec=".length);
    }
  }
  if (type !== "Application" || exec === undefined) {
    throw new Error(`invalid application desktop entry: ${application}`);
  }
  const argv = parseDesktopExec(exec);
  if (argv.length === 0) throw new Error(`application desktop entry has no executable: ${application}`);
  return argv;
}
function browserCommand(url: string, environment: Record<string, string>): string[] {
  for (const desktopEntry of [
    "brave-browser.desktop",
    "google-chrome.desktop",
    "chromium.desktop",
    "firefox.desktop",
  ]) {
    try {
      return [...desktopApplicationCommand(desktopEntry, environment), url];
    } catch {
      // Try the next installed browser.
    }
  }
  for (const binary of ["brave", "google-chrome", "chromium", "firefox"]) {
    const resolved = Bun.which(binary);
    if (resolved !== null) return [resolved, url];
  }
  return ["xdg-open", url];
}


function surfaceWorkspace(surfaceId: SurfaceId): string {
  return `bot-${surfaceId}`;
}

function workspaceCriteria(workspaceName: string): string {
  return `[workspace="^${workspaceName.replaceAll(".", "[.]")}$"]`;
}

function botDesktopWorkspaceCriteria(workspaceName: string): string {
  const appId = BOT_DESKTOP_APP_ID.replaceAll(".", "[.]");
  const workspace = workspaceName.replaceAll(".", "[.]");
  return `[app_id="^${appId}$" workspace="^${workspace}$"]`;
}
async function hideBotDesktop(
  swayIpc: SwayIpcClient,
  workspaceName: string,
): Promise<void> {
  try {
    await swayIpc.runCommand(`${botDesktopWorkspaceCriteria(workspaceName)} move scratchpad`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(No matching node.)")) return;
    throw error;
  }
}


/**
 * Bot Screens over one shared Bot Computer. Each Screen owns an
 * output/workspace view into that computer.
 */
export class SwayBotScreenRuntimeAdapter implements BotScreenRuntimeAdapter {
  #units: ApplicationUnits;
  #computer: BotComputerRuntime;
  #runtimes = new Map<SurfaceId, BotScreenRuntime>();
  #sessions = new Map<SurfaceId, SwaySession>();
  #lifecycleOperation: Promise<void> = Promise.resolve();
  #inputTail: Promise<void> = Promise.resolve();
  #inputLeaseOwner: SurfaceId | undefined;
  #inputLeaseRelease: (() => void) | undefined;
  #resolvedWayvnc: string | undefined;

  constructor(private readonly options: SwayAdapterOptions) {
    this.#units = new ApplicationUnits(options.hostRuntimeDir);
    this.#computer = new BotComputerRuntime(options);
  }

  async start(provision: BotScreenProvision): Promise<BotScreenRuntime> {
    return this.#serializeLifecycle(async () => {
      const current = this.#sessions.get(provision.surfaceId);
      const currentRuntime = this.#runtimes.get(provision.surfaceId);
      if (current !== undefined && currentRuntime !== undefined) {
        await this.#stopSession(current, currentRuntime);
      }
      await this.#units.stop(provision.surfaceId);
      this.#validateProvision(provision);
      const computer = await this.#computer.ensure();
      return this.#startSurface(computer, provision);
    });
  }

  async reconcile(provision: BotScreenProvision): Promise<BotScreenRuntime | undefined> {
    return this.#serializeLifecycle(async () => {
      const current = this.#sessions.get(provision.surfaceId);
      const currentRuntime = this.#runtimes.get(provision.surfaceId);
      if (
        current !== undefined
        && currentRuntime !== undefined
        && await this.#liveSurfaceValid(current)
      ) {
        await this.#ensureHelpers(current);
        return this.#runtimes.get(provision.surfaceId) ?? currentRuntime;
      }
      if (current !== undefined && currentRuntime !== undefined) {
        await this.#stopSession(current, currentRuntime);
      }
      this.#validateProvision(provision);
      const computer = await this.#computer.reattach();
      if (computer === undefined) {
        await this.#discardSurfaceFromDisk(provision.surfaceId);
        return undefined;
      }
      try {
        return await this.#reattachSurface(computer, provision);
      } catch {
        await this.#discardSurfaceFromDisk(provision.surfaceId);
        return undefined;
      }
    });
  }

  async destroy(surfaceId: SurfaceId): Promise<void> {
    await this.#serializeLifecycle(async () => {
      const session = this.#sessions.get(surfaceId);
      const runtime = this.#runtimes.get(surfaceId);
      const retained = this.#latestSurfaceState(surfaceId);
      const workspaceName = session?.workspaceName ?? retained?.state.workspaceName;
      const computerGeneration = session?.computer.generation ?? retained?.state.generation;
      if (session !== undefined && runtime !== undefined) {
        await this.#stopSession(session, runtime);
      }
      const computer = this.#computer.current();
      if (
        workspaceName !== undefined
        && computer !== undefined
        && computerGeneration === computer.generation
        && computer.running()
      ) {
        const swayIpc = new SwayIpcClient(computer.sockets.swaySock);
        await swayIpc.runCommand(`${workspaceCriteria(workspaceName)} kill`).catch(() => {});
      }
      await this.#units.stop(surfaceId);
      rmSync(path.join(this.options.runtimeRoot, surfaceId), { recursive: true, force: true });
    });
  }

  async #startSurface(
    computer: BotComputer,
    provision: BotScreenProvision,
  ): Promise<BotScreenRuntime> {
    const outputName = this.#allocateOutput();
    const outputIndex = Number(outputName.slice("HEADLESS-".length));
    const workspaceName = surfaceWorkspace(provision.surfaceId);
    const runtimeSurfaceDir = path.join(this.options.runtimeRoot, provision.surfaceId);
    const runtimeDir = path.join(runtimeSurfaceDir, String(computer.generation));
    rmSync(runtimeSurfaceDir, { recursive: true, force: true });
    for (const directory of [this.options.runtimeRoot, runtimeSurfaceDir, runtimeDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const videoWidth = Math.round(provision.logicalWidth * provision.scale);
    const videoHeight = Math.round(provision.logicalHeight * provision.scale);
    let desktopChild: OwnedChild | undefined;
    let session: SwaySession | undefined;
    try {
      await this.#configureOutput(
        computer.wlrRandr,
        computer.childEnv,
        outputName,
        videoWidth,
        videoHeight,
        provision.refreshRate,
        provision.scale,
        (outputIndex - 1) * OUTPUT_SLOT_WIDTH,
        computer,
      );
      const swayIpc = new SwayIpcClient(computer.sockets.swaySock);
      await swayIpc.runCommand(`workspace ${workspaceName}`);
      await swayIpc.runCommand(`move workspace to output ${outputName}`);
      desktopChild = spawnDetachedChild({
        argv: [
          ...this.#units.command(provision.surfaceId, computer.generation, "application", computer.childEnv),
          computer.botDesktop,
          String(provision.logicalWidth),
          String(provision.logicalHeight),
          String(provision.scale),
        ],
        env: this.#units.launcherEnvironment(computer.childEnv),
        output: "pipe",
        owned: !this.#units.enabled,
      });
      const desktopProcess = desktopChild.process;
      const desktopReadiness = new ProcessLineReader(desktopProcess.stdout);
      await this.#waitForDesktop(
        desktopReadiness,
        desktopProcess,
        provision.logicalWidth,
        provision.logicalHeight,
      );
      await this.#capture(computer.grim, computer.childEnv, outputName, videoWidth, videoHeight);
      session = {
        provision,
        computer,
        runtimeSurfaceDir,
        runtimeDir,
        outputName,
        workspaceName,
        videoWidth,
        videoHeight,
        desktopProcess,
        desktopPid: desktopProcess.pid,
        ...(desktopChild.session === undefined ? {} : { desktopSession: desktopChild.session }),
        desktopIdentity: ownedProcessIdentity(
          desktopProcess.pid,
          computer.runtimeDir,
          applicationUnitName(provision.surfaceId, computer.generation, "application"),
        ),
      };
      await this.#startHelpers(session);
      computer.surfaceIds.add(provision.surfaceId);
      const runtime = this.#bindRuntime(session);
      this.#sessions.set(provision.surfaceId, session);
      this.#runtimes.set(provision.surfaceId, runtime);
      this.#writeSurfaceState(session);
      return runtime;
    } catch (error) {
      await session?.virtualInput?.stop().catch(() => {});
      await terminateOwnedChild(desktopChild).catch(() => {});
      await this.#units.stop(provision.surfaceId, computer.generation).catch(() => {});
      rmSync(runtimeSurfaceDir, { recursive: true, force: true });
      if (computer.surfaceIds.size === 0) await computer.stop().catch(() => {});
      throw error;
    }
  }

  async #reattachSurface(
    computer: BotComputer,
    provision: BotScreenProvision,
  ): Promise<BotScreenRuntime | undefined> {
    const runtimeSurfaceDir = path.join(this.options.runtimeRoot, provision.surfaceId);
    const runtimeDir = path.join(runtimeSurfaceDir, String(computer.generation));
    const state = this.#readSurfaceState(runtimeDir);
    if (
      state === undefined
      || state.generation !== computer.generation
      || !/^HEADLESS-[1-9]\d*$/.test(state.outputName)
      || this.#outputClaimed(state.outputName, provision.surfaceId)
      || !ownedProcessRunning(state.desktopIdentity)
    ) {
      return undefined;
    }
    const outputIndex = Number(state.outputName.slice("HEADLESS-".length));
    if (outputIndex > this.#computer.capacity) return undefined;
    const videoWidth = Math.round(provision.logicalWidth * provision.scale);
    const videoHeight = Math.round(provision.logicalHeight * provision.scale);
    await this.#capture(computer.grim, computer.childEnv, state.outputName, videoWidth, videoHeight);
    await Promise.all([
      this.#units.stopRole(provision.surfaceId, computer.generation, "input").catch(() => {}),
      this.#units.stopRole(provision.surfaceId, computer.generation, "wayvnc").catch(() => {}),
    ]);
    const sockets = wayvncSockets(this.options.runtimeRoot, provision.surfaceId);
    rmSync(sockets.listen, { force: true });
    rmSync(sockets.control, { force: true });
    // The desktop outlived a daemon restart: re-adopt its anchored session so
    // teardown can still find descendants that scrubbed their environment.
    const desktopSession = ownedSessionAt(state.desktopPid, state.desktopIdentity);
    const session: SwaySession = {
      provision,
      computer,
      runtimeSurfaceDir,
      runtimeDir,
      outputName: state.outputName,
      workspaceName: state.workspaceName,
      videoWidth,
      videoHeight,
      ...(state.desktopPid === undefined ? {} : { desktopPid: state.desktopPid }),
      desktopIdentity: state.desktopIdentity,
      ...(desktopSession === undefined ? {} : { desktopSession }),
    };
    try {
      await this.#startHelpers(session);
    } catch (error) {
      await session.virtualInput?.stop().catch(() => {});
      throw error;
    }
    computer.surfaceIds.add(provision.surfaceId);
    const runtime = this.#bindRuntime(session);
    this.#sessions.set(provision.surfaceId, session);
    this.#runtimes.set(provision.surfaceId, runtime);
    return runtime;
  }

  /** Starts whichever Screen helpers are missing; true when any restarted. */
  async #startHelpers(session: SwaySession): Promise<boolean> {
    const { provision, computer } = session;
    let started = false;
    if (session.virtualInput === undefined || !session.virtualInput.running) {
      session.virtualInput = await WaylandVirtualInput.start(
        computer.inputHelper,
        session.outputName,
        this.#units.launcherEnvironment(computer.childEnv),
        computer.generation,
        provision,
        this.#units.command(provision.surfaceId, computer.generation, "input", computer.childEnv),
      );
      started = true;
    }
    return started;
  }

  async #ensureHelpers(session: SwaySession): Promise<void> {
    if (!await this.#startHelpers(session)) return;
    const runtime = this.#bindRuntime(session);
    this.#runtimes.set(session.provision.surfaceId, runtime);
  }


  #bindRuntime(session: SwaySession): BotScreenRuntime {
    const { provision, computer } = session;
    const virtualInput = session.virtualInput;
    if (virtualInput === undefined) {
      throw new Error("Sway Bot Screen input helper is required before binding a runtime");
    }
    const swayIpc = new SwayIpcClient(computer.sockets.swaySock);
    const outputX = (Number(session.outputName.slice("HEADLESS-".length)) - 1) * OUTPUT_SLOT_WIDTH;
    const listWindows = async (): Promise<ComputerWindowListItem[]> =>
      listApplicationToplevels(await swayIpc.getTree())
        .filter((window) => window.workspace === session.workspaceName)
        .map((window) => window.bounds === undefined ? window : {
          ...window,
          bounds: {
            ...window.bounds,
            x: window.bounds.x - outputX,
          },
        });
    let lastInputEpoch = 0;
    const outcome = Promise.race<BotScreenRuntimeOutcome>([
      computer.exited().then((status) => ({
        type: "compositor-exited",
        error: new Error(`shared Sway compositor exited with status ${status}`),
      })),
      computer.busExited().then((status) => ({
        type: "session-bus-exited",
        error: new Error(`shared D-Bus session exited with status ${status}`),
      })),
      this.#desktopExited(session).then((status) => ({
        type: "desktop-exited",
        error: new Error(`Bot Desktop exited with status ${status}`),
      })),
      virtualInput.exited.then((error) => ({ type: "input-helper-exited", error })),
    ]);
    let stopped = false;
    let cleanupComplete = false;
    let cleanupInFlight: Promise<void> | undefined;
    const captureStreams = new Set<BotScreenCaptureStream>();
    const captureStreamStarts = new Set<Promise<void>>();
    let captureStreamSequence = 0;
    const expandedViews = new Set<BotScreenExpandedView>();
    const expandedViewStarts = new Set<Promise<void>>();
    type SharedWayvnc = {
      child: OwnedChild;
      socketPath: string;
      controlSocketPath: string;
      leaseCount: number;
      stopping?: Promise<void>;
      listeners: Set<(error: Error) => void>;
    };
    let sharedWayvnc: SharedWayvnc | undefined;
    let sharedWayvncStart: Promise<SharedWayvnc> | undefined;
    let sharedWayvncStop: Promise<void> | undefined;
    let pendingExpandedAcquires = 0;
    const failSharedWayvnc = (shared: SharedWayvnc, error: Error): void => {
      for (const listener of [...shared.listeners]) listener(error);
    };
    const stopSharedWayvnc = (shared: SharedWayvnc): Promise<void> => {
      if (shared.stopping !== undefined) return shared.stopping;
      const stopping = (async (): Promise<void> => {
        if (sharedWayvnc === shared) sharedWayvnc = undefined;
        await this.#units.stopRole(
          provision.surfaceId,
          computer.generation,
          "wayvnc",
        ).catch(() => {});
        await terminateOwnedChild(shared.child);
        try { unlinkSync(shared.socketPath); } catch { /* already gone */ }
        try { unlinkSync(shared.controlSocketPath); } catch { /* already gone */ }
      })();
      shared.stopping = stopping;
      sharedWayvncStop = stopping;
      void stopping.then(() => {
        if (sharedWayvncStop === stopping) sharedWayvncStop = undefined;
      }, () => {});
      return stopping;
    };
    const ensureSharedWayvnc = async (wayvnc: string): Promise<SharedWayvnc> => {
      await sharedWayvncStop;
      if (stopped) throw new Error("Bot Screen is not running");
      if (sharedWayvnc !== undefined) return sharedWayvnc;
      if (sharedWayvncStart !== undefined) return sharedWayvncStart;
      const starting = (async (): Promise<SharedWayvnc> => {
        // sun_path holds 107 bytes. The generation directory already holds a
        // near-limit Wayland socket, and wayvnc's default control socket
        // ($XDG_RUNTIME_DIR/wayvncctl) does not fit beside it.
        const sockets = wayvncSockets(this.options.runtimeRoot, provision.surfaceId);
        const socketPath = sockets.listen;
        const controlSocketPath = sockets.control;
        const wayvncChild = spawnDetachedChild({
          argv: [
            ...this.#units.command(provision.surfaceId, computer.generation, "wayvnc", computer.childEnv),
            wayvnc,
            "--unix-socket",
            "--socket",
            controlSocketPath,
            "--output",
            session.outputName,
            "--disable-input",
            socketPath,
          ],
          env: this.#units.launcherEnvironment(computer.childEnv),
          output: "pipe",
          owned: !this.#units.enabled,
        });
        const wayvncProcess = wayvncChild.process;
        const wayvncStderr = new Response(wayvncProcess.stderr).text();
        try {
          await waitForSocket(socketPath, wayvncProcess, "WayVNC");
          chmodSync(socketPath, 0o600);
          const shared: SharedWayvnc = {
            child: wayvncChild,
            socketPath,
            controlSocketPath,
            leaseCount: 0,
            listeners: new Set(),
          };
          void wayvncProcess.exited.then(async (status) => {
            const detail = (await wayvncStderr).trim().split("\n").slice(-8).join(" ");
            await stopSharedWayvnc(shared).catch(() => {});
            failSharedWayvnc(
              shared,
              new Error(`WayVNC exited with status ${status}${detail === "" ? "" : `: ${detail}`}`),
            );
          });
          sharedWayvnc = shared;
          return shared;
        } catch (error) {
          await terminateOwnedChild(wayvncChild).catch(() => {});
          try { unlinkSync(socketPath); } catch { /* already gone */ }
          throw error;
        }
      })();
      sharedWayvncStart = starting;
      try {
        return await starting;
      } finally {
        if (sharedWayvncStart === starting) sharedWayvncStart = undefined;
      }
    };
    const capture = async (): Promise<BotScreenCapture> => {
      if (stopped || !computer.running()) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      return this.#capture(
        computer.grim,
        computer.childEnv,
        session.outputName,
        session.videoWidth,
        session.videoHeight,
      );
    };
    const openCaptureStream = async (): Promise<BotScreenCaptureStream> => {
      if (stopped || !computer.running()) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      const opening = Promise.withResolvers<void>();
      captureStreamStarts.add(opening.promise);
      try {
        const stream = await WaylandCaptureStream.start(
          computer.captureHelper,
          session.outputName,
          this.#units.launcherEnvironment(computer.childEnv),
          session.videoWidth,
          session.videoHeight,
          this.#units.command(
            provision.surfaceId,
            computer.generation,
            `capture-${++captureStreamSequence}`,
            computer.childEnv,
          ),
        );
        if (stopped || !computer.running()) {
          await stream.close();
          throw new Error("Bot Computer compositor is not running");
        }
        let closed = false;
        let lease!: BotScreenCaptureStream;
        const close = async (): Promise<void> => {
          if (closed) return;
          closed = true;
          captureStreams.delete(lease);
          await stream.close();
        };
        lease = {
          next: async () => {
            try {
              return await stream.next();
            } catch (error) {
              await close().catch(() => {});
              throw error;
            }
          },
          close,
        };
        captureStreams.add(lease);
        return lease;
      } finally {
        opening.resolve();
        captureStreamStarts.delete(opening.promise);
      }
    };
    const focusWindow = async (window: ComputerWindowListItem): Promise<void> => {
      if (stopped || !computer.running()) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      await this.#withInputLease(session, async () => {
        await swayIpc.runCommand(`[con_id=${window.id}] focus`);
        const confirmed = (await listWindows()).find((candidate) => candidate.id === window.id);
        if (confirmed?.focused !== true) throw new Error("Sway window focus was not confirmed");
      });
    };
    const launch = async (request: BotScreenLaunchRequest): Promise<{ text?: string }> => {
      if (stopped || !computer.running()) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      return this.#withInputLease(session, async () => {
        const result = await this.#launchApplication(session, request);
        await hideBotDesktop(swayIpc, session.workspaceName);
        return result;
      });
    };
    const cleanupSurface = async (): Promise<void> => {
      stopped = true;
      if (cleanupComplete) return;
      if (cleanupInFlight !== undefined) return cleanupInFlight;
      const cleanup = (async (): Promise<void> => {
        await virtualInput.release().catch(() => {});
        this.#releaseInputLease(provision.surfaceId);
        await virtualInput.stop().catch(() => {});
        await Promise.allSettled(captureStreamStarts);
        await Promise.allSettled(expandedViewStarts);
        await Promise.allSettled([...captureStreams].map((stream) => stream.close()));
        await Promise.allSettled([...expandedViews].map((view) => view.close()));
        await Promise.allSettled([
          this.#stopDesktop(session),
          this.#units.stop(provision.surfaceId, computer.generation),
        ]);
      })();
      cleanupInFlight = cleanup;
      try {
        await cleanup;
        cleanupComplete = true;
      } finally {
        cleanupInFlight = undefined;
      }
    };
    session.cleanup = cleanupSurface;
    const runtime: BotScreenRuntime = {
      generation: computer.generation,
      sessionEnv: computer.childEnv,
      readiness: {
        compositor: "ready",
        waylandSocket: "private",
        output: {
          geometryGeneration: provision.geometryGeneration,
          logicalWidth: provision.logicalWidth,
          logicalHeight: provision.logicalHeight,
          scale: provision.scale,
          refreshRate: provision.refreshRate,
        },
        desktopSurface: "ready",
        capture: "ready",
        input: "ready",
      },
      expandedProjection: "rfb",
      capture,
      openCaptureStream,
      acquireExpandedView: async () => {
        if (stopped || !computer.running()) throw new Error("Bot Computer compositor is not running");
        if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
        const wayvnc = await this.#resolveWayvnc();
        const opening = Promise.withResolvers<void>();
        expandedViewStarts.add(opening.promise);
        pendingExpandedAcquires += 1;
        try {
          const shared = await ensureSharedWayvnc(wayvnc);
          if (stopped || !computer.running()) {
            throw new Error("Bot Computer compositor is not running");
          }
          const inbound: Uint8Array[] = [];
          const waiters: Array<{ resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }> = [];
          let closed = false;
          let leaseFailed: Error | undefined;
          const outbound: Array<{
            bytes: Uint8Array;
            offset: number;
            resolve: () => void;
            reject: (error: Error) => void;
          }> = [];
          let outboundBytes = 0;
          let writeTimeout: Timer | undefined;
          const failLease = (error: Error): void => {
            if (leaseFailed !== undefined) return;
            leaseFailed = error;
            clearTimeout(writeTimeout);
            for (const pending of outbound.splice(0)) pending.reject(error);
            outboundBytes = 0;
            for (const waiter of waiters.splice(0)) waiter.reject(error);
          };
          const socket = await Bun.connect({
            unix: shared.socketPath,
            socket: {
              data(_socket, data) {
                const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
                const waiter = waiters.shift();
                if (waiter !== undefined) waiter.resolve(copy);
                else inbound.push(copy);
              },
              error(_socket, error) {
                failLease(error instanceof Error ? error : new Error(String(error)));
              },
              close() {
                failLease(new Error("WayVNC RFB connection closed"));
              },
              drain() {
                flushWrites();
              },
            },
          });
          const flushWrites = (): void => {
            if (leaseFailed !== undefined) return;
            clearTimeout(writeTimeout);
            try {
              while (outbound.length > 0) {
                const pending = outbound[0]!;
                const remaining = pending.bytes.subarray(pending.offset);
                const written = socket.write(remaining);
                if (written < 0 || written > remaining.byteLength) throw new Error("WayVNC RFB write failed");
                pending.offset += written;
                if (pending.offset !== pending.bytes.byteLength) break;
                outbound.shift();
                outboundBytes -= pending.bytes.byteLength;
                pending.resolve();
              }
              if (outbound.length > 0) {
                writeTimeout = setTimeout(
                  () => failLease(new Error("WayVNC RFB write drain timed out")),
                  5_000,
                );
              }
            } catch (cause) {
              failLease(cause instanceof Error ? cause : new Error(String(cause)));
            }
          };
          if (stopped || !computer.running()) {
            try { socket.end(); } catch { /* already closed */ }
            throw new Error("Bot Computer compositor is not running");
          }
          shared.listeners.add(failLease);
          shared.leaseCount += 1;
          let lease!: BotScreenExpandedView;
          const close = async (): Promise<void> => {
            if (closed) return;
            closed = true;
            expandedViews.delete(lease);
            shared.listeners.delete(failLease);
            failLease(new Error("Sway Bot Screen expanded view is closed"));
            try { socket.end(); } catch { /* already closed */ }
            shared.leaseCount -= 1;
            if (shared.leaseCount === 0 && pendingExpandedAcquires === 0) {
              await stopSharedWayvnc(shared);
            }
          };
          lease = {
            send: async (bytes) => {
              if (closed) throw new Error("Sway Bot Screen expanded view is closed");
              if (leaseFailed !== undefined) throw leaseFailed;
              if (bytes.byteLength === 0) return;
              if (outboundBytes + bytes.byteLength > 4 * 1024 * 1024) {
                const error = new Error("WayVNC RFB pending write limit exceeded");
                failLease(error);
                throw error;
              }
              const pending = Promise.withResolvers<void>();
              const idle = outbound.length === 0;
              outbound.push({
                bytes: bytes.slice(),
                offset: 0,
                resolve: pending.resolve,
                reject: pending.reject,
              });
              outboundBytes += bytes.byteLength;
              if (idle) flushWrites();
              return pending.promise;
            },
            receive: async () => {
              if (closed) throw new Error("Sway Bot Screen expanded view is closed");
              if (leaseFailed !== undefined) throw leaseFailed;
              const queued = inbound.shift();
              if (queued !== undefined) return queued;
              const waiter = Promise.withResolvers<Uint8Array>();
              waiters.push(waiter);
              return waiter.promise;
            },
            close,
          };
          expandedViews.add(lease);
          return lease;
        } catch (error) {
          if (
            sharedWayvnc !== undefined
            && sharedWayvnc.leaseCount === 0
            && pendingExpandedAcquires === 1
          ) {
            await stopSharedWayvnc(sharedWayvnc);
          }
          throw error;
        } finally {
          pendingExpandedAcquires -= 1;
          opening.resolve();
          expandedViewStarts.delete(opening.promise);
        }
      },
      listWindows,
      focusWindow,
      launch,
      setInputAuthority: async (controllerEpoch) => {
        if (!Number.isSafeInteger(controllerEpoch) || controllerEpoch <= lastInputEpoch) {
          throw new BotScreenInputRejectedError("stale controller epoch");
        }
        const acquired = await this.#acquireInputLease(provision.surfaceId);
        try {
          await this.#focusWorkspace(session);
          lastInputEpoch = controllerEpoch;
          await virtualInput.setInputAuthority(controllerEpoch);
          return controllerEpoch;
        } catch (error) {
          if (acquired) this.#releaseInputLease(provision.surfaceId);
          throw error;
        }
      },
      input: async (event) => {
        if (event.controllerEpoch !== lastInputEpoch || this.#inputLeaseOwner !== provision.surfaceId) {
          throw new BotScreenInputRejectedError("stale controller epoch");
        }
        await virtualInput.input(event);
      },
      releaseInput: async (controllerEpoch) => {
        if (controllerEpoch !== undefined && controllerEpoch !== lastInputEpoch) {
          throw new BotScreenInputRejectedError("stale controller epoch");
        }
        try {
          await virtualInput.release(controllerEpoch);
        } finally {
          this.#releaseInputLease(provision.surfaceId);
        }
      },
      outcome,
      stop: () => this.#serializeLifecycle(() => this.#stopSession(session, runtime, cleanupSurface)),
    };
    return runtime;
  }

  async #launchApplication(
    session: SwaySession,
    request: BotScreenLaunchRequest,
  ): Promise<{ text?: string }> {
    await this.options.onLaunch?.();
    const cwd = this.options.applicationCwd;
    if (cwd === undefined || cwd === "" || !existsSync(cwd)) {
      throw new Error("Shared Workspace is unavailable for application launch");
    }
    const swayIpc = new SwayIpcClient(session.computer.sockets.swaySock);
    const before = new Set(
      listApplicationToplevels(await swayIpc.getTree()).map((window) => window.id),
    );
    const argv = request.app !== undefined
      ? desktopApplicationCommand(request.app, session.computer.childEnv)
      : browserCommand(request.url!, session.computer.childEnv);
    const text = request.app !== undefined ? `launched ${request.app}` : `opened ${request.url}`;
    const role = `application-${++session.computer.applicationSequence}` as const;
    const application = spawnDetachedChild({
      argv: [
        ...this.#units.computerCommand(
          session.computer.generation,
          role,
          session.computer.childEnv,
          cwd,
        ),
        ...argv,
      ],
      env: this.#units.launcherEnvironment(session.computer.childEnv),
      cwd,
      output: "ignore",
      owned: !this.#units.enabled,
    });
    // An application is shared by every Screen, so it is stopped with the Bot
    // Computer. Its entry survives its leader while descendants still live in the
    // owned session; that is what makes the teardown find them.
    // shortcut: such an entry and its idle anchor live until the Computer stops,
    // upgrade to a session watcher if orphaned applications become common.
    session.computer.applicationProcesses.add(application);
    void application.process.exited.then(() => {
      if (settleOwnedChild(application)) session.computer.applicationProcesses.delete(application);
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && session.computer.running()) {
      const windows = listApplicationToplevels(await swayIpc.getTree());
      const created = windows.filter((window) => !before.has(window.id));
      if (created.length > 0) {
        for (const window of created) {
          await swayIpc.runCommand(
            `[con_id=${window.id}] move container to workspace ${session.workspaceName}`,
          );
        }
        await this.#focusWorkspace(session);
        return { text };
      }
      await Bun.sleep(20);
    }
    return { text };
  }

  async #withInputLease<T>(
    session: SwaySession,
    operation: () => Promise<T>,
  ): Promise<T> {
    const acquired = await this.#acquireInputLease(session.provision.surfaceId);
    try {
      await this.#focusWorkspace(session);
      return await operation();
    } finally {
      if (acquired) this.#releaseInputLease(session.provision.surfaceId);
    }
  }

  async #acquireInputLease(surfaceId: SurfaceId): Promise<boolean> {
    if (this.#inputLeaseOwner === surfaceId) return false;
    const previous = this.#inputTail;
    const gate = Promise.withResolvers<void>();
    this.#inputTail = previous.catch(() => {}).then(() => gate.promise);
    await previous.catch(() => {});
    this.#inputLeaseOwner = surfaceId;
    this.#inputLeaseRelease = () => {
      if (this.#inputLeaseOwner !== surfaceId) return;
      this.#inputLeaseOwner = undefined;
      this.#inputLeaseRelease = undefined;
      gate.resolve();
    };
    return true;
  }

  #releaseInputLease(surfaceId: SurfaceId): void {
    if (this.#inputLeaseOwner === surfaceId) this.#inputLeaseRelease?.();
  }

  async #focusWorkspace(session: SwaySession): Promise<void> {
    if (!session.computer.running()) {
      throw new Error("Bot Computer compositor is not running");
    }
    await new SwayIpcClient(session.computer.sockets.swaySock)
      .runCommand(`workspace ${session.workspaceName}`);
  }

  async #stopSession(
    session: SwaySession,
    runtime: BotScreenRuntime,
    cleanup?: () => Promise<void>,
  ): Promise<void> {
    if (this.#runtimes.get(session.provision.surfaceId) !== runtime) return;
    this.#runtimes.delete(session.provision.surfaceId);
    this.#sessions.delete(session.provision.surfaceId);
    this.#releaseInputLease(session.provision.surfaceId);
    const cleanupSurface = cleanup ?? session.cleanup;
    if (cleanupSurface !== undefined) {
      await cleanupSurface();
    } else {
      await session.virtualInput?.release().catch(() => {});
      await Promise.allSettled([
        session.virtualInput?.stop(),
        this.#stopDesktop(session),
        this.#units.stop(session.provision.surfaceId, session.computer.generation),
      ]);
    }
    rmSync(session.runtimeSurfaceDir, { recursive: true, force: true });
    session.computer.surfaceIds.delete(session.provision.surfaceId);
    if (session.computer.surfaceIds.size === 0) await session.computer.stop();
  }

  async #discardSurfaceFromDisk(surfaceId: SurfaceId): Promise<void> {
    const retained = this.#latestSurfaceState(surfaceId);
    await this.#units.stop(surfaceId).catch(() => {});
    if (retained !== undefined) {
      if (retained.state.desktopIdentity !== undefined) {
        await terminateOwnedProcess(retained.state.desktopIdentity);
      }
      // Only this Screen's recorded session: its children share the Computer's
      // private runtime directory, so a runtime sweep would reach other Screens.
      await terminateOwnedSession(ownedSessionAt(retained.state.desktopPid, retained.state.desktopIdentity));
    }
    rmSync(path.join(this.options.runtimeRoot, surfaceId), { recursive: true, force: true });
  }

  async #liveSurfaceValid(session: SwaySession): Promise<boolean> {
    if (!session.computer.running() || !this.#desktopRunning(session)) return false;
    try {
      await this.#capture(
        session.computer.grim,
        session.computer.childEnv,
        session.outputName,
        session.videoWidth,
        session.videoHeight,
      );
      return true;
    } catch {
      return false;
    }
  }

  #desktopRunning(session: SwaySession): boolean {
    if (session.desktopProcess !== undefined) {
      return session.desktopProcess.exitCode === null && session.desktopProcess.signalCode === null;
    }
    return ownedProcessRunning(session.desktopIdentity);
  }

  #desktopExited(session: SwaySession): Promise<number> {
    if (session.desktopProcess !== undefined) return session.desktopProcess.exited;
    return watchOwnedProcess(session.desktopIdentity);
  }

  async #stopDesktop(session: SwaySession): Promise<void> {
    if (session.desktopProcess !== undefined) {
      await terminateOwnedChild({
        process: session.desktopProcess,
        ...(session.desktopSession === undefined ? {} : { session: session.desktopSession }),
      });
      return;
    }
    // A reattached desktop has no handle; identity covers the leader, the
    // recorded session covers descendants that outlived it.
    await terminateOwnedProcess(session.desktopIdentity);
    await terminateOwnedSession(session.desktopSession);
  }

  #allocateOutput(): string {
    for (let index = 1; index <= this.#computer.capacity; index += 1) {
      const outputName = `HEADLESS-${index}`;
      if (!this.#outputClaimed(outputName)) return outputName;
    }
    throw new Error("Bot Computer has no unassigned output");
  }

  /**
   * An output is claimed by a live session or by a retained Screen whose desktop is
   * still running and has not been reattached yet; starting over it would strand that Screen.
   */
  #outputClaimed(outputName: string, exceptSurfaceId?: SurfaceId): boolean {
    if ([...this.#sessions.values()].some((session) =>
      session.outputName === outputName && session.provision.surfaceId !== exceptSurfaceId
    )) return true;
    return this.#retainedOutputs(exceptSurfaceId).has(outputName);
  }

  /** Outputs a not-yet-reattached Screen still owns through a live desktop. */
  #retainedOutputs(exceptSurfaceId?: SurfaceId): Set<string> {
    const claimed = new Set<string>();
    const runtimeRoot = this.options.runtimeRoot;
    if (!existsSync(runtimeRoot)) return claimed;
    for (const entry of readdirSync(runtimeRoot)) {
      if (entry === "computer" || entry === exceptSurfaceId) continue;
      try {
        if (!lstatSync(path.join(runtimeRoot, entry)).isDirectory()) continue;
      } catch {
        continue;
      }
      const surfaceId = entry as SurfaceId;
      if (this.#sessions.has(surfaceId)) continue;
      const retained = this.#latestSurfaceState(surfaceId);
      if (retained !== undefined && ownedProcessRunning(retained.state.desktopIdentity)) {
        claimed.add(retained.state.outputName);
      }
    }
    return claimed;
  }

  #validateProvision(provision: BotScreenProvision): void {
    if (!Number.isSafeInteger(provision.scale) || provision.scale < 1) {
      throw new Error("Sway Bot Screen scale must be a positive integer");
    }
  }

  async #resolveWayvnc(): Promise<string> {
    if (this.#resolvedWayvnc === undefined && this.options.runtimeSupply !== undefined) {
      this.#resolvedWayvnc = (await resolveSwayRuntimeBinaries({
        ...swayRuntimeOverrides(this.options),
        supply: this.options.runtimeSupply,
      })).wayvncBin;
    }
    const wayvnc = this.#resolvedWayvnc
      ?? (this.options.wayvncBin === undefined
        ? undefined
        : executable(this.options.wayvncBin, this.options.wayvncBin));
    if (wayvnc === undefined) throw new Error("WayVNC executable is unavailable");
    return wayvnc;
  }

  #writeSurfaceState(session: SwaySession): void {
    writeFileSync(
      path.join(session.runtimeDir, SURFACE_STATE_FILE),
      JSON.stringify({
        generation: session.computer.generation,
        outputName: session.outputName,
        workspaceName: session.workspaceName,
        ...(session.desktopPid === undefined ? {} : { desktopPid: session.desktopPid }),
        desktopIdentity: session.desktopIdentity,
      } satisfies SwaySurfaceState),
      { mode: 0o600 },
    );
  }

  #readSurfaceState(runtimeDir: string): SwaySurfaceState | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(runtimeDir, SURFACE_STATE_FILE), "utf8"),
      ) as Partial<SwaySurfaceState>;
      if (
        typeof parsed.generation !== "number"
        || !Number.isSafeInteger(parsed.generation)
        || typeof parsed.outputName !== "string"
        || typeof parsed.workspaceName !== "string"
      ) {
        return undefined;
      }
      const computerRuntimeDir = path.join(
        this.options.runtimeRoot,
        "computer",
        String(parsed.generation),
      );
      const desktopIdentity = readOwnedIdentity(
        parsed.desktopIdentity,
        parsed.desktopPid,
        computerRuntimeDir,
      );
      if (desktopIdentity === undefined) return undefined;
      return {
        generation: parsed.generation,
        outputName: parsed.outputName,
        workspaceName: parsed.workspaceName,
        ...(typeof parsed.desktopPid === "number" ? { desktopPid: parsed.desktopPid } : {}),
        desktopIdentity,
      };
    } catch {
      return undefined;
    }
  }

  #latestSurfaceState(
    surfaceId: SurfaceId,
  ): { runtimeDir: string; state: SwaySurfaceState } | undefined {
    const runtimeSurfaceDir = path.join(this.options.runtimeRoot, surfaceId);
    if (!existsSync(runtimeSurfaceDir)) return undefined;
    const generations = readdirSync(runtimeSurfaceDir)
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .sort((left, right) => right - left);
    for (const generation of generations) {
      const runtimeDir = path.join(runtimeSurfaceDir, String(generation));
      const state = this.#readSurfaceState(runtimeDir);
      if (state !== undefined) return { runtimeDir, state };
    }
    return undefined;
  }

  async #configureOutput(
    wlrRandr: string,
    environment: Record<string, string>,
    outputName: string,
    videoWidth: number,
    videoHeight: number,
    refreshRate: number,
    scale: number,
    positionX: number,
    computer: BotComputer,
  ): Promise<void> {
    const argv = [
      wlrRandr,
      "--output",
      outputName,
      "--on",
      "--custom-mode",
      `${videoWidth}x${videoHeight}@${refreshRate}Hz`,
      "--pos",
      `${positionX},0`,
      "--transform",
      "normal",
      "--scale",
      String(scale),
    ];
    const deadline = Date.now() + 5_000;
    let lastError = "Sway output configuration failed";
    while (Date.now() < deadline) {
      if (!computer.running()) {
        throw new Error("Bot Computer exited before output configuration");
      }
      const configured = await command(argv, environment);
      if (configured.status === 0) return;
      lastError = `Sway output configuration failed${
        configured.stderr.trim() === "" ? "" : `: ${configured.stderr.trim()}`
      }`;
      await Bun.sleep(20);
    }
    throw new Error(lastError);
  }

  async #waitForDesktop(
    readiness: ProcessLineReader,
    desktopProcess: SwayProcess,
    width: number,
    height: number,
  ): Promise<void> {
    const expected = `READY ${width} ${height}`;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const line = await Promise.race([
        readiness.next(),
        desktopProcess.exited.then(() => {
          throw new Error("Bot Desktop exited during startup");
        }),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => {
          throw new Error("Bot Desktop did not commit the configured output surface");
        }),
      ]);
      if (line === expected) return;
    }
    throw new Error("Bot Desktop did not commit the configured output surface");
  }

  async #capture(
    grim: string,
    environment: Record<string, string>,
    outputName: string,
    expectedWidth: number,
    expectedHeight: number,
  ): Promise<BotScreenCapture> {
    const shot = Bun.spawn([grim, "-o", outputName, "-"], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, bytes, stderr] = await Promise.all([
      shot.exited,
      new Response(shot.stdout).arrayBuffer(),
      new Response(shot.stderr).text(),
    ]);
    const image = new Uint8Array(bytes);
    if (status !== 0 || image.length < 8 || image[0] !== 0x89 || image[1] !== 0x50) {
      throw new Error(
        `Sway Bot Screen capture failed${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
      );
    }
    const metadata = await sharp(image).metadata();
    if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
      throw new Error("Sway Bot Screen capture geometry does not match its configured output");
    }
    return { mediaType: "image/png", bytes: image };
  }

  async #serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleOperation;
    const result = previous.catch(() => {}).then(operation);
    this.#lifecycleOperation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
