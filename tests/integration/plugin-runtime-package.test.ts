import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

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

function createFixture(): { root: string; cache: string; output: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-runtime-package-"));
  roots.push(root);
  const cache = path.join(root, ".bun-cache");
  const output = path.join(root, "output");

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
    `import { nativeHelper, runtimeValue } from "fixture-runtime-dependency";

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
`,
  );
  write(root, "apps/web/dist/index.html", "<!doctype html><title>built web fixture</title>\n");
  for (const helper of helperPaths) {
    writeExecutable(root, helper, `#!/bin/sh\nprintf '%s\\n' ${path.basename(helper)}\n`);
  }

  return { root, cache, output };
}

test("packages a runnable production dependency tree without mutating the source install", () => {
  const fixture = createFixture();
  const installEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: fixture.cache };
  const install = run(["bun", "install"], { cwd: fixture.root, env: installEnv });
  assertSucceeded(install, "fixture dependency install");

  const sourceBefore = run(["bun", "apps/daemon/src/bootstrap/main.ts"], {
    cwd: fixture.root,
    env: { ...installEnv, EXPECT_DEVELOPMENT_DEPENDENCY: "1" },
  });
  assertSucceeded(sourceBefore, "source fixture consumer before packaging");
  const lockBefore = readFileSync(path.join(fixture.root, "bun.lock"));

  const revision = "0123456789abcdef0123456789abcdef01234567";
  const packaged = run(["bash", packager, fixture.root, fixture.output], {
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

  const packagedConsumer = run(["bun", "apps/daemon/src/bootstrap/main.ts"], {
    cwd: extracted,
    env: installEnv,
  });
  assertSucceeded(packagedConsumer, "packaged daemon consumer");

  expect(readFileSync(path.join(fixture.root, "bun.lock"))).toEqual(lockBefore);
  const sourceAfter = run(["bun", "apps/daemon/src/bootstrap/main.ts"], {
    cwd: fixture.root,
    env: { ...installEnv, EXPECT_DEVELOPMENT_DEPENDENCY: "1" },
  });
  assertSucceeded(sourceAfter, "source fixture consumer after packaging");
}, 60_000);
