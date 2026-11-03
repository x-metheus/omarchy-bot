import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createConnection } from "node:net";
import { CdpPipe } from "./cdpPipe.ts";
import { BrowserRuntime, BrowserWindowAttributionError } from "./browserRuntime.ts";
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
  BotScreenUnavailableError,
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
  spawnCaptureChild,
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
  processDescendsFrom,
  processIdentity,
  readOwnedIdentity,
  terminateOwnedProcess,
  terminateOwnedSession,
  watchOwnedProcess,
  type OwnedProcessIdentity,
  type OwnedSession,
  type ProcessIdentity,
} from "../../supervision/ownedProcesses.ts";
import { BOT_DESKTOP_APP_ID, listApplicationToplevels, SwayIpcClient, SwayWindowSubscription, type SwayWindowEvent } from "./swayIpc.ts";
import { resolveSwayRuntimeBinaries } from "./swayRuntimeSupply.ts";
import {
  PortableBotComputerAssets,
  type BotComputerAssetSupply,
} from "./botComputerAssets.ts";
import { desktopApplicationCommand } from "./desktopEntry.ts";
import { BrowserSupply } from "./browserSupply.ts";
import { WindowOwnership, type PendingWindowTarget } from "./windowOwnership.ts";
import { openBrowserHandler } from "./browserHandler.ts";
import { matchesBrowserWindowTitleStamp } from "./browserWindowAttribution.ts";

