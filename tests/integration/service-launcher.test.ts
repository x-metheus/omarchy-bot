import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "../..");
const serveScript = path.join(projectRoot, "scripts", "serve.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const uid of lockUids.splice(0)) {
    rmSync(`/tmp/omarchy-bot-${uid}`, { recursive: true, force: true });
    rmSync(`/tmp/ob-${uid}`, { recursive: true, force: true });
  }
});

// serve derives the per-user lock from `id -u`; a fake uid keeps parallel lanes
// and fixtures off each other's real Service lock.
let nextUid = 0;
const lockUids: number[] = [];

function writeExecutable(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  chmodSync(file, 0o700);
}

const fakeDaemon = `import { writeFileSync } from "node:fs";

writeFileSync(process.env.OMARCHY_BOT_SERVE_TEST_STARTED!, JSON.stringify({
  pid: process.pid,
  runtimeDir: process.env.XDG_RUNTIME_DIR ?? null,
}));
const shutdown = () => {
  writeFileSync(process.env.OMARCHY_BOT_SERVE_TEST_STOPPED!, "");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 60_000);
`;

interface Fixture {
  root: string;
  serve: string;
  bin: string;
  env: Record<string, string | undefined>;
  started: string;
  stopped: string;
  lockDir: string;
  state: string;
}

