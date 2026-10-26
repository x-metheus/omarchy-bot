import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** One self-contained Bot Computer runtime bundle published by CI. */
export interface SwayRuntimeBundle {
  release: string;
  sha256: string;
}

export const SWAY_RUNTIME_RELEASE = "sway-1.10.1-wayvnc-0.8.0-wlroots-0.18.1-v1";

export const SWAY_RUNTIME_BUNDLE: SwayRuntimeBundle = Object.freeze({
  release: SWAY_RUNTIME_RELEASE,
  sha256: "c821bcb7d8e349c22bf3c9a96084a550d7d5a357b2d9d340c608adbdc5fb9344",
});

const READY_FILE = ".omarchy-bot-runtime";

/** Bundle launcher names, keyed by the resolved binary field they provide. */
const BUNDLE_ENTRIES = {
  swayBin: "sway",
  swaymsgBin: "swaymsg",
  wayvncBin: "wayvnc",
  wlrRandrBin: "wlr-randr",
  xwaylandBin: "Xwayland",
  grimBin: "grim",
  dbusDaemonBin: "dbus-daemon",
  inputHelperBin: "omarchy-bot-wayland-input",
  captureHelperBin: "omarchy-bot-wayland-capture",
  botDesktopBin: "omarchy-bot-desktop",
} as const;

const BUNDLE_LABELS = {
  swayBin: "Sway",
  swaymsgBin: "swaymsg",
  wayvncBin: "WayVNC",
  wlrRandrBin: "wlr-randr",
  xwaylandBin: "Xwayland",
  grimBin: "grim",
  dbusDaemonBin: "dbus-daemon",
  inputHelperBin: "Bot Screen input helper",
  captureHelperBin: "Bot Screen capture helper",
  botDesktopBin: "Bot Desktop",
} as const;

export interface SwayRuntimeBinaries {
  swayBin: string;
  swaymsgBin: string;
  wayvncBin: string;
  wlrRandrBin: string;
  xwaylandBin: string;
  grimBin: string;
  dbusDaemonBin: string;
  inputHelperBin: string;
  captureHelperBin: string;
  botDesktopBin: string;
}

export interface SwayRuntimeSupply {
  ensure(): Promise<SwayRuntimeBinaries>;
}

export interface PortableSwayRuntimeSupplyOptions {
  rootDir: string;
  bundle?: SwayRuntimeBundle;
  platform?: string;
  arch?: string;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readyMarker(bundle: SwayRuntimeBundle): string {
  return `${bundle.release}\n${bundle.sha256}\n`;
}

/** Reads the pinned bundle installed with the application runtime. */
export class PortableSwayRuntimeSupply implements SwayRuntimeSupply {
  constructor(private readonly options: PortableSwayRuntimeSupplyOptions) {}

  async ensure(): Promise<SwayRuntimeBinaries> {
    const platform = this.options.platform ?? process.platform;
    const arch = this.options.arch ?? process.arch;
    if (platform !== "linux" || arch !== "x64") {
      throw new Error(
        `portable Sway provisioning requires Linux on x86_64 (found ${platform} ${arch})`,
      );
    }

    const destination = path.resolve(this.options.rootDir);
    let isDirectory = false;
    try {
      isDirectory = statSync(destination).isDirectory();
    } catch {
      // Report the expected bundle directory rather than a missing child marker.
    }
    if (!isDirectory) throw new Error(`Sway runtime bundle directory is unavailable: ${destination}`);

    const markerPath = path.join(destination, READY_FILE);
    const expected = readyMarker(this.options.bundle ?? SWAY_RUNTIME_BUNDLE);
    const received = readFileSync(markerPath, "utf8");
    if (received !== expected) {
      throw new Error(
        `Sway runtime bundle ready marker mismatch at ${markerPath} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)})`,
      );
    }

    const binaries = {} as SwayRuntimeBinaries;
    for (const [field, entry] of Object.entries(BUNDLE_ENTRIES) as [
      keyof SwayRuntimeBinaries,
      string,
    ][]) {
      const launcher = path.join(destination, "bin", entry);
      if (!isExecutableFile(launcher)) {
        throw new Error(`Sway runtime bundle executable is unavailable: ${launcher}`);
      }
      binaries[field] = launcher;
    }
    return binaries;
  }
}

export interface ResolveSwayRuntimeOptions {
  supply: SwayRuntimeSupply;
  swayOverride?: string;
  swaymsgOverride?: string;
  wayvncOverride?: string;
  wlrRandrOverride?: string;
  xwaylandOverride?: string;
  grimOverride?: string;
  dbusDaemonOverride?: string;
  inputHelperOverride?: string;
  captureHelperOverride?: string;
  botDesktopOverride?: string;
  findExecutable?: (candidate: string) => string | undefined;
}

function findExecutable(candidate: string): string | undefined {
  if (candidate.includes("/")) return isExecutableFile(candidate) ? candidate : undefined;
  return Bun.which(candidate) ?? undefined;
}

/**
 * Resolves the Bot Computer runtime tools. Explicit overrides stay
 * authoritative and a complete explicit set needs no installed bundle; a
 * configured bundle supplies the rest and wins over any host binary.
 */
export async function resolveSwayRuntimeBinaries(
  options: ResolveSwayRuntimeOptions,
): Promise<SwayRuntimeBinaries> {
  const find = options.findExecutable ?? findExecutable;
  const overrides: Record<keyof SwayRuntimeBinaries, string | undefined> = {
    swayBin: options.swayOverride,
    swaymsgBin: options.swaymsgOverride,
    wayvncBin: options.wayvncOverride,
    wlrRandrBin: options.wlrRandrOverride,
    xwaylandBin: options.xwaylandOverride,
    grimBin: options.grimOverride,
    dbusDaemonBin: options.dbusDaemonOverride,
    inputHelperBin: options.inputHelperOverride,
    captureHelperBin: options.captureHelperOverride,
    botDesktopBin: options.botDesktopOverride,
  };
  const explicit: Partial<SwayRuntimeBinaries> = {};
  for (const field of Object.keys(BUNDLE_ENTRIES) as (keyof SwayRuntimeBinaries)[]) {
    const resolved = resolveOverride(BUNDLE_LABELS[field], overrides[field], find);
    if (resolved !== undefined) explicit[field] = resolved;
  }
  if (Object.keys(explicit).length === Object.keys(BUNDLE_ENTRIES).length) {
    return explicit as SwayRuntimeBinaries;
  }
  return { ...await options.supply.ensure(), ...explicit };
}

function resolveOverride(
  label: string,
  override: string | undefined,
  find: (candidate: string) => string | undefined,
): string | undefined {
  if (override === undefined) return undefined;
  const resolved = find(override);
  if (resolved === undefined) {
    throw new Error(`configured ${label} executable is unavailable: ${override}`);
  }
  return resolved;
}
