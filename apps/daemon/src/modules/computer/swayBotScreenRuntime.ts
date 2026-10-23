import {
  chmodSync,
  existsSync,
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
import type { SurfaceComputerWorker, Supervisor } from "../../supervision/supervisor.ts";
import { ensureCaptureHelper } from "../../../native/capture-helper/build.ts";
import { ensureInputHelper } from "../../../native/pointer-helper/build.ts";
import { ensureBotDesktop } from "../../../native/bot-desktop/build.ts";
import {
  ApplicationUnits,
  applicationUnitName,
  botComputerUnitName,
} from "../../supervision/applicationUnits.ts";
import {
  BotScreenInputRejectedError,
  type BotScreenActionResult,
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
  explicitEnvironment,
  isSocket,
  ownedProcessIdentity,
  ownedProcessRunning,
  privateRuntimeProcesses,
  type OwnedProcessIdentity,
  ProcessLineReader,
  terminateDetachedProcess,
  terminateOwnedProcess,
  WaylandCaptureStream,
  WaylandVirtualInput,
  type DetachedProcess,
} from "./botScreenWaylandHelpers.ts";
import { BOT_DESKTOP_APP_ID, listApplicationToplevels, SwayIpcClient } from "./swayIpc.ts";
import {
  resolveSwayRuntimeBinaries,
  type SwayRuntimeSupply,
} from "./swayRuntimeSupply.ts";

export interface SwayAdapterOptions {
  runtimeRoot: string;
  profileRoot: string;
  hostRuntimeDir?: string;
  swayBin?: string;
  swaymsgBin?: string;
  wlrRandrBin?: string;
  grimBin?: string;
  inputHelperBin?: string;
  captureHelperBin?: string;
  botDesktopBin?: string;
  wayvncBin?: string;
  dbusDaemonBin?: string;
  runtimeSupply?: SwayRuntimeSupply;
  computerWorkers: Pick<Supervisor, "startComputerWorker">;
  capacity?: number;
  applicationCwd?: string;
}

type SwayProcess = DetachedProcess;
type ApplicationProcess = Bun.Subprocess<"ignore", "ignore", "ignore">;

const COMPUTER_STATE_FILE = "computer.json";
const SURFACE_STATE_FILE = "surface.json";
const BOT_DESKTOP_SWAY_CRITERIA = `[app_id="^${BOT_DESKTOP_APP_ID.replaceAll(".", "[.]")}$"]`;
const OUTPUT_SLOT_WIDTH = 8_192;

interface SharedComputerState {
  generation: number;
  waylandDisplay: string;
  swaySockName: string;
  swayPid?: number;
  dbusPid?: number;
  swayIdentity?: OwnedProcessIdentity | undefined;
  dbusIdentity?: OwnedProcessIdentity | undefined;
}

interface SwaySurfaceState {
  generation: number;
  computerGeneration: number;
  outputName: string;
  workspaceName: string;
  desktopPid?: number;
  desktopIdentity?: OwnedProcessIdentity | undefined;
}

interface SharedComputerSession {
  generation: number;
  runtimeComputerDir: string;
  runtimeDir: string;
  profileDir: string;
  childEnv: Record<string, string>;
  sockets: { waylandDisplay: string; swaySock: string };
  swayProcess?: SwayProcess;
  dbusProcess?: SwayProcess;
  swayPid?: number;
  dbusPid?: number;
  swayIdentity?: OwnedProcessIdentity | undefined;
  dbusIdentity?: OwnedProcessIdentity | undefined;
  grim: string;
  inputHelper: string;
  captureHelper: string;
  botDesktop: string;
  wlrRandr: string;
  surfaceIds: Set<SurfaceId>;
  applicationProcesses: Set<ApplicationProcess>;
  applicationSequence: number;
}

interface SwaySession {
  provision: BotScreenProvision;
  computer: SharedComputerSession;
  runtimeSurfaceDir: string;
  runtimeDir: string;
  outputName: string;
  workspaceName: string;
  videoWidth: number;
  videoHeight: number;
  desktopProcess?: SwayProcess;
  desktopPid?: number;
  desktopIdentity?: OwnedProcessIdentity | undefined;
  virtualInput?: WaylandVirtualInput;
  computerWorker?: SurfaceComputerWorker;
  cleanup?: (() => Promise<void>) | undefined;
}

function writeSwayConfig(configHome: string): string {
  const swayDir = path.join(configHome, "sway");
  mkdirSync(swayDir, { recursive: true, mode: 0o700 });
  chmodSync(swayDir, 0o700);
  const configPath = path.join(swayDir, "config");
  writeFileSync(
    configPath,
    [
      "xwayland enable",
      "default_border none",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return configPath;
}

function sessionEnvironment(input: {
  runtimeDir: string;
  waylandDisplay: string;
  homeDir: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
  swaySock: string;
  dbusAddress: string;
}): Record<string, string> {
  return {
    ...explicitEnvironment(input),
    SWAYSOCK: input.swaySock,
    DBUS_SESSION_BUS_ADDRESS: input.dbusAddress,
    XDG_CURRENT_DESKTOP: "sway",
  };
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
 * One private, headless Sway Bot Computer with a persistent application
 * profile. Each Bot Screen owns an output/workspace view into that computer.
 */
export class SwayBotScreenRuntimeAdapter implements BotScreenRuntimeAdapter {
  #units: ApplicationUnits;
  #runtimes = new Map<SurfaceId, BotScreenRuntime>();
  #sessions = new Map<SurfaceId, SwaySession>();
  #computer: SharedComputerSession | undefined;
  #lifecycleOperation: Promise<void> = Promise.resolve();
  #inputTail: Promise<void> = Promise.resolve();
  #inputLeaseOwner: SurfaceId | undefined;
  #inputLeaseRelease: (() => void) | undefined;
  #resolvedWayvnc: string | undefined;

  constructor(private readonly options: SwayAdapterOptions) {
    this.#units = new ApplicationUnits(options.hostRuntimeDir);
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1) {
      throw new Error("Bot Computer output capacity must be a positive integer");
    }
    if (this.#capacity > 32) {
      throw new Error("Bot Computer output capacity cannot exceed 32");
    }
  }

  get #capacity(): number {
    return this.options.capacity ?? 8;
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
      const computer = await this.#ensureComputer();
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
        && current.provision.generation === provision.generation
        && await this.#liveSurfaceValid(current)
      ) {
        await this.#ensureHelpers(current);
        return this.#runtimes.get(provision.surfaceId) ?? currentRuntime;
      }
      if (current !== undefined && currentRuntime !== undefined) {
        await this.#stopSession(current, currentRuntime);
      }
      this.#validateProvision(provision);
      let computer = this.#computer;
      if (computer !== undefined && !this.#computerRunning(computer)) {
        await this.#stopComputer(computer).catch(() => {});
        computer = undefined;
      }
      computer ??= await this.#reattachComputer();
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
      const computerGeneration = session?.computer.generation ?? retained?.state.computerGeneration;
      if (session !== undefined && runtime !== undefined) {
        await this.#stopSession(session, runtime);
      }
      const computer = this.#computer;
      if (
        workspaceName !== undefined
        && computer !== undefined
        && computerGeneration === computer.generation
        && this.#computerRunning(computer)
      ) {
        const swayIpc = new SwayIpcClient(computer.sockets.swaySock);
        await swayIpc.runCommand(`${workspaceCriteria(workspaceName)} kill`).catch(() => {});
      }
      await this.#units.stop(surfaceId);
      rmSync(path.join(this.options.runtimeRoot, surfaceId), { recursive: true, force: true });
    });
  }

  async #startSurface(
    computer: SharedComputerSession,
    provision: BotScreenProvision,
  ): Promise<BotScreenRuntime> {
    const outputName = this.#allocateOutput();
    const outputIndex = Number(outputName.slice("HEADLESS-".length));
    const workspaceName = surfaceWorkspace(provision.surfaceId);
    const runtimeSurfaceDir = path.join(this.options.runtimeRoot, provision.surfaceId);
    const runtimeDir = path.join(runtimeSurfaceDir, String(provision.generation));
    rmSync(runtimeSurfaceDir, { recursive: true, force: true });
    for (const directory of [this.options.runtimeRoot, runtimeSurfaceDir, runtimeDir]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const videoWidth = Math.round(provision.logicalWidth * provision.scale);
    const videoHeight = Math.round(provision.logicalHeight * provision.scale);
    let desktopProcess: SwayProcess | undefined;
    let virtualInput: WaylandVirtualInput | undefined;
    let computerWorker: SurfaceComputerWorker | undefined;
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
      desktopProcess = Bun.spawn([
        ...this.#units.command(provision.surfaceId, provision.generation, "application", computer.childEnv),
        computer.botDesktop,
        String(provision.logicalWidth),
        String(provision.logicalHeight),
        String(provision.scale),
      ], {
        env: this.#units.launcherEnvironment(computer.childEnv),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      const desktopReadiness = new ProcessLineReader(desktopProcess.stdout);
      await this.#waitForDesktop(
        desktopReadiness,
        desktopProcess,
        provision.logicalWidth,
        provision.logicalHeight,
      );
      await this.#capture(computer.grim, computer.childEnv, outputName, videoWidth, videoHeight);
      virtualInput = await WaylandVirtualInput.start(
        computer.inputHelper,
        outputName,
        this.#units.launcherEnvironment(computer.childEnv),
        provision,
        this.#units.command(provision.surfaceId, provision.generation, "input", computer.childEnv),
      );
      computerWorker = await this.options.computerWorkers.startComputerWorker({
        surfaceId: provision.surfaceId,
        runtimeGeneration: provision.generation,
        env: computer.childEnv,
        wrapCommand: (targetEnvironment) => ({
          commandPrefix: this.#units.command(
            provision.surfaceId,
            provision.generation,
            "worker",
            targetEnvironment,
          ),
          launcherEnvironment: this.#units.launcherEnvironment(targetEnvironment),
        }),
      });
      const session: SwaySession = {
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
        desktopIdentity: ownedProcessIdentity(
          desktopProcess.pid,
          computer.runtimeDir,
          applicationUnitName(provision.surfaceId, provision.generation, "application"),
        ),
        virtualInput,
        computerWorker,
      };
      computer.surfaceIds.add(provision.surfaceId);
      const runtime = this.#bindRuntime(session);
      this.#sessions.set(provision.surfaceId, session);
      this.#runtimes.set(provision.surfaceId, runtime);
      this.#writeSurfaceState(session);
      return runtime;
    } catch (error) {
      await computerWorker?.stop().catch(() => {});
      await virtualInput?.stop().catch(() => {});
      if (desktopProcess !== undefined) await terminateDetachedProcess(desktopProcess).catch(() => {});
      await this.#units.stop(provision.surfaceId, provision.generation).catch(() => {});
      rmSync(runtimeSurfaceDir, { recursive: true, force: true });
      if (computer.surfaceIds.size === 0) await this.#stopComputer(computer).catch(() => {});
      throw error;
    }
  }

  async #reattachSurface(
    computer: SharedComputerSession,
    provision: BotScreenProvision,
  ): Promise<BotScreenRuntime | undefined> {
    const runtimeSurfaceDir = path.join(this.options.runtimeRoot, provision.surfaceId);
    const runtimeDir = path.join(runtimeSurfaceDir, String(provision.generation));
    const state = this.#readSurfaceState(runtimeDir);
    if (
      state === undefined
      || state.generation !== provision.generation
      || state.computerGeneration !== computer.generation
      || !/^HEADLESS-[1-9]\d*$/.test(state.outputName)
      || this.#outputClaimed(state.outputName)
      || !ownedProcessRunning(state.desktopIdentity)
    ) {
      return undefined;
    }
    const outputIndex = Number(state.outputName.slice("HEADLESS-".length));
    if (outputIndex > this.#capacity) return undefined;
    const videoWidth = Math.round(provision.logicalWidth * provision.scale);
    const videoHeight = Math.round(provision.logicalHeight * provision.scale);
    await this.#capture(computer.grim, computer.childEnv, state.outputName, videoWidth, videoHeight);
    await Promise.all([
      this.#units.stopRole(provision.surfaceId, provision.generation, "input").catch(() => {}),
      this.#units.stopRole(provision.surfaceId, provision.generation, "worker").catch(() => {}),
      this.#units.stopRole(provision.surfaceId, provision.generation, "wayvnc").catch(() => {}),
    ]);
    rmSync(path.join(runtimeDir, "wayvnc.sock"), { force: true });
    const virtualInput = await WaylandVirtualInput.start(
      computer.inputHelper,
      state.outputName,
      this.#units.launcherEnvironment(computer.childEnv),
      provision,
      this.#units.command(provision.surfaceId, provision.generation, "input", computer.childEnv),
    );
    let computerWorker: SurfaceComputerWorker | undefined;
    try {
      computerWorker = await this.options.computerWorkers.startComputerWorker({
        surfaceId: provision.surfaceId,
        runtimeGeneration: provision.generation,
        env: computer.childEnv,
        wrapCommand: (targetEnvironment) => ({
          commandPrefix: this.#units.command(
            provision.surfaceId,
            provision.generation,
            "worker",
            targetEnvironment,
          ),
          launcherEnvironment: this.#units.launcherEnvironment(targetEnvironment),
        }),
      });
    } catch (error) {
      await virtualInput.stop().catch(() => {});
      throw error;
    }
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
      virtualInput,
      computerWorker,
    };
    computer.surfaceIds.add(provision.surfaceId);
    const runtime = this.#bindRuntime(session);
    this.#sessions.set(provision.surfaceId, session);
    this.#runtimes.set(provision.surfaceId, runtime);
    return runtime;
  }

  async #ensureComputer(): Promise<SharedComputerSession> {
    if (this.#computer !== undefined && this.#computerRunning(this.#computer)) {
      return this.#computer;
    }
    if (this.#computer !== undefined) await this.#stopComputer(this.#computer).catch(() => {});
    const recovered = await this.#reattachComputer();
    if (recovered !== undefined) return recovered;
    return this.#startComputer();
  }

  async #startComputer(): Promise<SharedComputerSession> {
    await this.#discardComputerFromDisk();
    const tools = await this.#resolveTools();
    const generation = Date.now();
    const runtimeComputerDir = path.join(this.options.runtimeRoot, "computer");
    const runtimeDir = path.join(runtimeComputerDir, String(generation));
    const profileDir = path.join(this.options.profileRoot, "computer");
    const homeDir = path.join(profileDir, "home");
    const configHome = path.join(profileDir, "config");
    const dataHome = path.join(profileDir, "data");
    const stateHome = path.join(profileDir, "state");
    const cacheHome = path.join(profileDir, "cache");
    for (const directory of [
      this.options.runtimeRoot,
      runtimeComputerDir,
      runtimeDir,
      this.options.profileRoot,
      profileDir,
      homeDir,
      configHome,
      dataHome,
      stateHome,
      cacheHome,
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    const expectedWaylandPath = path.join(runtimeDir, "wayland-0");
    if (Buffer.byteLength(expectedWaylandPath) > 107) {
      throw new Error(`Bot Computer runtime path is too long for a private Wayland socket: ${runtimeDir}`);
    }
    const configPath = writeSwayConfig(path.join(runtimeDir, "compositor-config"));
    const bootstrapEnv = {
      ...explicitEnvironment({
        runtimeDir,
        waylandDisplay: "wayland-0",
        homeDir,
        configHome,
        dataHome,
        stateHome,
        cacheHome,
      }),
      XDG_CURRENT_DESKTOP: "sway",
      WLR_BACKENDS: "headless",
      WLR_HEADLESS_OUTPUTS: String(this.#capacity),
      WLR_LIBINPUT_NO_DEVICES: "1",
      WLR_RENDERER_ALLOW_SOFTWARE: "1",
      WLR_RENDERER: "pixman",
    };
    await this.#units.stopComputer();
    const swayProcess = Bun.spawn([
      ...this.#units.computerCommand(generation, "compositor", bootstrapEnv),
      tools.sway,
      "-c",
      configPath,
    ], {
      env: this.#units.launcherEnvironment(bootstrapEnv),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let dbusProcess: SwayProcess | undefined;
    try {
      const sockets = await this.#discoverSockets(runtimeDir, swayProcess);
      const dbusPath = path.join(runtimeDir, "bus");
      const childEnv = sessionEnvironment({
        runtimeDir,
        waylandDisplay: sockets.waylandDisplay,
        homeDir,
        configHome,
        dataHome,
        stateHome,
        cacheHome,
        swaySock: sockets.swaySock,
        dbusAddress: `unix:path=${dbusPath}`,
      });
      dbusProcess = Bun.spawn([
        ...this.#units.computerCommand(generation, "session-bus", childEnv),
        tools.dbusDaemon,
        "--session",
        "--nofork",
        "--nopidfile",
        `--address=unix:path=${dbusPath}`,
      ], {
        env: this.#units.launcherEnvironment(childEnv),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      await this.#waitForSocket(dbusPath, dbusProcess, "Bot Computer session bus");
      const computer: SharedComputerSession = {
        generation,
        runtimeComputerDir,
        runtimeDir,
        profileDir,
        childEnv,
        sockets,
        swayProcess,
        dbusProcess,
        swayPid: swayProcess.pid,
        dbusPid: dbusProcess.pid,
        swayIdentity: ownedProcessIdentity(
          swayProcess.pid,
          runtimeDir,
          botComputerUnitName(generation, "compositor"),
        ),
        dbusIdentity: ownedProcessIdentity(
          dbusProcess.pid,
          runtimeDir,
          botComputerUnitName(generation, "session-bus"),
        ),
        grim: tools.grim,
        inputHelper: tools.inputHelper,
        captureHelper: tools.captureHelper,
        botDesktop: tools.botDesktop,
        wlrRandr: tools.wlrRandr,
        surfaceIds: new Set(),
        applicationProcesses: new Set(),
        applicationSequence: 0,
      };
      this.#computer = computer;
      this.#writeComputerState(computer);
      return computer;
    } catch (error) {
      if (dbusProcess !== undefined) await terminateDetachedProcess(dbusProcess).catch(() => {});
      await terminateDetachedProcess(swayProcess).catch(() => {});
      await this.#units.stopComputer(generation).catch(() => {});
      await Promise.all(privateRuntimeProcesses(runtimeDir).map(terminateOwnedProcess));
      rmSync(runtimeComputerDir, { recursive: true, force: true });
      throw error;
    }
  }

  async #reattachComputer(): Promise<SharedComputerSession | undefined> {
    const runtimeComputerDir = path.join(this.options.runtimeRoot, "computer");
    const state = this.#readComputerState(runtimeComputerDir);
    if (state === undefined) {
      if (existsSync(runtimeComputerDir)) await this.#discardComputerFromDisk();
      return undefined;
    }
    const runtimeDir = path.join(runtimeComputerDir, String(state.generation));
    const sockets = this.#liveSockets(runtimeDir);
    const dbusPath = path.join(runtimeDir, "bus");
    if (
      sockets === undefined
      || sockets.waylandDisplay !== state.waylandDisplay
      || path.basename(sockets.swaySock) !== state.swaySockName
      || !isSocket(dbusPath)
      || !ownedProcessRunning(state.swayIdentity)
      || !ownedProcessRunning(state.dbusIdentity)
    ) {
      await this.#discardComputerFromDisk();
      return undefined;
    }
    const tools = await this.#resolveTools();
    const profileDir = path.join(this.options.profileRoot, "computer");
    const homeDir = path.join(profileDir, "home");
    const configHome = path.join(profileDir, "config");
    const dataHome = path.join(profileDir, "data");
    const stateHome = path.join(profileDir, "state");
    const cacheHome = path.join(profileDir, "cache");
    if ([homeDir, configHome, dataHome, stateHome, cacheHome].some((directory) => !existsSync(directory))) {
      await this.#discardComputerFromDisk();
      return undefined;
    }
    const childEnv = sessionEnvironment({
      runtimeDir,
      waylandDisplay: sockets.waylandDisplay,
      homeDir,
      configHome,
      dataHome,
      stateHome,
      cacheHome,
      swaySock: sockets.swaySock,
      dbusAddress: `unix:path=${dbusPath}`,
    });
    const computer: SharedComputerSession = {
      generation: state.generation,
      runtimeComputerDir,
      runtimeDir,
      profileDir,
      childEnv,
      sockets,
      ...(state.swayPid === undefined ? {} : { swayPid: state.swayPid }),
      ...(state.dbusPid === undefined ? {} : { dbusPid: state.dbusPid }),
      swayIdentity: state.swayIdentity,
      dbusIdentity: state.dbusIdentity,
      grim: tools.grim,
      inputHelper: tools.inputHelper,
      captureHelper: tools.captureHelper,
      botDesktop: tools.botDesktop,
      wlrRandr: tools.wlrRandr,
      surfaceIds: new Set(),
      applicationProcesses: new Set(),
      applicationSequence: 0,
    };
    this.#computer = computer;
    return computer;
  }

  async #ensureHelpers(session: SwaySession): Promise<void> {
    let rebound = false;
    if (session.virtualInput === undefined || !session.virtualInput.running) {
      session.virtualInput = await WaylandVirtualInput.start(
        session.computer.inputHelper,
        session.outputName,
        this.#units.launcherEnvironment(session.computer.childEnv),
        session.provision,
        this.#units.command(
          session.provision.surfaceId,
          session.provision.generation,
          "input",
          session.computer.childEnv,
        ),
      );
      rebound = true;
    }
    if (session.computerWorker === undefined || !await this.#workerPending(session.computerWorker)) {
      session.computerWorker = await this.options.computerWorkers.startComputerWorker({
        surfaceId: session.provision.surfaceId,
        runtimeGeneration: session.provision.generation,
        env: session.computer.childEnv,
        wrapCommand: (targetEnvironment) => ({
          commandPrefix: this.#units.command(
            session.provision.surfaceId,
            session.provision.generation,
            "worker",
            targetEnvironment,
          ),
          launcherEnvironment: this.#units.launcherEnvironment(targetEnvironment),
        }),
      });
      rebound = true;
    }
    if (!rebound) return;
    const runtime = this.#bindRuntime(session);
    this.#runtimes.set(session.provision.surfaceId, runtime);
  }

  async #workerPending(worker: SurfaceComputerWorker): Promise<boolean> {
    let settled = false;
    void worker.exited.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    return !settled;
  }

  #bindRuntime(session: SwaySession): BotScreenRuntime {
    const { provision, computer } = session;
    const virtualInput = session.virtualInput;
    const computerWorker = session.computerWorker;
    if (virtualInput === undefined || computerWorker === undefined) {
      throw new Error("Sway Bot Screen helpers are required before binding a runtime");
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
      this.#computerExited(computer).then((status) => ({
        type: "compositor-exited",
        error: new Error(`shared Sway compositor exited with status ${status}`),
      })),
      this.#sessionBusExited(computer).then((status) => ({
        type: "session-bus-exited",
        error: new Error(`shared D-Bus session exited with status ${status}`),
      })),
      this.#desktopExited(session).then((status) => ({
        type: "desktop-exited",
        error: new Error(`Bot Desktop exited with status ${status}`),
      })),
      computerWorker.exited.then((error) => ({ type: "computer-worker-exited", error })),
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
      process: SwayProcess;
      socketPath: string;
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
          provision.generation,
          "wayvnc",
        ).catch(() => {});
        await terminateDetachedProcess(shared.process);
        try { unlinkSync(shared.socketPath); } catch { /* already gone */ }
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
        const socketPath = path.join(session.runtimeDir, "wayvnc.sock");
        const wayvncProcess = Bun.spawn([
          ...this.#units.command(provision.surfaceId, provision.generation, "wayvnc", computer.childEnv),
          wayvnc,
          "--unix-socket",
          "--output",
          session.outputName,
          "--disable-input",
          socketPath,
        ], {
          env: this.#units.launcherEnvironment(computer.childEnv),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });
        const wayvncStderr = new Response(wayvncProcess.stderr).text();
        try {
          await this.#waitForSocket(socketPath, wayvncProcess, "WayVNC");
          chmodSync(socketPath, 0o600);
          const shared: SharedWayvnc = {
            process: wayvncProcess,
            socketPath,
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
          await terminateDetachedProcess(wayvncProcess).catch(() => {});
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
      if (stopped || !this.#computerRunning(computer)) throw new Error("Bot Computer compositor is not running");
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
      if (stopped || !this.#computerRunning(computer)) throw new Error("Bot Computer compositor is not running");
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
            provision.generation,
            `capture-${++captureStreamSequence}`,
            computer.childEnv,
          ),
        );
        if (stopped || !this.#computerRunning(computer)) {
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
      if (stopped || !this.#computerRunning(computer)) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      await this.#withInputLease(session, async () => {
        await swayIpc.runCommand(`[con_id=${window.id}] focus`);
        const confirmed = (await listWindows()).find((candidate) => candidate.id === window.id);
        if (confirmed?.focused !== true) throw new Error("Sway window focus was not confirmed");
      });
    };
    const launch = async (request: BotScreenLaunchRequest): Promise<{ text?: string }> => {
      if (stopped || !this.#computerRunning(computer)) throw new Error("Bot Computer compositor is not running");
      if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
      return this.#withInputLease(session, async () => {
        const result = await this.#launchApplication(session, request);
        await hideBotDesktop(swayIpc, session.workspaceName);
        return result;
      });
    };
    const notify = async (args: Record<string, unknown>): Promise<BotScreenActionResult> => {
      const result = await computerWorker.act({ name: "notify", args });
      const workerImage = result.image === undefined
        ? undefined
        : {
            mediaType: result.image.mediaType,
            bytes: new Uint8Array(Buffer.from(result.image.base64, "base64")),
          };
      return {
        ...(result.text === undefined ? {} : { text: result.text }),
        ...(result.windowList === undefined ? {} : {
          windowList: result.windowList.filter((window) =>
            window.workspace === undefined || window.workspace === session.workspaceName
          ),
        }),
        ...(workerImage === undefined ? {} : { image: workerImage }),
      };
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
          computerWorker.stop(),
          this.#stopDesktop(session),
          this.#units.stop(provision.surfaceId, provision.generation),
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
        computerWorker: "ready",
      },
      expandedProjection: "rfb",
      capture,
      openCaptureStream,
      acquireExpandedView: async () => {
        if (stopped || !this.#computerRunning(computer)) throw new Error("Bot Computer compositor is not running");
        if (!this.#desktopRunning(session)) throw new Error("Bot Desktop is not running");
        if (this.#resolvedWayvnc === undefined && this.options.runtimeSupply !== undefined) {
          await this.#resolveTools();
        }
        const wayvnc = this.#resolvedWayvnc
          ?? (this.options.wayvncBin === undefined
            ? undefined
            : executable(this.options.wayvncBin, this.options.wayvncBin));
        if (wayvnc === undefined) throw new Error("WayVNC executable is unavailable");
        const opening = Promise.withResolvers<void>();
        expandedViewStarts.add(opening.promise);
        pendingExpandedAcquires += 1;
        try {
          const shared = await ensureSharedWayvnc(wayvnc);
          if (stopped || !this.#computerRunning(computer)) {
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
          if (stopped || !this.#computerRunning(computer)) {
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
      notify,
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
    const application = Bun.spawn([
      ...this.#units.computerCommand(
        session.computer.generation,
        role,
        session.computer.childEnv,
        cwd,
      ),
      ...argv,
    ], {
      cwd,
      env: this.#units.launcherEnvironment(session.computer.childEnv),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    session.computer.applicationProcesses.add(application);
    void application.exited.then(() => session.computer.applicationProcesses.delete(application));
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && this.#computerRunning(session.computer)) {
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
    if (!this.#computerRunning(session.computer)) {
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
        session.computerWorker?.stop(),
        this.#stopDesktop(session),
        this.#units.stop(session.provision.surfaceId, session.provision.generation),
      ]);
    }
    rmSync(session.runtimeSurfaceDir, { recursive: true, force: true });
    session.computer.surfaceIds.delete(session.provision.surfaceId);
    if (session.computer.surfaceIds.size === 0) await this.#stopComputer(session.computer);
  }

  async #stopComputer(computer: SharedComputerSession): Promise<void> {
    if (this.#computer !== computer) return;
    this.#computer = undefined;
    await this.#units.stopComputer(computer.generation).catch(() => {});
    await Promise.allSettled(
      [...computer.applicationProcesses].map((application) =>
        this.#stopApplicationProcess(application)
      ),
    );
    computer.applicationProcesses.clear();
    await Promise.allSettled([
      this.#stopProcess(computer.dbusProcess, computer.dbusIdentity),
      this.#stopProcess(computer.swayProcess, computer.swayIdentity),
    ]);
    await Promise.all(privateRuntimeProcesses(computer.runtimeDir).map(terminateOwnedProcess));
    rmSync(computer.runtimeComputerDir, { recursive: true, force: true });
  }

  async #discardSurfaceFromDisk(surfaceId: SurfaceId): Promise<void> {
    const retained = this.#latestSurfaceState(surfaceId);
    await this.#units.stop(surfaceId).catch(() => {});
    if (retained?.state.desktopIdentity !== undefined) {
      await terminateOwnedProcess(retained.state.desktopIdentity);
    }
    rmSync(path.join(this.options.runtimeRoot, surfaceId), { recursive: true, force: true });
  }

  async #discardComputerFromDisk(): Promise<void> {
    const runtimeComputerDir = path.join(this.options.runtimeRoot, "computer");
    const state = this.#readComputerState(runtimeComputerDir);
    await this.#units.stopComputer(state?.generation).catch(() => {});
    if (state !== undefined) {
      await Promise.all([
        terminateOwnedProcess(state.dbusIdentity),
        terminateOwnedProcess(state.swayIdentity),
      ]);
    }
    if (existsSync(runtimeComputerDir)) {
      const generations = readdirSync(runtimeComputerDir)
        .filter((entry) => /^\d+$/.test(entry));
      await Promise.all(generations.flatMap((generation) =>
        privateRuntimeProcesses(path.join(runtimeComputerDir, generation))
          .map(terminateOwnedProcess)
      ));
    }
    rmSync(runtimeComputerDir, { recursive: true, force: true });
  }

  async #liveSurfaceValid(session: SwaySession): Promise<boolean> {
    if (!this.#computerRunning(session.computer) || !this.#desktopRunning(session)) return false;
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

  #computerRunning(computer: SharedComputerSession): boolean {
    const swayRunning = computer.swayProcess !== undefined
      ? computer.swayProcess.exitCode === null && computer.swayProcess.signalCode === null
      : ownedProcessRunning(computer.swayIdentity);
    const dbusRunning = computer.dbusProcess !== undefined
      ? computer.dbusProcess.exitCode === null && computer.dbusProcess.signalCode === null
      : ownedProcessRunning(computer.dbusIdentity);
    return swayRunning
      && dbusRunning
      && isSocket(path.join(computer.runtimeDir, computer.sockets.waylandDisplay))
      && isSocket(computer.sockets.swaySock);
  }

  #desktopRunning(session: SwaySession): boolean {
    if (session.desktopProcess !== undefined) {
      return session.desktopProcess.exitCode === null && session.desktopProcess.signalCode === null;
    }
    return ownedProcessRunning(session.desktopIdentity);
  }

  #computerExited(computer: SharedComputerSession): Promise<number> {
    if (computer.swayProcess !== undefined) return computer.swayProcess.exited;
    return this.#watchPid(computer.swayIdentity);
  }

  #sessionBusExited(computer: SharedComputerSession): Promise<number> {
    if (computer.dbusProcess !== undefined) return computer.dbusProcess.exited;
    return this.#watchPid(computer.dbusIdentity);
  }

  #desktopExited(session: SwaySession): Promise<number> {
    if (session.desktopProcess !== undefined) return session.desktopProcess.exited;
    return this.#watchPid(session.desktopIdentity);
  }

  async #watchPid(identity: OwnedProcessIdentity | undefined): Promise<number> {
    while (ownedProcessRunning(identity)) await Bun.sleep(100);
    return 0;
  }

  async #stopApplicationProcess(application: ApplicationProcess): Promise<void> {
    if (application.exitCode !== null || application.signalCode !== null) return;
    try {
      process.kill(-application.pid, "SIGTERM");
    } catch {
      application.kill("SIGTERM");
    }
    const stopped = await Promise.race([
      application.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (stopped) return;
    try {
      process.kill(-application.pid, "SIGKILL");
    } catch {
      application.kill("SIGKILL");
    }
    await application.exited;
  }

  async #stopProcess(
    process: SwayProcess | undefined,
    identity: OwnedProcessIdentity | undefined,
  ): Promise<void> {
    if (process !== undefined) {
      await terminateDetachedProcess(process);
    } else {
      await terminateOwnedProcess(identity);
    }
  }

  async #stopDesktop(session: SwaySession): Promise<void> {
    await this.#stopProcess(session.desktopProcess, session.desktopIdentity);
  }

  #allocateOutput(): string {
    for (let index = 1; index <= this.#capacity; index += 1) {
      const outputName = `HEADLESS-${index}`;
      if (!this.#outputClaimed(outputName)) return outputName;
    }
    throw new Error("Bot Computer has no unassigned output");
  }

  #outputClaimed(outputName: string): boolean {
    return [...this.#sessions.values()].some((session) => session.outputName === outputName);
  }

  #validateProvision(provision: BotScreenProvision): void {
    if (!Number.isSafeInteger(provision.scale) || provision.scale < 1) {
      throw new Error("Sway Bot Screen scale must be a positive integer");
    }
  }

  async #resolveTools(): Promise<{
    sway: string;
    wlrRandr: string;
    grim: string;
    inputHelper: string;
    captureHelper: string;
    botDesktop: string;
    dbusDaemon: string;
  }> {
    let sway: string | undefined;
    let wlrRandr: string | undefined;
    if (this.options.runtimeSupply !== undefined) {
      const binaries = await resolveSwayRuntimeBinaries({
        ...(this.options.swayBin === undefined ? {} : { swayOverride: this.options.swayBin }),
        ...(this.options.swaymsgBin === undefined ? {} : { swaymsgOverride: this.options.swaymsgBin }),
        ...(this.options.wayvncBin === undefined ? {} : { wayvncOverride: this.options.wayvncBin }),
        ...(this.options.wlrRandrBin === undefined ? {} : { wlrRandrOverride: this.options.wlrRandrBin }),
        supply: this.options.runtimeSupply,
      });
      sway = binaries.swayBin;
      wlrRandr = binaries.wlrRandrBin;
      this.#resolvedWayvnc = binaries.wayvncBin;
    } else {
      sway = executable(this.options.swayBin, "sway");
      wlrRandr = executable(this.options.wlrRandrBin, "wlr-randr");
    }
    const grim = executable(this.options.grimBin, "grim");
    const dbusDaemon = executable(this.options.dbusDaemonBin, "dbus-daemon");
    const [inputHelper, captureHelper, botDesktop] = await Promise.all([
      this.options.inputHelperBin === undefined
        ? ensureInputHelper()
        : Promise.resolve(executable(this.options.inputHelperBin, this.options.inputHelperBin)),
      this.options.captureHelperBin === undefined
        ? ensureCaptureHelper()
        : Promise.resolve(executable(this.options.captureHelperBin, this.options.captureHelperBin)),
      this.options.botDesktopBin === undefined
        ? ensureBotDesktop()
        : Promise.resolve(executable(this.options.botDesktopBin, this.options.botDesktopBin)),
    ]);
    if (sway === undefined) throw new Error("Sway executable is unavailable");
    if (wlrRandr === undefined) throw new Error("wlr-randr is required for the Sway Bot Computer runtime");
    if (grim === undefined) throw new Error("grim is required for the Sway Bot Computer runtime");
    if (dbusDaemon === undefined) throw new Error("dbus-daemon is required for the Sway Bot Computer runtime");
    if (inputHelper === undefined || captureHelper === undefined || botDesktop === undefined) {
      throw new Error("Bot Desktop and the Bot Screen capture/input helpers are required for Sway");
    }
    return { sway, wlrRandr, grim, inputHelper, captureHelper, botDesktop, dbusDaemon };
  }

  #writeComputerState(computer: SharedComputerSession): void {
    writeFileSync(
      path.join(computer.runtimeComputerDir, COMPUTER_STATE_FILE),
      JSON.stringify({
        generation: computer.generation,
        waylandDisplay: computer.sockets.waylandDisplay,
        swaySockName: path.basename(computer.sockets.swaySock),
        ...(computer.swayPid === undefined ? {} : { swayPid: computer.swayPid }),
        ...(computer.dbusPid === undefined ? {} : { dbusPid: computer.dbusPid }),
        swayIdentity: computer.swayIdentity,
        dbusIdentity: computer.dbusIdentity,
      } satisfies SharedComputerState),
      { mode: 0o600 },
    );
  }

  #writeSurfaceState(session: SwaySession): void {
    writeFileSync(
      path.join(session.runtimeDir, SURFACE_STATE_FILE),
      JSON.stringify({
        generation: session.provision.generation,
        computerGeneration: session.computer.generation,
        outputName: session.outputName,
        workspaceName: session.workspaceName,
        ...(session.desktopPid === undefined ? {} : { desktopPid: session.desktopPid }),
        desktopIdentity: session.desktopIdentity,
      } satisfies SwaySurfaceState),
      { mode: 0o600 },
    );
  }

  #readComputerState(runtimeComputerDir: string): SharedComputerState | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(runtimeComputerDir, COMPUTER_STATE_FILE), "utf8"),
      ) as Partial<SharedComputerState>;
      if (
        typeof parsed.generation !== "number"
        || !Number.isSafeInteger(parsed.generation)
        || typeof parsed.waylandDisplay !== "string"
        || parsed.waylandDisplay.includes("/")
        || typeof parsed.swaySockName !== "string"
        || parsed.swaySockName.includes("/")
      ) {
        return undefined;
      }
      const runtimeDir = path.join(runtimeComputerDir, String(parsed.generation));
      const swayIdentity = this.#readIdentity(parsed.swayIdentity, parsed.swayPid, runtimeDir);
      const dbusIdentity = this.#readIdentity(parsed.dbusIdentity, parsed.dbusPid, runtimeDir);
      if (swayIdentity === undefined || dbusIdentity === undefined) return undefined;
      return {
        generation: parsed.generation,
        waylandDisplay: parsed.waylandDisplay,
        swaySockName: parsed.swaySockName,
        ...(typeof parsed.swayPid === "number" ? { swayPid: parsed.swayPid } : {}),
        ...(typeof parsed.dbusPid === "number" ? { dbusPid: parsed.dbusPid } : {}),
        swayIdentity,
        dbusIdentity,
      };
    } catch {
      return undefined;
    }
  }

  #readSurfaceState(runtimeDir: string): SwaySurfaceState | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(runtimeDir, SURFACE_STATE_FILE), "utf8"),
      ) as Partial<SwaySurfaceState>;
      if (
        typeof parsed.generation !== "number"
        || !Number.isSafeInteger(parsed.generation)
        || typeof parsed.computerGeneration !== "number"
        || !Number.isSafeInteger(parsed.computerGeneration)
        || typeof parsed.outputName !== "string"
        || typeof parsed.workspaceName !== "string"
      ) {
        return undefined;
      }
      const computerRuntimeDir = path.join(
        this.options.runtimeRoot,
        "computer",
        String(parsed.computerGeneration),
      );
      const desktopIdentity = this.#readIdentity(
        parsed.desktopIdentity,
        parsed.desktopPid,
        computerRuntimeDir,
      );
      if (desktopIdentity === undefined) return undefined;
      return {
        generation: parsed.generation,
        computerGeneration: parsed.computerGeneration,
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

  #readIdentity(
    value: unknown,
    pid: number | undefined,
    runtimeDir: string,
  ): OwnedProcessIdentity | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const identity = value as Partial<OwnedProcessIdentity>;
    if (
      identity.pid !== pid
      || identity.runtimeDir !== runtimeDir
      || typeof identity.startTime !== "string"
      || !/^\d+$/.test(identity.startTime)
      || typeof identity.bootId !== "string"
      || (identity.unitName !== undefined && typeof identity.unitName !== "string")
    ) {
      return undefined;
    }
    return identity as OwnedProcessIdentity;
  }

  #liveSockets(runtimeDir: string): { waylandDisplay: string; swaySock: string } | undefined {
    if (!existsSync(runtimeDir)) return undefined;
    const waylandDisplay = readdirSync(runtimeDir).find((entry) =>
      /^wayland-\d+$/.test(entry) && isSocket(path.join(runtimeDir, entry))
    );
    const swaySock = readdirSync(runtimeDir)
      .filter((entry) => entry.startsWith("sway-ipc") && isSocket(path.join(runtimeDir, entry)))
      .map((entry) => path.join(runtimeDir, entry))[0];
    if (waylandDisplay === undefined || swaySock === undefined) return undefined;
    return { waylandDisplay, swaySock };
  }

  async #discoverSockets(
    runtimeDir: string,
    swayProcess: SwayProcess,
  ): Promise<{ waylandDisplay: string; swaySock: string }> {
    const stderr = new Response(swayProcess.stderr).text();
    const exited = swayProcess.exited.then(async (status) => {
      const detail = (await stderr).trim().split("\n").slice(-3).join(" ");
      throw new Error(
        `Sway exited before readiness with status ${status}${detail === "" ? "" : `: ${detail}`}`,
      );
    });
    const socketReady = (async (): Promise<{ waylandDisplay: string; swaySock: string }> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const sockets = this.#liveSockets(runtimeDir);
        if (sockets !== undefined) return sockets;
        await Bun.sleep(20);
      }
      throw new Error("Sway did not create its private Wayland and IPC sockets");
    })();
    return Promise.race([socketReady, exited]);
  }

  async #waitForSocket(
    socketPath: string,
    process: SwayProcess,
    label: string,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (isSocket(socketPath)) return;
      if (process.exitCode !== null) {
        throw new Error(`${label} exited before binding its private socket with status ${process.exitCode}`);
      }
      await Bun.sleep(20);
    }
    throw new Error(`${label} did not create its private socket`);
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
    computer: SharedComputerSession,
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
      if (!this.#computerRunning(computer)) {
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
