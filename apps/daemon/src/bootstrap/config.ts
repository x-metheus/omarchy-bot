import { existsSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { sharedWorkspaceDir } from "../modules/workspace/sharedWorkspace.ts";
export interface BotScreenCapacityPolicy {
  readonly defaultCapacity: number;
  readonly defaultProfile: "1080p" | "720p";
  readonly limits: Readonly<Record<"1080p" | "720p", number>>;
}

/** Conservative admission limits, not a measured Sway performance approval. */
export const BOT_SCREEN_CAPACITY_POLICY: BotScreenCapacityPolicy = Object.freeze({
  defaultCapacity: 4,
  defaultProfile: "1080p",
  limits: Object.freeze({ "1080p": 4, "720p": 8 }),
});

export interface Config {
  dataDir: string;
  stateDir: string;
  dbPath: string;
  artifactsDir: string;
  attachmentsDir: string;
  avatarsDir: string;
  /** Home-local Shared Workspace; distinct from product data under dataDir. */
  sharedWorkspaceDir: string;
  /** Voxtype transcript targets live here; runtime dir preferred, state dir fallback. */
  dictationDir: string;
  /** Transient child sockets and retained Bot-owned application profiles. */
  botScreenRuntimeDir: string;
  botScreenProfileDir: string;
  /** Bot Computer bundle shipped inside the installed application runtime. */
  botScreenSwayRuntimeSupplyDir: string;
  botComputerFontSupplyDir: string;
  conformanceDir: string;
  statusPath: string;
  /** Voxtype binary override (defaults to `voxtype` on PATH). */
  voxtypeBin?: string;
  /** HTTP listener address; remote listeners require TLS or a declared proxy. */
  host: string;
  port: number;
  tlsCert?: string;
  tlsKey?: string;
  /** Single proxy peer IP; IPv4 must use canonical dotted-quad notation. */
  trustedProxy?: string;
  turnTimeoutMs: number;
  /** Maximum time deletion waits for a cancelled Turn to report a terminal state. */
  botDeletionTerminalTimeoutMs: number;
  botScreenCapacity: number;
  botScreenProfile: "1080p" | "720p";
  botScreenLogicalWidth: number;
  botScreenLogicalHeight: number;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function botScreenProfile(): {
  name: "1080p" | "720p";
  logicalWidth: number;
  logicalHeight: number;
} {
  const name = process.env.OMARCHY_BOT_SCREEN_PROFILE ?? BOT_SCREEN_CAPACITY_POLICY.defaultProfile;
  if (name === "1080p") return { name, logicalWidth: 1920, logicalHeight: 1080 };
  if (name === "720p") return { name, logicalWidth: 1280, logicalHeight: 720 };
  throw new Error("OMARCHY_BOT_SCREEN_PROFILE must be 1080p or 720p");
}

function botScreenCapacity(profile: "1080p" | "720p"): number {
  const capacity = positiveInteger(
    "OMARCHY_BOT_SCREEN_CAPACITY",
    BOT_SCREEN_CAPACITY_POLICY.defaultCapacity,
  );
  const supported = BOT_SCREEN_CAPACITY_POLICY.limits[profile];
  if (capacity > supported) {
    throw new Error(
      `OMARCHY_BOT_SCREEN_CAPACITY=${capacity} exceeds the configured ${profile} capacity of ${supported}`,
    );
  }
  return capacity;
}

function isCanonicalIPv4(address: string): boolean {
  return isIP(address) === 4 && /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address);
}

export function loadConfig(): Config {
  const host = process.env.OMARCHY_BOT_HOST ?? "127.0.0.1";
  const tlsCert = process.env.OMARCHY_BOT_TLS_CERT || undefined;
  const tlsKey = process.env.OMARCHY_BOT_TLS_KEY || undefined;
  const trustedProxy = process.env.OMARCHY_BOT_TRUSTED_PROXY || undefined;
  if (trustedProxy && !isCanonicalIPv4(trustedProxy) && isIP(trustedProxy) !== 6) {
    throw new Error("OMARCHY_BOT_TRUSTED_PROXY must be one IP address (canonical IPv4 or IPv6)");
  }
  if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error("OMARCHY_BOT_TLS_CERT and OMARCHY_BOT_TLS_KEY must be set together");
  for (const file of [tlsCert, tlsKey]) {
    if (file && !existsSync(file)) throw new Error(`TLS file does not exist: ${file}`);
  }
  const loopback = host === "localhost" || host === "[::1]" || host === "::1"
    || (isCanonicalIPv4(host) && host.startsWith("127."))
    || (isIP(host) === 6 && host.startsWith("::ffff:127.") && isCanonicalIPv4(host.slice(7)));
  if (!loopback && !(tlsCert && tlsKey) && !trustedProxy) {
    throw new Error(`Bind address ${host} requires a certificate (OMARCHY_BOT_TLS_CERT and OMARCHY_BOT_TLS_KEY) or a declared trusted proxy (OMARCHY_BOT_TRUSTED_PROXY)`);
  }
  const dataDir = process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot");
  const stateDir = process.env.OMARCHY_BOT_STATE ?? path.join(os.homedir(), ".local/state/omarchy-bot");
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const voxtypeBin = process.env.OMARCHY_BOT_VOXTYPE_BIN;
  const screenProfile = botScreenProfile();
  const cfg: Config = {
    dataDir,
    stateDir,
    dbPath: path.join(dataDir, "db.sqlite"),
    artifactsDir: path.join(dataDir, "artifacts"),
    attachmentsDir: path.join(dataDir, "attachments"),
    avatarsDir: path.join(dataDir, "avatars"),
    sharedWorkspaceDir: sharedWorkspaceDir(),
    dictationDir: runtimeDir ? path.join(runtimeDir, "omarchy-bot", "dictation") : path.join(stateDir, "dictation"),
    botScreenRuntimeDir: runtimeDir
      ? path.join(runtimeDir, "omarchy-bot", "screens")
      : path.join(stateDir, "screen-runtime"),
    botScreenProfileDir: path.join(dataDir, "screens"),
    botScreenSwayRuntimeSupplyDir: path.join(dataDir, "runtime", "current", "sway"),
    botComputerFontSupplyDir: path.join(dataDir, "runtime", "current", "fonts"),
    conformanceDir: path.join(dataDir, "conformance"),
    statusPath: path.join(stateDir, "status.json"),
    ...(voxtypeBin !== undefined ? { voxtypeBin } : {}),
    host,
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
    ...(trustedProxy ? { trustedProxy } : {}),
    port: Number(process.env.OMARCHY_BOT_PORT ?? 7321),
    turnTimeoutMs: Number(process.env.OMARCHY_BOT_TURN_TIMEOUT_MS ?? 600_000),
    botDeletionTerminalTimeoutMs: Number(process.env.OMARCHY_BOT_DELETION_TERMINAL_TIMEOUT_MS ?? 30_000),
    botScreenCapacity: botScreenCapacity(screenProfile.name),
    botScreenProfile: screenProfile.name,
    botScreenLogicalWidth: screenProfile.logicalWidth,
    botScreenLogicalHeight: screenProfile.logicalHeight,
  };
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cfg.artifactsDir, { recursive: true });
  mkdirSync(cfg.attachmentsDir, { recursive: true });
  mkdirSync(cfg.avatarsDir, { recursive: true });
  mkdirSync(cfg.dictationDir, { recursive: true });
  mkdirSync(cfg.botScreenProfileDir, { recursive: true });
  mkdirSync(cfg.conformanceDir, { recursive: true });
  return cfg;
}
