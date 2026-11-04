import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BrowserSupply,
  ignoredBrowserSelectionNotice,
  PACK_DESKTOP_ID,
} from "../../apps/daemon/src/modules/computer/browserSupply.ts";
import {
  BROWSER_PACK_MISSING,
  PortableBotComputerAssets,
  type BotComputerAssetSupply,
} from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";
import { processIdentity } from "../../apps/daemon/src/supervision/ownedProcesses.ts";

let root: string | undefined;
const children: Array<{ kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function executable(file: string, body: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A private host: a fake `/usr/bin/brave` that only leaves a marker, its
 * desktop entry, and host default-handler lists that prefer it. Nothing here
 * is the real host, and the real host browser is never on a test PATH.
 */
function fixtureHost(base: string): {
  usrBin: string;
  share: string;
  xdgConfig: string;
  braveMarker: string;
} {
  const usrBin = path.join(base, "host", "usr", "bin");
  const share = path.join(base, "host", "usr", "share");
  const xdgConfig = path.join(base, "host", "etc", "xdg");
  const braveMarker = path.join(base, "host-brave-ran");
  const brave = executable(path.join(usrBin, "brave"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${braveMarker}'\n`);
  mkdirSync(path.join(share, "applications"), { recursive: true });
  writeFileSync(path.join(share, "applications", "brave-browser.desktop"), [
    "[Desktop Entry]", "Type=Application", "Name=Brave", `Exec=${brave} %U`,
    "MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;", "",
  ].join("\n"));
  const preferBrave = [
    "[Default Applications]",
    "x-scheme-handler/http=brave-browser.desktop",
    "x-scheme-handler/https=brave-browser.desktop",
    "text/html=brave-browser.desktop",
    "",
  ].join("\n");
  writeFileSync(path.join(share, "applications", "mimeapps.list"), preferBrave);
  mkdirSync(xdgConfig, { recursive: true });
  writeFileSync(path.join(xdgConfig, "mimeapps.list"), preferBrave);
  return { usrBin, share, xdgConfig, braveMarker };
}

/** A fake pack whose browser only records the argv it was started with. */
function fixturePack(base: string): { assets: BotComputerAssetSupply; browserBin: string; log: string } {
  const log = path.join(base, "pack-argv.log");
  const browserBin = executable(
    path.join(base, "pack", "browser"),
    `#!/bin/sh\nfor argument do printf '%s\\n' "$argument"; done > '${log}'\n`,
  );
  return {
    browserBin,
    log,
    assets: {
      ensureFonts: async () => ({ fontConfigFile: path.join(base, "fonts.conf") }),
      ensureBrowser: async () => ({ browserBin }),
    },
  };
}

function screenEnvironment(supply: BrowserSupply, profileDir: string, host: ReturnType<typeof fixtureHost>, base: string): Record<string, string> {
  const runtimeDir = path.join(base, "run");
  mkdirSync(runtimeDir, { recursive: true });
  return supply.environment({
    HOME: path.join(profileDir, "home"),
    XDG_CONFIG_HOME: path.join(profileDir, "config"),
    XDG_DATA_HOME: path.join(profileDir, "data"),
    XDG_DATA_DIRS: host.share,
    XDG_CONFIG_DIRS: host.xdgConfig,
    XDG_CURRENT_DESKTOP: "sway",
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "no-bus")}`,
    PATH: host.usrBin,
  });
}

const xdgMime = Bun.which("xdg-mime", { PATH: "/usr/bin:/bin" });

test.skipIf(xdgMime === null)("xdg-mime under the Screen environment resolves web defaults to the pack entry", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const host = fixtureHost(root);
  const pack = fixturePack(root);
  const profileDir = path.join(root, "profile", "computer");
  const supply = new BrowserSupply({ assets: pack.assets, profileDir });
  const env = screenEnvironment(supply, profileDir, host, root);
  // xdg-mime needs coreutils, awk and grep; the fixture host's bin stays first.
  const query = (type: string) => {
    const result = Bun.spawnSync([xdgMime!, "query", "default", type], {
      env: { ...env, PATH: `${env.PATH}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString().trim();
  };
  // The fixture host really prefers brave until the Bot Computer is prepared.
  expect(query("x-scheme-handler/https")).toBe("brave-browser.desktop");

  await supply.prepare();
  for (const type of ["x-scheme-handler/http", "x-scheme-handler/https", "text/html"]) {
    expect(query(type)).toBe(PACK_DESKTOP_ID);
  }
  expect(env.BROWSER).toBe(supply.launcher);
  expect(readFileSync(path.join(profileDir, "data", "applications", PACK_DESKTOP_ID), "utf8"))
    .toContain(`Exec=${supply.launcher} %U`);
  expect(existsSync(host.braveMarker)).toBeFalse();
});

test("the Bot mimeapps.list keeps unrelated defaults and replaces host browser handlers", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const pack = fixturePack(root);
  const profileDir = path.join(root, "profile", "computer");
  mkdirSync(path.join(profileDir, "config"), { recursive: true });
  writeFileSync(path.join(profileDir, "config", "mimeapps.list"), [
    "[Added Associations]",
    "image/png=imv.desktop;",
    "",
    "[Default Applications]",
    "x-scheme-handler/https=brave-browser.desktop",
    "image/png=imv.desktop",
    "",
  ].join("\n"));
  writeFileSync(path.join(profileDir, "config", "sway-mimeapps.list"), "[Default Applications]\ntext/html=firefox.desktop\n");
  const supply = new BrowserSupply({ assets: pack.assets, profileDir });
  await supply.prepare();
  await supply.prepare();
  const list = readFileSync(path.join(profileDir, "config", "mimeapps.list"), "utf8");
  expect(list).toContain("image/png=imv.desktop");
  expect(list).toContain("[Added Associations]");
  expect(list).not.toContain("brave-browser.desktop");
  expect(list.match(/x-scheme-handler\/https=/g)).toHaveLength(1);
  expect(list).toContain(`x-scheme-handler/https=${PACK_DESKTOP_ID}`);
  const desktopList = readFileSync(path.join(profileDir, "config", "sway-mimeapps.list"), "utf8");
  expect(desktopList).not.toContain("firefox.desktop");
  expect(desktopList).toContain(`text/html=${PACK_DESKTOP_ID}`);
});

test("a host browser name on the Screen PATH opens the pack and never runs the host browser", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const host = fixtureHost(root);
  const pack = fixturePack(root);
  const profileDir = path.join(root, "profile", "computer");
  const supply = new BrowserSupply({ assets: pack.assets, profileDir });
  await supply.prepare();
  const env = screenEnvironment(supply, profileDir, host, root);
  expect(env.PATH!.split(":")[0]).toBe(supply.shimDir);
  for (const name of ["brave", "brave-browser", "chromium", "google-chrome-stable", "firefox", "microsoft-edge"]) {
    // Guard before running: a name that missed the shim must never reach any browser.
    expect(Bun.which(name, { PATH: env.PATH! })).toBe(path.join(supply.shimDir, name));
  }

  const run = Bun.spawnSync(["/bin/sh", "-c", "brave --incognito https://x.example/"], { env, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  expect(readFileSync(pack.log, "utf8").trim().split("\n")).toEqual([
    `--user-data-dir=${supply.profilePath}`,
    "--ozone-platform=wayland", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-sync", "--password-store=basic",
    "--new-window", "https://x.example/",
  ]);
  // `BROWSER` is the same pack launcher.
  rmSync(pack.log);
  expect(Bun.spawnSync(["/bin/sh", "-c", "\"$BROWSER\" https://y.example/"], { env }).exitCode).toBe(0);
  expect(readFileSync(pack.log, "utf8").trim().split("\n").at(-1)).toBe("https://y.example/");
  expect(existsSync(host.braveMarker)).toBeFalse();
});

test("open_app requests for another browser are refused with an actionable error", () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const pack = fixturePack(root);
  const supply = new BrowserSupply({ assets: pack.assets, profileDir: path.join(root, "profile") });
  for (const app of [
    "brave", "/usr/bin/brave", "brave-browser.desktop", "chromium", "google-chrome-stable",
    "google-chrome.desktop", "chrome", "firefox", "firefox.desktop", "microsoft-edge-beta",
    "vivaldi-stable", "opera", "epiphany", "librewolf", "zen-browser", "com.brave.Browser.desktop",
    "org.mozilla.firefox.desktop",
  ]) {
    expect(() => supply.refuseHostBrowser(app), app).toThrow(/open_url.*browser tool/);
  }
  // A desktop entry with an innocent name that runs a browser is refused by its command.
  expect(() => supply.refuseHostBrowser("web.desktop", ["env", "MOZ_X=1", "/usr/bin/firefox", "--new-window"]))
    .toThrow("open_app cannot start web.desktop");
  expect(() => supply.refuseHostBrowser("web.desktop", ["/usr/bin/flatpak", "run", "--branch=stable", "com.brave.Browser"]))
    .toThrow("open_app cannot start web.desktop");
  for (const app of ["foot", "fixture-app", "org.gnome.Nautilus.desktop", "chromaprint", "operator.desktop"]) {
    expect(() => supply.refuseHostBrowser(app, [app])).not.toThrow();
  }
});

test("the old config/chromium profile is moved once and never overwritten", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const pack = fixturePack(root);
  const profileDir = path.join(root, "profile", "computer");
  const legacy = path.join(profileDir, "config", "chromium");
  mkdirSync(path.join(legacy, "Default"), { recursive: true });
  writeFileSync(path.join(legacy, "Default", "Cookies"), "signed in");
  const supply = new BrowserSupply({ assets: pack.assets, profileDir });

  const argv = await supply.launchCommand("https://example.com/");
  expect(supply.profilePath).toBe(path.join(profileDir, "config", "omarchy-bot-browser"));
  expect(argv).toContain(`--user-data-dir=${supply.profilePath}`);
  expect(readFileSync(path.join(supply.profilePath, "Default", "Cookies"), "utf8")).toBe("signed in");
  expect(existsSync(legacy)).toBeFalse();

  // A later host Chromium profile at the old path is never moved over the pack profile.
  mkdirSync(path.join(legacy, "Default"), { recursive: true });
  writeFileSync(path.join(legacy, "Default", "Cookies"), "someone else");
  await supply.launchCommand("https://example.com/again");
  await new BrowserSupply({ assets: pack.assets, profileDir }).prepare();
  expect(readFileSync(path.join(supply.profilePath, "Default", "Cookies"), "utf8")).toBe("signed in");
  expect(readFileSync(path.join(legacy, "Default", "Cookies"), "utf8")).toBe("someone else");
});

