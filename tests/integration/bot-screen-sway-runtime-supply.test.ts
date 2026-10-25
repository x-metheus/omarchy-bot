import { afterEach, expect, test } from "bun:test";
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
  SWAY_RUNTIME_RELEASE,
  resolveSwayRuntimeBinaries,
  type SwayRuntimeBinaries,
  type SwayRuntimeBundle,
} from "../../apps/daemon/src/modules/computer/swayRuntimeSupply.ts";

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
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

function fixtureBundle(archive = "verified portable sway runtime fixture"): {
  bundle: SwayRuntimeBundle;
  archive: string;
} {
  return {
    archive,
    bundle: {
      release: SWAY_RUNTIME_RELEASE,
      url: "https://packages.invalid/omarchy-bot-sway-runtime.tar.gz",
      sha256: new Bun.CryptoHasher("sha256").update(archive).digest("hex"),
    },
  };
}

/** Extracts launchers that print the path they were executed from. */
function writeLaunchers(destination: string, launchers: readonly string[] = LAUNCHERS): void {
  const binDir = path.join(destination, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const launcher of launchers) {
    const target = path.join(binDir, launcher);
    writeFileSync(target, `#!/bin/sh\nprintf '%s\\n' "$0"\n`);
    chmodSync(target, 0o700);
  }
}

function bundleSupply(options: {
  rootDir: string;
  bundle: SwayRuntimeBundle;
  archive?: string;
  launchers?: readonly string[];
  onFetch?: () => void;
}): PortableSwayRuntimeSupply {
  const { archive = "verified portable sway runtime fixture" } = options;
  return new PortableSwayRuntimeSupply({
    rootDir: options.rootDir,
    bundle: options.bundle,
    fetch: async () => {
      options.onFetch?.();
      return new Response(archive);
    },
    extractArchive: async (_archivePath, destination) => {
      writeLaunchers(destination, options.launchers);
    },
  });
}

function supplyRoot(): string {
  root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-sway-bundle-"));
  return root;
}

test("refuses a checksum mismatch without extracting or publishing", async () => {
  const supplyDir = supplyRoot();
  let extractionCalls = 0;
  const supply = new PortableSwayRuntimeSupply({
    rootDir: supplyDir,
    bundle: { ...fixtureBundle().bundle, sha256: "0".repeat(64) },
    fetch: async () => new Response("tampered archive"),
    extractArchive: async () => {
      extractionCalls += 1;
    },
  });

  await expect(supply.ensure()).rejects.toThrow("Sway runtime bundle failed SHA-256 verification");
  expect(extractionCalls).toBe(0);
  expect(readdirSync(supplyDir)).toEqual([]);
});

test("publishes a verified bundle and runs every bundled launcher from its cache", async () => {
  const supplyDir = supplyRoot();
  const { bundle, archive } = fixtureBundle();
  const supply = bundleSupply({ rootDir: supplyDir, bundle, archive });

  const binaries = await supply.ensure();
  const [published] = readdirSync(supplyDir);
  expect(published).toBe(`${SWAY_RUNTIME_RELEASE}-${bundle.sha256.slice(0, 16)}`);

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
    expect(resolved).toBe(path.join(supplyDir, published!, "bin", launcher));
    expect(statSync(resolved).mode & 0o111).not.toBe(0);
    const ran = Bun.spawnSync([resolved]);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString().trim()).toBe(resolved);
  }
});

test("never exposes a partial bundle while publishing", async () => {
  const supplyDir = supplyRoot();
  const { bundle, archive } = fixtureBundle();
  const published = `${SWAY_RUNTIME_RELEASE}-${bundle.sha256.slice(0, 16)}`;
  let visibleDuringExtraction: boolean | undefined;
  const supply = new PortableSwayRuntimeSupply({
    rootDir: supplyDir,
    bundle,
    fetch: async () => new Response(archive),
    extractArchive: async (_archivePath, destination) => {
      writeLaunchers(destination);
      visibleDuringExtraction = existsSync(path.join(supplyDir, published));
    },
  });

  const binaries = await supply.ensure();

  // Half-extracted launchers stay under a private name until the rename.
  expect(visibleDuringExtraction).toBeFalse();
  expect(binaries.swayBin).toBe(path.join(supplyDir, published, "bin", "sway"));
  expect(readdirSync(supplyDir)).toEqual([published]);
});

test("reuses a verified cached bundle without fetching again", async () => {
  const supplyDir = supplyRoot();
  const { bundle, archive } = fixtureBundle();
  let fetchCalls = 0;
  const supply = bundleSupply({
    rootDir: supplyDir,
    bundle,
    archive,
    onFetch: () => {
      fetchCalls += 1;
    },
  });

  const first = await supply.ensure();
  const second = await supply.ensure();
  expect(fetchCalls).toBe(1);
  expect(second).toEqual(first);
});

test("invalidates the cache when the pinned checksum changes", async () => {
  const supplyDir = supplyRoot();
  const first = fixtureBundle("first archive");
  await bundleSupply({ rootDir: supplyDir, bundle: first.bundle, archive: first.archive }).ensure();

  const second = fixtureBundle("second archive");
  let fetchCalls = 0;
  const binaries = await bundleSupply({
    rootDir: supplyDir,
    bundle: second.bundle,
    archive: second.archive,
    onFetch: () => {
      fetchCalls += 1;
    },
  }).ensure();

  expect(fetchCalls).toBe(1);
  expect(binaries.swayBin).toContain(second.bundle.sha256.slice(0, 16));
  expect(readdirSync(supplyDir).sort()).toEqual([
    `${SWAY_RUNTIME_RELEASE}-${first.bundle.sha256.slice(0, 16)}`,
    `${SWAY_RUNTIME_RELEASE}-${second.bundle.sha256.slice(0, 16)}`,
  ].sort());
});

