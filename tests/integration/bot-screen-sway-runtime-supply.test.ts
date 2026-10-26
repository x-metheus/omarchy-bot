import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PortableSwayRuntimeSupply,
  SWAY_RUNTIME_BUNDLE,
  SWAY_RUNTIME_RELEASE,
  resolveSwayRuntimeBinaries,
  type SwayRuntimeBinaries,
} from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";

let root: string | undefined;
const network = spyOn(globalThis, "fetch").mockRejectedValue(
  new Error("runtime supply must not use the network"),
);

beforeEach(() => { network.mockClear(); });
afterAll(() => { network.mockRestore(); });

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  expect(network).not.toHaveBeenCalled();
});

const LAUNCHERS = [
  "sway",
  "swaymsg",
  "wayvnc",
  "wlr-randr",
  "Xwayland",
  "grim",
  "dbus-daemon",
  "omarchy-bot-wayland-input",
  "omarchy-bot-wayland-capture",
  "omarchy-bot-desktop",
] as const;

const MARKER = `${SWAY_RUNTIME_RELEASE}\n${SWAY_RUNTIME_BUNDLE.sha256}\n`;

function supplyRoot(): string {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-bundle-"));
  return path.join(root, "runtime", "current", "sway");
}

function writeBundle(destination: string): void {
  const binDir = path.join(destination, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const launcher of LAUNCHERS) {
    const target = path.join(binDir, launcher);
    writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' "$0"\n`, { mode: 0o700 });
  }
  writeFileSync(path.join(destination, ".omarchy-bot-runtime"), MARKER);
}

test("runs every installed bundle launcher without writing to the bundle or using the network", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const before = statSync(supplyDir).mtimeMs;
  const supply = new PortableSwayRuntimeSupply({ rootDir: supplyDir });

  const binaries = await supply.ensure();
  const expected: [keyof SwayRuntimeBinaries, string][] = [
    ["swayBin", "sway"],
    ["swaymsgBin", "swaymsg"],
    ["wayvncBin", "wayvnc"],
    ["wlrRandrBin", "wlr-randr"],
    ["xwaylandBin", "Xwayland"],
    ["grimBin", "grim"],
    ["dbusDaemonBin", "dbus-daemon"],
    ["inputHelperBin", "omarchy-bot-wayland-input"],
    ["captureHelperBin", "omarchy-bot-wayland-capture"],
    ["botDesktopBin", "omarchy-bot-desktop"],
  ];
  for (const [field, launcher] of expected) {
    const resolved = binaries[field];
    expect(resolved).toBe(path.join(supplyDir, "bin", launcher));
    const ran = Bun.spawnSync([resolved]);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString().trim()).toBe(resolved);
  }
  expect(await supply.ensure()).toEqual(binaries);
  expect(readdirSync(supplyDir).sort()).toEqual([".omarchy-bot-runtime", "bin"]);
  expect(statSync(supplyDir).mtimeMs).toBe(before);
});

test("returns absolute launcher paths when given a relative installed directory", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const binaries = await new PortableSwayRuntimeSupply({
    rootDir: path.relative(process.cwd(), supplyDir),
  }).ensure();
  expect(binaries.swayBin).toBe(path.join(supplyDir, "bin", "sway"));
});

test("names the absent installed bundle directory without creating it", async () => {
  const supplyDir = supplyRoot();
  await expect(new PortableSwayRuntimeSupply({ rootDir: supplyDir }).ensure()).rejects.toThrow(supplyDir);
  expect(existsSync(supplyDir)).toBeFalse();
});

test("names a missing ready marker and leaves the installed tree untouched", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const markerPath = path.join(supplyDir, ".omarchy-bot-runtime");
  rmSync(markerPath);
  await expect(new PortableSwayRuntimeSupply({ rootDir: supplyDir }).ensure()).rejects.toThrow(markerPath);
  expect(readdirSync(supplyDir)).toEqual(["bin"]);
});

test("refuses a checksum marker mismatch and reports the expected and received pins", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const markerPath = path.join(supplyDir, ".omarchy-bot-runtime");
  const received = `${SWAY_RUNTIME_RELEASE}\n${"0".repeat(64)}\n`;
  writeFileSync(markerPath, received);
  await expect(new PortableSwayRuntimeSupply({ rootDir: supplyDir }).ensure()).rejects.toThrow(
    `expected ${JSON.stringify(MARKER)}, received ${JSON.stringify(received)}`,
  );
  expect(readFileSync(markerPath, "utf8")).toBe(received);
});

