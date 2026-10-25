import { afterEach, expect, test } from "bun:test";
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

const projectRoot = path.resolve(import.meta.dir, "../..");
const launcher = path.join(projectRoot, "plugin", "launch.sh");
const roots: string[] = [];
const lockDirs: string[] = [];

const helperPaths = [
  "apps/daemon/dist/native-pointer/omarchy-bot-wayland-input",
  "apps/daemon/dist/native-capture/omarchy-bot-wayland-capture",
  "apps/daemon/dist/native-bot-desktop/omarchy-bot-desktop",
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const lockDir of lockDirs.splice(0)) rmSync(lockDir, { recursive: true, force: true });
});

function writeExecutable(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, 0o700);
}

function writeZstdShim(binDir: string): void {
  writeExecutable(
    path.join(binDir, "zstd"),
    `#!/usr/bin/env python3
import ctypes
import sys

lib = ctypes.CDLL("libzstd.so.1")
lib.ZSTD_compressBound.restype = ctypes.c_size_t
lib.ZSTD_compress.restype = ctypes.c_size_t
lib.ZSTD_decompress.restype = ctypes.c_size_t
lib.ZSTD_isError.restype = ctypes.c_uint
lib.ZSTD_getFrameContentSize.restype = ctypes.c_ulonglong
lib.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
lib.ZSTD_compress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
lib.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
lib.ZSTD_getFrameContentSize.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
lib.ZSTD_isError.argtypes = [ctypes.c_size_t]

data = sys.stdin.buffer.read()
decompress = any(
  arg in ("-d", "--decompress") or (arg.startswith("-") and not arg.startswith("--") and "d" in arg[1:])
  for arg in sys.argv[1:]
)
if decompress:
  size = lib.ZSTD_getFrameContentSize(data, len(data))
  if size in (0xFFFFFFFFFFFFFFFF, 0xFFFFFFFFFFFFFFFE):
    size = max(len(data) * 20, 1)
  out = ctypes.create_string_buffer(size)
  written = lib.ZSTD_decompress(out, size, data, len(data))
  if lib.ZSTD_isError(written):
    raise SystemExit("zstd decompress failed")
  sys.stdout.buffer.write(out.raw[:written])
else:
  bound = lib.ZSTD_compressBound(len(data))
  out = ctypes.create_string_buffer(bound)
  written = lib.ZSTD_compress(out, bound, data, len(data), 3)
  if lib.ZSTD_isError(written):
    raise SystemExit("zstd compress failed")
  sys.stdout.buffer.write(out.raw[:written])
`,
  );
}

