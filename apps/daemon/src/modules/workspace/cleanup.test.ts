import { expect, spyOn, test } from "bun:test";
import fs, {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupWorkspace } from "./cleanup.ts";

const markerName = "workspace-cleanup.json";
const journalName = "workspace-cleanup.journal.json";
const backupName = "workspace-backup-2026-01-02";
const aliasTarget = "../../.pi/skills/imported";
const sharedMcp = ' { "mcpServers" : {}, "settings": 9 }\r\n';
const piMcp = '{"mcpServers":{"imported":{"command":"test"}}}';

function withWorkspace(run: (fixture: { root: string; workspaceDir: string; dataDir: string; now: Date }) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-workspace-cleanup-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    mkdirSync(workspaceDir);
    mkdirSync(dataDir);
    run({ root, workspaceDir, dataDir, now: new Date("2026-01-02T12:00:00.000Z") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function put(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function snapshot(root: string): Record<string, unknown> {
  return Object.fromEntries(readdirSync(root).sort().map((name) => {
    const entry = path.join(root, name);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) return [name, { link: readlinkSync(entry) }];
    const content = stat.isDirectory() ? snapshot(entry) : readFileSync(entry);
    return [name, { mode: stat.mode, content }];
  }));
}

function seedMigration(workspaceDir: string, withAlias = true): string {
  put(workspaceDir, ".pi/skills/imported/SKILL.md", "# Imported skill\n");
  put(workspaceDir, ".pi/mcp.json", piMcp);
  put(workspaceDir, ".codex/config.toml", "# Valid empty configuration\n");
  put(workspaceDir, ".claude/other.txt", "Keep me\n");
  const alias = path.join(workspaceDir, ".agents/skills/imported");
  if (withAlias) {
    put(workspaceDir, ".mcp.json", sharedMcp);
    mkdirSync(path.dirname(alias), { recursive: true });
    symlinkSync(aliasTarget, alias, "dir");
  }
  return alias;
}

test("cleanupWorkspace merges Pi and Codex MCP servers and keeps the shared conflict and root keys", () => withWorkspace((fixture) => {
  const { workspaceDir } = fixture;
  const shared = { mcpServers: { existing: { command: "shared", env: { API_KEY: "shared-secret" } } }, settings: { keep: true } };
  const file = put(workspaceDir, ".mcp.json", JSON.stringify(shared));
  put(workspaceDir, ".pi/mcp.json", JSON.stringify({ mcpServers: {
    existing: { command: "legacy", env: { API_KEY: "legacy-secret" } }, pi: { command: "pi-server", cwd: "./tools" },
  } }));
  put(workspaceDir, ".codex/config.toml", `
[mcp_servers.stdio]
command = "codex-server"
args = ["--stdio"]
env = { MODE = "test" }
enabled = false
[mcp_servers.http]
url = "https://example.test/mcp"
http_headers = { Accept = "application/json" }
`);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", mcpServersAdded: ["pi", "stdio", "http"], conflicts: ["existing"] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain('"existing"');
    expect(String(warn.mock.calls[0])).not.toMatch(/secret|API_KEY|application\/json/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...shared, mcpServers: {
      ...shared.mcpServers,
      pi: { command: "pi-server", cwd: "./tools" },
      stdio: { command: "codex-server", args: ["--stdio"], env: { MODE: "test" }, disabled: true },
      http: { url: "https://example.test/mcp", headers: { Accept: "application/json" }, disabled: false },
    } });
  } finally {
    warn.mockRestore();
  }
}));

test("cleanupWorkspace leaves the existing MCP file byte-for-byte untouched when nothing is added", () => withWorkspace((fixture) => {
  const original = ' {"mcpServers":{"same":{"command":"same","args":["one"]}}}\r\n';
  const file = put(fixture.workspaceDir, ".mcp.json", original);
  put(fixture.workspaceDir, ".pi/mcp.json", '{"mcpServers":{"same":{"args":["one"],"command":"same"}}}');
  const inode = lstatSync(file).ino;
  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", mcpServersAdded: [], conflicts: [] });
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(lstatSync(file).ino).toBe(inode);
}));

const invalidConfigurations = [
  [".mcp.json", "{"],
  [".pi/mcp.json", "{"],
  [".codex/config.toml", "[mcp_servers.invalid"],
  [".mcp.json", '{"mcpServers":null}'],
  [".pi/mcp.json", '{"mcpServers":{"bad":42}}'],
  [".codex/config.toml", 'mcp_servers = "invalid"'],
] as const;

test.each(invalidConfigurations)("cleanupWorkspace aborts before changing files for invalid %s (%s)", (relative, invalid) => withWorkspace((fixture) => {
  seedMigration(fixture.workspaceDir);
  const file = put(fixture.workspaceDir, relative, invalid);
  const before = snapshot(fixture.root);
  expect(() => cleanupWorkspace(fixture)).toThrow(file);
  expect(snapshot(fixture.root)).toEqual(before);
}));

test("cleanupWorkspace warns by name and keeps unrepresentable Codex entries in the backup", () => withWorkspace((fixture) => {
  const invalidServers = {
    both: 'command = "private-command"\nurl = "https://private.example.test"',
    args: 'command = "private-command"\nargs = [123]',
    env: 'command = "private-command"\nenv = { Private = 456 }',
    headers: 'url = "https://private.example.test"\nhttp_headers = { Private = 456 }',
    sse: 'type = "sse"\nurl = "https://private.example.test"',
    cwd: 'command = "private-command"\ncwd = "./private-tools"',
    timeout: 'command = "private-command"\nstartup_timeout_sec = 20',
    inherited: 'command = "private-command"\nenv_vars = ["PRIVATE_KEY"]',
    noTransport: 'enabled = false',
  };
  const codex = Object.entries({ ...invalidServers, valid: 'command = "valid"' })
    .map(([name, definition]) => `[mcp_servers.${name}]\n${definition}\n`).join("\n");
  put(fixture.workspaceDir, ".codex/config.toml", codex);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", mcpServersAdded: ["valid"] });
    const shared = JSON.parse(readFileSync(path.join(fixture.workspaceDir, ".mcp.json"), "utf8"));
    expect(shared.mcpServers).toEqual({ valid: { command: "valid", args: [], disabled: false } });
    expect(readFileSync(path.join(fixture.dataDir, backupName, ".codex/config.toml"), "utf8")).toBe(codex);
    expect(warn).toHaveBeenCalledTimes(Object.keys(invalidServers).length);
    for (const name of Object.keys(invalidServers)) expect(String(warn.mock.calls)).toContain(`"${name}"`);
    expect(String(warn.mock.calls)).not.toMatch(/private|456|startup_timeout_sec/);
  } finally {
    warn.mockRestore();
  }
}));

