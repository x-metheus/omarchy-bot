import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BotScreenInputRejectedError } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import type { ComputerSurfaceOwner } from "../../apps/daemon/src/modules/computer/broker.ts";
import type { SurfaceId } from "../../packages/domain/src/ids.ts";
import { api, authedFetch, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { createScriptedSwayFixture, type ScriptedSwayFixture } from "./helpers/swayBotScreen.ts";

const SURFACE = "surf_55555555555555555555555555555555" as SurfaceId;

const RFB_BANNER = new Uint8Array([
  0x52, 0x46, 0x42, 0x20, 0x30, 0x30, 0x33, 0x2e, 0x30, 0x30, 0x38, 0x0a,
]);

const RFB_POINTER_EVENT = new Uint8Array([
  5,
  1,
  0, 10,
  0, 20,
]);

function provision(surfaceId = SURFACE) {
  return {
    surfaceId,
    geometryGeneration: 1,
    logicalWidth: 1920,
    logicalHeight: 1080,
    scale: 1,
    refreshRate: 15,
  };
}

function wayvncSocket(fixture: ScriptedSwayFixture, surfaceId: string): string {
  return path.join(fixture.runtimeRoot, `wv-${surfaceId.slice("surf_".length)}.sock`);
}

function leftoverWayvncSockets(fixture: ScriptedSwayFixture, surfaceId: string): string[] {
  try {
    return readdirSync(fixture.runtimeRoot).filter((entry) => entry.startsWith(`wv-${surfaceId.slice("surf_".length)}`) && entry.endsWith(".sock"));
  } catch {
    return [];
  }
}

async function until(probe: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!probe()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

let fixture: ScriptedSwayFixture | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  if (harness !== undefined) {
    await harness.stop().catch(() => {});
    harness = undefined;
  }
  fixture?.dispose();
  fixture = undefined;
});

test("expanded view starts one owner-only WayVNC unix socket and close leaves Sway ready", async () => {
  fixture = await createScriptedSwayFixture();
  const runtime = await fixture.adapter.start(provision());
  expect(fixture.wayvncStarts()).toBe(0);
  expect(existsSync(wayvncSocket(fixture, SURFACE))).toBeFalse();

  await runtime.capture();
  const stream = await runtime.openCaptureStream();
  await stream.close();
  expect(fixture.wayvncStarts()).toBe(0);

  const view = await runtime.acquireExpandedView();
  await until(() => existsSync(wayvncSocket(fixture!, SURFACE)), "WayVNC unix socket was not created");
  expect(fixture.wayvncStarts()).toBe(1);
  expect(lstatSync(wayvncSocket(fixture, SURFACE)).isSocket()).toBeTrue();
  expect(statSync(wayvncSocket(fixture, SURFACE)).mode & 0o777).toBe(0o600);
  expect(fixture.wayvncArgvTokens()).toContain("--unix-socket");
  expect(fixture.wayvncArgvTokens()).toContain(wayvncSocket(fixture, SURFACE));
  expect(fixture.wayvncArgvTokens()).toContain("HEADLESS-1");
  expect(fixture.wayvncArgvTokens()).toContain("--disable-input");
  // Pinned wayvnc 0.10.1 rejects unknown --disable-paste; clipboard is
  // disabled by --disable-input.
  expect(fixture.wayvncArgvTokens()).not.toContain("--disable-paste");
  expect(fixture.wayvncArgvTokens().some((token) => token.startsWith("unix:path="))).toBeFalse();
  expect(fixture.wayvncArgvTokens().join(" ")).not.toMatch(/(?:^|\s)(?:-L|0\.0\.0\.0|:5900)(?:\s|$)/);
  expect(fixture.wayvncEnv()).toContain("WAYLAND_DISPLAY=wayland-0");
  expect(await view.receive()).toEqual(RFB_BANNER);

  await view.close();
  await until(() => !existsSync(wayvncSocket(fixture!, SURFACE)), "WayVNC unix socket remained after lease close");
  expect(fixture.wayvncStarts()).toBe(1);
  expect(runtime.readiness.compositor).toBe("ready");
  expect(runtime.readiness.desktopSurface).toBe("ready");
  expect(fixture.stops).toEqual([]);
  const outcome = await Promise.race([
    runtime.outcome.then(() => "resolved" as const),
    Bun.sleep(50).then(() => "pending" as const),
  ]);
  expect(outcome).toBe("pending");
  expect(await runtime.capture()).toMatchObject({ mediaType: "image/png" });
  await runtime.stop();
});