test("rejects a bundle missing a required launcher and publishes nothing", async () => {
  const supplyDir = supplyRoot();
  const { bundle, archive } = fixtureBundle();
  const supply = bundleSupply({
    rootDir: supplyDir,
    bundle,
    archive,
    launchers: LAUNCHERS.filter((launcher) => launcher !== "grim"),
  });

  await expect(supply.ensure()).rejects.toThrow("did not contain executable bin/grim");
  expect(readdirSync(supplyDir)).toEqual([]);
});

test("rejects an unsupported platform before downloading", async () => {
  const supplyDir = supplyRoot();
  let fetchCalls = 0;
  const supply = new PortableSwayRuntimeSupply({
    rootDir: supplyDir,
    platform: "linux",
    arch: "arm64",
    bundle: fixtureBundle().bundle,
    fetch: async () => {
      fetchCalls += 1;
      return new Response("unused");
    },
  });

  await expect(supply.ensure()).rejects.toThrow("requires Linux on x86_64");
  expect(fetchCalls).toBe(0);
  expect(readdirSync(supplyDir)).toEqual([]);
});

test("ensure does not create or touch a running Bot Desktop Session directory", async () => {
  const supplyDir = supplyRoot();
  const sessionDir = path.join(supplyDir, "running-session");
  const sentinel = path.join(sessionDir, "session.json");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(sentinel, "{\"generation\":1}\n", { mode: 0o600 });
  const before = {
    entries: readdirSync(sessionDir),
    sentinel: readFileSync(sentinel, "utf8"),
    mode: statSync(sessionDir).mode,
    mtimeMs: statSync(sentinel).mtimeMs,
  };

  const { bundle, archive } = fixtureBundle();
  const binaries = await bundleSupply({
    rootDir: path.join(supplyDir, "runtime", "sway"),
    bundle,
    archive,
  }).ensure();

  expect(existsSync(binaries.swayBin)).toBeTrue();
  expect(readdirSync(sessionDir)).toEqual(before.entries);
  expect(readFileSync(sentinel, "utf8")).toBe(before.sentinel);
  expect(statSync(sessionDir).mode).toBe(before.mode);
  expect(statSync(sentinel).mtimeMs).toBe(before.mtimeMs);
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

function supplyOf(binaries: SwayRuntimeBinaries): { supply: { ensure(): Promise<SwayRuntimeBinaries> } } {
  return { supply: { ensure: async () => binaries } };
}

test("prefers the bundle over installed host tools", async () => {
  const { supply } = supplyOf(BUNDLE_BINARIES);
  const resolved = await resolveSwayRuntimeBinaries({
    supply,
    findExecutable: (candidate) => `/usr/bin/${candidate}`,
  });
  expect(resolved).toEqual(BUNDLE_BINARIES);
});

test("lets explicit overrides win and skips the bundle when the set is complete", async () => {
  let supplyCalls = 0;
  const overrides = {
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
  };
  const resolved = await resolveSwayRuntimeBinaries({
    supply: {
      ensure: async () => {
        supplyCalls += 1;
        return BUNDLE_BINARIES;
      },
    },
    findExecutable: (candidate) => (candidate.includes("/") ? candidate : undefined),
    ...overrides,
  });

  expect(supplyCalls).toBe(0);
  expect(resolved).toEqual({
    swayBin: "/configured/sway",
    swaymsgBin: "/configured/swaymsg",
    wayvncBin: "/configured/wayvnc",
    wlrRandrBin: "/configured/wlr-randr",
    xwaylandBin: "/configured/Xwayland",
    grimBin: "/configured/grim",
    dbusDaemonBin: "/configured/dbus-daemon",
    inputHelperBin: "/configured/input",
    captureHelperBin: "/configured/capture",
    botDesktopBin: "/configured/bot-desktop",
  });
});

test("keeps an unavailable explicit override authoritative", async () => {
  let supplyCalls = 0;
  await expect(resolveSwayRuntimeBinaries({
    swayOverride: "/configured/missing-sway",
    supply: {
      ensure: async () => {
        supplyCalls += 1;
        return BUNDLE_BINARIES;
      },
    },
    findExecutable: (candidate) => (candidate.includes("/") ? undefined : `/usr/bin/${candidate}`),
  })).rejects.toThrow("configured Sway executable is unavailable: /configured/missing-sway");
  expect(supplyCalls).toBe(0);
});

test("fails an incomplete cache entry without deleting it", async () => {
  const supplyDir = supplyRoot();
  const { bundle, archive } = fixtureBundle();
  const cacheDir = path.join(supplyDir, `${SWAY_RUNTIME_RELEASE}-${bundle.sha256.slice(0, 16)}`);
  const stale = path.join(cacheDir, "bin", "sway");
  mkdirSync(path.dirname(stale), { recursive: true });
  writeFileSync(stale, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  await expect(bundleSupply({ rootDir: supplyDir, bundle, archive }).ensure()).rejects
    .toThrow(`is incomplete; remove that directory and retry`);
  // The preseeded key is the one the supply targets: no second cache entry and
  // no leftover staging tree, and the foreign bytes are untouched.
  expect(readdirSync(supplyDir)).toEqual([path.basename(cacheDir)]);
  expect(readFileSync(stale, "utf8")).toBe("#!/bin/sh\nexit 0\n");
  expect(readdirSync(cacheDir)).toEqual(["bin"]);
});