test("cleanupWorkspace installs Pi and nested Claude skills while keeping shared identities and blocked destinations", () => withWorkspace((fixture) => {
  const { workspaceDir, dataDir } = fixture;
  const original = "---\nname: shared\n---\nExisting\n";
  const legacy = "---\nname: 'shared' # same identity\n---\nLegacy\n";
  const existing = put(workspaceDir, ".agents/skills/category/winner/SKILL.md", original);
  put(workspaceDir, ".agents/skills/occupied", "Keep this file\n");
  put(workspaceDir, ".pi/skills/occupied/SKILL.md", "# Blocked\n");
  put(workspaceDir, ".pi/skills/other-basename/SKILL.md", legacy);
  put(workspaceDir, ".pi/skills/pi-skill/SKILL.md", "# Pi skill without frontmatter\n");
  put(workspaceDir, ".pi/skills/pi-skill/assets/note.txt", "Pi skill content\n");
  const claude = "---\nname: claude-skill\n---\nClaude skill\n";
  put(workspaceDir, ".claude/skills/category/nested/SKILL.md", claude);
  put(workspaceDir, ".claude/skills/a/b/c/d/e/too-deep/SKILL.md", "# Beyond scan depth\n");

  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["pi-skill", "nested"], conflicts: ["occupied", "shared"] });
  expect(readFileSync(existing, "utf8")).toBe(original);
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/pi-skill/assets/note.txt"), "utf8")).toBe("Pi skill content\n");
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/nested/SKILL.md"), "utf8")).toBe(claude);
  expect(existsSync(path.join(workspaceDir, ".agents/skills/too-deep"))).toBe(false);
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/occupied"), "utf8")).toBe("Keep this file\n");
  expect(readFileSync(path.join(dataDir, backupName, ".pi/skills/other-basename/SKILL.md"), "utf8")).toBe(legacy);
  expect(readFileSync(path.join(dataDir, backupName, ".pi/skills/occupied/SKILL.md"), "utf8")).toBe("# Blocked\n");
  expect(readFileSync(path.join(dataDir, backupName, ".pi/skills/pi-skill/assets/note.txt"), "utf8")).toBe("Pi skill content\n");
}));

