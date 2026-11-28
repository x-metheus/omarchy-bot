import os from "node:os";
import path from "node:path";

// These are the legacy Pi Service defaults, kept after its runtime was removed.
export function legacyAgentPaths(env = process.env) {
  const home = os.homedir();
  const homeDir = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || home;
  const dataDir = process.platform === "win32"
    ? path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "omarchy-bot")
    : process.platform === "darwin"
      ? path.join(homeDir, "Library", "Application Support", "omarchy-bot")
      : path.join(homeDir, ".local", "share", "omarchy-bot");
  const stateDir = process.platform === "linux" ? path.join(homeDir, ".local", "state", "omarchy-bot") : path.join(dataDir, "state");
  return { homeDir, dataDir, stateDir, sharedWorkspaceDir: path.join(homeDir, ".omarchy-bot", "workspace") };
}
