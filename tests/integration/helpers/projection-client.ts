import type { SurfaceId } from "../../../packages/domain/src/ids.ts";

const PROJECTION_VERSION = 3 as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const RFB_CLIENT_BANNER = new TextEncoder().encode("RFB 003.008\n");

export interface ProjectionOwner {
  botId: string;
  surfaceId: SurfaceId;
}

export interface ProjectionSession {
  version: 3;
  sessionId: string;
  surfaceId: SurfaceId;
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

export interface ProjectionFrame {
  sequence: number;
  capturedAt: string;
  receivedAtMs: number;
  bytes: Uint8Array;
  digest: string;
}

export interface ProjectionAuthority {
  active: boolean;
  controllerEpoch: number;
  runtimeGeneration: number;
  geometryGeneration: number;
}

export interface ProjectionFailure {
  reason: string;
  snapshotFallback: boolean;
}

export interface RfbServerInit {
  width: number;
  height: number;
  name: string;
}

type ProjectionMode = "idle" | "preview" | "expanded";
type InputType = "pointer-motion" | "pointer-button" | "pointer-scroll" | "key" | "paste" | "release-control";

interface PreviewHeader {
  sequence: number;
  capturedAt: string;
  byteLength: number;
}

function projectionEndpoint(baseUrl: string, owner: ProjectionOwner): URL {
  const endpoint = new URL("/api/computer/projection", baseUrl);
  endpoint.searchParams.set("botId", owner.botId);
  endpoint.searchParams.set("surfaceId", owner.surfaceId);
  return endpoint;
}

function websocketUrl(value: string, baseUrl: string, token?: string): string {
  const url = new URL(value, baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`unsupported projection WebSocket protocol ${url.protocol}`);
  }
  if (token) url.searchParams.set("access_token", token);
  return url.href;
}

function waitUntil<T>(probe: () => T | undefined, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = performance.now();
    const poll = (): void => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
      } else if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error(message));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

function waitForOpen(socket: WebSocket, description: string): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${description} open timed out`));
    }, DEFAULT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${description} failed to open`));
    }, { once: true });
  });
}

async function messageBytes(value: unknown): Promise<Uint8Array | undefined> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return undefined;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000
    + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8)
    + bytes[offset + 3]!;
}

