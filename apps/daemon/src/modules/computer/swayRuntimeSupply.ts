import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** One self-contained Bot Computer runtime bundle published by CI. */
export interface SwayRuntimeBundle {
  release: string;
  url: string;
  sha256: string;
}

export const SWAY_RUNTIME_RELEASE = "sway-1.10.1-wayvnc-0.8.0-wlroots-0.18.1-v1";

export const SWAY_RUNTIME_BUNDLE: SwayRuntimeBundle = Object.freeze({
  release: SWAY_RUNTIME_RELEASE,
  url: `https://github.com/XMethues/omarchy-bot/releases/download/sway-runtime-fc4b7ec887c6b5ccad7f62706b4e5a186e63eaeb3e8f70636e641af241a52f94/omarchy-bot-sway-runtime-${SWAY_RUNTIME_RELEASE}-x86_64.tar.gz`,
  sha256: "fc4b7ec887c6b5ccad7f62706b4e5a186e63eaeb3e8f70636e641af241a52f94",
});

const READY_FILE = ".omarchy-bot-runtime";
const DOWNLOAD_TIMEOUT_MS = 60_000;

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

type RuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;
type ArchiveExtractor = (archivePath: string, destination: string) => Promise<void>;

export interface PortableSwayRuntimeSupplyOptions {
  rootDir: string;
  bundle?: SwayRuntimeBundle;
  fetch?: RuntimeFetch;
  extractArchive?: ArchiveExtractor;
  platform?: string;
  arch?: string;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && (statSync(candidate).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function sha256(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk);
  return hasher.digest("hex");
}

async function extractArchiveWithTar(archivePath: string, destination: string): Promise<void> {
  const tar = Bun.which("tar");
  if (tar === null) {
    throw new Error("portable Sway provisioning requires tar with gzip archive support");
  }
  const child = Bun.spawn([tar, "--extract", "--gzip", "--file", archivePath, "--directory", destination], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (status !== 0) {
    throw new Error(
      `tar could not extract ${path.basename(archivePath)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
    );
  }
}

function readyMarker(bundle: SwayRuntimeBundle): string {
  return `${bundle.release}\n${bundle.sha256}\n`;
}

/** Cache identity: a different pinned digest must not reuse an installed bundle. */
function cacheKey(bundle: SwayRuntimeBundle): string {
  return `${bundle.release}-${bundle.sha256.slice(0, 16)}`;
}

/**
 * Lazily installs the pinned Bot Computer runtime bundle into an
 * application-owned directory. Each process shares one in-flight promise;
 * competing processes publish only a fully verified and extracted directory
 * through atomic rename. `ensure()` never touches Bot Desktop Session trees.
 */
export class PortableSwayRuntimeSupply implements SwayRuntimeSupply {
  readonly #bundle: SwayRuntimeBundle;
  readonly #fetch: RuntimeFetch;
  readonly #extractArchive: ArchiveExtractor;
  readonly #platform: string;
  readonly #arch: string;
  #inFlight: Promise<SwayRuntimeBinaries> | undefined;

  constructor(private readonly options: PortableSwayRuntimeSupplyOptions) {
    this.#bundle = options.bundle ?? SWAY_RUNTIME_BUNDLE;
    this.#fetch = options.fetch ?? fetch;
    this.#extractArchive = options.extractArchive ?? extractArchiveWithTar;
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
  }

  ensure(): Promise<SwayRuntimeBinaries> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    const provision = this.#provision().finally(() => {
      if (this.#inFlight === provision) this.#inFlight = undefined;
    });
    this.#inFlight = provision;
    return provision;
  }

  async #provision(): Promise<SwayRuntimeBinaries> {
    if (this.#platform !== "linux" || this.#arch !== "x64") {
      throw new Error(
        `portable Sway provisioning requires Linux on x86_64 (found ${this.#platform} ${this.#arch})`,
      );
    }

    const bundle = this.#bundle;
    const destination = path.join(this.options.rootDir, cacheKey(bundle));
    const ready = this.#readyBinaries(destination, bundle);
    if (ready !== undefined) return ready;

    mkdirSync(this.options.rootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.options.rootDir, 0o700);
    const staging = `${destination}.stage-${process.pid}-${randomUUID()}`;
    mkdirSync(staging, { recursive: true, mode: 0o700 });

    try {
      const archivePath = path.join(staging, "bundle.tar.gz");
      await this.#downloadVerified(bundle, archivePath);
      const extracted = path.join(staging, "bundle");
      mkdirSync(extracted, { recursive: true, mode: 0o700 });
      await this.#extractArchive(archivePath, extracted);
      this.#validateBundle(extracted);
      writeFileSync(path.join(extracted, READY_FILE), readyMarker(bundle), { mode: 0o600 });

      try {
        renameSync(extracted, destination);
      } catch (error) {
        const concurrentlyPublished = this.#readyBinaries(destination, bundle);
        if (concurrentlyPublished !== undefined) return concurrentlyPublished;
        throw new Error(
          existsSync(destination)
            ? `the Sway runtime bundle cache at ${destination} is incomplete; remove that directory and retry`
            : `could not publish the app-owned Sway runtime bundle at ${destination}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const published = this.#readyBinaries(destination, bundle);
      if (published === undefined) {
        throw new Error(`app-owned Sway runtime bundle at ${destination} was not complete after publication`);
      }
      return published;
    } catch (error) {
      throw new Error(
        `unable to provision the app-owned Sway runtime bundle under ${this.options.rootDir}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async #downloadVerified(bundle: SwayRuntimeBundle, archivePath: string): Promise<void> {
    if (!bundle.url.startsWith("https://")) {
      throw new Error("Sway runtime bundle must use HTTPS");
    }
    let response: Response;
    try {
      response = await this.#fetch(bundle.url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `could not download the Sway runtime bundle from ${bundle.url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(
        `could not download the Sway runtime bundle from ${bundle.url}: HTTP ${response.status}`,
      );
    }
    await Bun.write(archivePath, response);
    const actual = await sha256(archivePath);
    if (actual !== bundle.sha256) {
      throw new Error(
        `Sway runtime bundle failed SHA-256 verification (expected ${bundle.sha256}, received ${actual})`,
      );
    }
  }

  #validateBundle(root: string): void {
    for (const entry of Object.values(BUNDLE_ENTRIES)) {
      if (!isExecutableFile(path.join(root, "bin", entry))) {
        throw new Error(`bundle archive did not contain executable bin/${entry}`);
      }
    }
  }

  #readyBinaries(destination: string, bundle: SwayRuntimeBundle): SwayRuntimeBinaries | undefined {
    try {
      if (readFileSync(path.join(destination, READY_FILE), "utf8") !== readyMarker(bundle)) {
        return undefined;
      }
      const binaries = {} as Record<keyof typeof BUNDLE_ENTRIES, string>;
      for (const [field, entry] of Object.entries(BUNDLE_ENTRIES) as [
        keyof typeof BUNDLE_ENTRIES,
        string,
      ][]) {
        const launcher = path.join(destination, "bin", entry);
        if (!isExecutableFile(launcher)) return undefined;
        binaries[field] = launcher;
      }
      return binaries;
    } catch {
      return undefined;
    }
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
 * authoritative and a complete explicit set needs no bundle download; a
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
