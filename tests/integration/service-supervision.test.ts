/**
 * Ticket 02 acceptance, Seam 1 + Seam 3: the Service supervises its own child
 * process groups when no user manager exists, and still prefers transient units
 * when one does. Everything here is external behaviour: the Service API, the
 * processes it owns, and the fixture manager's own log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SurfaceId } from "../../packages/domain/src/index.ts";
import type { MessageDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  makeBot,
  messages,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";
import { waitScreenReady } from "./helpers/bot-screen-load-observe.ts";
import { createScriptedSwayFixture, type ScriptedSwayFixture } from "./helpers/swayBotScreen.ts";
import {
  createFakeManager,
  fileLines,
  processCmdline,
  processEnvironment,
  processRunning,
  processesUnder,
  startManagedService,
  startUnrelatedSentinel,
  waitFor,
  workerProcesses,
  writeOrphanApplication,
  writeResistantApplication,
  type FakeManager,
  type ManagedService,
  type UnrelatedSentinel,
} from "./helpers/serviceSupervision.ts";

const BIN_KEYS = [
  "OMARCHY_BOT_SWAY_BIN",
  "OMARCHY_BOT_SWAYMSG_BIN",
  "OMARCHY_BOT_WAYVNC_BIN",
  "OMARCHY_BOT_WLR_RANDR_BIN",
  "OMARCHY_BOT_GRIM_BIN",
  "OMARCHY_BOT_INPUT_HELPER_BIN",
  "OMARCHY_BOT_CAPTURE_HELPER_BIN",
  "OMARCHY_BOT_DESKTOP_BIN",
] as const;

const priorEnvironment = {
  ...Object.fromEntries(BIN_KEYS.map((key) => [key, process.env[key]])),
  PATH: process.env.PATH,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  OMARCHY_BOT_HOST_SESSION_MARKER: process.env.OMARCHY_BOT_HOST_SESSION_MARKER,
};

const roots: string[] = [];
const fixtures: ScriptedSwayFixture[] = [];
let harness: Harness | undefined;
let managed: ManagedService | undefined;
let manager: FakeManager | undefined;
let sentinel: UnrelatedSentinel | undefined;
let leakedPids: number[] = [];

afterEach(async () => {
  await harness?.stop().catch(() => {});
  harness = undefined;
  await managed?.stop().catch(() => {});
  managed = undefined;
  sentinel?.stop();
  sentinel = undefined;
  // Exact PIDs the fixtures created, captured with their kernel start time, so a
  // red run cannot leave a resistant descendant behind for the next suite.
  for (const pid of leakedPids) killExact(pid);
  leakedPids = [];
  manager?.dispose();
  manager = undefined;
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchRoot(label: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `omarchy-bot-supervision-${label}-`));
  roots.push(root);
  return root;
}

function killExact(pid: number): void {
  if (!processRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Records a fixture-created PID so a failing test cannot leak it. */
function trackPid(pid: number): number {
  leakedPids.push(pid);
  return pid;
}

/**
 * Production Screen binaries from the scripted fixture. The harness points a
 * production adapter at private paths, so the eight overrides are the only way
 * to run the real supervision path without touching the host compositor.
 */
async function scriptedScreen(): Promise<ScriptedSwayFixture> {
  const fixture = await createScriptedSwayFixture();
  fixtures.push(fixture);
  for (const [key, value] of Object.entries(fixture.binEnv)) process.env[key] = value;
  return fixture;
}

async function owner(h: Harness, botId: string): Promise<{ botId: string; surfaceId: SurfaceId }> {
  const bot = await api<{ id: string; surfaceId: SurfaceId }>(h, "GET", `/api/bots/${botId}`);
  return { botId: bot.id, surfaceId: bot.surfaceId };
}

function toolStatuses(transcript: MessageDto[], name: string): Array<string | undefined> {
  return transcript
    .filter((message) => message.kind === "tool" && message.toolCall?.name === name)
    .map((message) => message.toolCall?.status);
}

