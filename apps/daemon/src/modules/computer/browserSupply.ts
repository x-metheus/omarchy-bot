import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  processDescendsFrom,
  processIdentity,
  processIdentityRunning,
  signalAll,
  type ProcessIdentity,
} from "../../supervision/ownedProcesses.ts";
import { BROWSER_PACK_MISSING, type BotComputerAssetSupply } from "./botComputerAssets.ts";
import { desktopExecutable } from "./desktopEntry.ts";

/**
 * Browser Supply: the one place that knows how the Bot Computer gets a browser
 * (Computer ADR 0013). Every Bot uses the browser pack's Chromium and nothing
 * else, so this module answers, for every caller:
 *
 * - how the pack is launched (argv and flags),
 * - where its private profile lives (and the one-time move from the old path),
 * - what the Bot Computer environment needs so every browser path ends at the
 *   pack (default URL handlers, `BROWSER`, and a shim directory first on PATH),
 * - which `open_app` requests name another browser and are refused,
 * - whether a process is the pack browser.
 */

/**
 * Headless pixman Sway has no GPU and no desktop session for first-run UI.
 * The CDP pipe is added only to launches the Service spawns with fds 3 and 4.
 */
const PACK_FLAGS = [
  "--ozone-platform=wayland",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--password-store=basic",
] as const;
const CDP_PIPE_FLAG = "--remote-debugging-pipe";

/** A Service-owned profile name no host browser uses by default. */
const PROFILE_NAME = "omarchy-bot-browser";
/** Chromium's own default under `XDG_CONFIG_HOME`, where the pack profile used to live. */
const LEGACY_PROFILE_NAME = "chromium";
const SHIM_DIR_NAME = "browser-shims";
const LAUNCHER_NAME = "omarchy-bot-browser";
/**
 * Orphan teardown windows, mirroring owned-session teardown: a pack gets a grace
 * window after SIGTERM before SIGKILL, then a short wait for each to land.
 */
const PACK_TERM_GRACE_MS = 2_000;
const PACK_KILL_WAIT_MS = 1_000;
const PACK_SIGNAL_POLL_MS = 50;
export const PACK_DESKTOP_ID = "omarchy-bot-browser.desktop";
const PACK_MIME_TYPES = [
  "x-scheme-handler/http",
  "x-scheme-handler/https",
  "text/html",
  "application/xhtml+xml",
] as const;

/**
 * Common host browser commands. Each gets a shim in the Screen PATH that opens
 * the pack, and `open_app` refuses each by executable basename or desktop id.
 */
const HOST_BROWSER_COMMANDS = [
  "brave", "brave-browser", "brave-browser-stable", "brave-browser-beta", "brave-browser-nightly",
  "chromium", "chromium-browser",
  "chrome", "google-chrome", "google-chrome-stable", "google-chrome-beta", "google-chrome-unstable",
  "firefox", "firefox-esr", "firefox-developer-edition", "firefox-nightly",
  "microsoft-edge", "microsoft-edge-stable", "microsoft-edge-beta", "microsoft-edge-dev",
  "vivaldi", "vivaldi-stable", "vivaldi-snapshot",
  "opera", "opera-beta", "opera-developer",
  "epiphany", "epiphany-browser",
  "librewolf", "zen", "zen-browser", "floorp", "waterfox", "falkon", "midori", "qutebrowser",
  "x-www-browser", "www-browser", "gnome-www-browser", "sensible-browser",
] as const;
/** Desktop ids that are not a command name (Flatpak and reverse-DNS ids). */
const HOST_BROWSER_DESKTOP_IDS = [
  "com.brave.browser", "org.chromium.chromium", "com.google.chrome", "org.mozilla.firefox",
  "com.microsoft.edge", "com.vivaldi.vivaldi", "com.opera.opera", "org.gnome.epiphany",
  "io.gitlab.librewolf-community", "app.zen_browser.zen", "one.ablaze.floorp", "org.qutebrowser.qutebrowser",
] as const;
/** Versioned or channel variants such as `google-chrome-canary` or `firefox-wayland`. */
const HOST_BROWSER_FAMILY = /^(brave|chromium|google-chrome|firefox|microsoft-edge|vivaldi|opera|epiphany|librewolf|zen)(-[a-z0-9-]+)?$/;

function isHostBrowserName(candidate: string): boolean {
  const name = path.basename(candidate).toLowerCase().replace(/\.desktop$/, "");
  return (HOST_BROWSER_COMMANDS as readonly string[]).includes(name)
    || (HOST_BROWSER_DESKTOP_IDS as readonly string[]).includes(name)
    || HOST_BROWSER_FAMILY.test(name);
}

