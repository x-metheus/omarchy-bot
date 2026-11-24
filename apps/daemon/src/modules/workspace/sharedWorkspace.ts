import { accessSync, chmodSync, constants as fsConstants, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { confinedPath } from "@omarchy-bot/domain";
import { sharedWorkspaceDir } from "./paths.ts";

export { sharedWorkspaceDir } from "./paths.ts";

/**
 * Create or reuse the Shared Workspace. Existing contents are left intact.
 * Failures are explicit: callers must not fall back to launch, source, or install paths.
 */
export function prepareSharedWorkspace(dir = sharedWorkspaceDir()): string {
  try {
    mkdirSync(dir, { recursive: true });
    const st = statSync(dir);
    if (!st.isDirectory()) {
      throw new Error(`${dir} is not a directory`);
    }
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK);
    return dir;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Shared Workspace is unavailable: ${detail}`);
  }
}

/** Preserve an explicit Thread cwd; otherwise prepare and return the Shared Workspace. */
export function resolveWorkCwd(explicitCwd?: string | null): string {
  if (explicitCwd !== undefined && explicitCwd !== null && explicitCwd !== "") {
    return explicitCwd;
  }
  return prepareSharedWorkspace();
}

/** Resolve a Sidecar transfer path inside Shared Workspace. Absolute and `..` escapes fail closed. */
export function confinedWorkspacePath(relative: string, root = sharedWorkspaceDir()): string {
  const trimmed = relative.trim();
  if (trimmed.length === 0 || trimmed === "/") {
    throw new Error("Shared Workspace path must be explicit");
  }
  try {
    return confinedPath(trimmed, root);
  } catch {
    throw new Error("path escapes Shared Workspace");
  }
}

export function privateFolderDir(botId: string, root = sharedWorkspaceDir()): string {
  if (!botId || botId !== botId.trim() || botId === "." || botId === ".." || /[/\\]/.test(botId)) {
    throw new Error("Bot ID must be a single path component");
  }
  const folder = confinedWorkspacePath(`bots/${botId}`, root);
  if (path.dirname(folder) !== confinedWorkspacePath("bots", root)) {
    throw new Error("private folder must be inside the Shared Workspace bots directory");
  }
  return folder;
}

function directoryStat(dir: string) {
  const entry = lstatSync(dir, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) throw new Error(`${dir} must be a directory`);
  return entry;
}

const PRIVATE_FOLDER_MODE = 0o700;

export function ensurePrivateFolder(botId: string, root = sharedWorkspaceDir()): string {
  prepareSharedWorkspace(root);
  const folder = privateFolderDir(botId, root);
  const parent = path.dirname(folder);
  if (!directoryStat(parent) || !directoryStat(folder)) {
    mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
  }
  if (!directoryStat(parent)) throw new Error(`${parent} must be a directory`);
  const entry = directoryStat(folder);
  if (!entry) throw new Error(`${folder} must be a directory`);
  if ((entry.mode & 0o7777) !== PRIVATE_FOLDER_MODE) chmodSync(folder, PRIVATE_FOLDER_MODE);
  return folder;
}

export function removePrivateFolder(botId: string, root = sharedWorkspaceDir()): boolean {
  const folder = privateFolderDir(botId, root);
  if (!directoryStat(path.dirname(folder)) || !directoryStat(folder)) return false;
  // Node's recursive removal is path-based, so this check is a mistake guard.
  rmSync(folder, { recursive: true, force: true });
  return true;
}