test("cleanupWorkspace assigns deterministic suffixes around existing skills and unmatched aliases", () => withWorkspace((fixture) => {
  const { workspaceDir } = fixture;
  put(workspaceDir, ".agents/skills/tools/SKILL.md", "---\nname: shared-tools\n---\n");
  put(workspaceDir, ".pi/skills/tools/SKILL.md", "---\nname: pi-tools\n---\n");
  put(workspaceDir, ".claude/skills/nested/tools/SKILL.md", "---\nname: claude-tools\n---\n");
  put(workspaceDir, ".claude/skills/unmatched/SKILL.md", "# Unmatched\n");
  const alias = path.join(workspaceDir, ".agents/skills/unmatched");
  symlinkSync("../../.pi/skills/missing", alias, "dir");
  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["tools-2", "tools-3", "unmatched-2"] });
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/tools-2/SKILL.md"), "utf8")).toContain("pi-tools");
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/tools-3/SKILL.md"), "utf8")).toContain("claude-tools");
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/unmatched-2/SKILL.md"), "utf8")).toBe("# Unmatched\n");
  expect(readlinkSync(alias)).toBe("../../.pi/skills/missing");
}));

test("cleanupWorkspace assigns distinct destinations to legacy Skills whose names differ only in case", () => withWorkspace((fixture) => {
  const { workspaceDir, dataDir } = fixture;
  const pi = "---\nname: pi-tools\n---\nPi tools\n";
  const claude = "---\nname: claude-tools\n---\nClaude tools\n";
  put(workspaceDir, ".pi/skills/Tools/SKILL.md", pi);
  put(workspaceDir, ".claude/skills/tools/SKILL.md", claude);

  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["Tools", "tools-2"] });
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/Tools/SKILL.md"), "utf8")).toBe(pi);
  expect(readFileSync(path.join(workspaceDir, ".agents/skills/tools-2/SKILL.md"), "utf8")).toBe(claude);
  expect(readFileSync(path.join(dataDir, backupName, ".pi/skills/Tools/SKILL.md"), "utf8")).toBe(pi);
  expect(readFileSync(path.join(dataDir, backupName, ".claude/skills/tools/SKILL.md"), "utf8")).toBe(claude);
  expect(existsSync(path.join(workspaceDir, ".pi"))).toBe(false);
  expect(existsSync(path.join(workspaceDir, ".claude"))).toBe(false);
  expect(readdirSync(dataDir).sort()).toEqual([backupName, markerName]);
}));

test("cleanupWorkspace copies a symlinked legacy Skill and preserves its target", () => withWorkspace((fixture) => {
  const { workspaceDir, dataDir } = fixture;
  const target = path.join(workspaceDir, "team/report");
  const content = "---\nname: reporting\n---\nReport Skill\n";
  put(target, "SKILL.md", content);
  put(target, "assets/note.txt", "Report asset\n");
  const legacy = path.join(workspaceDir, ".claude/skills/report");
  mkdirSync(path.dirname(legacy), { recursive: true });
  symlinkSync("../../team/report", legacy, "dir");
  put(workspaceDir, ".claude/skills/second-report/SKILL.md", content);
  const before = snapshot(target);

  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["report"], conflicts: ["reporting"] });
  const installed = path.join(workspaceDir, ".agents/skills/report");
  expect(lstatSync(installed).isDirectory()).toBe(true);
  expect(snapshot(installed)).toEqual(before);
  expect(snapshot(target)).toEqual(before);
  expect(readlinkSync(path.join(dataDir, backupName, ".claude/skills/report"))).toBe("../../team/report");
  expect(existsSync(path.join(workspaceDir, ".claude"))).toBe(false);
  expect(readdirSync(dataDir).sort()).toEqual([backupName, markerName]);
}));