export interface SwayAdapterOptions extends BotComputerOptions {
  /** Test hook. The scripted fixture blocks here so an in-flight launch stays pending. */
  onLaunch?: () => Promise<void>;
  applicationCwd?: string;
  /** Portable browser and font supply; fontDir supplies installed runtime fonts. */
  assetSupply?: BotComputerAssetSupply;
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
  /** The last launch's window binding; a Browser Tool call on this Screen waits for it. */
  pendingBinding?: Promise<void> | undefined;
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

/** How a process ended, or `undefined` while it still runs. */
function exitDescription(process: DetachedProcess): string | undefined {
  if (process.exitCode !== null) return `code ${process.exitCode}`;
  if (process.signalCode !== null) return `signal ${process.signalCode}`;
  return undefined;
}

/** The end of a child's stderr; a failure that printed nothing still says so. */
function stderrTailText(child: OwnedChild): string {
  const tail = child.stderrTail?.text().trim() ?? "";
  return tail === "" ? "no stderr output" : tail;
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
  #assets: BotComputerAssetSupply;
  /** The only browser source: launch argv, profile, Screen plumbing, and pack identity. */
  #browser: BrowserSupply;
  /**
   * The Computer's one window record: Sway routing here and the Browser Tool's
   * target binding both go through it, so a window has one owning Screen.
   */
  #ownership = new WindowOwnership();
  /** The open `window::new` subscription for the current Bot Computer. */
  #windowEvents: { computer: BotComputer; subscription: SwayWindowSubscription } | undefined;
  #parkingJobs = new Map<string, Promise<void>>();
  #attributionJobs = new Map<PendingWindowTarget, Promise<void>>();
  #attributionErrors = new Map<string, unknown>();
  #parkingFailures = new Map<string, Error>();
  #launchClaim: { session: SwaySession; result: ReturnType<typeof Promise.withResolvers<void>>; targets: Set<string>; signal: AbortSignal; active: boolean } | undefined;
  #humanLease: { session: SwaySession; epoch: number } | undefined;

  constructor(private readonly options: SwayAdapterOptions) {
    this.#units = new ApplicationUnits(options.hostRuntimeDir);
    this.#assets = options.assetSupply
      ?? new PortableBotComputerAssets({
        profileDir: path.join(options.profileRoot, "computer"),
        ...(options.fontDir === undefined ? {} : { fontDir: options.fontDir }),
        ...(options.browserPackDir === undefined ? {} : { browserPackDir: options.browserPackDir }),
      });
    this.#browser = new BrowserSupply({
      assets: this.#assets,
      profileDir: path.join(options.profileRoot, "computer"),
      handlerDispatch: true,
    });
    this.#computer = new BotComputerRuntime({ ...options, assetSupply: this.#assets, browserSupply: this.#browser });
    this.#ownership.onPendingTarget(candidate => this.#startAttribution(candidate));
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
      await this.#subscribeWindowEvents(computer);
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
        await this.#subscribeWindowEvents(current.computer);
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
      await this.#subscribeWindowEvents(computer);
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
      if (computer.surfaceIds.size === 0) {
        await computer.stop().catch(() => {});
        this.#forgetComputerTracking();
      }
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
    const capture = async (signal?: AbortSignal): Promise<BotScreenCapture> => {
      if (stopped || !computer.running()) throw new BotScreenUnavailableError("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new BotScreenUnavailableError("Bot Desktop is not running");
      return this.#capture(
        computer.grim,
        computer.childEnv,
        session.outputName,
        session.videoWidth,
        session.videoHeight,
        signal,
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
    const launch = async (request: BotScreenLaunchRequest, signal?: AbortSignal): Promise<{ text?: string }> => {
      if (stopped || !computer.running()) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      return this.#withInputLease(session, async () => {
        let launched = false;
        try {
          const result = await this.#launchApplication(session, request, signal);
          launched = true;
          return result;
        } finally {
          // The full-screen floating Bot Desktop stays visible until the
          // launched window paints over it, including when the launch fails.
          try {
            await hideBotDesktop(swayIpc, session.workspaceName);
          } catch (error) {
            // A failed launch keeps its own error; only a successful launch
            // reports that the Desktop could not be hidden.
            if (launched) throw error;
            console.error("Bot Desktop could not be hidden after a failed launch", error);
          }
        }
      });
    };
    const cleanupSurface = async (): Promise<void> => {
      stopped = true;
      if (cleanupComplete) return;
      if (cleanupInFlight !== undefined) return cleanupInFlight;
      const cleanup = (async (): Promise<void> => {
        await virtualInput.release().catch(() => {});
        computer.browser?.dropScreen(provision.surfaceId);
        this.#ownership.releaseSurface(provision.surfaceId);
        this.#attributionErrors.delete(provision.surfaceId);
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
      browser: async (action, input, signal) => {
        signal.throwIfAborted();
        // A Service Host without the pack has no Bot browser and no fallback.
        await this.#browser.ensurePack();
        if (session.pendingBinding) await this.#waitForAttributionJobs([session.pendingBinding], signal);
        await this.#awaitAttributions(session, signal);
        if (action.name === "request_takeover") return { text: "Browser is available for Takeover" };
        const routed = await listWindows();
        if (
          computer.browser?.alive !== true
          || !routed.some((window) => window.pid !== undefined && this.#browser.isPackBrowser(window.pid))
        ) {
          await launch({ url: "about:blank" }, signal);
          signal.throwIfAborted();
          // The launch binds the window it claimed; nothing here pairs a new page
          // target with a new pack window, which would bind a pop-up that merely
          // mapped while the launch ran.
          if (session.pendingBinding) await this.#waitForAttributionJobs([session.pendingBinding], signal);
        }
        if (computer.browser?.alive !== true) throw new Error("Browser tool unavailable: browser CDP pipe closed; close browser windows and relaunch. Computer tools remain available.");
        return computer.browser.perform(provision.surfaceId, action, { windows: listWindows, focusWindow, input }, signal);
      },
      setInputAuthority: async (controllerEpoch, kind = "bot") => {
        if (!Number.isSafeInteger(controllerEpoch) || controllerEpoch <= lastInputEpoch) {
          throw new BotScreenInputRejectedError("stale controller epoch");
        }
        const acquired = await this.#acquireInputLease(provision.surfaceId);
        try {
          await this.#focusWorkspace(session);
          lastInputEpoch = controllerEpoch;
          await virtualInput.setInputAuthority(controllerEpoch);
          this.#humanLease = kind === "web" ? { session, epoch: controllerEpoch } : undefined;
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
    signal?: AbortSignal,
    inheritedTargets?: Set<string>,
  ): Promise<{ text?: string }> {
    const surfaceLifetime = this.#ownership.surfaceSignal(session.provision.surfaceId);
    await this.options.onLaunch?.();
    surfaceLifetime.throwIfAborted();
    if (session.computer !== this.#computer.current() || this.#sessions.get(session.provision.surfaceId) !== session) throw new Error("Browser Screen changed before launch");
    signal?.throwIfAborted();
    const cwd = this.options.applicationCwd;
    if (cwd === undefined || cwd === "" || !existsSync(cwd)) {
      throw new Error("Shared Workspace is unavailable for application launch");
    }
    const swayIpc = new SwayIpcClient(session.computer.sockets.swaySock);
    // The tree is shared by every Screen, so this snapshot is tree-wide: it names
    // the windows that already exist on every Surface, not just this one.
    const before = new Map(
      listApplicationToplevels(await swayIpc.getTree())
        .map((window) => [window.id, window] as const),
    );
    // Fonts are only needed by graphical children, so fake-runtime tests stay offline.
    await session.computer.ensureFonts();
    let argv: string[];
    if (request.app !== undefined) {
      // Refuse by name first: a host browser's desktop entry need not resolve to be refused.
      this.#browser.refuseHostBrowser(request.app);
      argv = desktopApplicationCommand(request.app, session.computer.childEnv);
      this.#browser.refuseHostBrowser(request.app, argv);
    } else {
      argv = await this.#browser.launchCommand(request.url!);
    }
    const text = request.app !== undefined ? `launched ${request.app}` : `opened ${request.url}`;
    const browserPipe = argv.includes("--remote-debugging-pipe");
    // A pack that survived a Service restart still holds the profile singleton,
    // but the CDP pipe that could drive it is gone, so a new piped pack would
    // forward to it and exit. Replace it first: its tabs and URL are lost, its
    // sign-ins stay in the profile (Computer ADR 0013).
    if (browserPipe) await this.#browser.stopOrphanPacks();
    const lifetime = AbortSignal.any([surfaceLifetime, AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    lifetime.throwIfAborted();
    const launchClaim = { session, result: Promise.withResolvers<void>(), targets: inheritedTargets ?? new Set<string>(), signal: lifetime, active: true };
    this.#launchClaim = launchClaim;
    // Ordinary apps may hand a URL to the running pack; they use this same
    // launch context and stamp path, while keeping process claims for app windows.
    void launchClaim.result.promise.catch(() => {});
    const binding = browserPipe ? launchClaim.result : undefined;
    if (binding) {
      session.pendingBinding = binding.promise;
    }
    try {
      const role = `application-${++session.computer.applicationSequence}` as const;
      const application = spawnDetachedChild({
        argv: [
          ...(browserPipe ? [] : this.#units.computerCommand(
            session.computer.generation,
            role,
            session.computer.childEnv,
            cwd,
          )),
          ...argv,
        ],
        env: browserPipe ? session.computer.childEnv : this.#units.launcherEnvironment(session.computer.childEnv),
        cwd,
        output: "ignore",
        // A pack that dies during startup is diagnosed from the end of its stderr.
        captureStderr: browserPipe,
        // Extra CDP descriptors cannot pass through systemd-run's stdio forwarding.
        owned: browserPipe || !this.#units.enabled,
        browserPipe,
      });
      if (browserPipe) {
        const writer = createConnection({ fd: application.process.stdio[3]! });
        const reader = createConnection({ fd: application.process.stdio[4]! });
        if (session.computer.browser?.alive !== true) {
          // This launch's CDP descriptors become the Service's browser pipe. A pack
          // that exits before its window is stamped never opens one, so fail the
          // launch now with its stderr instead of waiting out the deadline. A
          // forwarding child of a singleton handoff exits by design and owns no pipe.
          if (binding) {
            void application.process.exited.then(() => {
              const exit = exitDescription(application.process);
              binding.reject(new Error(
                `The browser exited during startup (${exit ?? "unknown"}): ${stderrTailText(application)}`,
              ));
            });
          }
          const browser = new BrowserRuntime(new CdpPipe(writer, reader), this.#ownership, {
            ownerForNewTarget: (targetId) => {
              if (session.computer !== this.#computer.current()) return undefined;
              const launch = this.#launchClaim;
              if (launch?.session.computer === session.computer && !launch.signal.aborted
                && this.#sessions.get(launch.session.provision.surfaceId) === launch.session) {
                launch.targets.add(targetId);
                return launch.session.provision.surfaceId;
              }
              const human = this.#humanLease;
              if (human?.session.computer === session.computer
                && this.#inputLeaseOwner === human.session.provision.surfaceId) return human.session.provision.surfaceId;
              return undefined;
            },
          });
          session.computer.browser = browser;
          void application.process.exited.then(() => browser.close());
        } else {
          writer.destroy();
          reader.destroy();
        }
      }
      // An application is shared by every Screen, so it is stopped with the Bot
      // Computer. Its entry survives its leader while descendants still live in the
      // owned session; that is what makes the teardown find them.
      // shortcut: such an entry and its idle anchor live until the Computer stops,
      // upgrade to a session watcher if orphaned applications become common.
      session.computer.applicationProcesses.add(application);
      // The identity captured now proves later that a reported pid still is this
      // launch rather than a reused pid (see `processDescendsFrom`).
      const applicationIdentity = processIdentity(application.process.pid);
      // A pack launch is the pack browser by construction, whatever its binary.
      if (browserPipe) this.#browser.trackLaunch(application.process.pid, applicationIdentity);
      void application.process.exited.then(() => {
        if (settleOwnedChild(application)) {
          session.computer.applicationProcesses.delete(application);
          this.#browser.forgetLaunch(application.process.pid);
        }
      });
      if (binding) {
        const abort = () => {
          if (signal?.aborted || surfaceLifetime.aborted) {
            binding.reject(lifetime.reason);
            return;
          }
          void (async () => {
            const foreign = this.#foreignBrowserWindows(session, listApplicationToplevels(await swayIpc.getTree()));
            binding.reject(new BrowserWindowAttributionError("launch", new Error("No stamped browser window appeared"
              + (foreign.length ? `; the shared browser window ${foreign.map(({ window, surfaceId }) => `${window.id} on Screen ${surfaceId}`).join(", ")} was left in place` : ""))));
          })().catch(error => binding.reject(new BrowserWindowAttributionError("launch", error)));
        };
        lifetime.addEventListener("abort", abort, { once: true });
        if (lifetime.aborted) abort();
        try {
          await binding.promise;
          return { text };
        } finally {
          lifetime.removeEventListener("abort", abort);
          if (this.#launchClaim?.result === binding) this.#launchClaim = undefined;
          if (session.pendingBinding === binding.promise) session.pendingBinding = undefined;
        }
      }
      // A cold portable Chromium can take longer than 5s to map its window, and the
      // window is routed only once it exists.
      const timeoutMs = request.app !== undefined ? 5_000 : 30_000;
      const target = request.app !== undefined ? `application ${request.app}` : `URL ${request.url}`;
      const { claimed, settled } = await this.#routeWindowsOntoWorkspace(swayIpc, session, {
        timeoutMs,
        discover: (tree) => {
          const applications = this.#claimLaunchedWindows(session, before, tree, application.process.pid, applicationIdentity);
          const stamped = this.#ownership.windowsFor(session.provision.surfaceId)
            .filter(owned => owned.targetId !== undefined && launchClaim.targets.has(owned.targetId))
            .flatMap(owned => tree.filter(window => window.id === owned.swayWindowId));
          return [...applications, ...stamped];
        },
        settled: (current) => current?.workspace === session.workspaceName && current.visible === true,
        beforePoll: async () => {
          if (signal?.aborted) {
            await terminateOwnedChild(application);
            signal.throwIfAborted();
          }
        },
      });
      if (settled) {
        return { text };
      }
      if (claimed.length > 0) {
        // A claimed window that never settles is a failure, but the reason differs:
        // it can disappear, stay on another workspace, or stay mapped invisible.
        let current: ComputerWindowListItem[] = [];
        try {
          current = listApplicationToplevels(await swayIpc.getTree());
        } catch {
          // The launch already failed; a divergent final read must not replace its reason.
        }
        const absent: string[] = [];
        const misplaced: string[] = [];
        const invisible: string[] = [];
        for (const { id } of claimed) {
          const window = current.find((candidate) => candidate.id === id);
          if (window === undefined) absent.push(id);
          else if (window.workspace !== session.workspaceName) misplaced.push(id);
          else if (window.visible !== true) invisible.push(id);
        }
        const reasons = [
          ...(absent.length === 0
            ? []
            : [`window ${absent.join(", ")} never appeared on workspace ${session.workspaceName}`]),
          ...(misplaced.length === 0
            ? []
            : [`window ${misplaced.join(", ")} is not on workspace ${session.workspaceName}`]),
          ...(invisible.length === 0
            ? []
            : [`window ${invisible.join(", ")} is not visible on workspace ${session.workspaceName}`]),
        ];
        if (reasons.length > 0) {
          throw new Error(`Launched ${target} but ${reasons.join("; ")} after routing`);
        }
      }
      let foreign: Array<{ window: ComputerWindowListItem; surfaceId: SurfaceId }> = [];
      try {
        foreign = this.#foreignBrowserWindows(
          session,
          listApplicationToplevels(await swayIpc.getTree()),
        );
      } catch {
        // The launch already failed; a second IPC error must not replace its reason.
      }
      throw new Error(
        `Launched ${target} but no window owned by the launched process appeared on workspace `
        + `${session.workspaceName} within ${timeoutMs}ms`
        + (foreign.length === 0
          ? ""
          : `; the shared browser window ${
            foreign.map(({ window, surfaceId }) => `${window.id} on Screen ${surfaceId}`).join(", ")
          } was left in place`),
      );
    } finally {
      launchClaim.active = false;
      if (this.#launchClaim === launchClaim) this.#launchClaim = undefined;
    }
  }

  /**
   * Moves the windows a launch may route onto the Screen's workspace and waits
   * for every one of them to reach the state the caller needs. `discover` picks
   * this launch's windows out of a tree snapshot, and `settled` decides when one
   * has arrived, so a tiled application and a transient pop-up can each state
   * their own rule instead of sharing the tiled one.
   */
  async #routeWindowsOntoWorkspace(
    swayIpc: SwayIpcClient,
    session: SwaySession,
    options: {
      timeoutMs: number;
      discover: (tree: readonly ComputerWindowListItem[]) => ComputerWindowListItem[];
      settled: (current: ComputerWindowListItem | undefined) => boolean;
      /** Runs before each poll; throws to stop waiting, e.g. when the caller aborts. */
      beforePoll?: () => Promise<void>;
    },
  ): Promise<{ claimed: ComputerWindowListItem[]; settled: boolean }> {
    // Sway announces a container before it is mapped and routed, so a claimed
    // window that is absent, still elsewhere, or not yet settled is a transient
    // state: retry it within the same deadline instead of failing.
    const claimed = new Map<string, ComputerWindowListItem>();
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline && session.computer.running()) {
      await options.beforePoll?.();
      const tree = listApplicationToplevels(await swayIpc.getTree());
      const moved: ComputerWindowListItem[] = [];
      for (const window of options.discover(tree)) {
        if (claimed.has(window.id)) continue;
        claimed.set(window.id, window);
        if (window.pid !== undefined && this.#browser.isPackBrowser(window.pid)) continue;
        await swayIpc.runCommand(
          `[con_id=${window.id}] move container to workspace ${session.workspaceName}`,
        );
        moved.push(window);
      }
      if (moved.length > 0) {
        await this.#focusWorkspace(session);
        // A just-routed tiled window is not arranged until it is focused: on
        // Sway 1.10 the tabbed container stays 0x0 and the window unmapped, so
        // focus only the routed windows before the caller's settle check.
        for (const window of moved) {
          await swayIpc.runCommand(`[con_id=${window.id}] focus`);
        }
      }
      if (claimed.size > 0) {
        // Re-read the claimed containers themselves: a window on the right
        // workspace that Sway still hides (scratchpad) has not settled.
        const routed = moved.length > 0
          ? listApplicationToplevels(await swayIpc.getTree())
          : tree;
        const allSettled = [...claimed.keys()].every((id) =>
          options.settled(routed.find((candidate) => candidate.id === id)));
        if (allSettled) return { claimed: [...claimed.values()], settled: true };
      }
      await Bun.sleep(20);
    }
    return { claimed: [...claimed.values()], settled: false };
  }

  /** Cold handlers request the same daemon-owned pipe lifecycle as open_url. */
  async #ensureBrowserHandler(computer: BotComputer): Promise<void> {
    if (computer.browserHandler) return;
    let tail = Promise.resolve();
    computer.browserHandler = await openBrowserHandler(computer.runtimeDir, (urls, requestSignal) => {
      const launch = this.#launchClaim;
      const human = this.#humanLease;
      const activeLaunch = launch?.active && launch.session.computer === computer && !launch.signal.aborted ? launch : undefined;
      const activeHuman = human?.session.computer === computer && this.#inputLeaseOwner === human.session.provision.surfaceId ? human : undefined;
      const session = activeLaunch?.session ?? activeHuman?.session;
      if (!session) return Promise.reject(new Error("Browser handler requires an active Bot launch or Web Control lease"));
      const signal = AbortSignal.any([requestSignal, this.#ownership.surfaceSignal(session.provision.surfaceId), ...(activeLaunch ? [activeLaunch.signal] : [])]);
      const work = tail.then(async () => {
        signal.throwIfAborted();
        if (computer !== this.#computer.current() || this.#sessions.get(session.provision.surfaceId) !== session
          || (activeLaunch && !activeLaunch.active) || (!activeLaunch && this.#humanLease !== activeHuman)) throw new Error("Browser handler authority changed before launch");
        for (const url of urls) {
          signal.throwIfAborted();
          const previous = this.#launchClaim;
          try {
            await this.#launchApplication(session, { url }, signal, activeLaunch?.targets);
            await hideBotDesktop(new SwayIpcClient(computer.sockets.swaySock), session.workspaceName);
          }
          finally {
            if (previous?.active && !previous.signal.aborted && this.#sessions.get(previous.session.provision.surfaceId) === previous.session) this.#launchClaim = previous;
          }
        }
      });
      tail = work.catch(() => {});
      return work;
    });
  }

  /** Opens the one window-event subscription a live Bot Computer needs. */
  async #subscribeWindowEvents(computer: BotComputer): Promise<void> {
    await this.#ensureBrowserHandler(computer);
    const open = this.#windowEvents;
    if (open !== undefined && open.computer === computer && !open.subscription.closed) return;
    open?.subscription.close();
    this.#windowEvents = undefined;
    const subscription = await SwayWindowSubscription.open(computer.sockets.swaySock);
    this.#windowEvents = { computer, subscription };
    computer.windowEvents = subscription;
    subscription.onWindowEvent((event) => this.#enqueueWindowEvent(computer, event));
    // New events may have been lost before this listener was installed. Feed
    // the current tree through the same identity and parking-job guards.
    const windows = listApplicationToplevels(await new SwayIpcClient(computer.sockets.swaySock).getTree());
    if (computer !== this.#computer.current() || this.#windowEvents?.subscription !== subscription) return;
    for (const window of windows) this.#enqueueWindowEvent(computer, { change: "new", window });
    await Promise.all(this.#parkingJobs.values());
  }

  /**
   * Parking cannot wait behind a launch's completion or attribution observation.
   * Each event catches its own failure so later events can still be handled.
   */
  #enqueueWindowEvent(computer: BotComputer, event: SwayWindowEvent): void {
    if (event.change !== "new" || computer !== this.#computer.current()) return;
    if (this.#parkingJobs.has(event.window.id)) return;
    // Each new window issues parking immediately, independently of slow CDP
    // attribution or another window's verification. Every task catches its tail.
    const job = this.#routeWindowEvent(computer, event.window).catch(error => {
      console.error("Bot Computer window event routing failed", error);
    }).finally(() => {
      if (this.#parkingJobs.get(event.window.id) === job) this.#parkingJobs.delete(event.window.id);
    });
    this.#parkingJobs.set(event.window.id, job);
  }

  /** No pack window enters ownership until the Sway stamp port verifies its identity. */
  async #routeWindowEvent(computer: BotComputer, window: ComputerWindowListItem): Promise<void> {
    if (window.pid === undefined || !this.#browser.isPackBrowser(window.pid)) return;
    if (this.#ownership.ownerOfSwayWindow(window.id) !== undefined) return;
    if (this.#ownership.isUnowned(window.id) || this.#ownership.isParked(window.id)) return;
    try {
      await this.#parkUnownedWindow(computer, window);
      if (computer !== this.#computer.current()) return;
      this.#parkingFailures.delete(window.id);
      this.#ownership.markParked(window.id);
    } catch (error) {
      if (computer === this.#computer.current()) this.#parkingFailures.set(window.id, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async #parkUnownedWindow(computer: BotComputer, window: Pick<ComputerWindowListItem, "id">, signal?: AbortSignal): Promise<void> {
    const bounded = AbortSignal.any([AbortSignal.timeout(1_500), ...(signal ? [signal] : [])]);
    const ipc = new SwayIpcClient(computer.sockets.swaySock);
    try {
      bounded.throwIfAborted();
      if (computer !== this.#computer.current()) throw new Error("Bot Computer changed before parking");
      await ipc.runCommand(`[con_id=${window.id}] move scratchpad`, bounded);
      while (true) {
        bounded.throwIfAborted();
        if (computer !== this.#computer.current()) throw new Error("Bot Computer changed during parking");
        const current = listApplicationToplevels(await ipc.getTree(bounded)).find(candidate => candidate.id === window.id);
        if (!current || current.workspace === "__i3_scratch") return;
        await this.#attributionTick(bounded);
      }
    } catch (error) {
      throw new Error(`Bot Computer could not park window ${window.id} on the scratchpad`, { cause: error });
    }
  }

  /** Schedules CDP work outside the Sway event tail: title/new events keep flowing. */
  #startAttribution(candidate: PendingWindowTarget): void {
    if (!this.#ownership.hasPendingTarget(candidate) || this.#attributionJobs.has(candidate)) return;
    const session = this.#sessions.get(candidate.surfaceId as SurfaceId);
    const computer = session?.computer;
    const browser = computer?.browser;
    if (!session || !computer || !browser || computer !== this.#computer.current()) return;
    const launch = this.#launchClaim?.targets.has(candidate.targetId) ? this.#launchClaim : undefined;
    const check = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (computer !== this.#computer.current() || !computer.running()) throw new Error("Bot Computer changed during attribution");
    };
    const ipc = new SwayIpcClient(computer.sockets.swaySock);
    const job = browser.attributeTarget(candidate, {
      observeTitle: async (nonce, signal) => {
        while (true) {
          check(signal);
          const windows = listApplicationToplevels(await ipc.getTree(signal));
          check(signal);
          const matched = windows.find(window => matchesBrowserWindowTitleStamp(window.title, nonce)
            && window.pid !== undefined && this.#browser.isPackBrowser(window.pid));
          if (matched) {
            if (this.#ownership.isParked(matched.id)) return { swayWindowId: matched.id, title: matched.title! };
            const parkingError = this.#parkingFailures.get(matched.id);
            if (parkingError) throw parkingError;
          }
          await this.#attributionTick(signal);
        }
      },
      routeAndVerify: async (surfaceId, swayWindowId, signal) => {
        check(signal);
        if (this.#sessions.get(surfaceId as SurfaceId) !== session) throw new Error("Browser Screen changed during attribution");
        const deadline = AbortSignal.timeout(2_000);
        const routeSignal = AbortSignal.any([signal, deadline]);
        try {
          await ipc.runCommand(`[con_id=${swayWindowId}] move container to workspace ${session.workspaceName}`, routeSignal);
          // Workspace identity and scratchpad removal are the routing evidence.
          // An inactive tab/output need not be visible and must never be focused.
          while (true) {
            check(routeSignal);
            const window = listApplicationToplevels(await ipc.getTree(routeSignal)).find(window => window.id === swayWindowId);
            if (!window) throw new Error("Stamped browser window disappeared during routing");
            if (window.workspace === session.workspaceName) return;
            await this.#attributionTick(routeSignal);
          }
        } catch (error) {
          if (deadline.aborted && !signal.aborted) throw new Error("Browser window move was not verified within 2000ms", { cause: error });
          throw error;
        }
      },
      park: async (swayWindowId, signal) => {
        check(signal);
        await this.#parkUnownedWindow(computer, { id: swayWindowId }, signal);
      },
    }, launch?.signal).then(owned => {
      if (owned) launch?.result.resolve();
    }).catch(error => {
      if (computer !== this.#computer.current() || this.#sessions.get(candidate.surfaceId as SurfaceId) !== session) return;
      if (launch) launch.result.reject(error);
      else this.#attributionErrors.set(candidate.surfaceId, error);
    }).finally(() => { this.#attributionJobs.delete(candidate); });
    this.#attributionJobs.set(candidate, job);
  }

  async #awaitAttributions(session: SwaySession, signal: AbortSignal): Promise<void> {
    await session.computer.browser?.settleOpenerDiscovery(signal);
    while (true) {
      signal.throwIfAborted();
      const jobs = [...this.#attributionJobs].filter(([candidate]) => candidate.surfaceId === session.provision.surfaceId).map(([, job]) => job);
      if (jobs.length === 0) break;
      await this.#waitForAttributionJobs(jobs, signal);
    }
    const error = this.#attributionErrors.get(session.provision.surfaceId);
    this.#attributionErrors.delete(session.provision.surfaceId);
    if (error !== undefined) throw error;
  }

  #attributionTick(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 10);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async #waitForAttributionJobs(jobs: Promise<void>[], signal: AbortSignal): Promise<void> {
    const abort = Promise.withResolvers<never>();
    const onAbort = () => abort.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { await Promise.race([Promise.all(jobs), abort.promise]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  /** Ordinary application launch claims remain process-based; pack windows require a stamp. */
  #claimLaunchedWindows(
    session: SwaySession,
    before: ReadonlyMap<string, ComputerWindowListItem>,
    tree: readonly ComputerWindowListItem[],
    applicationPid: number,
    applicationIdentity: ProcessIdentity | undefined,
  ): ComputerWindowListItem[] {
    const surfaceId = session.provision.surfaceId;
    const created = tree.filter((window) => !before.has(window.id));
    const direct = created.filter((window) =>
      window.pid !== undefined
      && !this.#browser.isPackBrowser(window.pid)
      && applicationIdentity !== undefined
      && processDescendsFrom(window.pid, applicationPid, applicationIdentity)
    );
    return direct.filter((window) => this.#ownership.claim(surfaceId, window.id));
  }

  /**
   * Already-running browser windows on other Screens. A forwarded `open_url` that
   * opened no new window finds the browser there instead of here; naming it shows
   * the launch left the other Screen's window untouched.
   */
  #foreignBrowserWindows(
    session: SwaySession,
    tree: readonly ComputerWindowListItem[],
  ): Array<{ window: ComputerWindowListItem; surfaceId: SurfaceId }> {
    const foreign: Array<{ window: ComputerWindowListItem; surfaceId: SurfaceId }> = [];
    for (const window of tree) {
      if (window.pid === undefined || !this.#browser.isPackBrowser(window.pid)) continue;
      const surfaceId = this.#workspaceSurface(window.workspace);
      if (surfaceId === undefined || surfaceId === session.provision.surfaceId) continue;
      foreign.push({ window, surfaceId });
    }
    return foreign;
  }

  /** The Screen a live `bot-<surfaceId>` workspace belongs to. */
  #workspaceSurface(workspace: string | undefined): SurfaceId | undefined {
    if (workspace === undefined) return undefined;
    for (const surfaceId of this.#runtimes.keys()) {
      if (surfaceWorkspace(surfaceId) === workspace) return surfaceId;
    }
    return undefined;
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
    if (this.#humanLease?.session.provision.surfaceId === surfaceId) this.#humanLease = undefined;
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
    if (session.computer.surfaceIds.size === 0) {
      await session.computer.stop();
      this.#forgetComputerTracking();
    }
  }

  /** A stopped shared Computer starts a fresh Sway session with fresh window ids. */
  #forgetComputerTracking(): void {
    this.#browser.forgetLaunches();
    this.#ownership.reset();
    this.#attributionJobs.clear();
    this.#attributionErrors.clear();
    this.#parkingFailures.clear();
    this.#parkingJobs.clear();
    this.#humanLease = undefined;
    this.#launchClaim?.result.reject(new Error("Bot Computer restarted"));
    this.#launchClaim = undefined;
    this.#windowEvents?.subscription.close();
    this.#windowEvents = undefined;
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
    signal?: AbortSignal,
  ): Promise<BotScreenCapture> {
    signal?.throwIfAborted();
    // The kill hook is armed by the same call that creates `shot`, so an abort
    // that lands while `grim` is being created still ends it, and this capture
    // settles only once `shot` has exited.
    const { child: shot, exited: childExited } = spawnCaptureChild(
      () => Bun.spawn([grim, "-o", outputName, "-"], {
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
      signal,
    );
    try {
      const [status, bytes, stderr] = await Promise.all([
        shot.exited,
        new Response(shot.stdout).arrayBuffer(),
        new Response(shot.stderr).text(),
      ]);
      signal?.throwIfAborted();
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
    } finally {
      await childExited;
    }
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