export class RfbViewProbe {
  readonly messages: Uint8Array[] = [];
  serverInit: RfbServerInit | undefined;
  #buffer = new Uint8Array();
  #offset = 0;
  #messageChain = Promise.resolve();

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.#messageChain = this.#messageChain.then(async () => {
        const bytes = await messageBytes(event.data);
        if (bytes === undefined) return;
        this.messages.push(bytes);
        const unread = this.#buffer.subarray(this.#offset);
        const combined = new Uint8Array(unread.byteLength + bytes.byteLength);
        combined.set(unread);
        combined.set(bytes, unread.byteLength);
        this.#buffer = combined;
        this.#offset = 0;
      });
    });
  }

  static async open(url: string): Promise<RfbViewProbe> {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const probe = new RfbViewProbe(socket);
    await waitForOpen(socket, "RFB WebSocket");
    return probe;
  }

  get negotiated(): boolean {
    return this.serverInit !== undefined;
  }

  async negotiate(timeoutMs = 15_000): Promise<RfbServerInit> {
    if (this.serverInit !== undefined) return this.serverInit;
    const banner = await this.#readExactly(12, timeoutMs);
    if (new TextDecoder().decode(banner) !== "RFB 003.008\n") {
      throw new Error(`unsupported RFB banner ${JSON.stringify(new TextDecoder().decode(banner))}`);
    }
    this.socket.send(RFB_CLIENT_BANNER);

    const securityCount = (await this.#readExactly(1, timeoutMs))[0]!;
    if (securityCount === 0) {
      const reasonLength = readUint32(await this.#readExactly(4, timeoutMs), 0);
      const reason = new TextDecoder().decode(await this.#readExactly(reasonLength, timeoutMs));
      throw new Error(`RFB server rejected security negotiation: ${reason}`);
    }
    const securityTypes = await this.#readExactly(securityCount, timeoutMs);
    if (!securityTypes.includes(1)) throw new Error("RFB server does not offer None security");
    this.socket.send(new Uint8Array([1]));

    const securityResult = readUint32(await this.#readExactly(4, timeoutMs), 0);
    if (securityResult !== 0) {
      const reasonLength = readUint32(await this.#readExactly(4, timeoutMs), 0);
      const reason = new TextDecoder().decode(await this.#readExactly(reasonLength, timeoutMs));
      throw new Error(`RFB security negotiation failed: ${reason}`);
    }
    this.socket.send(new Uint8Array([1]));

    const serverInit = await this.#readExactly(24, timeoutMs);
    const width = readUint16(serverInit, 0);
    const height = readUint16(serverInit, 2);
    const nameLength = readUint32(serverInit, 20);
    const name = new TextDecoder().decode(await this.#readExactly(nameLength, timeoutMs));
    this.serverInit = { width, height, name };
    return this.serverInit;
  }

  send(bytes: Uint8Array): void {
    if (this.serverInit === undefined) throw new Error("RFB probe must negotiate before sending protocol messages");
    this.socket.send(bytes);
  }

  sendPointer(buttonMask: number, x: number, y: number): void {
    this.send(new Uint8Array([
      5,
      buttonMask,
      (x >> 8) & 0xff,
      x & 0xff,
      (y >> 8) & 0xff,
      y & 0xff,
    ]));
  }

  requestFramebufferUpdate(width: number, height: number): void {
    this.send(new Uint8Array([
      3,
      0,
      0,
      0,
      0,
      0,
      (width >> 8) & 0xff,
      width & 0xff,
      (height >> 8) & 0xff,
      height & 0xff,
    ]));
  }

  async waitForServerMessageType(type: number, timeoutMs = 15_000): Promise<void> {
    const actual = (await this.#readExactly(1, timeoutMs))[0];
    if (actual !== type) throw new Error(`RFB server sent message type ${String(actual)}, expected ${type}`);
  }

  close(): void {
    this.socket.close();
  }

  async #readExactly(length: number, timeoutMs: number): Promise<Uint8Array> {
    await waitUntil(
      () => this.#buffer.byteLength - this.#offset >= length ? true : undefined,
      timeoutMs,
      `RFB stream did not provide ${length} bytes`,
    );
    await this.#messageChain;
    const bytes = this.#buffer.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return bytes;
  }
}

export class ProjectionClient {
  readonly frames: ProjectionFrame[] = [];
  readonly endpoint: URL;
  readonly controlSocket: WebSocket;
  rfb: RfbViewProbe | undefined;
  #mode: ProjectionMode | undefined;
  #authority: ProjectionAuthority | undefined;
  #failure: ProjectionFailure | undefined;
  #previewHeader: PreviewHeader | undefined;
  #nextSequence = 1;

  private constructor(
    readonly owner: ProjectionOwner,
    readonly session: ProjectionSession,
    endpoint: URL,
    controlSocket: WebSocket,
    readonly token?: string,
  ) {
    this.endpoint = endpoint;
    this.controlSocket = controlSocket;
    controlSocket.addEventListener("message", (event: MessageEvent<unknown>) => {
      void this.#onControlMessage(event.data);
    });
  }

  static async connect(
    baseUrl: string,
    owner: ProjectionOwner,
    label: string = owner.surfaceId,
    token?: string,
  ): Promise<ProjectionClient> {
    const endpoint = projectionEndpoint(baseUrl, owner);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ version: PROJECTION_VERSION }),
    });
    if (response.status !== 201) {
      throw new Error(`projection session creation failed for ${label}: ${response.status} ${await response.text()}`);
    }
    const session = await response.json() as ProjectionSession;
    if (
      session.version !== PROJECTION_VERSION
      || session.sessionId === ""
      || session.surfaceId !== owner.surfaceId
      || typeof session.controlUrl !== "string"
      || typeof session.rfbUrl !== "string"
    ) throw new Error(`projection session creation returned an invalid v3 descriptor for ${label}`);

    const controlSocket = new WebSocket(websocketUrl(session.controlUrl, endpoint.href, token));
    controlSocket.binaryType = "arraybuffer";
    const client = new ProjectionClient(owner, session, endpoint, controlSocket, token);
    await waitForOpen(controlSocket, `projection control WebSocket for ${label}`);
    await waitUntil(
      () => client.#mode,
      DEFAULT_TIMEOUT_MS,
      `projection control WebSocket for ${label} did not publish initial view state`,
    );
    return client;
  }

  get modeState(): ProjectionMode | undefined {
    return this.#mode;
  }

  async setMode(mode: ProjectionMode, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProjectionAuthority | undefined> {
    this.#sendControl({ type: "view", mode });
    await waitUntil(
      () => this.#mode === mode ? mode : undefined,
      timeoutMs,
      `projection did not acknowledge ${mode} mode`,
    );
    if (mode !== "expanded") {
      this.rfb?.close();
      this.rfb = undefined;
      return undefined;
    }
    const rfb = await this.openRfb();
    await rfb.negotiate(timeoutMs);
    return this.waitForAuthority(true, timeoutMs);
  }

  async openRfb(): Promise<RfbViewProbe> {
    if (this.#mode !== "expanded") throw new Error("projection must acknowledge expanded mode before RFB opens");
    if (this.rfb !== undefined && this.rfb.socket.readyState === WebSocket.OPEN) return this.rfb;
    this.rfb = await RfbViewProbe.open(websocketUrl(this.session.rfbUrl, this.endpoint.href, this.token));
    return this.rfb;
  }

  async waitForPreviewFrame(afterSequence = 0, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProjectionFrame> {
    return waitUntil(
      () => this.frames.find((frame) => frame.sequence > afterSequence),
      timeoutMs,
      `Screen ${this.owner.surfaceId} did not deliver another preview frame`,
    );
  }

  waitForAuthority(active: boolean, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProjectionAuthority> {
    return waitUntil(
      () => this.#authority?.active === active ? this.#authority : undefined,
      timeoutMs,
      `projection input authority did not become ${active ? "active" : "inactive"}`,
    );
  }

  waitForFailure(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProjectionFailure> {
    return waitUntil(() => this.#failure, timeoutMs, "projection failure was not delivered");
  }

  sendMotion(x: number, y: number): number {
    return this.sendInput("pointer-motion", { x, y });
  }

  sendScroll(x: number, y: number, deltaY: number): number {
    return this.sendInput("pointer-scroll", { x, y, deltaX: 0, deltaY });
  }

  sendInput(type: InputType, payload: Record<string, unknown>): number {
    if (this.#authority?.active !== true) throw new Error("Web Control authority is not active");
    const sequence = this.#nextSequence++;
    this.#sendControl({
      type,
      geometryGeneration: this.session.geometryGeneration,
      controllerEpoch: this.#authority.controllerEpoch,
      sequence,
      ...payload,
    });
    return sequence;
  }

  async close(): Promise<void> {
    this.rfb?.close();
    this.rfb = undefined;
    let response: Response | undefined;
    try {
      response = await fetch(this.endpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ sessionId: this.session.sessionId }),
      });
    } finally {
      if (this.controlSocket.readyState === WebSocket.OPEN || this.controlSocket.readyState === WebSocket.CONNECTING) {
        this.controlSocket.close();
      }
    }
    if (response !== undefined && !response.ok && response.status !== 404) {
      throw new Error(`projection teardown failed: ${response.status} ${await response.text()}`);
    }
  }

  #sendControl(message: Record<string, unknown>): void {
    if (this.controlSocket.readyState !== WebSocket.OPEN) throw new Error("projection control WebSocket is not open");
    this.controlSocket.send(JSON.stringify({
      version: PROJECTION_VERSION,
      sessionId: this.session.sessionId,
      surfaceId: this.owner.surfaceId,
      runtimeGeneration: this.session.runtimeGeneration,
      ...message,
    }));
  }

  async #onControlMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      const bytes = await messageBytes(raw);
      const header = this.#previewHeader;
      this.#previewHeader = undefined;
      if (bytes === undefined || header === undefined || bytes.byteLength !== header.byteLength) return;
      this.frames.push({
        sequence: header.sequence,
        capturedAt: header.capturedAt,
        receivedAtMs: performance.now(),
        bytes,
        digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      });
      return;
    }

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      message.version !== PROJECTION_VERSION
      || message.sessionId !== this.session.sessionId
      || message.surfaceId !== this.owner.surfaceId
      || message.runtimeGeneration !== this.session.runtimeGeneration
    ) return;

    if (message.type === "view-state" && (message.mode === "idle" || message.mode === "preview" || message.mode === "expanded")) {
      this.#mode = message.mode;
      return;
    }
    if (
      message.type === "input-authority"
      && typeof message.active === "boolean"
      && typeof message.controllerEpoch === "number"
      && typeof message.geometryGeneration === "number"
    ) {
      this.#authority = {
        active: message.active,
        controllerEpoch: message.controllerEpoch,
        runtimeGeneration: this.session.runtimeGeneration,
        geometryGeneration: message.geometryGeneration,
      };
      return;
    }
    if (message.type === "projection-failure") {
      this.#failure = {
        reason: typeof message.reason === "string" ? message.reason : "",
        snapshotFallback: message.snapshotFallback === true,
      };
      return;
    }
    if (
      message.type === "preview-frame"
      && typeof message.sequence === "number"
      && typeof message.capturedAt === "string"
      && typeof message.byteLength === "number"
      && Number.isSafeInteger(message.byteLength)
      && message.byteLength > 0
    ) {
      this.#previewHeader = {
        sequence: message.sequence,
        capturedAt: message.capturedAt,
        byteLength: message.byteLength,
      };
    }
  }
}