/** Installed runtime: the serve entry plus the Service it starts, no plugin checkout. */
function fixture(options: { uid?: number } = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-serve-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "installed-runtime");
  const serve = path.join(runtimeRoot, "scripts", "serve.sh");
  writeExecutable(serve, readFileSync(serveScript, "utf8"));
  const main = path.join(runtimeRoot, "apps", "daemon", "src", "bootstrap", "main.ts");
  mkdirSync(path.dirname(main), { recursive: true });
  writeFileSync(main, fakeDaemon);
  const bin = path.join(root, "bin");
  writeExecutable(path.join(bin, "bun"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  nextUid += 1;
  const uid = options.uid ?? 900_000 + process.pid * 10 + nextUid;
  lockUids.push(uid);
  writeExecutable(path.join(bin, "id"), `#!/bin/sh\nprintf '%s\\n' ${uid}\n`);
  const started = path.join(root, "started.json");
  const stopped = path.join(root, "stopped");
  // Fixture host: not Omarchy. serve must never consult this file.
  const osRelease = path.join(root, "os-release");
  writeFileSync(osRelease, "NAME=Ubuntu\nID=ubuntu\n");
  const lockDir = `/tmp/omarchy-bot-${uid}`;
  const state = path.join(root, "state", "omarchy-bot");
  const runtime = path.join(root, "runtime");
  mkdirSync(runtime, { recursive: true });
  return {
    root,
    serve,
    bin,
    started,
    stopped,
    lockDir,
    state,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_RUNTIME_DIR: runtime,
      OMARCHY_BOT_HOME: path.join(root, "data", "omarchy-bot"),
      OMARCHY_BOT_STATE: state,
      OMARCHY_BOT_PLUGIN_OS_RELEASE: osRelease,
      OMARCHY_BOT_SERVE_TEST_STARTED: started,
      OMARCHY_BOT_SERVE_TEST_STOPPED: stopped,
    },
  };
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

// The Service is a real child process; its readiness is an OS event, so poll it
// rather than fake the clock.
async function waitForFile(file: string, attempts = 250): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(file)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

function start(setup: Fixture, env = setup.env) {
  return Bun.spawn(["bash", setup.serve], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("serve starts an installed runtime without a plugin checkout", async () => {
  const setup = fixture();
  const child = start(setup);
  try {
    await waitForFile(setup.started);
    const daemon = JSON.parse(readFileSync(setup.started, "utf8")) as {
      pid: number;
      runtimeDir: string;
    };
    expect(daemon.runtimeDir).toBe(setup.env.XDG_RUNTIME_DIR!);
    expect(mode(setup.lockDir)).toBe(0o700);
    expect(existsSync(path.join(setup.lockDir, "service.lock"))).toBeTrue();
    expect(existsSync(path.join(setup.root, "installed-runtime", "plugin"))).toBeFalse();
    // A host-provided runtime directory is used as given, not shadowed.
    expect(existsSync(path.join(setup.state, "runtime"))).toBeFalse();

    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await waitForFile(setup.stopped);
  } finally {
    child.kill("SIGKILL");
  }
});

test("serve rejects a non-x86_64 host before starting the Service", async () => {
  const setup = fixture();
  writeExecutable(
    path.join(setup.bin, "uname"),
    '#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo aarch64 ;; *) exit 2 ;; esac\n',
  );

  const result = await start(setup);
  expect(await result.exited).toBe(1);
  expect(await new Response(result.stderr).text()).toContain(
    "supports Linux on x86_64 only (found Linux aarch64)",
  );
  expect(existsSync(setup.started)).toBeFalse();
});

test("serve fallback runtime fits real Bot Computer socket paths for a long uid", async () => {
  // 10-digit uids exist on some hosts and every byte counts: a unix socket path
  // cannot exceed 107 bytes, and the Bot Computer binds both of these.
  const setup = fixture({ uid: 4_294_967_295 });
  const env = { ...setup.env };
  delete env.XDG_RUNTIME_DIR;

  const child = start(setup, env);
  try {
    await waitForFile(setup.started);
    const daemon = JSON.parse(readFileSync(setup.started, "utf8")) as { runtimeDir: string };
    const runtimeDir = daemon.runtimeDir;
    expect(runtimeDir).toBe(`/tmp/ob-${4_294_967_295}`);
    expect(mode(runtimeDir)).toBe(0o700);
    expect(mode(setup.lockDir)).toBe(0o700);

    // Bind the paths the daemon derives, as Sway and WayVNC would.
    const generation = "1700000000000";
    const surface = `surf_${"a".repeat(32)}`;
    const swaySock = path.join(
      runtimeDir, "omarchy-bot", "screens", "computer", generation,
      `sway-ipc.${4_294_967_295}.${4_000_000}.sock`,
    );
    const wayvncSock = path.join(runtimeDir, "omarchy-bot", "screens", surface, generation, "wayvnc.sock");
    for (const socket of [swaySock, wayvncSock]) {
      expect(Buffer.byteLength(socket)).toBeLessThan(108);
      mkdirSync(path.dirname(socket), { recursive: true });
      const server = Bun.listen({ unix: socket, socket: { data() {} } });
      server.stop(true);
    }

    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  } finally {
    child.kill("SIGKILL");
  }
});

test("serve never follows a lock directory an attacker plants during creation", async () => {
  const setup = fixture();
  const outside = path.join(setup.root, "outside");
  mkdirSync(outside, { recursive: true, mode: 0o755 });
  chmodSync(outside, 0o755);
  // Win the check-then-create race deterministically: the shim answers the
  // `-d` probe negatively, then plants the symlink just before mkdir runs.
  writeExecutable(
    path.join(setup.bin, "mkdir"),
    `#!/bin/sh
for arg in "$@"; do :; done
ln -s ${JSON.stringify(outside)} ${JSON.stringify(setup.lockDir)}
/bin/mkdir "$@"
`,
  );

  const result = start(setup);
  try {
    // Bounded: a version that follows the link starts a Service and never exits.
    const exited = await Promise.race([result.exited, Bun.sleep(2_000).then(() => null)]);
    expect(exited).toBe(1);
    expect(await new Response(result.stderr).text()).toContain(
      "requires an owned, non-symlink directory",
    );
    // The link target was not chmodded and no lock was created through it.
    expect(mode(outside)).toBe(0o755);
    expect(existsSync(path.join(outside, "service.lock"))).toBeFalse();
    expect(existsSync(setup.started)).toBeFalse();
  } finally {
    result.kill("SIGKILL");
  }
});

test("serve refuses a service lock that is already a symlink", async () => {
  const setup = fixture();
  const victim = path.join(setup.root, "victim");
  writeFileSync(victim, "keep");
  mkdirSync(setup.lockDir, { recursive: true, mode: 0o700 });
  const planted = Bun.spawnSync(["ln", "-s", victim, path.join(setup.lockDir, "service.lock")]);
  expect(planted.exitCode).toBe(0);

  const result = start(setup);
  try {
    const exited = await Promise.race([result.exited, Bun.sleep(2_000).then(() => null)]);
    expect(exited).toBe(1);
    expect(await new Response(result.stderr).text()).toContain("refuses to follow a symlinked lock");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(existsSync(setup.started)).toBeFalse();
  } finally {
    result.kill("SIGKILL");
  }
});

test("serve keeps one lock path whether or not the host provides a user runtime directory", async () => {
  const setup = fixture();
  // A host with /run/user-like runtime present and one without must both take
  // the same per-user lock, or a Service started before it appeared would be
  // invisible to one started after.
  const withRuntime = start(setup);
  try {
    await waitForFile(setup.started);
    const running = JSON.parse(readFileSync(setup.started, "utf8")) as { pid: number };

    const withoutRuntime = { ...setup.env };
    delete withoutRuntime.XDG_RUNTIME_DIR;
    const second = await start(setup, withoutRuntime);
    const stderr = await new Response(second.stderr).text();
    expect(await second.exited).toBe(1);
    expect(stderr).toContain("already running for this user");
    expect(stderr).toContain(`pid ${running.pid}`);
    expect(stderr).toContain(setup.lockDir);

    withRuntime.kill("SIGTERM");
    expect(await withRuntime.exited).toBe(0);
  } finally {
    withRuntime.kill("SIGKILL");
  }
});

test("a second serve for the same user fails fast and names the running Service", async () => {
  const setup = fixture();
  const first = start(setup);
  try {
    await waitForFile(setup.started);
    const running = JSON.parse(readFileSync(setup.started, "utf8")) as { pid: number };

    const other = path.join(setup.root, "other");
    mkdirSync(other, { recursive: true });
    const secondEnv: Record<string, string | undefined> = {
      ...setup.env,
      XDG_RUNTIME_DIR: path.join(other, "runtime"),
      XDG_DATA_HOME: path.join(other, "data"),
      OMARCHY_BOT_HOME: path.join(other, "data", "omarchy-bot"),
      OMARCHY_BOT_STATE: path.join(other, "state"),
    };
    mkdirSync(secondEnv.XDG_RUNTIME_DIR!, { recursive: true });

    const began = Date.now();
    const second = await start(setup, secondEnv);
    const stderr = await new Response(second.stderr).text();
    expect(await second.exited).toBe(1);
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(stderr).toContain("already running for this user");
    expect(stderr).toContain(`pid ${running.pid}`);

    first.kill("SIGTERM");
    expect(await first.exited).toBe(0);
    await waitForFile(setup.stopped);

    rmSync(setup.started, { force: true });
    const restarted = start(setup, secondEnv);
    try {
      await waitForFile(setup.started);
      restarted.kill("SIGTERM");
      expect(await restarted.exited).toBe(0);
    } finally {
      restarted.kill("SIGKILL");
    }
  } finally {
    first.kill("SIGKILL");
  }
});
