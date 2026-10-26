/**
 * Worker lifetime under Service supervision (ticket 02, slice B).
 *
 * Seam 1: the Service boots through the integration harness with a dedicated
 * fixture worker that spawns TERM-resistant descendants. Every assertion is
 * observable from outside: /proc lifetime and the environment the worker
 * actually received.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon, type Harness } from "./helpers/harness.ts";

const workersDir = path.resolve(import.meta.dir, "fixtures/worker-supervision");

interface StartRecord {
  mode: string;
  pid: number;
  env: Record<string, string>;
}

let h: Harness | undefined;
let home: string | undefined;
let hostRuntime: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

/** Kills only pids this fixture recorded, proven by this home in their own env. */
function reapFixture(fixtureHome: string): void {
  const stateDir = path.join(fixtureHome, "fixture-state");
  if (!existsSync(stateDir)) return;
  const pids = new Set<number>();
  const log = path.join(stateDir, "starts.log");
  if (existsSync(log)) {
    for (const line of readFileSync(log, "utf8").split("\n")) {
      if (line.length > 0) pids.add((JSON.parse(line) as StartRecord).pid);
    }
  }
  for (const entry of readdirSync(stateDir)) {
    if (!/^descendant-\d+\.pid$/.test(entry)) continue;
    const raw = readFileSync(path.join(stateDir, entry), "utf8").trim();
    if (/^\d+$/.test(raw)) pids.add(Number(raw));
  }
  for (const pid of pids) {
    try {
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`OMARCHY_BOT_HOME=${fixtureHome}`)) continue;
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

afterEach(async () => {
  if (h !== undefined) {
    await h.stop().catch(() => {});
    h = undefined;
  }
  if (home !== undefined) {
    reapFixture(home);
    rmSync(home, { recursive: true, force: true });
    home = undefined;
  }
  if (hostRuntime !== undefined) {
    rmSync(hostRuntime, { recursive: true, force: true });
    hostRuntime = undefined;
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

function hostVariable(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

function starts(fixtureHome: string): StartRecord[] {
  const file = path.join(fixtureHome, "fixture-state", "starts.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

/** Zombies count as gone, so a killed descendant is observable. */
function pidAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

async function waitDead(label: string, pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`${label} ${pid} is still alive`);
    await Bun.sleep(25);
  }
}

function descendantPid(fixtureHome: string, workerPid: number): number | undefined {
  const file = path.join(fixtureHome, "fixture-state", `descendant-${workerPid}.pid`);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8").trim();
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Boots the Service with the fixture worker in `mode` and waits for it to start. */
async function boot(mode: string): Promise<{ fixtureHome: string; started: StartRecord }> {
  const fixtureHome = mkdtempSync(path.join(os.tmpdir(), "worker-supervision-"));
  home = fixtureHome;
  writeFileSync(path.join(fixtureHome, "fixture-mode"), mode);
  h = await startDaemon(fixtureHome, { workersDir, waitForAgentReady: false });
  const started = await waitFor(`${mode} worker start`, () => starts(fixtureHome)[0]);
  return { fixtureHome, started };
}

test("Service shutdown stops a worker and its TERM-resistant descendant", async () => {
  const { fixtureHome, started } = await boot("resistant");
  const descendant = await waitFor("worker descendant", () => descendantPid(fixtureHome, started.pid));
  // Nothing about this process resembles a worker, so teardown must leave it alone.
  const unrelated = Bun.spawn(["sleep", "120"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  expect(pidAlive(started.pid)).toBeTrue();
  expect(pidAlive(descendant)).toBeTrue();

  try {
    await h!.stop();
    h = undefined;

    await waitDead("worker", started.pid);
    await waitDead("worker descendant", descendant);
    expect(pidAlive(unrelated.pid)).toBeTrue();
  } finally {
    unrelated.kill("SIGKILL");
  }
}, 60_000);

test("Service shutdown closes worker stdin and reaps descendants after the worker exits", async () => {
  const { fixtureHome, started } = await boot("shutdown-exit");
  const descendant = await waitFor("worker descendant", () => descendantPid(fixtureHome, started.pid));

  await h!.stop();
  h = undefined;

  expect(readFileSync(path.join(fixtureHome, "fixture-state", `stdin-closed-${started.pid}`), "utf8")).toBe("closed");
  await waitDead("worker", started.pid);
  await waitDead("worker descendant", descendant);
}, 60_000);

test("Service restart after a worker crash reaps the dead worker's descendants", async () => {
  const { fixtureHome, started } = await boot("crash");
  const descendant = await waitFor("worker descendant", () => descendantPid(fixtureHome, started.pid));

  const restarted = await waitFor("worker restart", () => starts(fixtureHome)[1], 20_000);
  expect(restarted.pid).not.toBe(started.pid);
  await waitDead("crashed worker", started.pid);
  await waitDead("crashed worker descendant", descendant);
  expect(pidAlive(restarted.pid)).toBeTrue();
}, 60_000);

test("Service reaps descendants when a worker dies before its handshake", async () => {
  const { fixtureHome, started } = await boot("exit-early");
  const descendant = await waitFor("worker descendant", () => descendantPid(fixtureHome, started.pid));

  await waitDead("worker", started.pid);
  await waitDead("worker descendant", descendant);
}, 60_000);

test("Service shutdown reaps a worker descendant that cleared its environment", async () => {
  const { fixtureHome, started } = await boot("scrubbed");
  const descendant = await waitFor("scrubbed worker descendant", () => descendantPid(fixtureHome, started.pid));
  const environment = readFileSync(`/proc/${descendant}/environ`, "utf8").split("\0");
  expect(environment.some((entry) => entry.startsWith("OMARCHY_BOT_"))).toBeFalse();

  await h!.stop();
  h = undefined;

  await waitDead("worker", started.pid);
  await waitDead("scrubbed worker descendant", descendant);
}, 60_000);

test("workers never inherit the host session environment", async () => {
  // A private, writable stand-in for a host session runtime: the point is that
  // none of it reaches the worker, not where the host keeps it.
  hostRuntime = mkdtempSync(path.join(os.tmpdir(), "host-session-runtime-"));
  hostVariable("XDG_RUNTIME_DIR", hostRuntime);
  hostVariable("DBUS_SESSION_BUS_ADDRESS", `unix:path=${path.join(hostRuntime, "bus")}`);
  hostVariable("WAYLAND_DISPLAY", "wayland-host");
  hostVariable("HOST_ONLY_LEAK", "1");

  const { fixtureHome, started } = await boot("env");

  expect(started.env.HOST_ONLY_LEAK).toBeUndefined();
  expect(started.env.XDG_RUNTIME_DIR).toBeUndefined();
  expect(started.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  expect(started.env.WAYLAND_DISPLAY).toBeUndefined();
  expect(started.env.OMARCHY_BOT_HOME).toBe(fixtureHome);
}, 60_000);
