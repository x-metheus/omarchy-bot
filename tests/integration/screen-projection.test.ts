import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ComputerSurfaceOwner } from "../../apps/daemon/src/modules/computer/broker.ts";
import type { ProjectionWebSocket } from "../../apps/daemon/src/modules/computer/screenProjection.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { api, authedFetch, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";

const RFB_BANNER = new Uint8Array([
  0x52, 0x46, 0x42, 0x20, 0x30, 0x30, 0x33, 0x2e, 0x30, 0x30, 0x38, 0x0a,
]);
const RFB_CLIENT_BYTES = new Uint8Array([1, 2, 3, 4]);

interface SessionDescriptor {
  version: 3;
  sessionId: string;
  surfaceId: string;
  runtimeGeneration: number;
  geometryGeneration: number;
  logicalWidth: number;
  logicalHeight: number;
  videoWidth: number;
  videoHeight: number;
  scale: number;
  state: "connecting";
  controlUrl: string;
  rfbUrl: string;
  snapshotUrl: string;
  security: { authentication: "none"; httpsRequired: false };
}

class SocketInbox {
  #messages: Array<string | Uint8Array> = [];
  #waiters: Array<{
    predicate: (message: string | Uint8Array) => boolean;
    resolve: (message: string | Uint8Array) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }> = [];

  constructor(readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const message = typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new Uint8Array(event.data as ArrayBuffer);
      const waiterIndex = this.#waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex < 0) {
        this.#messages.push(message);
        return;
      }
      const [waiter] = this.#waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
    });
  }

  next(
    predicate: (message: string | Uint8Array) => boolean,
    description: string,
    timeoutMs = 5_000,
  ): Promise<string | Uint8Array> {
    const index = this.#messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error(`${description} timed out`));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }

  json(type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
    return this.next(
      (message) => {
        if (typeof message !== "string") return false;
        try {
          return (JSON.parse(message) as { type?: unknown }).type === type;
        } catch {
          return false;
        }
      },
      `${type} message`,
      timeoutMs,
    ).then((message) => JSON.parse(message as string) as Record<string, unknown>);
  }

  binary(description = "binary WebSocket message"): Promise<Uint8Array> {
    return this.next((message) => message instanceof Uint8Array, description).then((message) => message as Uint8Array);
  }
}

class BackpressuredSocket implements ProjectionWebSocket {
  readonly messages: Array<string | Uint8Array> = [];
  closed = false;

  send(data: string | Uint8Array): number {
    this.messages.push(typeof data === "string" ? data : data.slice());
    return -1;
  }

  close(): void {
    this.closed = true;
  }

  getBufferedAmount(): number {
    return 0;
  }
}

async function ownerFor(h: Harness, botId: string): Promise<ComputerSurfaceOwner> {
  const bot = await api<{ id: string; surfaceId: string }>(h, "GET", `/api/bots/${botId}`);
  return { botId: bot.id, surfaceId: bot.surfaceId as ComputerSurfaceOwner["surfaceId"] };
}

async function until(probe: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!probe()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

function wsUrl(h: Harness, path: string): string {
  const url = new URL(path, h.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (h.token) url.searchParams.set("access_token", h.token);
  return url.href;
}

async function openSocket(url: string): Promise<SocketInbox> {
  const socket = new WebSocket(url);
  const inbox = new SocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${url} did not open`)), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket ${url} failed to open`));
    }, { once: true });
  });
  return inbox;
}

async function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
}

async function createSession(h: Harness, owner: ComputerSurfaceOwner): Promise<SessionDescriptor> {
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
  return await response.json() as SessionDescriptor;
}

function envelope(session: SessionDescriptor): {
  version: 3;
  sessionId: string;
  surfaceId: string;
  runtimeGeneration: number;
} {
  return {
    version: 3,
    sessionId: session.sessionId,
    surfaceId: session.surfaceId,
    runtimeGeneration: session.runtimeGeneration,
  };
}

async function connectControl(h: Harness, session: SessionDescriptor): Promise<SocketInbox> {
  const control = await openSocket(wsUrl(h, session.controlUrl));
  expect(await control.json("view-state")).toEqual({
    ...envelope(session),
    type: "view-state",
    mode: "idle",
  });
  return control;
}

async function setMode(control: SocketInbox, session: SessionDescriptor, mode: "idle" | "preview" | "expanded"): Promise<void> {
  control.socket.send(JSON.stringify({ ...envelope(session), type: "view", mode }));
  expect(await control.json("view-state")).toEqual({
    ...envelope(session),
    type: "view-state",
    mode,
  });
}

