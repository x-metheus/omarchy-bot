import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { setSetting } from "../../persistence/settings.ts";
import { ALLOWED_FOLDERS_SETTING, readAllowedFolders } from "./allowedFolders.ts";

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
