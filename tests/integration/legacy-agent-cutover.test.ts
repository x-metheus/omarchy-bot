import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { legacyAgentPaths } from "../../scripts/legacy-agent-paths.ts";

test("legacy cutover previews and clears app-owned Pi sessions and the managed workspace", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-cutover-"));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
      OMARCHY_BOT_HOME: undefined, OMARCHY_BOT_STATE: undefined };
    const legacy = legacyAgentPaths(env);
    const sessionDatabase = path.join(legacy.dataDir, "db.sqlite");
    const chosen = path.join(home, "user-selected", "sample.txt");
    const install = path.join(legacy.dataDir, "app", "installed-file");
    const otherPiSession = path.join(home, ".pi", "agent", "sessions", "standalone.jsonl");
    const managedFile = path.join(legacy.sharedWorkspaceDir, "managed.txt");
    for (const file of [chosen, install, otherPiSession, managedFile]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "fixture");
    }
    const db = new Database(sessionDatabase, { create: true });
    db.exec("CREATE TABLE pi_documents (id TEXT); INSERT INTO pi_documents VALUES ('legacy-session')");
    db.exec("CREATE TABLE threads (cwd TEXT)");
    db.query("INSERT INTO threads VALUES (?)").run(path.dirname(chosen));
    db.close();

    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "scripts/clear-legacy-agent-data.ts", ...args], { env });
    const preview = run();
    expect(preview.exitCode, preview.stderr.toString()).toBe(0);
    expect(preview.stdout.toString()).toContain(sessionDatabase);
    expect(preview.stdout.toString()).toContain(legacy.sharedWorkspaceDir);
    expect(await Bun.file(sessionDatabase).exists()).toBe(true);
    expect(await Bun.file(managedFile).exists()).toBe(true);

    const apply = run("--apply");
    expect(apply.exitCode, apply.stderr.toString()).toBe(0);
    expect(await Bun.file(sessionDatabase).exists()).toBe(false);
    expect(await Bun.file(managedFile).exists()).toBe(false);
    for (const file of [chosen, install, otherPiSession]) expect(await readFile(file, "utf8")).toBe("fixture");
    expect(run("--apply").exitCode).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy cutover refuses to clear a managed root containing a selected working directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-cutover-"));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
      OMARCHY_BOT_HOME: undefined, OMARCHY_BOT_STATE: undefined };
    const legacy = legacyAgentPaths(env);
    const selected = path.join(legacy.sharedWorkspaceDir, "user folder");
    await mkdir(selected, { recursive: true });
    await mkdir(legacy.dataDir, { recursive: true });
    const file = path.join(selected, "sample.txt");
    await writeFile(file, "fixture");
    const database = path.join(legacy.dataDir, "db.sqlite");
    const db = new Database(database, { create: true });
    db.exec("CREATE TABLE threads (cwd TEXT)");
    db.query("INSERT INTO threads VALUES (?)").run(selected);
    db.close();

    const apply = Bun.spawnSync([process.execPath, "scripts/clear-legacy-agent-data.ts", "--apply"], { env });
    expect(apply.exitCode).not.toBe(0);
    expect(apply.stderr.toString()).toContain("selected legacy directory");
    expect(await readFile(file, "utf8")).toBe("fixture");
    expect(await Bun.file(database).exists()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