function hostSession(): Record<string, string | undefined> {
  return {
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    OMARCHY_BOT_HOST_SESSION_MARKER: process.env.OMARCHY_BOT_HOST_SESSION_MARKER,
  };
}

function seedHostSession(): void {
  process.env.OMARCHY_BOT_HOST_SESSION_MARKER = "host-session-only";
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/host-session/bus";
}

/** Waits for a fixture-created descendant PID, failing the moment its Screen dies. */
async function descendantPid(h: Harness, pidFile: string, surface: { botId: string; surfaceId: SurfaceId }): Promise<number> {
  return waitFor(
    async () => {
      const [pid] = fileLines(pidFile);
      if (pid !== undefined) return trackPid(Number(pid));
      const view = await api<{ state: string; activity?: string }>(
        h,
        "GET",
        `/api/computer/state?botId=${encodeURIComponent(surface.botId)}&surfaceId=${encodeURIComponent(surface.surfaceId)}`,
      );
      if (view.state === "unavailable") {
        throw new Error(`Screen failed before launching the fixture application: ${view.activity ?? "unknown"}`);
      }
      return undefined;
    },
    15_000,
    "the fixture application descendant",
  );
}

describe("Service supervision without a user manager", () => {
  test("a Screen starts, accepts input, and stops through the Service API", async () => {
    const fixture = await scriptedScreen();
    seedHostSession();
    harness = await startDaemon(undefined, {
      useProductionBotScreen: true,
      useHostApplicationUnits: false,
    });
    const botId = await makeBot(harness, "Supervised Screen");
    const surface = await owner(harness, botId);
    await waitScreenReady(harness, surface);

    const observed = await sendToBot(harness, botId, "computer:observe");
    await waitThreadIdle(harness, observed.threadId);
    const clicked = await sendToBot(harness, botId, "computer:click");
    await waitThreadIdle(harness, clicked.threadId);

    expect(toolStatuses(await messages(harness, clicked.threadId), "computer")).toEqual(["completed"]);
    expect(fixture.inputCommands().some((line) => line.startsWith("button "))).toBeTrue();

    const runtimeRoot = path.join(harness.home, "r");
    expect(processesUnder(runtimeRoot).length).toBeGreaterThan(0);

    const deleted = await api<{ status: string }>(harness, "DELETE", `/api/bots/${botId}`, {});
    expect(deleted.status).toBe("deleted");
    expect(existsSync(path.join(runtimeRoot, surface.surfaceId))).toBeFalse();
    await waitFor(
      () => (processesUnder(runtimeRoot).length === 0 ? true : undefined),
      10_000,
      "owned Bot Computer processes to exit after Bot deletion",
    );
  }, 60_000);

  test("deletion stops a TERM-resistant descendant whose leader already exited", async () => {
    await scriptedScreen();
    const scratch = scratchRoot("orphan");
    const pidFile = path.join(scratch, "orphan.pid");
    const application = writeOrphanApplication(scratch, pidFile);
    harness = await startDaemon(undefined, {
      useProductionBotScreen: true,
      useHostApplicationUnits: false,
    });
    const botId = await makeBot(harness, "Orphan application");
    const surface = await owner(harness, botId);
    await waitScreenReady(harness, surface);
    await harness.svc.screens.act(surface, { name: "open_app", args: { app: application } });
    const orphan = await descendantPid(harness, pidFile, surface);
    expect(processRunning(orphan)).toBeTrue();

    const deleted = await api<{ status: string }>(harness, "DELETE", `/api/bots/${botId}`, {});
    expect(deleted.status).toBe("deleted");
    await waitFor(
      () => (processRunning(orphan) ? undefined : true),
      10_000,
      "the orphaned descendant to be torn down with its owned group",
    );
  }, 60_000);

  test("Service shutdown leaves no Bot Computer, application, or worker descendant", async () => {
    await scriptedScreen();
    const scratch = scratchRoot("shutdown");
    const pidFile = path.join(scratch, "resistant.pid");
    const application = writeResistantApplication(scratch, pidFile);
    sentinel = startUnrelatedSentinel(scratch);
    harness = await startDaemon(undefined, {
      useProductionBotScreen: true,
      useHostApplicationUnits: false,
    });
    const home = harness.home;
    const botId = await makeBot(harness, "Shutdown cleanup");
    const surface = await owner(harness, botId);
    await waitScreenReady(harness, surface);
    await harness.svc.screens.act(surface, { name: "open_app", args: { app: application } });
    const descendant = await descendantPid(harness, pidFile, surface);

    expect(workerProcesses(home).length).toBeGreaterThan(0);
    const runtimeRoot = path.join(home, "r");
    expect(processesUnder(runtimeRoot).length).toBeGreaterThan(0);

    await harness.stop();
    harness = undefined;

    await waitFor(
      () => (processesUnder(runtimeRoot).length === 0 ? true : undefined),
      15_000,
      "every owned Bot Computer process to exit on Service shutdown",
    );
    await waitFor(
      () => (processRunning(descendant) ? undefined : true),
      10_000,
      "the TERM-resistant application descendant to be killed with its group",
    );
    await waitFor(
      () => (workerProcesses(home).length === 0 ? true : undefined),
      15_000,
      "every Agent worker to exit on Service shutdown",
    );
    expect(sentinel.alive()).toBeTrue();
  }, 90_000);

  test("the child environment is explicit and the host session is never imported or exported", async () => {
    await scriptedScreen();
    seedHostSession();
    const before = hostSession();
    harness = await startDaemon(undefined, {
      useProductionBotScreen: true,
      useHostApplicationUnits: false,
    });
    const botId = await makeBot(harness, "Explicit environment");
    const surface = await owner(harness, botId);
    await waitScreenReady(harness, surface);

    expect(harness.svc.screens.status(surface).state).toBe("ready");
    // The compositor is the child that must never see the host session.
    const compositor = await waitFor(
      () => processesUnder(path.join(harness!.home, "r", "computer")).find((pid) =>
        processCmdline(pid).some((arg) => arg.endsWith("sway"))
      ),
      10_000,
      "the Bot Computer compositor process",
    );
    const childEnvironment = processEnvironment(compositor);
    expect(childEnvironment).not.toContain("OMARCHY_BOT_HOST_SESSION_MARKER=host-session-only");
    expect(childEnvironment.some((entry) => entry.startsWith("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/host-session")))
      .toBeFalse();
    expect(childEnvironment).toContain("WAYLAND_DISPLAY=wayland-0");
    expect(childEnvironment).toContain("XDG_SESSION_TYPE=wayland");
    expect(childEnvironment.some((entry) =>
      entry.startsWith(`XDG_RUNTIME_DIR=${path.join(harness!.home, "r", "computer")}${path.sep}`)
    )).toBeTrue();

    await harness.stop();
    harness = undefined;
    expect(hostSession()).toEqual(before);
  }, 60_000);
});