test.each([".pi/skills", ".claude/skills/category"])(
  "cleanupWorkspace discovers Skills through linked %s with a directory cycle", (relative) => withWorkspace((fixture) => {
    const { workspaceDir, dataDir } = fixture;
    const target = path.join(workspaceDir, "legacy-skills");
    const content = "# Report Skill\n";
    put(target, "report/SKILL.md", content);
    symlinkSync(".", path.join(target, "cycle"), "dir");
    const legacy = path.join(workspaceDir, relative);
    mkdirSync(path.dirname(legacy), { recursive: true });
    symlinkSync(target, legacy, "dir");
    const before = snapshot(target);

    expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["report"], conflicts: [] });
    expect(readFileSync(path.join(workspaceDir, ".agents/skills/report/SKILL.md"), "utf8")).toBe(content);
    expect(snapshot(target)).toEqual(before);
    expect(readlinkSync(path.join(dataDir, backupName, relative))).toBe(target);
    expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(dataDir).sort()).toEqual([backupName, markerName]);
  }),
);

test("cleanupWorkspace replaces a NativeSkills alias with its matching skill", () => withWorkspace((fixture) => {
  const alias = seedMigration(fixture.workspaceDir);
  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["imported"] });
  expect(lstatSync(alias).isDirectory()).toBe(true);
  expect(readFileSync(path.join(alias, "SKILL.md"), "utf8")).toBe("# Imported skill\n");
}));

test("cleanupWorkspace backs up all legacy folders, writes the marker last, and skips the second start", () => withWorkspace((fixture) => {
  const { root, workspaceDir, dataDir, now } = fixture;
  const legacyFiles = [".pi/custom/file", ".codex/unknown.bin", ".claude/extra.txt"];
  for (const file of legacyFiles) put(workspaceDir, file, file);
  const backupDir = path.join(dataDir, backupName);
  const markerFile = path.join(dataDir, markerName);
  expect(cleanupWorkspace({ ...fixture, hooks: { beforeStep(step) {
    if (step === "marker") {
      expect(existsSync(markerFile)).toBe(false);
      expect(existsSync(path.join(dataDir, journalName))).toBe(true);
      for (const file of legacyFiles) expect(readFileSync(path.join(backupDir, file), "utf8")).toBe(file);
    }
  } } })).toMatchObject({ status: "completed", backupDir });
  for (const file of legacyFiles) expect(existsSync(path.join(workspaceDir, file.split("/")[0]!))).toBe(false);
  expect(JSON.parse(readFileSync(markerFile, "utf8"))).toEqual({ version: 1, completedAt: now.toISOString(), backup: backupDir });
  expect(readdirSync(dataDir).sort()).toEqual([backupName, markerName]);

  put(workspaceDir, ".pi/recreated", "User data\n");
  put(dataDir, journalName, "A marked start must never read this\n");
  const before = snapshot(root);
  expect(cleanupWorkspace(fixture)).toEqual({ status: "skipped" });
  expect(snapshot(root)).toEqual(before);
}));

test("cleanupWorkspace reserves a fresh dated backup with the first available suffix", () => withWorkspace((fixture) => {
  const { workspaceDir, dataDir } = fixture;
  const old = put(dataDir, `${backupName}/keep`, "Existing backup\n");
  mkdirSync(path.join(dataDir, `${backupName}-2`));
  put(workspaceDir, ".pi/custom", "New backup\n");
  const backupDir = path.join(dataDir, `${backupName}-3`);
  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", backupDir });
  expect(readFileSync(old, "utf8")).toBe("Existing backup\n");
  expect(readFileSync(path.join(backupDir, ".pi/custom"), "utf8")).toBe("New backup\n");
}));

test("cleanupWorkspace records a null backup when there are no legacy folders", () => withWorkspace((fixture) => {
  const { dataDir, now } = fixture;
  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", mcpServersAdded: [], skillsMoved: [] });
  expect(readdirSync(dataDir)).toEqual([markerName]);
  expect(JSON.parse(readFileSync(path.join(dataDir, markerName), "utf8"))).toEqual({ version: 1, completedAt: now.toISOString(), backup: null });
}));

const steps = ["folders", "skills", "mcp", "marker"] as const;

