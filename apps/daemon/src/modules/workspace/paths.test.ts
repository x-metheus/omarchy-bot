import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { platformPaths } from "./paths.ts";

test("Linux config preserves the previous data, state and Shared Workspace paths", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-platform-paths-"));
  const script = `
    import os from "node:os";
    import path from "node:path";
    import { loadConfig } from "../../bootstrap/config.ts";
    import { platformPaths } from "./paths.ts";
    process.env.HOME = path.join(process.env.HOME, "live-home");
    const expected = {
      dataDir: process.env.OMARCHY_BOT_HOME ?? path.join(os.homedir(), ".local/share/omarchy-bot"),
      stateDir: process.env.OMARCHY_BOT_STATE ?? path.join(os.homedir(), ".local/state/omarchy-bot"),
      sharedWorkspaceDir: path.join(process.env.HOME, ".omarchy-bot", "workspace"),
    };
    console.log(JSON.stringify({ expected, paths: platformPaths({ platform: "linux" }), config: process.platform === "linux" ? loadConfig() : null }));
  `;
  try {
    for (const override of [false, true]) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, "pi") };
      delete env.OMARCHY_BOT_HOME;
      delete env.OMARCHY_BOT_STATE;
      if (override) {
        env.OMARCHY_BOT_HOME = path.join(home, "service-data");
        env.OMARCHY_BOT_STATE = path.join(home, "service-state");
      }
      const result = Bun.spawnSync([process.execPath, "--eval", script], { cwd: import.meta.dir, env });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const { paths, config, expected } = JSON.parse(result.stdout.toString());
      expect(paths).toMatchObject(expected);
      if (process.platform === "linux") expect(config).toMatchObject(expected);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("maps macOS and Windows Service directories and user folders", () => {
  expect(platformPaths({ platform: "darwin", env: {}, home: "/Users/test" })).toEqual({
    homeDir: "/Users/test",
    dataDir: "/Users/test/Library/Application Support/omarchy-bot",
    stateDir: "/Users/test/Library/Application Support/omarchy-bot/state",
    sharedWorkspaceDir: "/Users/test/.omarchy-bot/workspace",
    downloadsDir: "/Users/test/Downloads",
  });
  expect(platformPaths({ platform: "win32", env: { USERPROFILE: "C:\\Users\\test", APPDATA: "D:\\Roaming" }, home: "C:\\Default" })).toEqual({
    homeDir: "C:\\Users\\test",
    dataDir: "D:\\Roaming\\omarchy-bot",
    stateDir: "D:\\Roaming\\omarchy-bot\\state",
    sharedWorkspaceDir: "C:\\Users\\test\\.omarchy-bot\\workspace",
    downloadsDir: "C:\\Users\\test\\Downloads",
  });
});

test("Linux Downloads uses the XDG user directories file with a home or absolute path", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-user-dirs-"));
  const options = { platform: "linux", env: {}, home } as const;
  const configFile = path.join(home, ".config", "user-dirs.dirs");
  try {
    expect(platformPaths(options).downloadsDir).toBe(path.join(home, "Downloads"));
    mkdirSync(path.dirname(configFile));
    writeFileSync(configFile, '# XDG user dirs\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/Local Downloads"\n');
    expect(platformPaths(options).downloadsDir).toBe(path.join(home, "Local Downloads"));
    const absolute = path.join(home, "incoming");
    writeFileSync(configFile, `XDG_DOWNLOAD_DIR="${absolute}"\n`);
    expect(platformPaths(options).downloadsDir).toBe(absolute);
    writeFileSync(configFile, 'XDG_DOWNLOAD_DIR="relative/path"\n');
    expect(platformPaths(options).downloadsDir).toBe(path.join(home, "Downloads"));
    expect(platformPaths({ ...options, env: { XDG_CONFIG_HOME: "relative" } }).downloadsDir).toBe(path.join(home, "Downloads"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test.each(["$HOME/", "$HOME/downloads-alias"])("Linux omits Downloads when %s resolves to home", (value) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-disabled-downloads-"));
  try {
    const config = path.join(home, ".config");
    mkdirSync(config);
    symlinkSync(home, path.join(home, "downloads-alias"), "junction");
    writeFileSync(path.join(config, "user-dirs.dirs"), `XDG_DOWNLOAD_DIR="${value}"\n`);
    expect(platformPaths({ platform: "linux", env: {}, home }).downloadsDir).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("Linux reads user-dirs.dirs from an absolute XDG_CONFIG_HOME", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-xdg-config-"));
  try {
    const config = path.join(home, "custom-config");
    mkdirSync(config);
    writeFileSync(path.join(config, "user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/incoming"\n');
    expect(platformPaths({ platform: "linux", env: { XDG_CONFIG_HOME: config }, home }).downloadsDir).toBe(path.join(home, "incoming"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