describe("WebSocket Screen Projection", () => {
  let h: Harness;
  let adapter: FakeBotScreenRuntimeAdapter;
  const sockets = new Set<WebSocket>();

  beforeEach(async () => {
    adapter = new FakeBotScreenRuntimeAdapter();
    h = await startDaemon(undefined, { botScreenAdapter: adapter });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await h.stop();
  });

  test("creates a version 3 WebSocket projection session without an SDP offer", async () => {
    const owner = await ownerFor(h, await makeBot(h, "WebSocket projected screen"));
    const query = `botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`;
    const response = await authedFetch(h, `${h.baseUrl}/api/computer/projection?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 3 }),
    });

    expect(response.status).toBe(201);
    const descriptor = await response.json() as Record<string, unknown>;
    expect(descriptor).toEqual({
      version: 3,
      sessionId: expect.any(String),
      surfaceId: owner.surfaceId,
      runtimeGeneration: 1,
      geometryGeneration: 1,
      logicalWidth: 1920,
      logicalHeight: 1080,
      videoWidth: 1920,
      videoHeight: 1080,
      scale: 1,
      state: "connecting",
      controlUrl: `/api/computer/projection/control?${query}&sessionId=${encodeURIComponent(String(descriptor.sessionId))}`,
      rfbUrl: `/api/computer/projection/rfb?${query}&sessionId=${encodeURIComponent(String(descriptor.sessionId))}`,
      snapshotUrl: `/api/computer/snapshot?${query}`,
      security: { authentication: "none", httpsRequired: false },
    });
    expect(JSON.stringify(descriptor)).not.toContain("sdp");
    expect(JSON.stringify(descriptor)).not.toContain("candidate");
  });

  test("rejects legacy WebRTC offers instead of converting them", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Legacy offer"));
    const response = await authedFetch(
      h,
      `${h.baseUrl}/api/computer/projection?botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 2, type: "offer", sdp: "v=0" }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "a version 3 Screen Projection request is required" });
  });

  test("sends one bounded PNG message after preview metadata and cleans up on control close", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Preview socket"));
    const session = await createSession(h, owner);
    const control = await connectControl(h, session);
    sockets.add(control.socket);

    await setMode(control, session, "preview");
    const header = await control.json("preview-frame");
    const png = await control.binary("preview PNG");
    expect(header).toEqual({
      ...envelope(session),
      type: "preview-frame",
      geometryGeneration: session.geometryGeneration,
      logicalWidth: session.logicalWidth,
      logicalHeight: session.logicalHeight,
      videoWidth: session.videoWidth,
      videoHeight: session.videoHeight,
      scale: session.scale,
      sequence: 1,
      mediaType: "image/png",
      capturedAt: expect.any(String),
      byteLength: png.byteLength,
    });
    expect(header).not.toHaveProperty("chunkCount");
    expect(png.byteLength).toBeGreaterThan(0);
    expect(adapter.expandedViewsAcquired).toBe(0);
    expect(h.svc.projections.surfaceMedia(owner.surfaceId)).toMatchObject({
      viewers: 1,
      previewViewers: 1,
      expandedViewers: 0,
      rfbActive: false,
    });

    control.socket.close();
    await closed(control.socket);
    await until(
      () => h.svc.projections.surfaceMedia(owner.surfaceId).viewers === 0,
      "preview viewer was not released",
    );
    expect(h.svc.screens.status(owner)).toEqual({ state: "ready" });
    expect(adapter.stops).toEqual([]);
  });

  test("acknowledges expanded mode before bridging every bidirectional RFB byte", async () => {
    const owner = await ownerFor(h, await makeBot(h, "RFB bridge"));
    const session = await createSession(h, owner);
    const control = await connectControl(h, session);
    sockets.add(control.socket);

    await setMode(control, session, "expanded");
    expect(adapter.expandedViewsAcquired).toBe(0);
    const authority = await control.json("input-authority");
    const rfb = await openSocket(wsUrl(h, session.rfbUrl));
    sockets.add(rfb.socket);
    expect(await rfb.binary("RFB banner")).toEqual(RFB_BANNER);
    expect(adapter.expandedViewsAcquired).toBe(1);

    rfb.socket.send(RFB_CLIENT_BYTES);
    expect(await rfb.binary("echoed RFB bytes")).toEqual(RFB_CLIENT_BYTES);
    expect(adapter.inputEvents).toEqual([]);
    expect(h.svc.projections.loadMetrics(owner, session.sessionId)).toMatchObject({
      rfbBytesSent: RFB_BANNER.byteLength + RFB_CLIENT_BYTES.byteLength,
      rfbBytesReceived: RFB_CLIENT_BYTES.byteLength,
    });

    control.socket.send(JSON.stringify({
      ...envelope(session),
      type: "pointer-button",
      geometryGeneration: session.geometryGeneration,
      controllerEpoch: authority.controllerEpoch,
      sequence: 1,
      x: 40,
      y: 50,
      button: "left",
      state: "pressed",
    }));
    await adapter.waitForInputEvents(1);
    expect(adapter.inputEvents[0]?.event).toMatchObject({ type: "button", x: 40, y: 50 });
  });

  test("keeps queued Bun WebSocket sends alive under backpressure", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Backpressured projection"));
    const session = await createSession(h, owner);
    const controlReservation = h.svc.projections.reserveSocket(owner, session.sessionId, "control");
    expect(controlReservation).toBeDefined();
    const control = new BackpressuredSocket();
    expect(h.svc.projections.openSocket(controlReservation!, control)).toBeTrue();

    h.svc.projections.socketMessage(
      controlReservation!,
      JSON.stringify({ ...envelope(session), type: "view", mode: "preview" }),
    );
    await until(
      () => (h.svc.projections.loadMetrics(owner, session.sessionId)?.captureAttempts ?? 0) > 0,
      "preview capture did not run",
    );
    expect(h.svc.projections.loadMetrics(owner, session.sessionId)).toMatchObject({
      previewFrames: 1,
      sendFailures: 0,
    });

    h.svc.projections.socketMessage(
      controlReservation!,
      JSON.stringify({ ...envelope(session), type: "view", mode: "expanded" }),
    );
    const rfbReservation = h.svc.projections.reserveSocket(owner, session.sessionId, "rfb");
    expect(rfbReservation).toBeDefined();
    const rfb = new BackpressuredSocket();
    expect(h.svc.projections.openSocket(rfbReservation!, rfb)).toBeTrue();
    await until(
      () => rfb.messages.some((message) => message instanceof Uint8Array),
      "RFB banner was not queued",
    );
    expect(h.svc.projections.failureDiagnostic(owner, session.sessionId)).toBeUndefined();
    expect(h.svc.projections.status(owner, session.sessionId)).toMatchObject({ state: "expanded" });
    expect(h.svc.projections.loadMetrics(owner, session.sessionId)).toMatchObject({
      rfbBytesSent: RFB_BANNER.byteLength,
      sendFailures: 0,
    });
  });

  test("rejects stale input without forwarding it and releases held authority", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Rejected input"));
    const session = await createSession(h, owner);
    const control = await connectControl(h, session);
    sockets.add(control.socket);
    await setMode(control, session, "expanded");
    const authority = await control.json("input-authority");

    control.socket.send(JSON.stringify({
      ...envelope(session),
      type: "key",
      geometryGeneration: session.geometryGeneration,
      controllerEpoch: authority.controllerEpoch,
      sequence: 2,
      code: "KeyA",
      state: "pressed",
      modifiers: { control: false, alt: false, shift: false, meta: false },
    }));
    await closed(control.socket);
    await adapter.waitForReleases(1);
    expect(adapter.inputEvents).toEqual([]);
    expect(h.svc.projections.failureDiagnostic(owner, session.sessionId)).toMatchObject({
      reason: "transport-failed",
      technicalError: "invalid Web Control input",
    });
  });

  test("closing RFB releases only its view while sibling viewers and the desktop remain live", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Multiple viewers"));
    const firstSession = await createSession(h, owner);
    const secondSession = await createSession(h, owner);
    const firstControl = await connectControl(h, firstSession);
    const secondControl = await connectControl(h, secondSession);
    sockets.add(firstControl.socket);
    sockets.add(secondControl.socket);
    await setMode(firstControl, firstSession, "expanded");
    await setMode(secondControl, secondSession, "expanded");
    await firstControl.json("input-authority");
    await secondControl.json("input-authority");

    const firstRfb = await openSocket(wsUrl(h, firstSession.rfbUrl));
    const secondRfb = await openSocket(wsUrl(h, secondSession.rfbUrl));
    sockets.add(firstRfb.socket);
    sockets.add(secondRfb.socket);
    expect(await firstRfb.binary()).toEqual(RFB_BANNER);
    expect(await secondRfb.binary()).toEqual(RFB_BANNER);
    expect(adapter.expandedViewsAcquired).toBe(2);
    expect(h.svc.projections.surfaceMedia(owner.surfaceId)).toMatchObject({
      viewers: 2,
      expandedViewers: 2,
      rfbActive: true,
    });

    firstRfb.socket.close();
    await closed(firstRfb.socket);
    await until(() => adapter.expandedViewsReleased === 1, "first RFB lease was not released");
    expect(h.svc.projections.status(owner, firstSession.sessionId)).toMatchObject({ mode: "expanded" });
    secondRfb.socket.send(RFB_CLIENT_BYTES);
    expect(await secondRfb.binary()).toEqual(RFB_CLIENT_BYTES);

    firstControl.socket.close();
    await closed(firstControl.socket);
    await until(() => h.svc.projections.surfaceMedia(owner.surfaceId).viewers === 1, "first viewer remained");
    expect(h.svc.projections.status(owner, secondSession.sessionId)).toMatchObject({ state: "expanded" });
    expect(h.svc.screens.status(owner)).toEqual({ state: "ready" });
    expect(adapter.stops).toEqual([]);

    secondControl.socket.close();
    await closed(secondControl.socket);
    await until(() => adapter.expandedViewsReleased === 2, "last RFB lease was not released");
    expect(h.svc.projections.surfaceMedia(owner.surfaceId)).toEqual({
      surfaceId: owner.surfaceId,
      viewers: 0,
      previewViewers: 0,
      expandedViewers: 0,
      captureActive: false,
      rfbActive: false,
    });
    expect(h.svc.screens.status(owner)).toEqual({ state: "ready" });
    expect(adapter.stops).toEqual([]);
  }, 15_000);

  // Ticket 02 acceptance runs this file by path: bun test tests/integration/screen-projection.test.ts
  test("tolerates consecutive stalled captures and keeps the Bot Screen in preview", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Stalled preview"));
    const session = await createSession(h, owner);
    const control = await connectControl(h, session);
    sockets.add(control.socket);

    adapter.stallNextCaptures(owner.surfaceId, 2);
    await setMode(control, session, "preview");
    expect(await control.json("preview-frame", 20_000)).toMatchObject({
      ...envelope(session),
      type: "preview-frame",
      sequence: 1,
    });
    expect((await control.binary("preview PNG")).byteLength).toBeGreaterThan(0);
    expect(h.svc.projections.failureDiagnostic(owner, session.sessionId)).toBeUndefined();
    expect(h.svc.projections.status(owner, session.sessionId)).toMatchObject({ state: "preview", mode: "preview" });

    adapter.stallNextCaptures(owner.surfaceId, 1);
    expect(await control.json("preview-frame", 20_000)).toMatchObject({
      ...envelope(session),
      type: "preview-frame",
      sequence: 2,
    });
    expect(h.svc.projections.failureDiagnostic(owner, session.sessionId)).toBeUndefined();
    const metrics = h.svc.projections.loadMetrics(owner, session.sessionId)!;
    expect(metrics).toMatchObject({
      captureAttempts: 5,
      sourceFrames: 2,
      previewFrames: 2,
      transientCaptureFailures: 3,
    });
    expect(metrics.unexplainedShortfalls).toBe(metrics.previewFrames - metrics.browserReceives);
  }, 40_000);

  test("ends the preview with capture-failed after three consecutive stalled captures", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Persistently stalled preview"));
    const session = await createSession(h, owner);
    const control = await connectControl(h, session);
    sockets.add(control.socket);

    adapter.stallNextCaptures(owner.surfaceId, 3);
    await setMode(control, session, "preview");
    expect(await control.json("projection-failure", 20_000)).toMatchObject({
      ...envelope(session),
      type: "projection-failure",
      reason: "capture-failed",
      snapshotFallback: true,
    });
    expect(h.svc.projections.failureDiagnostic(owner, session.sessionId)).toMatchObject({
      reason: "capture-failed",
      technicalError: "Screen capture did not produce a frame within its latency bound",
    });
    expect(h.svc.projections.loadMetrics(owner, session.sessionId)).toMatchObject({
      captureAttempts: 3,
      sourceFrames: 0,
      transientCaptureFailures: 3,
      unexplainedShortfalls: 0,
    });
    expect(adapter.captureStarts(owner.surfaceId)).toBe(3);
  }, 30_000);

  test("aborts a timed-out capture and starts no capture over a live one", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Aborted capture"));
    const session = await createSession(h, owner);
    const control = await connectControl(h, session);
    sockets.add(control.socket);

    adapter.stallNextCaptures(owner.surfaceId, 2);
    // A killed child takes real time to end, so a retry that did not wait for
    // it would be visible as a capture accounted for before its child is gone.
    adapter.blockCaptureTeardown();
    await setMode(control, session, "preview");
    await adapter.waitForCaptureTeardown();
    await Bun.sleep(400);
    // The timed-out frame still owns the capture slot while its child lives.
    expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(1);
    expect(adapter.captureStarts(owner.surfaceId)).toBe(1);
    expect(h.svc.projections.loadMetrics(owner, session.sessionId)).toMatchObject({
      captureAttempts: 1,
      transientCaptureFailures: 0,
    });
    expect(h.svc.projections.surfaceMedia(owner.surfaceId).captureActive).toBeTrue();
    adapter.releaseCaptureTeardown();

    expect(await control.json("preview-frame", 20_000)).toMatchObject({
      ...envelope(session),
      type: "preview-frame",
      sequence: 1,
    });
    expect(adapter.captureAborts(owner.surfaceId)).toBe(2);
    expect(adapter.captureStarts(owner.surfaceId)).toBe(3);
    expect(adapter.maxConcurrentCaptures(owner.surfaceId)).toBe(1);
    // Every capture began with no child still running from the previous one.
    expect(adapter.captureStartLiveChildren(owner.surfaceId)).toEqual([0, 0, 0]);
    expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(0);
  }, 30_000);

  test("ends a capture child whose signal had already aborted before its kill hook", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Pre-aborted capture"));
    const source = (await h.svc.screens.projectionSource(owner))!;
    adapter.stallNextCaptures(owner.surfaceId, 1);
    const controller = new AbortController();
    controller.abort(new Error("capture deadline already passed"));

    await expect(source.capture(controller.signal)).rejects.toThrow("capture deadline already passed");

    expect(adapter.captureAborts(owner.surfaceId)).toBe(1);
    expect(adapter.captureStartLiveChildren(owner.surfaceId)).toEqual([0]);
    expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(0);
    expect(adapter.maxConcurrentCaptures(owner.surfaceId)).toBe(1);
  }, 15_000);

  test("a capture aborted while its child spawns holds the next capture until that child is gone", async () => {
    const owner = await ownerFor(h, await makeBot(h, "Spawn-window abort"));
    const source = (await h.svc.screens.projectionSource(owner))!;
    adapter.stallNextCaptures(owner.surfaceId, 1);
    adapter.blockCaptureTeardown();
    const controller = new AbortController();
    // The deadline lands after the child exists, before the capture installs
    // its kill hook.
    adapter.onCaptureSpawn(() => controller.abort(new Error("capture deadline passed during spawn")));

    const aborted = source.capture(controller.signal);
    await adapter.waitForCaptureTeardown();
    const next = source.capture();
    await Bun.sleep(50);
    expect(adapter.captureStarts(owner.surfaceId)).toBe(1);
    expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(1);

    adapter.releaseCaptureTeardown();
    await expect(aborted).rejects.toThrow("capture deadline passed during spawn");
    expect(adapter.captureAborts(owner.surfaceId)).toBe(1);
    expect(adapter.liveCaptureChildren(owner.surfaceId)).toBe(0);

    await next;
    expect(adapter.captureStarts(owner.surfaceId)).toBe(2);
    expect(adapter.captureStartLiveChildren(owner.surfaceId)).toEqual([0, 0]);
    expect(adapter.maxConcurrentCaptures(owner.surfaceId)).toBe(1);
  }, 15_000);

  test("fails the first time a capture reports an unusable Bot Screen", async () => {
    for (const technicalError of ["Bot Desktop is not running", "Bot Computer compositor is not running"]) {
      const owner = await ownerFor(h, await makeBot(h, `Unusable screen ${technicalError}`));
      adapter.failCapturesWith(owner.surfaceId, technicalError);
      const session = await createSession(h, owner);
      const control = await connectControl(h, session);
      sockets.add(control.socket);

      await setMode(control, session, "preview");
      expect(await control.json("projection-failure")).toMatchObject({
        ...envelope(session),
        type: "projection-failure",
        reason: "capture-failed",
        snapshotFallback: true,
      });
      expect(h.svc.projections.failureDiagnostic(owner, session.sessionId)).toMatchObject({
        reason: "capture-failed",
        technicalError,
      });
      expect(h.svc.projections.loadMetrics(owner, session.sessionId)).toMatchObject({
        captureAttempts: 1,
        sourceFrames: 0,
        transientCaptureFailures: 0,
        unexplainedShortfalls: 0,
      });
    }
  }, 30_000);
});