test.each([...steps])("cleanupWorkspace restores a full snapshot after a throw at %s and can retry", (failure) => withWorkspace((fixture) => {
  const { root, workspaceDir, dataDir } = fixture;
  const alias = seedMigration(workspaceDir);
  const mcpFile = path.join(workspaceDir, ".mcp.json");
  const before = snapshot(root);
  const visited: string[] = [];
  const error = new Error(`injected ${failure} failure`);
  expect(() => cleanupWorkspace({ ...fixture, hooks: { beforeStep(step) {
    visited.push(step);
    if (step !== failure) return;
    const index = steps.indexOf(step);
    expect(existsSync(path.join(workspaceDir, ".pi"))).toBe(index === 0);
    expect(lstatSync(alias).isSymbolicLink()).toBe(index < 2);
    expect(readFileSync(mcpFile, "utf8") === sharedMcp).toBe(index < 3);
    expect(existsSync(path.join(dataDir, markerName))).toBe(false);
    throw error;
  } } })).toThrow(error);
  expect(visited).toEqual(steps.slice(0, steps.indexOf(failure) + 1));
  expect(snapshot(root)).toEqual(before);
  expect(readlinkSync(alias)).toBe(aliasTarget);
  expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["imported"], mcpServersAdded: ["imported"] });
}));

test("cleanupWorkspace removes staged read-only Skill directories after a marker failure", () => withWorkspace((fixture) => {
  const { root, workspaceDir, dataDir } = fixture;
  const alias = seedMigration(workspaceDir);
  const assets = path.dirname(put(workspaceDir, ".pi/skills/imported/assets/note.txt", "Read-only directory\n"));
  const installedAssets = path.join(alias, "assets");
  chmodSync(assets, 0o555);
  const before = snapshot(root);
  const markerError = new Error("injected marker failure");
  let thrown: unknown;
  try {
    try {
      cleanupWorkspace({ ...fixture, hooks: { beforeStep(step) {
        if (step !== "marker") return;
        expect(lstatSync(installedAssets).mode & 0o777).toBe(0o555);
        throw markerError;
      } } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(markerError);
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(dataDir)).toEqual([]);
  } finally {
    // Let the fixture remove read-only directories even if rollback failed.
    for (const directory of [assets, installedAssets, ...readdirSync(dataDir).map((name) => path.join(dataDir, name, "skills/imported/assets"))]) {
      if (existsSync(directory)) chmodSync(directory, 0o755);
    }
  }
}));

test("cleanupWorkspace removes newly created MCP, Skills, and data paths on rollback", () => withWorkspace((fixture) => {
  seedMigration(fixture.workspaceDir, false);
  const dataDir = path.join(fixture.dataDir, "new", "nested");
  const before = snapshot(fixture.root);
  expect(() => cleanupWorkspace({ ...fixture, dataDir, hooks: { beforeStep(step) {
    if (step === "marker") throw new Error("injected marker failure");
  } } })).toThrow("injected marker failure");
  expect(snapshot(fixture.root)).toEqual(before);
}));

test.each(["completed", "partial", "pending", "cross-device copying", "cross-device published"])(
  "cleanupWorkspace undoes a %s journal before a fresh migration", (scenario) => withWorkspace((fixture) => {
    const { workspaceDir, dataDir } = fixture;
    const alias = seedMigration(workspaceDir);
    const before = snapshot(workspaceDir);
    const staging = "workspace-cleanup-seeded";
    const stagingDir = path.join(dataDir, staging);
    const backupDir = path.join(dataDir, backupName);
    mkdirSync(backupDir);
    mkdirSync(stagingDir);
    const folderMoves = (scenario === "completed" ? [".pi", ".codex", ".claude"] : [".pi"])
      .map((name) => ({ kind: "folder", name }));
    for (const { name } of folderMoves) renameSync(path.join(workspaceDir, name), path.join(backupDir, name));
    const completed: object[] = [...folderMoves];
    if (scenario === "completed") {
      mkdirSync(path.join(stagingDir, "aliases"));
      renameSync(alias, path.join(stagingDir, "aliases/imported"));
      put(alias, "SKILL.md", "# Imported skill\n");
      put(stagingDir, "mcp.previous", sharedMcp);
      put(workspaceDir, ".mcp.json", piMcp);
      mkdirSync(path.join(stagingDir, "skills"));
      completed.push({ kind: "alias", name: "imported" }, { kind: "skill", name: "imported" }, { kind: "mcp", previous: true });
    }
    const operation = { kind: "folder", name: ".codex" };
    const partial = ".partial-a1";
    let pending;
    if (scenario === "pending") {
      renameSync(path.join(workspaceDir, ".codex"), path.join(backupDir, ".codex"));
      pending = { operation };
    } else if (scenario === "cross-device copying") {
      put(backupDir, `${partial}/config.toml`, "# Partial copy\n");
      pending = { operation, partial, ready: false };
    } else if (scenario === "cross-device published") {
      fs.cpSync(path.join(workspaceDir, ".codex"), path.join(backupDir, ".codex"), { recursive: true });
      rmSync(path.join(workspaceDir, ".codex/config.toml"));
      pending = { operation, partial, ready: true };
    }
    put(dataDir, journalName, JSON.stringify({ staging, backup: backupName, createdSkillDirs: [], completed, pending }));

    expect(cleanupWorkspace({ ...fixture, hooks: { beforeStep(step) {
      if (step === "folders") {
        expect(snapshot(workspaceDir)).toEqual(before);
        expect(existsSync(stagingDir)).toBe(false);
        expect(readdirSync(backupDir)).toEqual([]);
      }
    } } })).toMatchObject({ status: "completed", backupDir, skillsMoved: ["imported"], mcpServersAdded: ["imported"] });
    expect(readdirSync(dataDir).sort()).toEqual([backupName, markerName]);
    expect(readFileSync(path.join(backupDir, ".pi/mcp.json"), "utf8")).toBe(piMcp);
  }),
);

test("cleanupWorkspace rolls back cross-device moves and retries after a failed move", () => withWorkspace((fixture) => {
  const { root, workspaceDir, dataDir } = fixture;
  seedMigration(workspaceDir);
  const before = snapshot(root);
  const rename = fs.renameSync;
  const isDataPath = (file: fs.PathLike) => String(file).startsWith(`${dataDir}${path.sep}`);
  let rejectMove = true;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (rejectMove && String(to) === path.join(workspaceDir, ".mcp.json") && path.basename(String(from)).startsWith(".partial-")) {
      throw Object.assign(new Error("failed MCP move"), { code: "EACCES" });
    }
    if (isDataPath(from) !== isDataPath(to)) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
    return rename(from, to);
  });
  try {
    expect(() => cleanupWorkspace(fixture)).toThrow("failed MCP move");
    expect(snapshot(root)).toEqual(before);
    rejectMove = false;
    expect(cleanupWorkspace(fixture)).toMatchObject({ status: "completed", skillsMoved: ["imported"], mcpServersAdded: ["imported"] });
    expect(readdirSync(dataDir).sort()).toEqual([backupName, markerName]);
  } finally {
    spy.mockRestore();
  }
}));