test("expanded WayVNC follows Sway when it binds wayland-1", async () => {
  fixture = await createScriptedSwayFixture({ waylandDisplay: "wayland-1" });
  const runtime = await fixture.adapter.start(provision());
  const view = await runtime.acquireExpandedView();
  expect(fixture.wayvncEnv()).toContain("WAYLAND_DISPLAY=wayland-1");
  expect(fixture.wayvncEnv()).not.toContain("WAYLAND_DISPLAY=wayland-0");
  expect(await view.receive()).toEqual(RFB_BANNER);
  await view.close();
  await runtime.stop();
});

test("two expanded leases share one WayVNC process and survive a sibling close", async () => {
  fixture = await createScriptedSwayFixture();
  const runtime = await fixture.adapter.start(provision());
  const first = await runtime.acquireExpandedView();
  const second = await runtime.acquireExpandedView();
  expect(fixture.wayvncStarts()).toBe(1);
  expect(existsSync(wayvncSocket(fixture, SURFACE))).toBeTrue();
  expect(await first.receive()).toEqual(RFB_BANNER);
  expect(await second.receive()).toEqual(RFB_BANNER);

  await first.close();
  expect(existsSync(wayvncSocket(fixture, SURFACE))).toBeTrue();
  expect(fixture.wayvncStarts()).toBe(1);
  expect(runtime.readiness.compositor).toBe("ready");
  expect(fixture.starts).toHaveLength(1);
  expect(fixture.stops).toEqual([]);
  await second.send(RFB_POINTER_EVENT);
  expect(await second.receive()).toEqual(RFB_POINTER_EVENT);

  await second.close();
  await until(() => !existsSync(wayvncSocket(fixture!, SURFACE)), "WayVNC unix socket remained after last lease close");
  expect(fixture.wayvncStarts()).toBe(1);
  expect(runtime.readiness.compositor).toBe("ready");
  expect(await runtime.capture()).toMatchObject({ mediaType: "image/png" });
  await runtime.stop();
});

test("RFB pointer bytes on the expanded-view lease do not move the Bot Screen", async () => {
  fixture = await createScriptedSwayFixture();
  const runtime = await fixture.adapter.start(provision());
  const view = await runtime.acquireExpandedView();
  expect(await view.receive()).toEqual(RFB_BANNER);

  await view.send(RFB_POINTER_EVENT);
  await Bun.sleep(50);
  expect(fixture.inputCommands().some((line) => line.startsWith("motion ") || line.startsWith("button "))).toBeFalse();

  await runtime.setInputAuthority(1);
  await runtime.input({
    surfaceId: SURFACE,
    runtimeGeneration: runtime.generation,
    geometryGeneration: 1,
    controllerEpoch: 1,
    sequence: 1,
    type: "button",
    x: 12,
    y: 34,
    button: "left",
    state: "pressed",
  });
  expect(fixture.inputCommands().some((line) => line.startsWith("button "))).toBeTrue();
  await view.close();
  await runtime.stop();
});

interface ProjectionSession {
  sessionId: string;
  surfaceId: string;
  runtimeGeneration: number;
  geometryGeneration: number;
  controlUrl: string;
  rfbUrl: string;
}

class SocketInbox {
  #messages: Array<string | Uint8Array> = [];
  #waiters: Array<(message: string | Uint8Array) => boolean> = [];

  constructor(readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const message = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const waiter = this.#waiters.shift();
      if (waiter === undefined || !waiter(message)) this.#messages.push(message);
    });
  }

  next(predicate: (message: string | Uint8Array) => boolean, description: string): Promise<string | Uint8Array> {
    const index = this.#messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${description} timed out`)), 5_000);
      const consume = (message: string | Uint8Array): boolean => {
        if (!predicate(message)) {
          this.#waiters.unshift(consume);
          return false;
        }
        clearTimeout(timer);
        resolve(message);
        return true;
      };
      this.#waiters.push(consume);
    });
  }

  json(type: string): Promise<Record<string, unknown>> {
    return this.next((message) => {
      if (typeof message !== "string") return false;
      try {
        return (JSON.parse(message) as { type?: string }).type === type;
      } catch {
        return false;
      }
    }, type).then((message) => JSON.parse(message as string) as Record<string, unknown>);
  }

  binary(description: string): Promise<Uint8Array> {
    return this.next((message) => message instanceof Uint8Array, description).then((message) => message as Uint8Array);
  }
}