test("the profile move waits while a browser still holds the old profile", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const pack = fixturePack(root);
  const profileDir = path.join(root, "profile", "computer");
  const legacy = path.join(profileDir, "config", "chromium");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "Local State"), "{}");
  // Stands in for a pack browser a previous Service started on the old path.
  const holder = Bun.spawn(["/bin/sh", "-c", "sleep 30; :", "sh", `--user-data-dir=${legacy}`], { stdout: "ignore", stderr: "ignore" });
  children.push(holder);
  const supply = new BrowserSupply({ assets: pack.assets, profileDir });

  expect(await supply.launchCommand("https://example.com/")).toContain(`--user-data-dir=${legacy}`);
  expect(existsSync(legacy)).toBeTrue();
  expect(existsSync(supply.profilePath)).toBeFalse();

  holder.kill("SIGKILL");
  await holder.exited;
  expect(await supply.launchCommand("https://example.com/")).toContain(`--user-data-dir=${supply.profilePath}`);
  expect(readFileSync(path.join(supply.profilePath, "Local State"), "utf8")).toBe("{}");
  expect(existsSync(legacy)).toBeFalse();
});

async function childOf(pid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const [child] = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
      if (child !== undefined) return Number(child);
    } catch {
      // Not yet forked.
    }
    await Bun.sleep(10);
  }
  throw new Error(`process ${pid} started no child`);
}

