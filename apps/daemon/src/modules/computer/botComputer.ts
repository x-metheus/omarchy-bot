import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { SurfaceId } from "@omarchy-bot/domain";
import {
  ApplicationUnits,
  botComputerUnitName,
} from "../../supervision/applicationUnits.ts";
import { ensureCaptureHelper } from "../../../native/capture-helper/build.ts";
import { ensureInputHelper } from "../../../native/pointer-helper/build.ts";
import { ensureBotDesktop } from "../../../native/bot-desktop/build.ts";
import {
  executable,
  explicitEnvironment,
  isSocket,
  ownedProcessIdentity,
  ownedProcessRunning,
  privateRuntimeProcesses,
  readOwnedIdentity,
  terminateDetachedProcess,
  terminateOwnedProcess,
  terminateProcess,
  waitForSocket,
  watchOwnedProcess,
  type DetachedProcess,
  type OwnedProcessIdentity,
} from "./botScreenWaylandHelpers.ts";
import {
  resolveSwayRuntimeBinaries,
  type SwayRuntimeSupply,
} from "./swayRuntimeSupply.ts";
import {
  PortableBotComputerAssets,
  type BotComputerAssetSupply,
} from "./botComputerAssets.ts";

type SwayProcess = DetachedProcess;
export type ApplicationProcess = Bun.Subprocess<"ignore", "ignore", "ignore">;

const COMPUTER_STATE_FILE = "computer.json";

export interface BotComputerOptions {
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
  /** Portable browser and font supply; defaults to the Bot Computer profile. */
  assetSupply?: BotComputerAssetSupply;
  capacity?: number;
}

/** The live shared Bot Computer every Bot Screen attaches to. */
export interface BotComputer {
  generation: number;
  runtimeComputerDir: string;
  runtimeDir: string;
  profileDir: string;
  childEnv: Record<string, string>;
  sockets: { waylandDisplay: string; swaySock: string };
  grim: string;
  inputHelper: string;
  captureHelper: string;
  botDesktop: string;
  wlrRandr: string;
  surfaceIds: Set<SurfaceId>;
  applicationProcesses: Set<ApplicationProcess>;
  applicationSequence: number;
  /** Lazily supplies the profile fonts and exports them to graphical children. */
  ensureFonts(): Promise<void>;
  running(): boolean;
  exited(): Promise<number>;
  busExited(): Promise<number>;
  stop(): Promise<void>;
}

interface LiveComputer extends BotComputer {
  swayProcess?: SwayProcess;
  dbusProcess?: SwayProcess;
  swayPid?: number;
  dbusPid?: number;
  swayIdentity?: OwnedProcessIdentity | undefined;
  dbusIdentity?: OwnedProcessIdentity | undefined;
}

interface SharedComputerState {
  generation: number;
  waylandDisplay: string;
  swaySockName: string;
  swayPid?: number;
  dbusPid?: number;
  swayIdentity?: OwnedProcessIdentity | undefined;
  dbusIdentity?: OwnedProcessIdentity | undefined;
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

/**
 * One private, headless Sway Bot Computer with a persistent application
 * profile. Bot Screens attach their output and workspace to it.
 */
export class BotComputerRuntime {
  #units: ApplicationUnits;
  #capacity: number;
  #computer: LiveComputer | undefined;
  #assets: BotComputerAssetSupply;
  #fontConfigFile: string | undefined;

  constructor(private readonly options: BotComputerOptions) {
    this.#units = new ApplicationUnits(options.hostRuntimeDir);
    this.#assets = options.assetSupply
      ?? new PortableBotComputerAssets({
        profileDir: path.join(options.profileRoot, "computer"),
      });
    this.#capacity = options.capacity ?? 8;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1) {
      throw new Error("Bot Computer output capacity must be a positive integer");
    }
    if (this.#capacity > 32) {
      throw new Error("Bot Computer output capacity cannot exceed 32");
    }
  }

  /** One capacity check, owned by the Bot Computer that allocates the outputs. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Starts or reattaches the shared computer; the one recovery owner. */
  async ensure(): Promise<BotComputer> {
    return (await this.reattach()) ?? this.#start();
  }

  /** Attaches to the live computer on disk without starting a new compositor. */
  async reattach(): Promise<BotComputer | undefined> {
    const current = this.#computer;
    if (current !== undefined) {
      if (current.running()) return current;
      await this.#stopComputer(current).catch(() => {});
    }
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
    const computer: LiveComputer = {
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
      ensureFonts: () => this.#ensureFonts(computer),
      running: () => this.#running(computer),
      exited: () => this.#exited(computer),
      busExited: () => this.#busExited(computer),
      stop: () => this.#stopComputer(computer),
    };
    this.#computer = computer;
    return computer;
  }

  async stop(): Promise<void> {
    const computer = this.#computer;
    if (computer !== undefined) await this.#stopComputer(computer);
  }

  /** Terminates and deletes whatever computer is recorded on disk. */
  async discard(): Promise<void> {
    await this.#discardComputerFromDisk();
  }

  current(): BotComputer | undefined {
    return this.#computer;
  }

  async #start(): Promise<BotComputer> {
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
      await waitForSocket(dbusPath, dbusProcess, "Bot Computer session bus");
      const computer: LiveComputer = {
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
        ensureFonts: () => this.#ensureFonts(computer),
        running: () => this.#running(computer),
        exited: () => this.#exited(computer),
        busExited: () => this.#busExited(computer),
        stop: () => this.#stopComputer(computer),
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

  async #stopComputer(computer: LiveComputer): Promise<void> {
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
      terminateProcess(computer.dbusProcess, computer.dbusIdentity),
      terminateProcess(computer.swayProcess, computer.swayIdentity),
    ]);
    await Promise.all(privateRuntimeProcesses(computer.runtimeDir).map(terminateOwnedProcess));
    rmSync(computer.runtimeComputerDir, { recursive: true, force: true });
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

  async #ensureFonts(computer: LiveComputer): Promise<void> {
    const fontConfigFile = this.#fontConfigFile
      ?? (await this.#assets.ensureFonts()).fontConfigFile;
    this.#fontConfigFile = fontConfigFile;
    computer.childEnv.FONTCONFIG_FILE = fontConfigFile;
  }

  #running(computer: LiveComputer): boolean {
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

  #exited(computer: LiveComputer): Promise<number> {
    if (computer.swayProcess !== undefined) return computer.swayProcess.exited;
    return watchOwnedProcess(computer.swayIdentity);
  }

  #busExited(computer: LiveComputer): Promise<number> {
    if (computer.dbusProcess !== undefined) return computer.dbusProcess.exited;
    return watchOwnedProcess(computer.dbusIdentity);
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

  #writeComputerState(computer: LiveComputer): void {
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
      const swayIdentity = readOwnedIdentity(parsed.swayIdentity, parsed.swayPid, runtimeDir);
      const dbusIdentity = readOwnedIdentity(parsed.dbusIdentity, parsed.dbusPid, runtimeDir);
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
}
