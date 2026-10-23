import { accessSync, constants as fsConstants, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinedPath } from "@omarchy-bot/domain";

/**
 * User home for Shared Workspace resolution.
 * Bun's `os.homedir()` ignores HOME changes after process start; tests set HOME
 * on the already-running daemon process, so the env var is the live value.
 */
function userHome(): string {
  const home = process.env.HOME;
  return home !== undefined && home !== "" ? home : os.homedir();
}

/** Home-local Shared Workspace used when a Thread has no explicit cwd. */
export function sharedWorkspaceDir(home = userHome()): string {
  return path.join(home, ".omarchy-bot", "workspace");
}

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