async function ownerFor(h: Harness, botId: string): Promise<ComputerSurfaceOwner> {
  const bot = await api<{ id: string; surfaceId: string }>(h, "GET", `/api/bots/${botId}`);
  return { botId: bot.id, surfaceId: bot.surfaceId as ComputerSurfaceOwner["surfaceId"] };
}

function envelope(session: ProjectionSession): object {
  return {
    version: 3,
    sessionId: session.sessionId,
    surfaceId: session.surfaceId,
    runtimeGeneration: session.runtimeGeneration,
  };
}

async function createProjection(h: Harness, owner: ComputerSurfaceOwner): Promise<ProjectionSession> {
  const response = await authedFetch(
    h,
    `${h.baseUrl}/api/computer/projection?botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 3 }),
    },
  );
  if (response.status !== 201) throw new Error(`projection creation failed: ${response.status} ${await response.text()}`);
  return await response.json() as ProjectionSession;
}

async function openProjectionSocket(h: Harness, path: string): Promise<SocketInbox> {
  const url = new URL(path, h.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (h.token) url.searchParams.set("access_token", h.token);
  const socket = new WebSocket(url.href);
  const inbox = new SocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("projection WebSocket did not open")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("projection WebSocket failed"));
    }, { once: true });
  });
  return inbox;
}

async function connectControl(h: Harness, session: ProjectionSession): Promise<SocketInbox> {
  const control = await openProjectionSocket(h, session.controlUrl);
  expect(await control.json("view-state")).toMatchObject({ ...envelope(session), mode: "idle" });
  return control;
}

async function setMode(control: SocketInbox, session: ProjectionSession, mode: "preview" | "expanded"): Promise<void> {
  control.socket.send(JSON.stringify({ ...envelope(session), type: "view", mode }));
  expect(await control.json("view-state")).toMatchObject({ ...envelope(session), mode });
}

test("Sway preview streams PNG on the control socket without starting WayVNC", async () => {
  fixture = await createScriptedSwayFixture();
  harness = await startDaemon(undefined, { botScreenAdapter: fixture.adapter });
  const owner = await ownerFor(harness, await makeBot(harness, "Sway preview"));
  const projection = await createProjection(harness, owner);
  const control = await connectControl(harness, projection);
  try {
    await setMode(control, projection, "preview");
    const header = await control.json("preview-frame");
    const png = await control.binary("preview PNG");
    expect(header).toMatchObject({
      ...envelope(projection),
      mediaType: "image/png",
      byteLength: png.byteLength,
    });
    expect(header).not.toHaveProperty("chunkCount");
    expect(fixture.wayvncStarts()).toBe(0);
    expect(existsSync(wayvncSocket(fixture, owner.surfaceId))).toBeFalse();
  } finally {
    control.socket.close();
  }
}, 15_000);

test("Sway expanded projection bridges actual RFB bytes while Broker input stays separate", async () => {
  fixture = await createScriptedSwayFixture();
  harness = await startDaemon(undefined, { botScreenAdapter: fixture.adapter });
  const owner = await ownerFor(harness, await makeBot(harness, "Sway RFB bridge"));
  const projection = await createProjection(harness, owner);
  const control = await connectControl(harness, projection);
  let rfb: SocketInbox | undefined;
  try {
    await setMode(control, projection, "expanded");
    const authority = await control.json("input-authority");
    expect(fixture.wayvncStarts()).toBe(0);
    rfb = await openProjectionSocket(harness, projection.rfbUrl);
    expect(await rfb.binary("RFB banner")).toEqual(RFB_BANNER);
    expect(fixture.wayvncStarts()).toBe(1);
    expect(JSON.stringify(projection)).not.toContain(wayvncSocket(fixture, owner.surfaceId));

    rfb.socket.send(RFB_POINTER_EVENT);
    expect(await rfb.binary("RFB response")).toEqual(RFB_POINTER_EVENT);
    await Bun.sleep(50);
    expect(fixture.inputCommands().some((line) => line.startsWith("motion ") || line.startsWith("button "))).toBeFalse();

    control.socket.send(JSON.stringify({
      ...envelope(projection),
      type: "pointer-button",
      geometryGeneration: projection.geometryGeneration,
      controllerEpoch: authority.controllerEpoch,
      sequence: 1,
      x: 40,
      y: 50,
      button: "left",
      state: "pressed",
    }));
    await until(
      () => fixture!.inputCommands().some((line) => line.startsWith("button ")),
      "Broker pointer input was not delivered",
    );
  } finally {
    rfb?.socket.close();
    control.socket.close();
  }
}, 15_000);

test("WayVNC failure fails only projection and leaves the Sway desktop ready", async () => {
  fixture = await createScriptedSwayFixture();
  harness = await startDaemon(undefined, { botScreenAdapter: fixture.adapter });
  const owner = await ownerFor(harness, await makeBot(harness, "Sway bridge failure"));
  const projection = await createProjection(harness, owner);
  const control = await connectControl(harness, projection);
  let rfb: SocketInbox | undefined;
  try {
    await setMode(control, projection, "expanded");
    rfb = await openProjectionSocket(harness, projection.rfbUrl);
    expect(await rfb.binary("RFB banner")).toEqual(RFB_BANNER);
    fixture.exitWayvnc();
    expect(await control.json("projection-failure")).toMatchObject({
      ...envelope(projection),
      reason: "rfb-bridge-failed",
      snapshotFallback: true,
    });
    const status = await authedFetch(
      harness,
      `${harness.baseUrl}/api/computer/projection?botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}&sessionId=${encodeURIComponent(projection.sessionId)}`,
    );
    expect(await status.json()).toMatchObject({ state: "failed", failure: "rfb-bridge-failed" });
    expect(harness.svc.screens.status(owner)).toEqual({ state: "ready" });
    expect(fixture.stops).toEqual([]);
    expect(await harness.svc.screens.act(owner, { name: "screenshot", args: {} })).toMatchObject({
      image: { mediaType: "image/png" },
    });
  } finally {
    rfb?.socket.close();
    control.socket.close();
  }
}, 15_000);

test("two expanded viewers share WayVNC until the final RFB lease closes", async () => {
  fixture = await createScriptedSwayFixture();
  harness = await startDaemon(undefined, { botScreenAdapter: fixture.adapter });
  const owner = await ownerFor(harness, await makeBot(harness, "Sway shared viewers"));
  const firstSession = await createProjection(harness, owner);
  const secondSession = await createProjection(harness, owner);
  const firstControl = await connectControl(harness, firstSession);
  const secondControl = await connectControl(harness, secondSession);
  let firstRfb: SocketInbox | undefined;
  let secondRfb: SocketInbox | undefined;
  try {
    await setMode(firstControl, firstSession, "expanded");
    await setMode(secondControl, secondSession, "expanded");
    firstRfb = await openProjectionSocket(harness, firstSession.rfbUrl);
    secondRfb = await openProjectionSocket(harness, secondSession.rfbUrl);
    expect(await firstRfb.binary("first RFB banner")).toEqual(RFB_BANNER);
    expect(await secondRfb.binary("second RFB banner")).toEqual(RFB_BANNER);
    expect(fixture.wayvncStarts()).toBe(1);
    const socketPath = wayvncSocket(fixture, owner.surfaceId);
    expect(existsSync(socketPath)).toBeTrue();

    firstRfb.socket.close();
    firstControl.socket.close();
    await until(() => harness!.svc.projections.surfaceMedia(owner.surfaceId).viewers === 1, "first viewer remained");
    expect(existsSync(socketPath)).toBeTrue();
    secondRfb.socket.send(RFB_POINTER_EVENT);
    expect(await secondRfb.binary("surviving RFB response")).toEqual(RFB_POINTER_EVENT);
    expect(harness.svc.screens.status(owner)).toEqual({ state: "ready" });

    secondRfb.socket.close();
    secondControl.socket.close();
    await until(() => !existsSync(socketPath), "WayVNC remained after final viewer close");
    expect(harness.svc.projections.surfaceMedia(owner.surfaceId)).toMatchObject({
      viewers: 0,
      expandedViewers: 0,
      rfbActive: false,
    });
    expect(harness.svc.screens.status(owner)).toEqual({ state: "ready" });
    expect(fixture.starts).toHaveLength(1);
    expect(fixture.stops).toEqual([]);
  } finally {
    firstRfb?.socket.close();
    secondRfb?.socket.close();
    firstControl.socket.close();
    secondControl.socket.close();
  }
}, 15_000);

test("RFB remains available when Broker authority activation is rejected", async () => {
  fixture = await createScriptedSwayFixture();
  const inner = fixture.adapter;
  harness = await startDaemon(undefined, {
    botScreenAdapter: {
      start: async (runtimeProvision) => {
        const runtime = await inner.start(runtimeProvision);
        runtime.setInputAuthority = async () => {
          throw new BotScreenInputRejectedError("input helper rejected authority");
        };
        return runtime;
      },
      reconcile: (runtimeProvision) => inner.reconcile?.(runtimeProvision) ?? Promise.resolve(undefined),
      destroy: (surfaceId) => inner.destroy?.(surfaceId) ?? Promise.resolve(),
    },
  });
  const owner = await ownerFor(harness, await makeBot(harness, "Sway view without authority"));
  const projection = await createProjection(harness, owner);
  const control = await connectControl(harness, projection);
  let rfb: SocketInbox | undefined;
  try {
    await setMode(control, projection, "expanded");
    rfb = await openProjectionSocket(harness, projection.rfbUrl);
    expect(await rfb.binary("RFB banner without authority")).toEqual(RFB_BANNER);
    expect(harness.svc.projections.status(owner, projection.sessionId)?.state).not.toBe("failed");
    expect(harness.svc.screens.status(owner)).toEqual({ state: "ready" });
  } finally {
    rfb?.socket.close();
    control.socket.close();
  }
}, 15_000);

test("expanded transport preserves ordered bytes across partial writes and drain", async () => {
  fixture = await createScriptedSwayFixture();
  const runtime = await fixture.adapter.start(provision());
  const connect = Bun.connect.bind(Bun);
  let drain: (() => void) | undefined;
  let allowance = 2;
  const connectSpy = spyOn(Bun, "connect").mockImplementation(async (options) => {
    const socket = await ("unix" in options ? connect(options) : connect(options));
    const write = socket.write.bind(socket);
    spyOn(socket, "write").mockImplementation((data) => {
      const bytes = data as Uint8Array;
      const count = Math.min(allowance, bytes.byteLength);
      if (count === 0) return 0;
      allowance -= count;
      return write(bytes.subarray(0, count));
    });
    drain = () => options.socket.drain?.(socket);
    return socket;
  });
  try {
    const view = await runtime.acquireExpandedView();
    connectSpy.mockRestore();
    expect(await view.receive()).toEqual(RFB_BANNER);
    let firstComplete = false;
    const first = view.send(new Uint8Array([1, 2, 3, 4])).then(() => { firstComplete = true; });
    const second = view.send(new Uint8Array([5, 6, 7]));
    await Bun.sleep(20);
    expect(firstComplete).toBeFalse();
    allowance = 5;
    drain?.();
    await Promise.all([first, second]);
    const received: number[] = [];
    while (received.length < 7) received.push(...await view.receive());
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7]);
    allowance = 0;
    const blocked = view.send(new Uint8Array([8, 9]));
    const rejected = blocked.then(() => undefined, (error: unknown) => error);
    await view.close();
    expect(await rejected).toBeInstanceOf(Error);
    expect(String(await rejected)).toMatch(/closed/);
  } finally {
    connectSpy.mockRestore();
    await runtime.stop();
  }
});

test("last viewer downgrade waits for old WayVNC shutdown before another expansion", async () => {
  fixture = await createScriptedSwayFixture();
  const stopping = path.join(path.dirname(fixture.wayvncBin), "stopping");
  const release = path.join(path.dirname(fixture.wayvncBin), "release-stop");
  const source = readFileSync(fixture.wayvncBin, "utf8");
  writeFileSync(fixture.wayvncBin, source.replace('const startsPath =', `
process.on("SIGTERM", async () => {
  writeFileSync(${JSON.stringify(stopping)}, "1");
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
  process.exit(0);
});
const startsPath =`));
  const runtime = await fixture.adapter.start(provision());
  try {
    const preview = await runtime.openCaptureStream();
    const first = await runtime.acquireExpandedView();
    expect(await first.receive()).toEqual(RFB_BANNER);
    const closing = first.close();
    await until(() => existsSync(stopping), "old WayVNC did not enter delayed shutdown");
    const expanding = runtime.acquireExpandedView();
    await Bun.sleep(50);
    expect(fixture.wayvncStarts()).toBe(1);
    writeFileSync(release, "1");
    await closing;
    const replacement = await expanding;
    expect(await replacement.receive()).toEqual(RFB_BANNER);
    expect(existsSync(wayvncSocket(fixture, SURFACE))).toBeTrue();
    const sibling = await runtime.acquireExpandedView();
    expect(await sibling.receive()).toEqual(RFB_BANNER);
    await replacement.send(RFB_POINTER_EVENT);
    expect(await replacement.receive()).toEqual(RFB_POINTER_EVENT);
    expect((await runtime.capture()).mediaType).toBe("image/png");
    expect(fixture.starts).toHaveLength(1);
    await sibling.close();
    await replacement.close();
    await preview.close();
  } finally {
    writeFileSync(release, "1");
    await runtime.stop();
  }
});