function writeCurlShim(file: string): void {
  writeExecutable(
    file,
    [
      "#!/bin/sh",
      "out=",
      "write_out=",
      "url=",
      "while [ $# -gt 0 ]; do",
      "  case $1 in",
      "    -o)",
      "      out=$2",
      "      shift 2",
      "      ;;",
      "    --proto|--max-time)",
      "      shift 2",
      "      ;;",
      "    --write-out)",
      "      write_out=$2",
      "      shift 2",
      "      ;;",
      "    --tlsv1.2|-*)",
      "      shift",
      "      ;;",
      "    *)",
      "      url=$1",
      "      shift",
      "      ;;",
      "  esac",
      "done",
      'if [ -z "$out" ] || [ -z "$url" ]; then',
      '  echo "curl fixture requires -o and a URL" >&2',
      "  exit 2",
      "fi",
      "case $url in",
      "  http://*)",
      '    echo "curl fixture refused a non-HTTPS URL" >&2',
      "    exit 1",
      "    ;;",
      "  *bun-linux-x64.zip)",
      '    if [ -n "${OMARCHY_BOT_PLUGIN_TEST_BUN_ZIP:-}" ]; then',
      '      cp "$OMARCHY_BOT_PLUGIN_TEST_BUN_ZIP" "$out"',
      "      exit 0",
      "    fi",
      "    exit 22",
      "    ;;",
      "  *.sha256)",
      '    if [ -n "${OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SIDECAR_STATUS:-}" ]; then',
      '      [ -z "$write_out" ] || printf "%s" "$OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SIDECAR_STATUS"',
      '      case $OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SIDECAR_STATUS in',
      '        2*)',
      '          if [ -n "${OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256:-}" ]; then',
      '            printf "%s\n" "$OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256" > "$out"',
      "          else",
      '            : > "$out"',
      "          fi",
      "          exit 0",
      "          ;;",
      "        000) exit 6 ;;",
      "        *) exit 22 ;;",
      "      esac",
      "    fi",
      '    if [ -n "${OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256:-}" ]; then',
      '      printf "%s\n" "$OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256" > "$out"',
      '      [ -z "$write_out" ] || printf "200"',
      "      exit 0",
      "    fi",
      '    [ -z "$write_out" ] || printf "404"',
      "    exit 22",
      "    ;;",
      "  *omarchy-bot-runtime-*)",
      '    if [ -n "${OMARCHY_BOT_PLUGIN_TEST_RUNTIME_ARCHIVE:-}" ]; then',
      '      cp "$OMARCHY_BOT_PLUGIN_TEST_RUNTIME_ARCHIVE" "$out"',
      "      exit 0",
      "    fi",
      "    exit 22",
      "    ;;",
      "esac",
      "exit 22",
      "",
    ].join("\n"),
  );
}

