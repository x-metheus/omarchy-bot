import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { appSigningKey } from "./helpers/appSignatureFixture.ts";

const releaseKey = appSigningKey().publicKey;
const projectRoot = path.resolve(import.meta.dir, "../..");
const packager = path.join(projectRoot, "scripts", "package-plugin-runtime.sh");
const roots: string[] = [];

const helperPaths = [
  "apps/daemon/dist/native-pointer/omarchy-bot-wayland-input",
  "apps/daemon/dist/native-capture/omarchy-bot-wayland-capture",
  "apps/daemon/dist/native-bot-desktop/omarchy-bot-desktop",
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function writeExecutable(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  write(root, relativePath, contents);
  chmodSync(file, 0o700);
}

interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

function run(
  argv: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): CommandResult {
  return Bun.spawnSync(argv, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function assertSucceeded(result: CommandResult, operation: string): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${operation} failed (${result.exitCode})\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
  );
}

function createFixture(): { root: string; cache: string; output: string; bundle: string; bundleSha256: string; fonts: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-runtime-package-"));
  roots.push(root);
  const cache = path.join(root, ".bun-cache");
  const output = path.join(root, "output");
  const bundle = path.join(root, "sway-runtime.tar.gz");
  const bundleRoot = path.join(root, "sway-bundle");
  for (const launcher of ["sway", "swaymsg"]) {
    writeExecutable(bundleRoot, `bin/${launcher}`, `#!/bin/sh\nprintf '%s\\n' ${launcher}\n`);
  }
  const archive = run(["tar", "-czf", bundle, "-C", bundleRoot, "."], { cwd: root });
  assertSucceeded(archive, "Sway fixture archiving");
  const bundleSha256 = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  write(
    root,
    "apps/daemon/src/modules/computer/swayRuntimeSupply.ts",
    `export const SWAY_RUNTIME_RELEASE = "sway-fixture-v1";\nexport const SWAY_RUNTIME_BUNDLE = { sha256: "${bundleSha256}" };\n`,
  );
  const fonts = path.join(root, "prepared-fonts");
  const font = "Fixture[wght].ttf";
  const fontBytes = "fixture font bytes";
  const fontSha256 = createHash("sha256").update(fontBytes).digest("hex");
  write(fonts, font, fontBytes);
  write(fonts, "FixtureCJK[wght].ttf", fontBytes);
  write(root, "apps/daemon/src/modules/computer/botComputerAssets.ts", `export const FONT_ASSETS = Object.freeze([
  { file: "${font}", url: "https://assets.invalid/font.ttf", sha256: "${fontSha256}" },
  { file: "FixtureCJK[wght].ttf", url: "https://assets.invalid/cjk.ttf", sha256: "${fontSha256}" },
]);\n`);

  write(
    root,
    "package.json",
    JSON.stringify({
      name: "plugin-runtime-fixture",
      private: true,
      type: "module",
      workspaces: ["apps/*"],
      devDependencies: {
        "fixture-development-only": "file:packages/fixture-development-only",
      },
    }),
  );
  write(root, "bunfig.toml", '[install]\nlinker = "hoisted"\n');
  write(
    root,
    "apps/daemon/package.json",
    JSON.stringify({
      name: "@fixture/daemon",
      private: true,
      type: "module",
      dependencies: {
        "fixture-runtime-dependency": "file:../../packages/fixture-runtime-dependency",
      },
    }),
  );
  write(
    root,
    "packages/fixture-runtime-dependency/package.json",
    JSON.stringify({
      name: "fixture-runtime-dependency",
      version: "1.0.0",
      type: "module",
      exports: "./index.ts",
    }),
  );
  write(
    root,
    "packages/fixture-runtime-dependency/index.ts",
    'export const runtimeValue = "runtime dependency resolved";\nexport const nativeHelper = new URL("./native-helper", import.meta.url);\n',
  );
  writeExecutable(
    root,
    "packages/fixture-runtime-dependency/native-helper",
    "#!/bin/sh\nprintf 'native runtime dependency executed\\n'\n",
  );
  write(
    root,
    "packages/fixture-development-only/package.json",
    JSON.stringify({
      name: "fixture-development-only",
      version: "1.0.0",
      type: "module",
      exports: "./index.ts",
    }),
  );
  write(
    root,
    "packages/fixture-development-only/index.ts",
    'export const developmentValue = "development dependency resolved";\n',
  );
  write(
    root,
    "apps/daemon/src/bootstrap/main.ts",
    `import { writeFileSync } from "node:fs";
import { nativeHelper, runtimeValue } from "fixture-runtime-dependency";

if (runtimeValue !== "runtime dependency resolved") throw new Error("runtime dependency did not resolve");
const native = Bun.spawnSync([nativeHelper.pathname], { stdout: "pipe", stderr: "pipe" });
if (native.exitCode !== 0 || native.stdout.toString().trim() !== "native runtime dependency executed") {
  throw new Error(\`native runtime dependency failed: \${native.stderr.toString()}\`);
}

let developmentValue: string | undefined;
try {
  developmentValue = (await import("fixture-development-only")).developmentValue;
} catch (error) {
  if (process.env.EXPECT_DEVELOPMENT_DEPENDENCY === "1") throw error;
}
if (process.env.EXPECT_DEVELOPMENT_DEPENDENCY === "1") {
  if (developmentValue !== "development dependency resolved") {
    throw new Error("source development dependency did not resolve");
  }
} else if (developmentValue !== undefined) {
  throw new Error("development-only dependency leaked into production runtime");
}
if (process.env.OMARCHY_BOT_SERVE_FIXTURE_MARKER !== undefined) {
  writeFileSync(process.env.OMARCHY_BOT_SERVE_FIXTURE_MARKER, String(process.pid));
}
`,
  );
  write(root, "apps/web/dist/index.html", "<!doctype html><title>built web fixture</title>\n");
  writeExecutable(
    root,
    "scripts/serve.sh",
    readFileSync(path.join(projectRoot, "scripts", "serve.sh"), "utf8"),
  );
  for (const helper of helperPaths) {
    writeExecutable(root, helper, `#!/bin/sh\nprintf '%s\\n' ${path.basename(helper)}\n`);
  }

  return { root, cache, output, bundle, bundleSha256, fonts };
}

test("packages a runnable production dependency tree without mutating the source install", () => {
  const fixture = createFixture();
  const installEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: fixture.cache, TAURI_UPDATER_PUBKEY: releaseKey };
  const install = run(["bun", "install"], { cwd: fixture.root, env: installEnv });
  assertSucceeded(install, "fixture dependency install");

  const sourceBefore = run(["bun", "apps/daemon/src/bootstrap/main.ts"], {
    cwd: fixture.root,
    env: { ...installEnv, EXPECT_DEVELOPMENT_DEPENDENCY: "1" },
  });
  assertSucceeded(sourceBefore, "source fixture consumer before packaging");
  const lockBefore = readFileSync(path.join(fixture.root, "bun.lock"));

  const revision = "0123456789abcdef0123456789abcdef01234567";
  const packaged = run(["bash", packager, fixture.root, fixture.output, fixture.bundle, fixture.fonts], {
    cwd: projectRoot,
    env: { ...installEnv, OMARCHY_BOT_PLUGIN_REVISION: revision },
  });
  assertSucceeded(packaged, "runtime packaging");

  const archive = path.join(
    fixture.output,
    `omarchy-bot-runtime-${revision}-x86_64.tar.zst`,
  );
  expect(packaged.stdout.toString()).toBe(`${archive}\n`);
  const checksum = run(["sha256sum", "--check", `${archive}.sha256`], { cwd: fixture.output });
  assertSucceeded(checksum, "runtime checksum verification");

  const extracted = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-runtime-extracted-"));
  roots.push(extracted);
  const extract = run(["tar", "--zstd", "-xf", archive, "-C", extracted], {
    cwd: fixture.root,
  });
  assertSucceeded(extract, "runtime extraction");
  expect(existsSync(path.join(extracted, "apps/web/dist"))).toBe(false);
  expect(readFileSync(path.join(extracted, "apps/cli/src/release-public-key"), "utf8").trim()).toBe(releaseKey);

  expect(readFileSync(path.join(extracted, "sway/.omarchy-bot-runtime"), "utf8"))
    .toBe(`sway-fixture-v1\n${fixture.bundleSha256}\n`);
  expect(readFileSync(path.join(extracted, "fonts/Fixture[wght].ttf"), "utf8")).toBe("fixture font bytes");
  expect(readFileSync(path.join(extracted, "fonts/FixtureCJK[wght].ttf"), "utf8")).toBe("fixture font bytes");
  for (const launcher of ["sway", "swaymsg"]) {
    const launched = run([path.join(extracted, "sway/bin", launcher)], { cwd: extracted });
    assertSucceeded(launched, `packaged ${launcher} launcher`);
    expect(launched.stdout.toString()).toBe(`${launcher}\n`);
  }

  const packagedConsumer = run(["bun", "apps/daemon/src/bootstrap/main.ts"], {
    cwd: extracted,
    env: installEnv,
  });
  assertSucceeded(packagedConsumer, "packaged daemon consumer");

  // The archive must ship a runnable entry, so run it exactly as a Launcher
  // would: fixture home, isolated per-user lock, real Bun from PATH.
  const runRoot = path.join(fixture.root, "serve-run");
  const uid = 930_000 + process.pid;
  const lockDir = `/tmp/omarchy-bot-${uid}`;
  writeExecutable(runRoot, "bin/id", `#!/bin/sh\nprintf '%s\\n' ${uid}\n`);
  try {
    const marker = path.join(runRoot, "service-ran");
    const packagedServe = run(["bash", "scripts/serve.sh"], {
      cwd: extracted,
      env: {
        ...installEnv,
        PATH: `${path.join(runRoot, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(runRoot, "home"),
        XDG_RUNTIME_DIR: path.join(runRoot, "runtime"),
        OMARCHY_BOT_HOME: path.join(runRoot, "data"),
        OMARCHY_BOT_STATE: path.join(runRoot, "state"),
        OMARCHY_BOT_SERVE_FIXTURE_MARKER: marker,
      },
    });
    assertSucceeded(packagedServe, "packaged serve entry");
    expect(readFileSync(marker, "utf8")).toMatch(/^\d+$/);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }

  expect(readFileSync(path.join(fixture.root, "bun.lock"))).toEqual(lockBefore);
  const sourceAfter = run(["bun", "apps/daemon/src/bootstrap/main.ts"], {
    cwd: fixture.root,
    env: { ...installEnv, EXPECT_DEVELOPMENT_DEPENDENCY: "1" },
  });
  assertSucceeded(sourceAfter, "source fixture consumer after packaging");
}, 60_000);

test("packages a keyless nonpublication runtime without a Web build or inherited trust key", () => {
  const fixture = createFixture();
  rmSync(path.join(fixture.root, "apps/web/dist"), { recursive: true });
  write(fixture.root, "apps/cli/src/release-public-key", releaseKey);
  const installEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: fixture.cache, TAURI_UPDATER_PUBKEY: undefined, RELEASE_BUILD: undefined };
  assertSucceeded(run(["bun", "install"], { cwd: fixture.root, env: installEnv }), "fixture dependency install");
  const packaged = run(["bash", packager, fixture.root, fixture.output, fixture.bundle, fixture.fonts], {
    cwd: projectRoot,
    env: { ...installEnv, OMARCHY_BOT_PLUGIN_REVISION: "without-web" },
  });
  assertSucceeded(packaged, "keyless runtime packaging without a Web build");
  const extracted = path.join(fixture.root, "extracted");
  mkdirSync(extracted);
  assertSucceeded(run(["tar", "--zstd", "-xf", path.join(fixture.output, "omarchy-bot-runtime-without-web-x86_64.tar.zst"), "-C", extracted], { cwd: fixture.root }), "keyless runtime extraction");
  expect(existsSync(path.join(extracted, "apps/cli/src/release-public-key"))).toBe(false);
});

test("refuses a Sway bundle that does not match the pinned checksum without writing an archive", () => {
  const fixture = createFixture();
  const installEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: fixture.cache };
  assertSucceeded(run(["bun", "install"], { cwd: fixture.root, env: installEnv }), "fixture dependency install");
  const expected = "0".repeat(64);
  write(
    fixture.root,
    "apps/daemon/src/modules/computer/swayRuntimeSupply.ts",
    `export const SWAY_RUNTIME_RELEASE = "sway-fixture-v1";\nexport const SWAY_RUNTIME_BUNDLE = { sha256: "${expected}" };\n`,
  );
  const revision = "wrong-checksum";
  const packaged = run(["bash", packager, fixture.root, fixture.output, fixture.bundle, fixture.fonts], {
    cwd: projectRoot,
    env: { ...installEnv, OMARCHY_BOT_PLUGIN_REVISION: revision },
  });

  expect(packaged.exitCode).not.toBe(0);
  expect(packaged.stderr.toString()).toContain(`expected ${expected}`);
  expect(packaged.stderr.toString()).toContain(`received ${fixture.bundleSha256}`);
  expect(existsSync(path.join(fixture.output, `omarchy-bot-runtime-${revision}-x86_64.tar.zst`)))
    .toBe(false);
});

test("refuses a font that does not match its pin without writing an archive", () => {
  const fixture = createFixture();
  const installEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: fixture.cache };
  assertSucceeded(run(["bun", "install"], { cwd: fixture.root, env: installEnv }), "fixture dependency install");
  const fontPath = path.join(fixture.fonts, "FixtureCJK[wght].ttf");
  writeFileSync(fontPath, "tampered");
  const expected = createHash("sha256").update("fixture font bytes").digest("hex");
  const received = createHash("sha256").update("tampered").digest("hex");
  const revision = "wrong-font-checksum";
  const packaged = run(["bash", packager, fixture.root, fixture.output, fixture.bundle, fixture.fonts], {
    cwd: projectRoot,
    env: { ...installEnv, OMARCHY_BOT_PLUGIN_REVISION: revision },
  });
  expect(packaged.exitCode).not.toBe(0);
  expect(packaged.stderr.toString()).toContain(fontPath);
  expect(packaged.stderr.toString()).toContain(`expected ${expected}`);
  expect(packaged.stderr.toString()).toContain(`received ${received}`);
  expect(existsSync(path.join(fixture.output, `omarchy-bot-runtime-${revision}-x86_64.tar.zst`))).toBe(false);
});

test.each(["", "true", "1"])("refuses malformed supplied trust keys in packaging mode %s", releaseBuild => {
  const fixture = createFixture();
  assertSucceeded(run(["bun", "install"], { cwd: fixture.root }), "fixture dependency install");
  const packaged = run(["bash", packager, fixture.root, fixture.output, fixture.bundle, fixture.fonts], {
    cwd: projectRoot,
    env: { ...process.env, OMARCHY_BOT_PLUGIN_REVISION: "bad-key", TAURI_UPDATER_PUBKEY: "not-a-key", RELEASE_BUILD: releaseBuild },
  });
  expect(packaged.exitCode).not.toBe(0);
  expect(packaged.stderr.toString()).toContain("release public key");
  expect(existsSync(path.join(fixture.output, "omarchy-bot-runtime-bad-key-x86_64.tar.zst"))).toBe(false);
});

test.each(["true", "1"])("requires a trust key for release packaging (%s)", releaseBuild => {
  const fixture = createFixture();
  assertSucceeded(run(["bun", "install"], { cwd: fixture.root }), "fixture dependency install");
  const packaged = run(["bash", packager, fixture.root, fixture.output, fixture.bundle, fixture.fonts], {
    cwd: projectRoot,
    env: { ...process.env, OMARCHY_BOT_PLUGIN_REVISION: "missing-key", TAURI_UPDATER_PUBKEY: undefined, RELEASE_BUILD: releaseBuild },
  });
  expect(packaged.exitCode).not.toBe(0);
  expect(packaged.stderr.toString()).toContain("requires TAURI_UPDATER_PUBKEY");
  expect(existsSync(path.join(fixture.output, "omarchy-bot-runtime-missing-key-x86_64.tar.zst"))).toBe(false);
});
