import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { legacyAgentPaths } from "./legacy-agent-paths.ts";

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";
assert.ok(apply || args.length === 0, "Usage: bun scripts/clear-legacy-agent-data.ts [--apply]");
assert.ok(process.env.OMARCHY_BOT_HOME === undefined && process.env.OMARCHY_BOT_STATE === undefined,
  "Custom legacy Service roots need operator review. Unset overrides only for a default installation.");
const { homeDir, dataDir, stateDir, sharedWorkspaceDir } = legacyAgentPaths();
const directories = ["artifacts", "attachments", "avatars", "plugins", "screens", "secrets"].map(name => path.join(dataDir, name));
directories.push(path.join(stateDir, "screen-runtime"), sharedWorkspaceDir);
const database = path.join(dataDir, "db.sqlite");
const files = [database, ...["-journal", "-shm", "-wal"].map(suffix => database + suffix)];
files.push(...["host-identity-salt", "model-credentials.json", "pairing-host-secret", "service.log", "status.json"].map(name => path.join(stateDir, name)));

const entries = [...files.map(file => ({ file, directory: false })), ...directories.map(file => ({ file, directory: true }))];
for (const { file, directory } of entries) {
  const relative = path.relative(homeDir, file);
  assert.ok(path.isAbsolute(homeDir) && relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..",
    `Legacy state is outside this profile: ${file}`);
  let current = homeDir;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    const expectsDirectory = current !== file || directory;
    assert.ok(!info.isSymbolicLink() && (expectsDirectory ? info.isDirectory() : info.isFile()),
      `Unsafe legacy state path: ${current}`);
  }
}

if (apply && statSync(database, { throwIfNoEntry: false })) {
  using db = new Database(database, { readonly: true });
  const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
  const selected = tables.has("threads")
    ? db.query<{ cwd: string }, []>("SELECT DISTINCT cwd FROM threads WHERE cwd IS NOT NULL AND cwd != ''").all().map(row => row.cwd)
    : [];
  if (tables.has("service_settings")) {
    const row = db.query<{ value: string }, []>("SELECT value FROM service_settings WHERE key = 'allowed_folders'").get();
    if (row) {
      const folders: unknown = JSON.parse(row.value);
      assert.ok(Array.isArray(folders), "Could not check legacy allowed folders");
      selected.push(...folders.filter((folder): folder is string => typeof folder === "string" && path.isAbsolute(folder)));
    }
  }
  for (const directory of selected) {
    assert.ok(path.isAbsolute(directory), `Cannot resolve selected legacy directory: ${directory}`);
    const resolved = statSync(directory, { throwIfNoEntry: false }) ? realpathSync(directory) : directory;
    for (const root of directories) {
      const target = statSync(root, { throwIfNoEntry: false }) ? realpathSync(root) : root;
      for (const candidate of [directory, resolved]) {
        const relative = path.relative(target, candidate);
        assert.ok(path.isAbsolute(relative) || relative.split(path.sep)[0] === "..",
          `Clear would remove a selected legacy directory: ${directory}`);
      }
    }
  }
}
for (const { file, directory } of entries) {
  console.log(file);
  if (apply) rmSync(file, { force: true, recursive: directory });
}
