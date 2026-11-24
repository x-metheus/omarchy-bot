import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PlatformPaths {
  homeDir: string;
  dataDir: string;
  stateDir: string;
  sharedWorkspaceDir: string;
  downloadsDir: string | undefined;
}

function userHome(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  // Bun's os.homedir() can keep the process-start HOME. The workspace uses the live value.
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || home;
}

/** Home-local Shared Workspace used when a Thread has no explicit cwd. */
export function sharedWorkspaceDir(
  home = userHome(process.platform, process.env, os.homedir()),
  platform = process.platform,
): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.join(home, ".omarchy-bot", "workspace");
}

export function isHomeDirectory(candidate: string, home: string): boolean {
  if (path.resolve(candidate) === path.resolve(home)) return true;
  try {
    const resolved = realpathSync(candidate);
    const resolvedHome = realpathSync(home);
    if (resolved === resolvedHome) return true;
    const candidateStat = statSync(resolved, { bigint: true });
    const homeStat = statSync(resolvedHome, { bigint: true });
    return candidateStat.dev === homeStat.dev && candidateStat.ino === homeStat.ino;
  } catch { return false; }
}

function linuxDownloadsDir(home: string, configHome: string | undefined): string | undefined {
  const config = configHome && path.posix.isAbsolute(configHome) ? configHome : path.posix.join(home, ".config");
  let downloads = path.posix.join(home, "Downloads");
  try {
    const userDirs = readFileSync(path.posix.join(config, "user-dirs.dirs"), "utf8");
    const value = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/m.exec(userDirs)?.[1];
    if (value !== undefined) {
      // Expand only the user's home and the escapes used in user-dirs.dirs, without evaluating shell syntax.
      const expanded = value.replace(/^\$(?:HOME\b|\{HOME\})(?=\/|$)/, () => home).replace(/\\([\\"$`])/g, "$1");
      if (path.posix.isAbsolute(expanded) && !expanded.includes("\0")) downloads = expanded;
    }
  } catch {
    // A missing or unreadable user-dirs file leaves the platform default in place.
  }
  const normalized = path.posix.resolve(downloads);
  if (isHomeDirectory(normalized, home)) return undefined;
  try { return realpathSync(normalized); } catch { return normalized; }
}

export function platformPaths({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
}: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): PlatformPaths {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const profile = userHome(platform, env, home);
  let dataRoot: string;
  let stateRoot: string;
  if (platform === "darwin") {
    dataRoot = paths.join(home, "Library", "Application Support", "omarchy-bot");
    stateRoot = paths.join(dataRoot, "state");
  } else if (platform === "win32") {
    dataRoot = paths.join(env.APPDATA || paths.join(profile, "AppData", "Roaming"), "omarchy-bot");
    stateRoot = paths.join(dataRoot, "state");
  } else {
    dataRoot = paths.join(home, ".local/share/omarchy-bot");
    stateRoot = paths.join(home, ".local/state/omarchy-bot");
  }
  return {
    homeDir: profile,
    dataDir: env.OMARCHY_BOT_HOME ?? dataRoot,
    stateDir: env.OMARCHY_BOT_STATE ?? stateRoot,
    sharedWorkspaceDir: sharedWorkspaceDir(profile, platform),
    downloadsDir: platform === "linux" ? linuxDownloadsDir(profile, env.XDG_CONFIG_HOME) : paths.join(profile, "Downloads"),
  };
}
