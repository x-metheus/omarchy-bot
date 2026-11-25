import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon, type Harness } from "./helpers/harness.ts";

test("Service startup migrates the legacy workspace once and preserves it on restart", async () => {
  const previousEnv = [
    "HOME",
    "USERPROFILE",
    "OMARCHY_BOT_HOME",
    "OMARCHY_BOT_STATE",
    "OMARCHY_BOT_PORT",
    "OMARCHY_BOT_WORKERS_DIR",
    "OMARCHY_BOT_DELETION_TERMINAL_TIMEOUT_MS",
  ].map((name) => [name, process.env[name]] as const);
  const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-workspace-startup-"));
  const stateDirs: string[] = [];
  const startFixtureDaemon = async () => {
    const previousStateDir = process.env.OMARCHY_BOT_STATE;
    try {
      return await startDaemon(home);
    } finally {
      const stateDir = process.env.OMARCHY_BOT_STATE;
      if (stateDir !== undefined && stateDir !== previousStateDir) {
        stateDirs.push(stateDir);
      }
    }
  };
  const workspace = path.join(home, ".omarchy-bot", "workspace");
  const sharedMcpFile = path.join(workspace, ".mcp.json");
  const markerFile = path.join(home, "workspace-cleanup.json");
  const backupNames = () => readdirSync(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("workspace-backup-"))
    .map((entry) => entry.name)
    .sort();

  let daemon: Harness | undefined;
  try {
    const shared = { url: "https://shared.example.invalid/mcp" };
    const conflict = { url: "https://shared.example.invalid/conflict" };
    const piOnly = { url: "https://pi.example.invalid/mcp" };
    const piMcp = JSON.stringify({ mcpServers: { piOnly, conflict: { url: "https://pi.example.invalid/conflict" } } });
    const codexConfig = `[mcp_servers.codexOnly]
command = "codex-example"
args = ["--stdio"]
env = { EXAMPLE_MODE = "test" }
`;
    const unrecognizedFile = "notes.txt";
    const unrecognizedContent = "Keep this unrecognized Codex file.\n";
    const skills = [
      { root: ".pi", name: "pi-skill", description: "Legacy Pi Skill" },
      { root: ".claude", name: "claude-skill", description: "Legacy Claude Skill" },
      { root: ".agents", name: "existing", description: "Existing Shared Workspace Skill" },
    ].map((skill) => ({
      ...skill,
      contents: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nInstructions for ${skill.name}.\n`,
    }));
    for (const { root, name, contents } of skills) {
      const directory = path.join(workspace, root, "skills", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "SKILL.md"), contents);
    }
    mkdirSync(path.join(workspace, ".codex"));
    writeFileSync(sharedMcpFile, JSON.stringify({ mcpServers: { shared, conflict } }));
    writeFileSync(path.join(workspace, ".pi", "mcp.json"), piMcp);
    writeFileSync(path.join(workspace, ".codex", "config.toml"), codexConfig);
    writeFileSync(path.join(workspace, ".codex", unrecognizedFile), unrecognizedContent);

    process.env.USERPROFILE = home;
    daemon = await startFixtureDaemon();
    expect(JSON.parse(readFileSync(sharedMcpFile, "utf8")).mcpServers).toEqual({
      shared,
      conflict,
      piOnly,
      codexOnly: { command: "codex-example", args: ["--stdio"], env: { EXAMPLE_MODE: "test" }, disabled: false },
    });
    for (const { name, contents } of skills) {
      expect(readFileSync(path.join(workspace, ".agents", "skills", name, "SKILL.md"), "utf8")).toBe(contents);
    }
    for (const folder of [".pi", ".claude"]) {
      expect(lstatSync(path.join(workspace, folder, "skills"), { throwIfNoEntry: false })).toBeUndefined();
    }

    const firstBackups = backupNames();
    expect(firstBackups).toEqual([expect.stringMatching(/^workspace-backup-\d{4}-\d{2}-\d{2}$/)]);
    const backupDir = path.join(home, firstBackups[0]!);
    expect(readdirSync(backupDir).sort()).toEqual([".claude", ".codex", ".pi"]);
    expect(readdirSync(path.join(backupDir, ".pi")).sort()).toEqual(["mcp.json", "skills"]);
    expect(readFileSync(path.join(backupDir, ".pi", "mcp.json"), "utf8")).toBe(piMcp);
    expect(readFileSync(path.join(backupDir, ".codex", "config.toml"), "utf8")).toBe(codexConfig);
    expect(readFileSync(path.join(backupDir, ".codex", unrecognizedFile), "utf8")).toBe(unrecognizedContent);
    const { version, completedAt } = JSON.parse(readFileSync(markerFile, "utf8"));
    expect(version).toBe(1);
    expect(typeof completedAt).toBe("string");
    expect(Date.parse(completedAt)).not.toBeNaN();

    await daemon.stop();
    daemon = undefined;
    const markerBytes = readFileSync(markerFile);
    const backups = backupNames();
    const mcpBytes = readFileSync(sharedMcpFile);

    daemon = await startFixtureDaemon();
    expect(readFileSync(markerFile)).toEqual(markerBytes);
    expect(backupNames()).toEqual(backups);
    expect(readFileSync(sharedMcpFile)).toEqual(mcpBytes);
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await daemon?.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const [name, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    for (const directory of [home, ...stateDirs]) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      console.error(new AggregateError(cleanupErrors, "Workspace startup test cleanup failed"));
    }
  }
});