test("cleanupWorkspace rolls back a published cross-device backup containing a read-only directory", () => withWorkspace((fixture) => {
  const { root, workspaceDir, dataDir } = fixture;
  seedMigration(workspaceDir);
  const codex = path.join(workspaceDir, ".codex");
  const backup = path.join(dataDir, backupName, ".codex");
  const readOnly = path.dirname(put(codex, "readonly/note.txt", "Read-only directory\n"));
  const backupReadOnly = path.join(backup, "readonly");
  chmodSync(readOnly, 0o555);
  const before = snapshot(root);
  const failure = Object.assign(new Error("injected source removal failure"), { code: "EACCES" });
  const rename = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to !== backup) return rename(from, to);
    if (from === codex) throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
    rename(from, to);
    expect(existsSync(path.join(workspaceDir, ".pi"))).toBe(false);
    expect(lstatSync(backupReadOnly).mode & 0o777).toBe(0o555);
    rmSync(path.join(codex, "config.toml"));
    throw failure;
  });
  try {
    let thrown: unknown;
    try { cleanupWorkspace(fixture); } catch (error) { thrown = error; }
    expect(thrown).toBe(failure);
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(dataDir)).toEqual([]);
  } finally {
    spy.mockRestore();
    for (const directory of [readOnly, backupReadOnly]) {
      if (existsSync(directory)) chmodSync(directory, 0o755);
    }
  }
}));

test("cleanupWorkspace refuses a workspace resolving to the configured home before changing files", () => withWorkspace((fixture) => {
  seedMigration(fixture.workspaceDir);
  const link = path.join(fixture.root, "home-link");
  symlinkSync(fixture.workspaceDir, link, "dir");
  const before = snapshot(fixture.root);
  const variable = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previous = process.env[variable];
  try {
    process.env[variable] = fixture.workspaceDir;
    expect(() => cleanupWorkspace({ ...fixture, workspaceDir: link })).toThrow(/home directory/i);
    expect(snapshot(fixture.root)).toEqual(before);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
}));