describe("Service supervision with a user manager present", () => {
  test("transient units stay preferred and their names are unchanged", async () => {
    const fixture = await scriptedScreen();
    manager = createFakeManager();
    const scratch = scratchRoot("managed");
    const home = path.join(scratch, "home");
    const state = path.join(scratch, "state");
    const runtimeRoot = path.join(home, "r");
    managed = await startManagedService({
      home,
      state,
      manager,
      binEnv: fixture.binEnv,
      workersDir: path.resolve(import.meta.dir, "fake-workers"),
      runtimeRoot,
    });
    const request = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${managed!.baseUrl}${p}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID() },
      });
      return (await response.json()) as T;
    };

    await waitFor(
      async () => {
        const agents = await request<Array<{ id: string; status: string }>>("GET", "/api/agents");
        return agents.find((agent) => agent.id === "pi")?.status === "ready" ? true : undefined;
      },
      30_000,
      "the managed Service agent to become ready",
    );
    const bot = await request<{ id: string; surfaceId: SurfaceId }>("POST", "/api/bots", {
      name: "Managed Screen",
      instructions: "",
      agentId: "pi",
    });
    const surface = { botId: bot.id, surfaceId: bot.surfaceId };
    const statePath = `/api/computer/state?botId=${encodeURIComponent(bot.id)}&surfaceId=${encodeURIComponent(bot.surfaceId)}`;
    // A preview request is the ordinary client trigger that starts the Screen.
    const snapshot = await fetch(
      `${managed.baseUrl}/api/computer/snapshot?botId=${encodeURIComponent(bot.id)}&surfaceId=${encodeURIComponent(bot.surfaceId)}`,
    );
    expect(snapshot.status).toBe(200);
    await waitFor(
      async () => {
        const view = await request<{ state: string; activity?: string }>("GET", statePath);
        if (view.state === "unavailable") {
          throw new Error(`managed Screen failed: ${view.activity ?? "unknown"}`);
        }
        return view.state === "ready" ? true : undefined;
      },
      30_000,
      "the managed Screen to become ready",
    );

    const units = manager.units();
    const generation = units.find((unit) => unit.startsWith("omarchy-bot-computer-g"))?.match(/-g(\d+)-/)?.[1];
    expect(generation).toBeString();
    expect(units).toContain(`omarchy-bot-computer-g${generation}-compositor`);
    expect(units).toContain(`omarchy-bot-computer-g${generation}-session-bus`);
    expect(units).toContain(
      `omarchy-bot-screen-${surface.surfaceId.slice("surf_".length)}-g${generation}-application`,
    );

    for (const argv of manager.launches()) {
      expect(argv).toContain("--user");
      expect(argv).toContain("--property=KillMode=control-group");
      const separator = argv.indexOf("--");
      expect(separator).toBeGreaterThan(0);
      expect(path.basename(argv[separator + 1]!)).toBe("env");
      expect(argv[separator + 2]).toBe("-i");
      // `env -i` is followed by explicit K=V pairs only; the child command comes after.
      const tail = argv.slice(separator + 3);
      const commandIndex = tail.findIndex((entry) => !/^[A-Z_][A-Z0-9_]*=/.test(entry));
      const environment = tail.slice(0, commandIndex < 0 ? undefined : commandIndex);
      expect(environment.length).toBeGreaterThan(0);
      expect(environment.some((entry) => entry.startsWith("OMARCHY_BOT_HOST_SESSION_MARKER="))).toBeFalse();
      const privateRuntime = environment.find((entry) => entry.startsWith("XDG_RUNTIME_DIR="))!;
      expect(privateRuntime.startsWith(`XDG_RUNTIME_DIR=${path.join(runtimeRoot, "computer")}`)).toBeTrue();
    }

    const deleted = await request<{ status: string }>("DELETE", `/api/bots/${bot.id}`, {});
    expect(deleted.status).toBe("deleted");
    const stops = await waitFor(
      () => {
        const calls = manager!.systemctlCalls().filter((call) => call.includes("stop"));
        return calls.length > 0 ? calls : undefined;
      },
      15_000,
      "the manager to stop the Surface units",
    );
    expect(stops.every((call) => call.includes("--user"))).toBeTrue();
  }, 120_000);
});

describe("Service supervision ownership safety", () => {
  test("an unrelated process with its own runtime directory survives deletion and shutdown", async () => {
    await scriptedScreen();
    sentinel = startUnrelatedSentinel(scratchRoot("sentinel"));
    harness = await startDaemon(undefined, {
      useProductionBotScreen: true,
      useHostApplicationUnits: false,
    });
    const botId = await makeBot(harness, "Sentinel neighbour");
    const surface = await owner(harness, botId);
    await waitScreenReady(harness, surface);
    const runtimeRoot = path.join(harness.home, "r");
    const owned = processesUnder(runtimeRoot);
    expect(owned.length).toBeGreaterThan(0);
    expect(owned).not.toContain(sentinel.pid);

    await api(harness, "DELETE", `/api/bots/${botId}`, {});
    await waitFor(
      () => (processesUnder(runtimeRoot).length === 0 ? true : undefined),
      10_000,
      "the owned Bot Computer processes to exit",
    );
    expect(sentinel.alive()).toBeTrue();

    await harness.stop();
    harness = undefined;
    expect(sentinel.alive()).toBeTrue();
  }, 60_000);
});