test("the identity predicate accepts the pack binary and its descendants only", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  // Small real binaries stand in for Chromium: one is the resolved pack binary,
  // the other is a different binary that would carry a Chromium-like app id.
  const shell = Bun.which("bash", { PATH: "/usr/bin:/bin" })!;
  const packBinary = path.join(root, "pack", "chrome-linux64", "chrome");
  const otherBinary = path.join(root, "host", "usr", "bin", "chromium");
  for (const target of [packBinary, otherBinary]) {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(shell, target);
    chmodSync(target, 0o755);
  }
  const supply = new BrowserSupply({
    assets: {
      ensureFonts: async () => ({ fontConfigFile: "" }),
      ensureBrowser: async () => ({ browserBin: path.join(root!, "pack", "browser"), executable: packBinary }),
    },
    profileDir: path.join(root, "profile"),
  });
  const pack = Bun.spawn([packBinary, "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
  const other = Bun.spawn([otherBinary, "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
  children.push(pack, other);
  const packChild = await childOf(pack.pid);
  const otherChild = await childOf(other.pid);

  // Before the pack is resolved nothing is the pack.
  expect(supply.isPackBrowser(pack.pid)).toBeFalse();
  await supply.ensurePack();
  expect(supply.isPackBrowser(pack.pid)).toBeTrue();
  expect(supply.isPackBrowser(packChild)).toBeTrue();
  expect(supply.isPackBrowser(other.pid)).toBeFalse();
  expect(supply.isPackBrowser(otherChild)).toBeFalse();
  expect(supply.isPackBrowser(process.pid)).toBeFalse();
});

test("a pack launch the Service spawned is the pack, with its descendants, until forgotten", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const pack = fixturePack(root);
  const supply = new BrowserSupply({ assets: pack.assets, profileDir: path.join(root, "profile") });
  const launched = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
  const unrelated = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
  children.push(launched, unrelated);
  const descendant = await childOf(launched.pid);
  supply.trackLaunch(launched.pid, processIdentity(launched.pid));
  expect(supply.isPackBrowser(launched.pid)).toBeTrue();
  expect(supply.isPackBrowser(descendant)).toBeTrue();
  expect(supply.isPackBrowser(unrelated.pid)).toBeFalse();
  supply.forgetLaunch(launched.pid);
  expect(supply.isPackBrowser(descendant)).toBeFalse();
});

/**
 * A Bot Computer whose pack binary is a copy of a real shell, so a real process
 * can stand in for the pack browser: `/proc/<pid>/exe` then is that path.
 */
function fixturePackBinary(base: string): { packBinary: string; assets: BotComputerAssetSupply } {
  const shell = Bun.which("bash", { PATH: "/usr/bin:/bin" })!;
  const packBinary = path.join(base, "pack", "portable-browser");
  mkdirSync(path.dirname(packBinary), { recursive: true });
  copyFileSync(shell, packBinary);
  chmodSync(packBinary, 0o755);
  return {
    packBinary,
    assets: {
      ensureFonts: async () => ({ fontConfigFile: path.join(base, "fonts.conf") }),
      ensureBrowser: async () => ({ browserBin: packBinary, executable: packBinary }),
    },
  };
}

/** A stand-in pack browser started with `--user-data-dir` and a per-test script. */
function spawnFakePack(packBinary: string, script: string, userDataDir: string) {
  return Bun.spawn([packBinary, "-c", script, "sh", `--user-data-dir=${userDataDir}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

async function settled(child: { exited: Promise<number> }, waitMs: number): Promise<"exited" | "alive"> {
  return await Promise.race([
    child.exited.then(() => "exited" as const),
    Bun.sleep(waitMs).then(() => "alive" as const),
  ]);
}

test("orphans are this Bot Computer's pack processes that no held pipe covers", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const { packBinary, assets } = fixturePackBinary(root);
  const supply = new BrowserSupply({ assets, profileDir: path.join(root, "profile", "computer") });
  // Nothing is the pack before the pack executable is resolved, so nothing is an orphan.
  expect(supply.orphanPacks()).toEqual([]);
  await supply.ensurePack();

  const pipeLess = spawnFakePack(packBinary, "sleep 30 & wait", supply.profilePath);
  // Same binary, another Bot Computer's profile: never this Service's to stop.
  const foreign = spawnFakePack(packBinary, "sleep 30 & wait", path.join(root, "other", "omarchy-bot-browser"));
  // A non-pack process that happens to carry this profile: identity decides, not the argument.
  const notThePack = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait", "sh", `--user-data-dir=${supply.profilePath}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(pipeLess, foreign, notThePack);
  const pipeLessChild = await childOf(pipeLess.pid);
  expect(supply.isPackBrowser(pipeLessChild)).toBeTrue();

  const orphans = () => supply.orphanPacks().map((orphan) => orphan.pid).sort();
  expect(orphans()).toEqual([pipeLess.pid, pipeLessChild].sort());

  // The pid tree of a launch whose CDP pipe the Service holds is not an orphan.
  supply.trackLaunch(pipeLess.pid, processIdentity(pipeLess.pid));
  expect(supply.orphanPacks()).toEqual([]);
  supply.forgetLaunch(pipeLess.pid);
  expect(orphans()).toEqual([pipeLess.pid, pipeLessChild].sort());
});

test("stopping orphans ends a SIGTERM-resistant pack and leaves every other process alone", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const { packBinary, assets } = fixturePackBinary(root);
  const supply = new BrowserSupply({ assets, profileDir: path.join(root, "profile", "computer") });
  await supply.ensurePack();

  const resistant = spawnFakePack(packBinary, "trap '' TERM; while :; do sleep 1; done", supply.profilePath);
  const foreign = spawnFakePack(packBinary, "sleep 30 & wait", path.join(root, "other", "omarchy-bot-browser"));
  const notThePack = Bun.spawn(["/bin/sh", "-c", "sleep 30 & wait", "sh", `--user-data-dir=${supply.profilePath}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(resistant, foreign, notThePack);

  expect(await supply.stopOrphanPacks(200)).toContain(resistant.pid);
  expect(await settled(resistant, 2_000)).toBe("exited");
  expect(await settled(foreign, 300)).toBe("alive");
  expect(await settled(notThePack, 300)).toBe("alive");
  expect(supply.orphanPacks()).toEqual([]);
});

test("a missing pack is reported with the install command and no host browser runs", async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-browser-supply-"));
  const host = fixtureHost(root);
  const profileDir = path.join(root, "profile", "computer");
  const supply = new BrowserSupply({
    assets: new PortableBotComputerAssets({ profileDir, browserPackDir: path.join(root, "no-pack") }),
    profileDir,
  });
  expect(BROWSER_PACK_MISSING).toContain("browser pack is missing");
  expect(BROWSER_PACK_MISSING).toContain("omarchy-bot update");
  await expect(supply.launchCommand("https://example.com/")).rejects.toThrow(BROWSER_PACK_MISSING);
  await expect(supply.ensurePack()).rejects.toThrow(BROWSER_PACK_MISSING);
  await supply.prepare();
  const env = screenEnvironment(supply, profileDir, host, root);
  const run = Bun.spawnSync(["/bin/sh", "-c", "brave https://x.example/"], { env, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(127);
  expect(run.stderr.toString()).toContain(BROWSER_PACK_MISSING);
  expect(existsSync(host.braveMarker)).toBeFalse();
});

test("the removed host-browser setting only produces an ignored notice", () => {
  expect(ignoredBrowserSelectionNotice({})).toBeUndefined();
  expect(ignoredBrowserSelectionNotice({ OMARCHY_BOT_BROWSER: "" })).toBeUndefined();
  expect(ignoredBrowserSelectionNotice({ OMARCHY_BOT_BROWSER: "host" })).toBe(
    "OMARCHY_BOT_BROWSER is ignored: every Bot uses the bundled browser pack (Computer ADR 0013).",
  );
});
