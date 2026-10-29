import { afterEach, describe, expect, test } from "bun:test";
import { SCREEN_PROJECTION_PROTOCOL_VERSION } from "@omarchy-bot/protocol";
import {
  ScreenProjectionConnection,
  type ScreenExpandedView,
  type ScreenProjectionState,
} from "./screenProjection.ts";
import { createMemoryShell, installShell } from "./shell.ts";

const SURFACE_ID = "surf_0123456789abcdef0123456789abcdef";
const SESSION_ID = "projection-session";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];
  readonly sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string | URL) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

interface ProjectionRequest {
  url: string;
  method: string;
  body: unknown;
}

function sessionDescriptor(overrides: Partial<Record<string, unknown>> = {}): object {
  return {
    version: SCREEN_PROJECTION_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    surfaceId: SURFACE_ID,
    runtimeGeneration: 1,
    geometryGeneration: 1,
    logicalWidth: 1920,
    logicalHeight: 1080,
    videoWidth: 1920,
    videoHeight: 1080,
    scale: 1,
    state: "connecting",
    controlUrl: `/api/computer/projection/control?botId=bot&surfaceId=${SURFACE_ID}&sessionId=${SESSION_ID}`,
    rfbUrl: `/api/computer/projection/rfb?botId=bot&surfaceId=${SURFACE_ID}&sessionId=${SESSION_ID}`,
    snapshotUrl: `/api/computer/snapshot?botId=bot&surfaceId=${SURFACE_ID}`,
    security: { authentication: "none", httpsRequired: false },
    ...overrides,
  };
}

function installBrowser(descriptor: unknown = sessionDescriptor()): ProjectionRequest[] {
  installShell(createMemoryShell({ storage: null, baseUrl: "https://client.example" }));
  const requests: ProjectionRequest[] = [];
  Object.assign(globalThis, {
    RTCPeerConnection: undefined,
    WebSocket: FakeWebSocket,
    window: {
      setTimeout,
      clearTimeout,
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(descriptor), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return requests;
}

function connection(callbacks: {
  states?: ScreenProjectionState[];
  frames?: Array<Blob | undefined>;
  expanded?: Array<ScreenExpandedView | undefined>;
  control?: boolean[];
  errors?: string[];
} = {}): ScreenProjectionConnection {
  return new ScreenProjectionConnection(
    "https://client.example/api/computer/projection",
    { botId: "bot", surfaceId: SURFACE_ID },
    {
      onState: (state) => callbacks.states?.push(state),
      onFrame: (frame) => callbacks.frames?.push(frame),
      onError: (error) => callbacks.errors?.push(error),
      onExpandedView: (view) => callbacks.expanded?.push(view),
      onControlStateChange: (active) => callbacks.control?.push(active),
    },
  );
}

function identity(type: string): Record<string, unknown> {
  return {
    version: SCREEN_PROJECTION_PROTOCOL_VERSION,
    type,
    sessionId: SESSION_ID,
    surfaceId: SURFACE_ID,
    runtimeGeneration: 1,
  };
}

function geometry(): Record<string, unknown> {
  return {
    geometryGeneration: 1,
    logicalWidth: 1920,
    logicalHeight: 1080,
    videoWidth: 1920,
    videoHeight: 1080,
    scale: 1,
  };
}

function sentJson(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as Record<string, unknown>);
}

const originalPeerConnection = globalThis.RTCPeerConnection;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  Object.assign(globalThis, {
    RTCPeerConnection: originalPeerConnection,
    fetch: originalFetch,
    window: originalWindow,
    WebSocket: originalWebSocket,
  });
  FakeWebSocket.instances.length = 0;
});

test("connects a version 3 projection descriptor through its control WebSocket", async () => {
  const requests = installBrowser();
  const projection = connection();

  await projection.connect();

  expect(requests).toEqual([{
    url: `https://client.example/api/computer/projection?botId=bot&surfaceId=${SURFACE_ID}`,
    method: "POST",
    body: { version: SCREEN_PROJECTION_PROTOCOL_VERSION },
  }]);
  expect(FakeWebSocket.instances.map(({ url }) => String(url))).toEqual([
    `wss://client.example/api/computer/projection/control?botId=bot&surfaceId=${SURFACE_ID}&sessionId=${SESSION_ID}`,
  ]);
  projection.close();
});