test("refuses a marker for a different release even when its checksum matches", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const received = `another-release\n${SWAY_RUNTIME_BUNDLE.sha256}\n`;
  writeFileSync(path.join(supplyDir, ".omarchy-bot-runtime"), received);
  await expect(new PortableSwayRuntimeSupply({ rootDir: supplyDir }).ensure()).rejects.toThrow(
    `expected ${JSON.stringify(MARKER)}, received ${JSON.stringify(received)}`,
  );
});

test("rejects a missing launcher by its installed path without deleting the bundle", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const launcherPath = path.join(supplyDir, "bin", "grim");
  rmSync(launcherPath);
  await expect(new PortableSwayRuntimeSupply({ rootDir: supplyDir }).ensure()).rejects.toThrow(launcherPath);
  expect(readFileSync(path.join(supplyDir, ".omarchy-bot-runtime"), "utf8")).toBe(MARKER);
  expect(existsSync(path.join(supplyDir, "bin", "sway"))).toBeTrue();
});

test("rejects a nonexecutable launcher by its installed path", async () => {
  const supplyDir = supplyRoot();
  writeBundle(supplyDir);
  const launcherPath = path.join(supplyDir, "bin", "omarchy-bot-desktop");
  chmodSync(launcherPath, 0o600);
  await expect(new PortableSwayRuntimeSupply({ rootDir: supplyDir }).ensure()).rejects.toThrow(launcherPath);
});

test("rejects an unsupported platform before accessing the installed bundle", async () => {
  const supplyDir = supplyRoot();
  await expect(new PortableSwayRuntimeSupply({
    rootDir: supplyDir,
    platform: "linux",
    arch: "arm64",
  }).ensure()).rejects.toThrow("requires Linux on x86_64");
  expect(existsSync(supplyDir)).toBeFalse();
});

const BUNDLE_BINARIES: SwayRuntimeBinaries = {
  swayBin: "/bundle/bin/sway",
  swaymsgBin: "/bundle/bin/swaymsg",
  wayvncBin: "/bundle/bin/wayvnc",
  wlrRandrBin: "/bundle/bin/wlr-randr",
  xwaylandBin: "/bundle/bin/Xwayland",
  grimBin: "/bundle/bin/grim",
  dbusDaemonBin: "/bundle/bin/dbus-daemon",
  inputHelperBin: "/bundle/bin/omarchy-bot-wayland-input",
  captureHelperBin: "/bundle/bin/omarchy-bot-wayland-capture",
  botDesktopBin: "/bundle/bin/omarchy-bot-desktop",
};

test("prefers the bundle over installed host tools", async () => {
  const resolved = await resolveSwayRuntimeBinaries({
    supply: { ensure: async () => BUNDLE_BINARIES },
    findExecutable: (candidate) => `/usr/bin/${candidate}`,
  });
  expect(resolved).toEqual(BUNDLE_BINARIES);
});

test("fills an incomplete explicit override set from the bundle", async () => {
  let supplyCalls = 0;
  const resolved = await resolveSwayRuntimeBinaries({
    supply: { ensure: async () => { supplyCalls += 1; return BUNDLE_BINARIES; } },
    swayOverride: "/configured/sway",
    findExecutable: (candidate) => candidate,
  });
  expect(supplyCalls).toBe(1);
  expect(resolved).toEqual({ ...BUNDLE_BINARIES, swayBin: "/configured/sway" });
});

test("lets explicit overrides win and skips the bundle when the set is complete", async () => {
  let supplyCalls = 0;
  const resolved = await resolveSwayRuntimeBinaries({
    supply: { ensure: async () => { supplyCalls += 1; return BUNDLE_BINARIES; } },
    findExecutable: (candidate) => candidate,
    swayOverride: "/configured/sway",
    swaymsgOverride: "/configured/swaymsg",
    wayvncOverride: "/configured/wayvnc",
    wlrRandrOverride: "/configured/wlr-randr",
    xwaylandOverride: "/configured/Xwayland",
    grimOverride: "/configured/grim",
    dbusDaemonOverride: "/configured/dbus-daemon",
    inputHelperOverride: "/configured/input",
    captureHelperOverride: "/configured/capture",
    botDesktopOverride: "/configured/bot-desktop",
  });
  expect(supplyCalls).toBe(0);
  expect(Object.values(resolved).every((binary) => binary.startsWith("/configured/"))).toBeTrue();
});

test("keeps an unavailable explicit override authoritative", async () => {
  let supplyCalls = 0;
  await expect(resolveSwayRuntimeBinaries({
    swayOverride: "/configured/missing-sway",
    supply: { ensure: async () => { supplyCalls += 1; return BUNDLE_BINARIES; } },
    findExecutable: () => undefined,
  })).rejects.toThrow("configured Sway executable is unavailable: /configured/missing-sway");
  expect(supplyCalls).toBe(0);
});
