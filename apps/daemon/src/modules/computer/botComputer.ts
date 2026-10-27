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
  spawnDetachedChild,
  terminateOwnedChild,
  waitForSocket,
  type DetachedProcess,
  type OwnedChild,
} from "./botScreenWaylandHelpers.ts";
import {
  ownedProcessIdentity,
  ownedProcessRunning,
  readOwnedIdentity,
  terminateOwnedProcess,
  terminateRuntimeProcesses,
  watchOwnedProcess,
  type OwnedProcessIdentity,
} from "../../supervision/ownedProcesses.ts";
import {
  resolveSwayRuntimeBinaries,
  type ResolveSwayRuntimeOptions,
  type SwayRuntimeBinaries,
  type SwayRuntimeSupply,
} from "./swayRuntimeSupply.ts";
import {
  PortableBotComputerAssets,
  type BotComputerAssetSupply,
} from "./botComputerAssets.ts";
import { listApplicationToplevels, SwayIpcClient } from "./swayIpc.ts";
import type { BrowserRuntime } from "./browserRuntime.ts";

type SwayProcess = DetachedProcess;
export type ApplicationProcess = OwnedChild;

const COMPUTER_STATE_FILE = "computer.json";

export interface BotComputerOptions {
  runtimeRoot: string;
  profileRoot: string;
  fontDir?: string;
  browserPackDir?: string;
  hostRuntimeDir?: string;
  swayBin?: string;
  swaymsgBin?: string;
  wlrRandrBin?: string;
  xwaylandBin?: string;
  grimBin?: string;
  inputHelperBin?: string;
  captureHelperBin?: string;
  botDesktopBin?: string;
  wayvncBin?: string;
  dbusDaemonBin?: string;
  runtimeSupply?: SwayRuntimeSupply;
  /** Portable browser and font supply; fontDir supplies installed runtime fonts. */
  assetSupply?: BotComputerAssetSupply;
  capacity?: number;
}

/**
 * Maps configured Bot Computer binaries onto resolver overrides, so the
 * compositor and the Screen adapter resolve tools identically.
 */