describe("expanded view authority", () => {
  test("waits for the matching expanded acknowledgement and noVNC connection before enabling input", async () => {
    installBrowser();
    const states: ScreenProjectionState[] = [];
    const expanded: Array<ScreenExpandedView | undefined> = [];
    const control: boolean[] = [];
    const projection = connection({ states, expanded, control });
    await projection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    projection.setMode("expanded");

    socket.message(JSON.stringify({
      ...identity("input-authority"),
      ...geometry(),
      geometryGeneration: 2,
      active: true,
      controllerEpoch: 7,
    }));
    socket.message(JSON.stringify({
      ...identity("view-state"),
      sessionId: "stale-session",
      mode: "expanded",
    }));
    expect(expanded).toEqual([]);
    expect(projection.keyTransition("KeyA", "pressed", {
      control: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe(false);

    socket.message(JSON.stringify({ ...identity("view-state"), mode: "expanded" }));
    const view = expanded[0]!;
    expect(view).toEqual({
      protocol: "rfb",
      viewOnly: true,
      url: `wss://client.example/api/computer/projection/rfb?botId=bot&surfaceId=${SURFACE_ID}&sessionId=${SESSION_ID}`,
    });
    expect(states.at(-1)).toBe("connecting");

    socket.message(JSON.stringify({
      ...identity("input-authority"),
      ...geometry(),
      active: true,
      controllerEpoch: 7,
    }));
    projection.expandedConnected(view);
    expect(states.at(-1)).toBe("expanded");
    expect(control).toEqual([true]);

    expect(projection.keyTransition("KeyA", "pressed", {
      control: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe(true);
    expect(projection.keyTransition("KeyA", "released", {
      control: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe(true);
    socket.message(JSON.stringify({
      ...identity("input-authority"),
      ...geometry(),
      active: true,
      controllerEpoch: 7,
    }));
    expect(projection.keyTransition("KeyB", "pressed", {
      control: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe(true);
    expect(projection.keyTransition("KeyB", "released", {
      control: false,
      alt: false,
      shift: false,
      meta: false,
    })).toBe(true);

    const keys = sentJson(socket).filter(({ type }) => type === "key");
    expect(keys.map(({ sessionId, sequence, code, state }) => [sessionId, sequence, code, state])).toEqual([
      [SESSION_ID, 1, "KeyA", "pressed"],
      [SESSION_ID, 2, "KeyA", "released"],
      [SESSION_ID, 3, "KeyB", "pressed"],
      [SESSION_ID, 4, "KeyB", "released"],
    ]);
    projection.close();
  });
});

describe("preview routing", () => {
  test("accepts exactly one matching PNG message and rejects stale identity and geometry", async () => {
    installBrowser();
    const frames: Array<Blob | undefined> = [];
    const projection = connection({ frames });
    await projection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message(JSON.stringify({ ...identity("view-state"), mode: "preview" }));

    socket.message(JSON.stringify({
      ...identity("preview-frame"),
      ...geometry(),
      sessionId: "stale-session",
      sequence: 1,
      mediaType: "image/png",
      byteLength: 1,
    }));
    socket.message(new Uint8Array([1]).buffer);
    socket.message(JSON.stringify({
      ...identity("preview-frame"),
      ...geometry(),
      geometryGeneration: 2,
      sequence: 2,
      mediaType: "image/png",
      byteLength: 1,
    }));
    socket.message(new Uint8Array([2]).buffer);
    expect(frames).toEqual([]);

    socket.message(JSON.stringify({
      ...identity("preview-frame"),
      ...geometry(),
      sequence: 3,
      mediaType: "image/png",
      capturedAt: new Date().toISOString(),
      byteLength: 2,
    }));
    socket.message(new Uint8Array([3, 4]).buffer);
    expect(frames).toHaveLength(1);
    expect(await frames[0]!.arrayBuffer()).toEqual(new Uint8Array([3, 4]).buffer);
    projection.close();
  });
});

test("ignores a late session descriptor after the viewer closes", async () => {
  const release = Promise.withResolvers<Response>();
  const fetchStarted = Promise.withResolvers<void>();
  Object.assign(globalThis, {
    RTCPeerConnection: undefined,
    WebSocket: FakeWebSocket,
    window: {
      setTimeout,
      clearTimeout,
      location: new URL("https://client.example/thread"),
    },
    fetch: async () => {
      fetchStarted.resolve();
      return release.promise;
    },
  });
  const states: ScreenProjectionState[] = [];
  const frames: Array<Blob | undefined> = [];
  const errors: string[] = [];
  const projection = connection({ states, frames, errors });

  const connecting = projection.connect();
  await fetchStarted.promise;
  projection.close();
  release.resolve(new Response(JSON.stringify(sessionDescriptor()), { status: 201 }));
  await connecting;

  expect(states).toEqual(["connecting", "closed"]);
  expect(frames).toEqual([undefined]);
  expect(errors).toEqual([]);
  expect(FakeWebSocket.instances).toEqual([]);
});
