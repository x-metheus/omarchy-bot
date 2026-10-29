import { mkdirSync } from "node:fs";
import { listenerConfig } from "./listenerConfig.ts";
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
  /** Transient child sockets and retained Bot-owned application profiles. */
  botScreenRuntimeDir: string;
  botScreenProfileDir: string;
  /** Bot Computer bundle shipped inside the installed application runtime. */
  botScreenSwayRuntimeSupplyDir: string;
  botComputerFontSupplyDir: string;
  botComputerBrowserPackDir: string;
  conformanceDir: string;
  statusPath: string;
  /** HTTP listener address; remote listeners require TLS or a declared proxy. */
  host: string;
  port: number;
  /** Explicit opt-in for loopback browser development origins. */
  development: boolean;
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

export function loadConfig(): Config {
  const { host, tlsCert, tlsKey, trustedProxy } = listenerConfig(process.env);
  const dataDir = process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot");
  const stateDir = process.env.OMARCHY_BOT_STATE ?? path.join(os.homedir(), ".local/state/omarchy-bot");
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const screenProfile = botScreenProfile();
  const cfg: Config = {
    dataDir,
    stateDir,
    dbPath: path.join(dataDir, "db.sqlite"),
    artifactsDir: path.join(dataDir, "artifacts"),
    attachmentsDir: path.join(dataDir, "attachments"),
    avatarsDir: path.join(dataDir, "avatars"),
    sharedWorkspaceDir: sharedWorkspaceDir(),
    botScreenRuntimeDir: runtimeDir
      ? path.join(runtimeDir, "omarchy-bot", "screens")
      : path.join(stateDir, "screen-runtime"),
    botScreenProfileDir: path.join(dataDir, "screens"),
    botScreenSwayRuntimeSupplyDir: path.join(dataDir, "runtime", "current", "sway"),
    botComputerFontSupplyDir: path.join(dataDir, "runtime", "current", "fonts"),
    botComputerBrowserPackDir: path.join(dataDir, "runtime", "browser"),
    conformanceDir: path.join(dataDir, "conformance"),
    statusPath: path.join(stateDir, "status.json"),
    host,
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
    ...(trustedProxy ? { trustedProxy } : {}),
    port: Number(process.env.OMARCHY_BOT_PORT ?? 7321),
    development: process.env.OMARCHY_BOT_DEV === "1",
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
  mkdirSync(cfg.botScreenProfileDir, { recursive: true });
  mkdirSync(cfg.conformanceDir, { recursive: true });
  return cfg;
}
