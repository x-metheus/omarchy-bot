import type { Database } from "bun:sqlite";
import path from "node:path";
import { getSetting, setSetting } from "../../persistence/settings.ts";
import type { PlatformPaths } from "./paths.ts";

/** JSON array of absolute folder paths in service_settings. */
export const ALLOWED_FOLDERS_SETTING = "allowed_folders";

export function readAllowedFolders(
  db: Database | undefined,
  paths: Pick<PlatformPaths, "sharedWorkspaceDir" | "downloadsDir">,
): readonly string[] {
  return [...new Set([
    path.resolve(paths.sharedWorkspaceDir),
    ...(paths.downloadsDir === undefined ? [] : [path.resolve(paths.downloadsDir)]),
    ...readSettingsAllowedFolders(db),
  ])];
}

export function readSettingsAllowedFolders(db: Database | undefined): readonly string[] {
  const stored = db && getSetting(db, ALLOWED_FOLDERS_SETTING);
  let extra: unknown;
  if (stored) {
    try { extra = JSON.parse(stored); } catch { /* Invalid Settings leave the defaults in place. */ }
  }
  const folders = new Set<string>();
  if (Array.isArray(extra)) {
    for (const folder of extra) {
      if (typeof folder === "string" && !folder.includes("\0") && path.isAbsolute(folder)) {
        folders.add(path.resolve(folder));
      }
    }
  }
  return [...folders];
}

/** Add one absolute folder to the Settings list; invalid stored entries are dropped. */
export function addSettingsAllowedFolder(db: Database, folder: string): void {
  if (!path.isAbsolute(folder) || folder.includes("\0")) throw new Error(`Allowed folder must be an absolute path: ${folder}`);
  const folders = new Set(readSettingsAllowedFolders(db));
  folders.add(path.resolve(folder));
  setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify([...folders]));
}