function fixture(): {
  root: string;
  pluginRoot: string;
  appRoot: string;
  binDir: string;
  bun: string;
  env: Record<string, string | undefined>;
  invocations: string;
  revision: string;
  lockDir: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-plugin-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin-source");
  const runtime = path.join(root, "runtime");
  const data = path.join(root, "data");
  const home = path.join(root, "home");
  const omarchyHome = path.join(data, "omarchy-bot");
  const binDir = path.join(root, "bin");
  mkdirSync(pluginRoot);
  mkdirSync(runtime);
  mkdirSync(binDir);
  // serve derives the per-user lock from `id -u`; a fixture uid keeps this
  // suite off the real Service lock.
  const uid = 910_000 + process.pid * 10 + roots.length;
  const lockDir = `/tmp/omarchy-bot-${uid}`;
  lockDirs.push(lockDir);
  // Absence tests must not consult the host mise configuration or network.
  writeExecutable(path.join(binDir, "mise"), "#!/bin/sh\nexit 1\n");
  writeExecutable(path.join(binDir, "id"), `#!/bin/sh\nprintf '%s\\n' ${uid}\n`);
  writeZstdShim(binDir);
  const osRelease = path.join(root, "os-release");
  writeFileSync(osRelease, 'NAME="Omarchy"\nID=omarchy\nID_LIKE=arch\n');
  const invocations = path.join(root, "bun-invocations");
  const bun = path.join(root, "bun");
  writeExecutable(
    bun,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.4.1; exit 0; fi
if [ "$1" = "-e" ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
if [ "$OMARCHY_BOT_PLUGIN_TEST_NO_BUILD" = "1" ]; then
  case "$1" in install|run|apps/daemon/native/*) exit 72 ;; esac
fi
printf '%s|%s\n' "$PWD" "$*" >> "$OMARCHY_BOT_PLUGIN_TEST_LOG"
`,
  );
  const curl = path.join(root, "curl");
  writeCurlShim(curl);
  writeFileSync(path.join(pluginRoot, "fixture.txt"), "tracked plugin source\n");
  writeExecutable(
    path.join(pluginRoot, "scripts", "serve.sh"),
    readFileSync(path.join(projectRoot, "scripts", "serve.sh"), "utf8"),
  );
  writeExecutable(
    path.join(pluginRoot, "apps", "daemon", "src", "bootstrap", "main.ts"),
    "// fixture Service entry\n",
  );

  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = Bun.spawnSync(["git", "-C", pluginRoot, ...args], { stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  const revision = Bun.spawnSync(["git", "-C", pluginRoot, "rev-parse", "HEAD"]).stdout.toString().trim();
  return {
    root,
    pluginRoot,
    appRoot: path.join(omarchyHome, "app", revision),
    binDir,
    bun,
    invocations,
    revision,
    lockDir,
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_RUNTIME_DIR: runtime,
      OMARCHY_BOT_HOME: omarchyHome,
      OMARCHY_BOT_PLUGIN_ROOT: pluginRoot,
      OMARCHY_BOT_PLUGIN_OS_RELEASE: osRelease,
      OMARCHY_BOT_PLUGIN_BUN: bun,
      OMARCHY_BOT_PLUGIN_CURL: curl,
      OMARCHY_BOT_PLUGIN_TEST_LOG: invocations,
    },
  };
}

async function runCommand(
  command: string[],
  env: Record<string, string | undefined>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

async function runLauncher(env: Record<string, string | undefined>): Promise<{ status: number; stderr: string }> {
  const result = await runCommand(["bash", launcher], env);
  const log = path.join(env.XDG_STATE_HOME!, "omarchy-bot", "plugin-launch.log");
  return {
    status: result.status,
    stderr: existsSync(log) ? readFileSync(log, "utf8") : result.stderr,
  };
}

function writeRuntimeTree(tree: string): void {
  mkdirSync(path.join(tree, "apps", "web", "dist"), { recursive: true });
  mkdirSync(path.join(tree, "node_modules"), { recursive: true });
  writeFileSync(path.join(tree, "package.json"), `${JSON.stringify({ scripts: { start: "true" } })}\n`);
  writeFileSync(path.join(tree, "apps", "web", "dist", "index.html"), "ok\n");
  // The published archive carries the launcher-neutral entry.
  writeExecutable(
    path.join(tree, "scripts", "serve.sh"),
    readFileSync(path.join(projectRoot, "scripts", "serve.sh"), "utf8"),
  );
  for (const helper of helperPaths) {
    writeExecutable(path.join(tree, helper), "#!/bin/sh\nexit 0\n");
  }
}

function makeRuntimeArchive(root: string): { archive: string; sha256: string } {
  const tree = path.join(root, "runtime-tree");
  writeRuntimeTree(tree);
  const archive = path.join(root, "omarchy-bot-runtime-fixture.tar.zst");
  const packed = Bun.spawnSync(["tar", "--zstd", "-cf", archive, "-C", tree, "."], {
    env: { ...process.env, PATH: `${path.join(root, "bin")}:/usr/bin:/bin` },
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(archive)).digest("hex");
  return { archive, sha256 };
}

function makeBunZip(root: string, bunSource: string): string {
  const zipRoot = path.join(root, "bun-zip");
  mkdirSync(path.join(zipRoot, "bun-linux-x64"), { recursive: true });
  const bun = path.join(zipRoot, "bun-linux-x64", "bun");
  writeFileSync(bun, readFileSync(bunSource));
  chmodSync(bun, 0o700);
  const zip = path.join(root, "bun-linux-x64.zip");
  const result = Bun.spawnSync(["python3", "-c", "import shutil, sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])", zip.replace(/\.zip$/, ""), zipRoot], {
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return zip;
}

test("repository exposes the official Omarchy service plugin contract", () => {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "manifest.json"), "utf8")) as {
    schemaVersion: number;
    id: string;
    kinds: string[];
    entryPoints: Record<string, string>;
  };
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    id: "io.github.xmethues.omarchy-bot",
    kinds: ["service"],
    entryPoints: { service: "plugin/Service.qml" },
  });
  expect(existsSync(path.join(projectRoot, manifest.entryPoints.service!))).toBeTrue();
});

test("a prepared revision remains usable without downloads or build tools", async () => {
  const setup = fixture();
  expect((await runLauncher(setup.env)).status).toBe(0);
  setup.env.OMARCHY_BOT_PLUGIN_TEST_NO_BUILD = "1";
  setup.env.OMARCHY_BOT_PLUGIN_CURL = path.join(setup.root, "missing-downloader");
  expect((await runLauncher(setup.env)).status).toBe(0);
  expect(readFileSync(path.join(setup.appRoot, "fixture.txt"), "utf8")).toBe("tracked plugin source\n");
  expect(readFileSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"), "utf8")).toBe(`${setup.revision}\n`);
  expect(Bun.spawnSync(["git", "-C", setup.pluginRoot, "status", "--porcelain"]).stdout.toString()).toBe("");
});

test("plugin tracked process owns the daemon and Service lock lifetime", async () => {
  const setup = fixture();
  writeRuntimeTree(setup.appRoot);
  writeFileSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"), `${setup.revision}\n`);
  const started = path.join(setup.root, "daemon-started");
  const stopped = path.join(setup.root, "daemon-stopped");
  setup.env.OMARCHY_BOT_PLUGIN_TEST_STARTED = started;
  setup.env.OMARCHY_BOT_PLUGIN_TEST_STOPPED = stopped;
  setup.env.OMARCHY_BOT_PLUGIN_BUN = process.execPath;
  const daemonEntry = path.join(setup.appRoot, "apps", "daemon", "src", "bootstrap", "main.ts");
  mkdirSync(path.dirname(daemonEntry), { recursive: true });
  writeFileSync(
    daemonEntry,
    `import { writeFileSync } from "node:fs";

writeFileSync(process.env.OMARCHY_BOT_PLUGIN_TEST_STARTED!, String(process.pid));
async function shutdown() {
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
  await Bun.sleep(20);
  writeFileSync(process.env.OMARCHY_BOT_PLUGIN_TEST_STOPPED!, "cleanup finished");
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 60_000);
`,
  );

  for (const signal of ["SIGTERM", "SIGKILL", "process-group"] as const) {
    rmSync(started, { force: true });
    rmSync(stopped, { force: true });
    const tracked = Bun.spawn(["setsid", "bash", launcher], {
      env: setup.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
        await Bun.sleep(20);
      }
      expect(existsSync(started)).toBeTrue();
      // serve holds the per-user lock for the Service pid it started.
      const daemonPid = Number(readFileSync(started, "utf8"));
      const held = Bun.spawnSync(["flock", "--timeout", "1", path.join(setup.lockDir, "service.lock"), "true"]);
      expect(held.exitCode).not.toBe(0);
      expect(Number(readFileSync(path.join(setup.lockDir, "service.lock"), "utf8"))).toBe(daemonPid);

      if (signal === "process-group") process.kill(-tracked.pid, "SIGTERM");
      else tracked.kill(signal);
      await tracked.exited;

      const lock = path.join(setup.lockDir, "service.lock");
      const probe = Bun.spawnSync(["flock", "--timeout", "3", lock, "true"]);
      expect(probe.exitCode).toBe(0);
      expect(existsSync(stopped)).toBeTrue();
    } finally {
      try {
        process.kill(-tracked.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

test("a competing plugin launch never disturbs the running Service's runtime", async () => {
  const setup = fixture();
  writeRuntimeTree(setup.appRoot);
  writeFileSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"), `${setup.revision}\n`);
  const started = path.join(setup.root, "daemon-started");
  const stopped = path.join(setup.root, "daemon-stopped");
  setup.env.OMARCHY_BOT_PLUGIN_TEST_STARTED = started;
  setup.env.OMARCHY_BOT_PLUGIN_TEST_STOPPED = stopped;
  setup.env.OMARCHY_BOT_PLUGIN_BUN = process.execPath;
  const daemonEntry = path.join(setup.appRoot, "apps", "daemon", "src", "bootstrap", "main.ts");
  mkdirSync(path.dirname(daemonEntry), { recursive: true });
  writeFileSync(
    daemonEntry,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.OMARCHY_BOT_PLUGIN_TEST_STARTED!, String(process.pid));
const shutdown = () => { writeFileSync(process.env.OMARCHY_BOT_PLUGIN_TEST_STOPPED!, ""); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 60_000);
`,
  );

  const first = Bun.spawn(["setsid", "bash", launcher], {
    env: setup.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(started); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(existsSync(started)).toBeTrue();
    const runtimeMarker = path.join(setup.appRoot, "apps", "web", "dist", "index.html");

    // The second launcher must wait on the Service lock, not prepare or prune
    // app_root while the first Service is running from it.
    const second = Bun.spawn(["bash", launcher], {
      env: setup.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(500);
    expect(second.exitCode).toBeNull();
    expect(readFileSync(runtimeMarker, "utf8")).toBe("ok\n");
    expect(existsSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"))).toBeTrue();
    expect(existsSync(started)).toBeTrue();

    second.kill("SIGKILL");
    await second.exited;
  } finally {
    try {
      process.kill(-first.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
});

test("plugin fixture never mutates an inherited product home", async () => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-existing-home-"));
  roots.push(outside);
  const inheritedHome = path.join(outside, "omarchy-bot");
  const marker = path.join(inheritedHome, "app", "existing-revision", "keep");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "unrelated product data\n");

  const originalHome = process.env.OMARCHY_BOT_HOME;
  process.env.OMARCHY_BOT_HOME = inheritedHome;
  let setup: ReturnType<typeof fixture>;
  try {
    setup = fixture();
  } finally {
    if (originalHome === undefined) delete process.env.OMARCHY_BOT_HOME;
    else process.env.OMARCHY_BOT_HOME = originalHome;
  }

  await expect(runLauncher(setup.env)).resolves.toEqual({ status: 0, stderr: "" });
  expect(existsSync(marker)).toBeTrue();
});

test("plugin lifecycle prefers a verified runtime artifact over source-build", async () => {
  const setup = fixture();
  const runtime = makeRuntimeArchive(setup.root);
  setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_ARCHIVE = runtime.archive;
  setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256 = `${runtime.sha256}  omarchy-bot-runtime-${setup.revision}-x86_64.tar.zst`;
  setup.env.OMARCHY_BOT_PLUGIN_TEST_NO_BUILD = "1";

  expect((await runLauncher(setup.env)).status).toBe(0);
  setup.env.OMARCHY_BOT_PLUGIN_CURL = path.join(setup.root, "missing-downloader");
  expect((await runLauncher(setup.env)).status).toBe(0);
  expect(existsSync(path.join(setup.appRoot, "apps", "web", "dist", "index.html"))).toBeTrue();
  for (const helper of helperPaths) {
    expect(existsSync(path.join(setup.appRoot, helper))).toBeTrue();
  }
  expect(readFileSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"), "utf8")).toBe(`${setup.revision}\n`);
});

test("plugin lifecycle rejects a runtime SHA-256 mismatch without extracting", async () => {
  const setup = fixture();
  const runtime = makeRuntimeArchive(setup.root);
  setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_ARCHIVE = runtime.archive;
  setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256 = `${"0".repeat(64)}  omarchy-bot-runtime-${setup.revision}-x86_64.tar.zst`;

  const result = await runLauncher(setup.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("plugin runtime failed SHA-256 verification");
  expect(existsSync(setup.appRoot)).toBeFalse();
  expect(existsSync(setup.invocations)).toBeFalse();
});

test("plugin lifecycle rejects a runtime checksum server error without source build", async () => {
  const setup = fixture();
  setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SIDECAR_STATUS = "500";

  const result = await runLauncher(setup.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("could not download the plugin runtime checksum (HTTP 500)");
  expect(existsSync(setup.appRoot)).toBeFalse();
  expect(existsSync(setup.invocations)).toBeFalse();
});

test("plugin lifecycle rejects transport and malformed checksum failures without source build", async () => {
  for (const failure of [
    { status: "000", message: "could not download the plugin runtime checksum (HTTP 000)" },
    { status: "200", checksum: "not-a-sha256", message: "plugin runtime checksum is malformed" },
  ]) {
    const setup = fixture();
    setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SIDECAR_STATUS = failure.status;
    setup.env.OMARCHY_BOT_PLUGIN_TEST_RUNTIME_SHA256 = failure.checksum;

    const result = await runLauncher(setup.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(failure.message);
    expect(existsSync(setup.appRoot)).toBeFalse();
    expect(existsSync(setup.invocations)).toBeFalse();
  }
});

test("plugin lifecycle rejects a non-HTTPS runtime URL", async () => {
  const setup = fixture();
  setup.env.OMARCHY_BOT_PLUGIN_RUNTIME_URL = "http://packages.invalid/omarchy-bot-runtime.tgz";
  setup.env.OMARCHY_BOT_PLUGIN_RUNTIME_SHA256 = "0".repeat(64);

  const result = await runLauncher(setup.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("plugin runtime must use HTTPS");
  expect(existsSync(setup.invocations)).toBeFalse();
});

test("plugin lifecycle resolves Bun from mise before downloading a pin", async () => {
  const setup = fixture();
  writeExecutable(
    path.join(setup.binDir, "mise"),
    '#!/bin/sh\nif [ "$1" = "which" ] && [ "$2" = "bun" ]; then printf "%s\\n" "$OMARCHY_BOT_PLUGIN_TEST_MISE_BUN"; exit 0; fi\nexit 1\n',
  );
  const env = { ...setup.env };
  delete env.OMARCHY_BOT_PLUGIN_BUN;
  env.OMARCHY_BOT_PLUGIN_TEST_MISE_BUN = setup.bun;

  await expect(runLauncher(env)).resolves.toEqual({ status: 0, stderr: "" });
  expect(readFileSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"), "utf8")).toBe(`${setup.revision}\n`);
});

test("plugin lifecycle downloads pinned Bun when PATH and mise are empty", async () => {
  const setup = fixture();
  const zip = makeBunZip(setup.root, setup.bun);
  const env = { ...setup.env };
  delete env.OMARCHY_BOT_PLUGIN_BUN;
  env.OMARCHY_BOT_PLUGIN_TEST_BUN_ZIP = zip;
  env.OMARCHY_BOT_PLUGIN_BUN_URL = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip";
  env.OMARCHY_BOT_PLUGIN_BUN_SHA256 = new Bun.CryptoHasher("sha256").update(readFileSync(zip)).digest("hex");

  await expect(runLauncher(env)).resolves.toEqual({ status: 0, stderr: "" });
  expect(existsSync(path.join(setup.env.XDG_DATA_HOME!, "omarchy-bot", "runtime", "bun", "1.4.2", "bin", "bun"))).toBeTrue();
  expect(readFileSync(path.join(setup.appRoot, ".omarchy-bot-plugin-ready"), "utf8")).toBe(`${setup.revision}\n`);
});


test("plugin lifecycle rejects non-Omarchy hosts before invoking Bun", async () => {
  const setup = fixture();
  writeFileSync(setup.env.OMARCHY_BOT_PLUGIN_OS_RELEASE!, "ID=arch\n");

  const result = await runLauncher(setup.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("supports Omarchy on x86_64 only");
  expect(existsSync(setup.invocations)).toBeFalse();
});

test("plugin lifecycle rejects an unsupported Bun before building", async () => {
  const setup = fixture();
  writeFileSync(setup.env.OMARCHY_BOT_PLUGIN_BUN!, "#!/bin/sh\necho 1.3.9\n");
  chmodSync(setup.env.OMARCHY_BOT_PLUGIN_BUN!, 0o700);

  const result = await runLauncher(setup.env);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("requires Bun 1.4 or newer (found 1.3.9)");
  expect(existsSync(setup.invocations)).toBeFalse();
});
