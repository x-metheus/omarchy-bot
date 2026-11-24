import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { getSetting, setSetting } from "../../persistence/settings.ts";
import {
  ALLOWED_FOLDERS_SETTING,
  addSettingsAllowedFolder,
  readAllowedFolders,
  readSettingsAllowedFolders,
  removeSettingsAllowedFolder,
} from "./allowedFolders.ts";

test("reads only valid normalized absolute folders from the persisted Settings array", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const home = os.tmpdir();
  const workspace = path.join(home, "workspace");
  const downloads = path.join(home, "Downloads");
  const extra = path.join(home, "extra");
  const paths = { sharedWorkspaceDir: workspace, downloadsDir: downloads };
  try {
    expect(readAllowedFolders(db, paths)).toEqual([workspace, downloads]);
    setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify([workspace, "relative", null, 10, `${extra}\0bad`, `${extra}${path.sep}nested${path.sep}..${path.sep}`, extra]));
    expect(readAllowedFolders(db, paths)).toEqual([workspace, downloads, extra]);
    for (const value of ["invalid JSON", JSON.stringify({ folders: [extra] })]) {
      setSetting(db, ALLOWED_FOLDERS_SETTING, value);
      expect(readAllowedFolders(db, paths)).toEqual([workspace, downloads]);
    }
  } finally {
    db.close();
  }
});

test("removes only the matching Settings folder and retains implicit access", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const workspace = path.join(os.tmpdir(), "workspace");
  const downloads = path.join(os.tmpdir(), "Downloads");
  const extra = path.join(os.tmpdir(), "extra");
  const kept = path.join(os.tmpdir(), "kept");
  const paths = { sharedWorkspaceDir: workspace, downloadsDir: downloads };
  try {
    for (const folder of [workspace, downloads, extra, kept]) addSettingsAllowedFolder(db, folder);
    removeSettingsAllowedFolder(db, `${extra}${path.sep}nested${path.sep}..`);
    removeSettingsAllowedFolder(db, workspace);
    removeSettingsAllowedFolder(db, downloads);
    expect(readSettingsAllowedFolders(db)).toEqual([kept]);
    expect(readAllowedFolders(db, paths)).toEqual([workspace, downloads, kept]);
  } finally {
    db.close();
  }
});

test("removing an absent folder leaves the stored Settings value alone", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const extra = path.join(os.tmpdir(), "extra");
  try {
    removeSettingsAllowedFolder(db, extra);
    expect(getSetting(db, ALLOWED_FOLDERS_SETTING)).toBeNull();
    const stored = JSON.stringify(["relative", path.join(os.tmpdir(), "kept")]);
    setSetting(db, ALLOWED_FOLDERS_SETTING, stored);
    removeSettingsAllowedFolder(db, extra);
    expect(getSetting(db, ALLOWED_FOLDERS_SETTING)).toBe(stored);
  } finally {
    db.close();
  }
});

test("rejects relative paths and paths with NUL when removing a folder", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  try {
    expect(() => removeSettingsAllowedFolder(db, "relative")).toThrow("Allowed folder must be an absolute path");
    expect(() => removeSettingsAllowedFolder(db, path.join(os.tmpdir(), "invalid\0folder"))).toThrow("Allowed folder must be an absolute path");
  } finally {
    db.close();
  }
});