/** Single-quoted for `/bin/sh`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeExecutable(file: string, body: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === body) return;
  writeFileSync(file, body, { mode: 0o700 });
  chmodSync(file, 0o700);
}

/** The binary a live process image runs, as the kernel names it. */
function processExecutable(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "");
  } catch {
    return undefined;
  }
}

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    return ppid !== undefined && /^\d+$/.test(ppid) ? Number(ppid) : undefined;
  } catch {
    return undefined;
  }
}

/** The argv a live process was started with; empty when it is already gone. */
function processArguments(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}

/** Sets this Service's defaults in `[Default Applications]`, keeping every other line. */
function withPackDefaults(source: string): string {
  const lines = source === "" ? [] : source.replace(/\n$/, "").split("\n");
  const defaults = PACK_MIME_TYPES.map((type) => `${type}=${PACK_DESKTOP_ID}`);
  const owned = new Set<string>(PACK_MIME_TYPES);
  const result: string[] = [];
  let group = "";
  let wrote = false;
  for (const line of lines) {
    const header = /^\s*\[(.*)\]\s*$/.exec(line);
    if (header !== null) {
      if (group === "Default Applications" && !wrote) {
        result.push(...defaults);
        wrote = true;
      }
      group = header[1]!;
      result.push(line);
      continue;
    }
    const key = /^\s*([^=#]+?)\s*=/.exec(line)?.[1];
    if (group === "Default Applications" && key !== undefined && owned.has(key)) continue;
    result.push(line);
  }
  if (group === "Default Applications" && !wrote) {
    result.push(...defaults);
    wrote = true;
  }
  if (!wrote) {
    if (result.length > 0 && result.at(-1) !== "") result.push("");
    result.push("[Default Applications]", ...defaults);
  }
  return `${result.join("\n")}\n`;
}

/** The daemon's one-line notice for the removed host-browser setting. */
export function ignoredBrowserSelectionNotice(environment: Record<string, string | undefined>): string | undefined {
  return environment.OMARCHY_BOT_BROWSER
    ? "OMARCHY_BOT_BROWSER is ignored: every Bot uses the bundled browser pack (Computer ADR 0013)."
    : undefined;
}

export interface BrowserSupplyOptions {
  assets: BotComputerAssetSupply;
  /** The Bot Computer profile (`<profileRoot>/computer`) that holds `config/` and `data/`. */
  profileDir: string;
}

export class BrowserSupply {
  readonly #assets: BotComputerAssetSupply;
  readonly #profileDir: string;
  /** Resolved real path of the pack's browser binary, once the pack is known. */
  #packExecutable: string | undefined;
  /** Pack launches this Service spawned: a pack process by construction. */
  #launches = new Map<number, ProcessIdentity | undefined>();

  constructor(options: BrowserSupplyOptions) {
    this.#assets = options.assets;
    this.#profileDir = options.profileDir;
  }

  /** Service-owned directory placed first on the Screen and Sway PATH. */
  get shimDir(): string {
    return path.join(this.#profileDir, SHIM_DIR_NAME);
  }

  /** The command every shim, the pack desktop entry and `BROWSER` run. */
  get launcher(): string {
    return path.join(this.shimDir, LAUNCHER_NAME);
  }

  /** The pack's private profile. */
  get profilePath(): string {
    return path.join(this.#profileDir, "config", PROFILE_NAME);
  }

  get #legacyProfilePath(): string {
    return path.join(this.#profileDir, "config", LEGACY_PROFILE_NAME);
  }

  /** Puts the shim directory first on PATH and points `BROWSER` at the pack. */
  environment(environment: Record<string, string>): Record<string, string> {
    const rest = (environment.PATH ?? "").split(":").filter((entry) => entry !== "" && entry !== this.shimDir);
    return {
      ...environment,
      PATH: [this.shimDir, ...rest].join(":"),
      BROWSER: this.launcher,
    };
  }

  /**
   * Writes the Bot Computer's browser plumbing: the shim directory, the pack
   * desktop entry and the private default handlers. Safe to repeat; a missing
   * pack still installs shims that report it instead of reaching a host browser.
   */
  async prepare(): Promise<void> {
    let browserBin: string | undefined;
    try {
      browserBin = await this.#resolvePack();
    } catch {
      browserBin = undefined;
    }
    this.#writePlumbing(browserBin, this.#userDataDir());
  }

  /** Fails with the actionable missing-pack message; there is no fallback browser. */
  async ensurePack(): Promise<void> {
    await this.#resolvePack();
  }

  /** The argv that opens `url` in a new routable pack window with the Service CDP pipe. */
  async launchCommand(url: string): Promise<string[]> {
    const browserBin = await this.#resolvePack();
    const userDataDir = this.#userDataDir();
    this.#writePlumbing(browserBin, userDataDir);
    return [browserBin, `--user-data-dir=${userDataDir}`, ...PACK_FLAGS, CDP_PIPE_FLAG, "--new-window", url];
  }

  /**
   * Refuses an `open_app` request that names another browser, by the requested
   * name (executable basename or desktop id) or by the command its desktop
   * entry runs.
   */
  refuseHostBrowser(application: string, argv?: readonly string[]): void {
    const executable = argv === undefined ? undefined : desktopExecutable(argv);
    const flatpak = argv !== undefined && executable !== undefined && path.basename(executable) === "flatpak"
      ? argv.slice(argv.indexOf(executable) + 1).filter((argument) => !argument.startsWith("-") && argument !== "run").at(0)
      : undefined;
    if (
      isHostBrowserName(application)
      || (executable !== undefined && isHostBrowserName(executable))
      || (flatpak !== undefined && isHostBrowserName(flatpak))
    ) {
      throw new Error(
        `open_app cannot start ${application}: Bots use only the bundled browser. `
        + "Use open_url to open a page in it, or the browser tool to operate it.",
      );
    }
  }

  /** Records a pack launch the Service spawned. */
  trackLaunch(pid: number, identity: ProcessIdentity | undefined): void {
    this.#launches.set(pid, identity);
  }

  forgetLaunch(pid: number): void {
    this.#launches.delete(pid);
  }

  /** A stopped Bot Computer takes its pack processes with it. */
  forgetLaunches(): void {
    this.#launches.clear();
  }

  /**
   * The one identity check: `pid` is the pack browser when its executable is
   * the resolved pack binary, or it descends from such a process or from a
   * pack launch the Service spawned. App ids and executable names never decide.
   */
  isPackBrowser(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    let current = pid;
    for (let depth = 0; depth < 64; depth += 1) {
      const launch = this.#launches.get(current);
      if (this.#launches.has(current) && launch !== undefined && processIdentityRunning(launch)) return true;
      if (this.#packExecutable !== undefined && processExecutable(current) === this.#packExecutable) return true;
      if (current <= 1) return false;
      const parent = parentPid(current);
      if (parent === undefined || parent === current) return false;
      current = parent;
    }
    return false;
  }

  /**
   * Pack processes of this Bot Computer whose CDP pipe this Service does not
   * hold: every pack process outside the pid tree of a tracked launch. They are
   * orphans because only a launch the Service spawned can be driven over the
   * pipe, and a pack without one still owns the profile singleton after a
   * Service restart. `isPackBrowser` is global, so a candidate is scoped by this
   * Bot Computer's own `--user-data-dir` as well: another data dir, checkout or
   * Service instance's pack is never this Service's to stop.
   */
  orphanPacks(): ProcessIdentity[] {
    if (this.#packExecutable === undefined) return [];
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return [];
    }
    const orphans: ProcessIdentity[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!this.#isOwnPackProcess(pid)) continue;
      if (this.#heldPipeCovers(pid)) continue;
      const identity = processIdentity(pid);
      if (identity !== undefined) orphans.push(identity);
    }
    return orphans;
  }

  /**
   * Stops every orphan pack with targeted teardown: SIGTERM, a grace window,
   * then SIGKILL, re-verifying each identity and rescanning between rounds so a
   * descendant forked during teardown cannot escape. Only pack processes of
   * this Bot Computer are signalled. A piped launch runs this first, so a
   * pipe-less pack holding the profile singleton is replaced cleanly; its tabs
   * and URLs are lost and its sign-ins persist in the profile.
   */
  async stopOrphanPacks(graceMs = PACK_TERM_GRACE_MS): Promise<number[]> {
    const stopped = new Set<number>();
    const termUntil = Date.now() + graceMs;
    let orphans = this.orphanPacks();
    while (orphans.length > 0 && Date.now() < termUntil) {
      for (const orphan of orphans) stopped.add(orphan.pid);
      signalAll(orphans, "SIGTERM");
      await Bun.sleep(PACK_SIGNAL_POLL_MS);
      orphans = this.orphanPacks();
    }
    const killUntil = Date.now() + PACK_KILL_WAIT_MS;
    while (orphans.length > 0 && Date.now() < killUntil) {
      for (const orphan of orphans) stopped.add(orphan.pid);
      signalAll(orphans, "SIGKILL");
      await Bun.sleep(PACK_SIGNAL_POLL_MS);
      orphans = this.orphanPacks();
    }
    if (orphans.length > 0) {
      throw new Error(
        `browser pack processes survived SIGKILL: ${orphans.map((orphan) => orphan.pid).join(", ")}`,
      );
    }
    return [...stopped];
  }

  /**
   * True when `pid` belongs to the pid tree of a launch whose CDP pipe this
   * Service holds, which is never an orphan. A tracked launch without a
   * captured identity is still ours by pid, so it is skipped rather than killed.
   */
  #heldPipeCovers(pid: number): boolean {
    for (const [launchPid, identity] of this.#launches) {
      if (processDescendsFrom(pid, launchPid, identity)) return true;
    }
    return false;
  }

  /**
   * True when `pid` or a pack ancestor runs with one of this Bot Computer's own
   * `--user-data-dir` values. A process whose profile arguments cannot be read
   * fails closed: it is left alone, never guessed to be ours.
   */
  #isOwnPackProcess(pid: number): boolean {
    let current = pid;
    for (let depth = 0; depth < 64; depth += 1) {
      if (this.#usesOwnProfile(current) && this.isPackBrowser(current)) return true;
      if (current <= 1) return false;
      const parent = parentPid(current);
      if (parent === undefined || parent === current) return false;
      current = parent;
    }
    return false;
  }

  /** One of this Bot Computer's profile paths, current or the pre-move legacy path. */
  #usesOwnProfile(pid: number): boolean {
    const argument = (directory: string): string => `--user-data-dir=${directory}`;
    const own = [this.profilePath, this.#legacyProfilePath].map(argument);
    return processArguments(pid).some((value) => own.includes(value));
  }

  async #resolvePack(): Promise<string> {
    // The asset supply reports a missing pack with BROWSER_PACK_MISSING.
    const supplied = await this.#assets.ensureBrowser();
    if (supplied.executable !== undefined) {
      try {
        this.#packExecutable = realpathSync(supplied.executable);
      } catch {
        this.#packExecutable = undefined;
      }
    }
    return supplied.browserBin;
  }

  /**
   * The profile directory to use now. An existing legacy profile is moved once,
   * only while no pack browser holds it and never over an existing profile.
   */
  #userDataDir(): string {
    const target = this.profilePath;
    const legacy = this.#legacyProfilePath;
    if (!existsSync(target) && existsSync(legacy)) {
      if (this.#profileInUse(legacy)) return legacy;
      renameSync(legacy, target);
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
  }

  /** A live process started with this exact `--user-data-dir`. */
  #profileInUse(userDataDir: string): boolean {
    const argument = `--user-data-dir=${userDataDir}`;
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").includes(argument)) return true;
      } catch {
        // The process exited while scanning.
      }
    }
    return false;
  }

  #writePlumbing(browserBin: string | undefined, userDataDir: string): void {
    const shimDir = this.shimDir;
    mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    chmodSync(shimDir, 0o700);
    // Host browser flags (profiles, app modes) never reach the pack; URLs do.
    writeExecutable(this.launcher, browserBin === undefined
      ? [
        "#!/bin/sh",
        `printf '%s\\n' ${shellQuote(BROWSER_PACK_MISSING)} >&2`,
        "exit 127",
        "",
      ].join("\n")
      : [
        "#!/bin/sh",
        "# Written by omarchy-bot: every browser in the Bot Computer is the browser pack.",
        "for argument do",
        "  shift",
        "  case \"$argument\" in",
        "    -*) ;;",
        "    *) set -- \"$@\" \"$argument\" ;;",
        "  esac",
        "done",
        `exec ${[browserBin, `--user-data-dir=${userDataDir}`, ...PACK_FLAGS, "--new-window"].map(shellQuote).join(" ")} "$@"`,
        "",
      ].join("\n"));
    const stub = `#!/bin/sh\nexec ${shellQuote(this.launcher)} "$@"\n`;
    for (const name of HOST_BROWSER_COMMANDS) writeExecutable(path.join(shimDir, name), stub);

    const applications = path.join(this.#profileDir, "data", "applications");
    mkdirSync(applications, { recursive: true, mode: 0o700 });
    const exec = /[\s"'\\$`]/.test(this.launcher)
      ? `"${this.launcher.replace(/(["`$\\])/g, "\\$1")}"`
      : this.launcher;
    const entry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Bot Browser",
      `Exec=${exec} %U`,
      `MimeType=${PACK_MIME_TYPES.join(";")};`,
      "Terminal=false",
      "",
    ].join("\n");
    const entryPath = path.join(applications, PACK_DESKTOP_ID);
    if (!existsSync(entryPath) || readFileSync(entryPath, "utf8") !== entry) {
      writeFileSync(entryPath, entry, { mode: 0o600 });
    }

    // The user-level list wins over every host default, and a desktop-specific
    // list in the same directory wins over it, so both carry the pack defaults.
    const configHome = path.join(this.#profileDir, "config");
    mkdirSync(configHome, { recursive: true, mode: 0o700 });
    for (const name of ["mimeapps.list", "sway-mimeapps.list"]) {
      const list = path.join(configHome, name);
      const exists = existsSync(list);
      if (!exists && name !== "mimeapps.list") continue;
      const before = exists ? readFileSync(list, "utf8") : "";
      const after = withPackDefaults(before);
      if (after !== before) writeFileSync(list, after, { mode: 0o600 });
    }
  }
}