export function swayRuntimeOverrides(
  options: BotComputerOptions,
): Omit<ResolveSwayRuntimeOptions, "supply"> {
  return {
    ...(options.swayBin === undefined ? {} : { swayOverride: options.swayBin }),
    ...(options.swaymsgBin === undefined ? {} : { swaymsgOverride: options.swaymsgBin }),
    ...(options.wayvncBin === undefined ? {} : { wayvncOverride: options.wayvncBin }),
    ...(options.wlrRandrBin === undefined ? {} : { wlrRandrOverride: options.wlrRandrBin }),
    ...(options.xwaylandBin === undefined ? {} : { xwaylandOverride: options.xwaylandBin }),
    ...(options.grimBin === undefined ? {} : { grimOverride: options.grimBin }),
    ...(options.dbusDaemonBin === undefined ? {} : { dbusDaemonOverride: options.dbusDaemonBin }),
    ...(options.inputHelperBin === undefined ? {} : { inputHelperOverride: options.inputHelperBin }),
    ...(options.captureHelperBin === undefined ? {} : { captureHelperOverride: options.captureHelperBin }),
    ...(options.botDesktopBin === undefined ? {} : { botDesktopOverride: options.botDesktopBin }),
  };
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
  browser?: BrowserRuntime;
  /** Lazily verifies the runtime fonts and exports fontconfig to graphical children. */
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
  swayChild?: OwnedChild;
  dbusChild?: OwnedChild;
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

const DISPLAY_FILE = "x11-display";

function writeSwayConfig(configHome: string): string {
  const swayDir = path.join(configHome, "sway");
  mkdirSync(swayDir, { recursive: true, mode: 0o700 });
  chmodSync(swayDir, 0o700);
  const configPath = path.join(swayDir, "config");
  writeFileSync(
    configPath,
    [
      "xwayland enable",
      // Each Screen workspace is tabbed: the focused window fills the Screen and the
      // others stay visible as titled tabs (Computer ADR 0011).
      "workspace_layout tabbed",
      // Tab headers stay; edge borders do not, or a capture shows a frame the
      // window did not draw.
      "default_border pixel 0",
      "default_floating_border normal 0",
      "hide_edge_borders both",
      // Inactive tabs are what makes a multi-window Screen readable; sway's default
      // unfocused title text is too dim to read in a capture.
      "client.unfocused #333333 #222222 #ffffff #292d2e #222222",
      // A client asking to raise its window should land on that window.
      "focus_on_window_activation focus",
      // The Bot Desktop placeholder is a full-screen toplevel; tiled inside the
      // tabbed container it collapses that container to 0x0 until the first focus.
      "for_window [app_id=\"dev.omarchy.BotDesktop\"] floating enable",
      // X11 dialogs and pop-ups float themselves only when the client asks first.
      // These rules cover the ones that do not, and center them. window_type and
      // window_role match X11 windows only.
      ...[
        "dialog", "utility", "toolbar", "splash", "menu",
        "dropdown_menu", "popup_menu", "notification",
      ].map((type) =>
        `for_window [window_type=\"${type}\"] floating enable, border normal 0, move position center`,
      ),
      ...["pop-up", "bubble", "Popup"].map((role) =>
        `for_window [window_role=\"${role}\"] floating enable, border normal 0, move position center`,
      ),
      // Portal pickers set their parent after mapping, so sway has already tiled
      // them; matching the portal app id floats and centers them on map.
      ...["xdg-desktop-portal-gtk", "xdg-desktop-portal-gnome", "xdg-desktop-portal-kde"].map((appId) =>
        `for_window [app_id=\"${appId}\"] floating enable, border normal 0, move position center`,
      ),
      // Sway sets DISPLAY once Xwayland reserves a display; deferred exec runs
      // after that, so record it for application launches and reattaches.
      `exec printf '%s' "$DISPLAY" > "$OMARCHY_BOT_DISPLAY_FILE"`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return configPath;
}

/**
 * A private session bus config: the standard session policy and limits, but no
 * service dirs, so the bus can never activate host session services.
 */
function writeSessionBusConfig(runtimeDir: string): string {
  const configPath = path.join(runtimeDir, "session-bus.conf");
  writeFileSync(
    configPath,
    [
      '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
      ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
      "<busconfig>",
      "  <type>session</type>",
      "  <keep_umask/>",
      // dbus-daemon rejects a config without a listen element; --address overrides it.
      `  <listen>unix:path=${path.join(runtimeDir, "bus")}</listen>`,
      "  <auth>EXTERNAL</auth>",
      '  <policy context="default">',
      '    <allow send_destination="*" eavesdrop="true"/>',
      '    <allow eavesdrop="true"/>',
      '    <allow own="*"/>',
      "  </policy>",
      '  <limit name="max_incoming_bytes">1000000000</limit>',
      '  <limit name="max_incoming_unix_fds">250000000</limit>',
      '  <limit name="max_outgoing_bytes">1000000000</limit>',
      '  <limit name="max_outgoing_unix_fds">250000000</limit>',
      '  <limit name="max_message_size">1000000000</limit>',
      '  <limit name="service_start_timeout">120000</limit>',
      '  <limit name="auth_timeout">240000</limit>',
      '  <limit name="pending_fd_timeout">150000</limit>',
      '  <limit name="max_completed_connections">100000</limit>',
      '  <limit name="max_incomplete_connections">10000</limit>',
      '  <limit name="max_connections_per_user">100000</limit>',
      '  <limit name="max_pending_service_starts">10000</limit>',
      '  <limit name="max_names_per_connection">50000</limit>',
      '  <limit name="max_match_rules_per_connection">50000</limit>',
      '  <limit name="max_replies_per_connection">50000</limit>',
      "</busconfig>",
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
  x11Display?: string;
}): Record<string, string> {
  return {
    ...explicitEnvironment(input),
    SWAYSOCK: input.swaySock,
    DBUS_SESSION_BUS_ADDRESS: input.dbusAddress,
    XDG_CURRENT_DESKTOP: "sway",
    ...(input.x11Display === undefined || input.x11Display === ""
      ? {}
      : { DISPLAY: input.x11Display }),
    // Keep AT-SPI and GTK accessibility from starting host session services.
    NO_AT_BRIDGE: "1",
    GTK_A11Y: "none",
  };
}

/** Prefers the bundle launchers and bundled XKB data for the given child. */
function bundleEnvironment(
  env: Record<string, string>,
  bundleRoot: string | undefined,
): Record<string, string> {
  if (bundleRoot === undefined) return env;
  const xkbRoot = path.join(bundleRoot, "share", "X11", "xkb");
  return {
    ...env,
    PATH: `${path.join(bundleRoot, "bin")}:${env.PATH}`,
    ...(existsSync(xkbRoot) ? { XKB_CONFIG_ROOT: xkbRoot } : {}),
  };
}

const X11_DISPLAY_PATTERN = /^:[0-9]+(?:\.[0-9]+)?$/;

/** The private display Sway recorded, only once it is a complete display name. */
function recordedX11Display(runtimeDir: string): string | undefined {
  try {
    const display = readFileSync(path.join(runtimeDir, DISPLAY_FILE), "utf8").trim();
    return X11_DISPLAY_PATTERN.test(display) ? display : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Waits for the display a bundle-supplied Xwayland must record. Sway sets
 * DISPLAY before its deferred exec runs, so an empty or partial file is not yet
 * a usable display and must not be accepted.
 */
async function awaitX11Display(
  runtimeDir: string,
  exited: Promise<number>,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  const gone = exited.then(() => true);
  while (Date.now() < deadline) {
    const display = recordedX11Display(runtimeDir);
    if (display !== undefined) return display;
    if (await Promise.race([gone, Bun.sleep(20).then(() => false)])) break;
  }
  const display = recordedX11Display(runtimeDir);
  if (display !== undefined) return display;
  throw new Error("Bot Computer Xwayland did not record a private DISPLAY");
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
        ...(options.fontDir === undefined ? {} : { fontDir: options.fontDir }),
        ...(options.browserPackDir === undefined ? {} : { browserPackDir: options.browserPackDir }),
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
    const x11Display = recordedX11Display(runtimeDir);
    if (tools.bundleRoot !== undefined && x11Display === undefined) {
      // A bundle computer must keep its private DISPLAY across reattach.
      await this.#discardComputerFromDisk();
      return undefined;
    }
    const childEnv = bundleEnvironment(
      sessionEnvironment({
        runtimeDir,
        waylandDisplay: sockets.waylandDisplay,
        homeDir,
        configHome,
        dataHome,
        stateHome,
        cacheHome,
        swaySock: sockets.swaySock,
        dbusAddress: `unix:path=${dbusPath}`,
        ...(x11Display === undefined ? {} : { x11Display }),
      }),
      tools.bundleRoot,
    );
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
    if (this.options.fontDir !== undefined) {
      this.#fontConfigFile ??= (await this.#assets.ensureFonts()).fontConfigFile;
    }
    const bootstrapEnv = bundleEnvironment({
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
      ...(this.#fontConfigFile === undefined ? {} : { FONTCONFIG_FILE: this.#fontConfigFile }),
      WLR_BACKENDS: "headless",
      WLR_HEADLESS_OUTPUTS: String(this.#capacity),
      WLR_LIBINPUT_NO_DEVICES: "1",
      WLR_RENDERER_ALLOW_SOFTWARE: "1",
      WLR_RENDERER: "pixman",
      OMARCHY_BOT_DISPLAY_FILE: path.join(runtimeDir, DISPLAY_FILE),
      ...(tools.xwayland === undefined ? {} : { WLR_XWAYLAND: tools.xwayland }),
    }, tools.bundleRoot);
    await this.#units.stopComputer();
    const swayChild = spawnDetachedChild({
      argv: [
        ...this.#units.computerCommand(generation, "compositor", bootstrapEnv),
        tools.sway,
        "-c",
        configPath,
      ],
      env: this.#units.launcherEnvironment(bootstrapEnv),
      output: "pipe",
      owned: !this.#units.enabled,
    });
    const swayProcess = swayChild.process;
    let dbusChild: OwnedChild | undefined;
    try {
      const sockets = await this.#discoverSockets(runtimeDir, swayProcess);
      const dbusPath = path.join(runtimeDir, "bus");
      // Only a bundle-supplied Sway starts the bundled Xwayland and its
      // deferred exec; explicit development overrides may not.
      const x11Display = tools.bundleRoot === undefined
        ? recordedX11Display(runtimeDir)
        : await awaitX11Display(runtimeDir, swayProcess.exited);
      const sessionBusConfig = writeSessionBusConfig(runtimeDir);
      const childEnv = bundleEnvironment(
        sessionEnvironment({
          runtimeDir,
          waylandDisplay: sockets.waylandDisplay,
          homeDir,
          configHome,
          dataHome,
          stateHome,
          cacheHome,
          swaySock: sockets.swaySock,
          dbusAddress: `unix:path=${dbusPath}`,
          ...(x11Display === undefined ? {} : { x11Display }),
        }),
        tools.bundleRoot,
      );
      dbusChild = spawnDetachedChild({
        argv: [
          ...this.#units.computerCommand(generation, "session-bus", childEnv),
          tools.dbusDaemon,
          `--config-file=${sessionBusConfig}`,
          "--nofork",
          "--nopidfile",
          `--address=unix:path=${dbusPath}`,
        ],
        env: this.#units.launcherEnvironment(childEnv),
        output: "pipe",
        owned: !this.#units.enabled,
      });
      const dbusProcess = dbusChild.process;
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
        swayChild,
        dbusChild,
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
      if (dbusChild !== undefined) await terminateOwnedChild(dbusChild).catch(() => {});
      await terminateOwnedChild(swayChild).catch(() => {});
      await this.#units.stopComputer(generation).catch(() => {});
      await terminateRuntimeProcesses(runtimeDir).catch(() => {});
      rmSync(runtimeComputerDir, { recursive: true, force: true });
      throw error;
    }
  }

  async #stopComputer(computer: LiveComputer): Promise<void> {
    if (this.#computer !== computer) return;
    this.#computer = undefined;
    computer.browser?.close();
    // Closing windows lets applications save profile data before their child processes are stopped.
    const ipc = new SwayIpcClient(computer.sockets.swaySock);
    const windows = await ipc.getTree().then(listApplicationToplevels).catch(() => []);
    await Promise.allSettled(windows.map((window) => ipc.runCommand(`[con_id=${window.id}] kill`)));
    await Promise.race([
      Promise.allSettled([...computer.applicationProcesses].map((application) => application.process.exited)),
      Bun.sleep(3_000),
    ]);
    await this.#units.stopComputer(computer.generation).catch(() => {});
    await Promise.allSettled(
      [...computer.applicationProcesses].map((application) =>
        this.#stopApplicationProcess(application)
      ),
    );
    computer.applicationProcesses.clear();
    await Promise.allSettled([
      this.#stopOwned(computer.dbusChild, computer.dbusProcess, computer.dbusIdentity),
      this.#stopOwned(computer.swayChild, computer.swayProcess, computer.swayIdentity),
    ]);
    await terminateRuntimeProcesses(computer.runtimeDir);
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
      await Promise.all(generations.map((generation) =>
        terminateRuntimeProcesses(path.join(runtimeComputerDir, generation))
      ));
    }
    rmSync(runtimeComputerDir, { recursive: true, force: true });
  }

  /** Stops a live child, or a reattached one proven only by its recorded identity. */
  async #stopOwned(
    child: OwnedChild | undefined,
    process: SwayProcess | undefined,
    identity: OwnedProcessIdentity | undefined,
  ): Promise<void> {
    if (child !== undefined) {
      await terminateOwnedChild(child);
      return;
    }
    if (process === undefined) {
      await terminateOwnedProcess(identity);
      return;
    }
    await terminateOwnedChild({ process });
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
    await terminateOwnedChild(application);
  }

  async #resolveTools(): Promise<{
    sway: string;
    wlrRandr: string;
    grim: string;
    inputHelper: string;
    captureHelper: string;
    botDesktop: string;
    dbusDaemon: string;
    /** Set only when the runtime bundle supplies the tools. */
    xwayland?: string;
    bundleRoot?: string;
  }> {
    if (this.options.runtimeSupply !== undefined) {
      const binaries = await resolveSwayRuntimeBinaries({
        supply: this.options.runtimeSupply,
        ...swayRuntimeOverrides(this.options),
      });
      // The bundle root is only meaningful when the bundle actually supplied a
      // tool; a fully explicit development set has none.
      const bundled = (Object.keys(binaries) as (keyof SwayRuntimeBinaries)[])
        .find((field) => this.options[field as keyof BotComputerOptions] === undefined);
      return {
        sway: binaries.swayBin,
        wlrRandr: binaries.wlrRandrBin,
        grim: binaries.grimBin,
        inputHelper: binaries.inputHelperBin,
        captureHelper: binaries.captureHelperBin,
        botDesktop: binaries.botDesktopBin,
        dbusDaemon: binaries.dbusDaemonBin,
        xwayland: binaries.xwaylandBin,
        ...(bundled === undefined
          ? {}
          : { bundleRoot: path.dirname(path.dirname(binaries[bundled])) }),
      };
    }

    const sway = executable(this.options.swayBin, "sway");
    const wlrRandr = executable(this.options.wlrRandrBin, "wlr-randr");
    const grim = executable(this.options.grimBin, "grim");
    const dbusDaemon = executable(this.options.dbusDaemonBin, "dbus-daemon");
    const xwayland = this.options.xwaylandBin === undefined
      ? undefined
      : executable(this.options.xwaylandBin, this.options.xwaylandBin);
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
    if (this.options.xwaylandBin !== undefined && xwayland === undefined) {
      throw new Error(`configured Xwayland executable is unavailable: ${this.options.xwaylandBin}`);
    }
    if (inputHelper === undefined || captureHelper === undefined || botDesktop === undefined) {
      throw new Error("Bot Desktop and the Bot Screen capture/input helpers are required for Sway");
    }
    return {
      sway,
      wlrRandr,
      grim,
      inputHelper,
      captureHelper,
      botDesktop,
      dbusDaemon,
      ...(xwayland === undefined ? {} : { xwayland }),
    };
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
