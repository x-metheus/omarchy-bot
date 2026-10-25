import {
  SCREEN_PROJECTION_PROTOCOL_VERSION,
  ScreenInputAuthorityMessageDto,
  ScreenKeyCodeDto,
  ScreenProjectionFailureMessageDto,
  ScreenProjectionPreviewFrameHeaderDto,
  ScreenProjectionSessionDto,
  ScreenProjectionViewStateMessageDto,
  type ScreenInputAuthorityMessageDto as InputAuthority,
  type ScreenProjectionBrowserMetricsDto,
  type ScreenProjectionFailureReasonDto,
  type ScreenProjectionModeDto,
  type ScreenProjectionPreviewFrameHeaderDto as PreviewFrameHeader,
} from "@omarchy-bot/protocol";
import { withDeviceToken } from "./deviceToken.ts";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 10_000;
const FIRST_FRAME_TIMEOUT_MS = 5_000;

const FAILURE_MESSAGES: Record<ScreenProjectionFailureReasonDto, string> = {
  "missing-first-frame": "No current frame arrived from the Bot Screen.",
  "capture-failed": "The Bot Screen capture helper stopped producing frames.",
  "transport-failed": "The screen connection was lost.",
  "rfb-start-failed": "The Bot Screen view could not start.",
  "rfb-bridge-failed": "The Bot Screen view connection failed.",
  "view-client-failed": "The browser could not display the Bot Screen view.",
};

export type ScreenProjectionMode = Exclude<ScreenProjectionModeDto, "idle">;
export type ScreenProjectionState =
  "connecting" | "preview" | "expanded" | "reconnecting" | "snapshot" | "unavailable" | "closed";

export interface ScreenProjectionOwner {
  botId: string;
  surfaceId: string;
}

export interface ScreenProjectionFailure {
  surfaceId: string;
  reason: ScreenProjectionFailureReasonDto;
  message: string;
  snapshotAvailable: boolean;
}

export interface ScreenExpandedView {
  protocol: "rfb";
  viewOnly: true;
  url: string;
}

export interface ScreenProjectionCallbacks {
  onState(state: ScreenProjectionState): void;
  onFrame(frame: Blob | undefined): void;
  onError(error: string): void;
  onFailure?(failure: ScreenProjectionFailure): void;
  onReconnectRequested?(): void;
  onControlStateChange?(active: boolean): void;
  onControlRevoked?(): void;
  onExpandedView?(view: ScreenExpandedView | undefined): void;
}

interface PendingFrame {
  header: PreviewFrameHeader;
}

interface PointerContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type PointerButton = "left" | "middle" | "right";

interface ProjectionGeometry {
  geometryGeneration: number;
  logicalWidth: number;
  logicalHeight: number;
  videoWidth: number;
  videoHeight: number;
  scale: number;
}

/** Browser-side projection session over one control WebSocket plus view-only noVNC. */
export class ScreenProjectionConnection {
  readonly #abort = new AbortController();
  readonly #heldPointerButtons = new Set<PointerButton>();
  #control: WebSocket | undefined;
  #sessionId: string | undefined;
  #runtimeGeneration: number | undefined;
  #desiredMode: ScreenProjectionMode = "preview";
  #acknowledgedMode: ScreenProjectionModeDto = "idle";
  #pending: PendingFrame | undefined;
  #closed = false;
  #connectionTimer: number | undefined;
  #firstFrameTimer: number | undefined;
  #receivedPreview = false;
  #inputAuthority: InputAuthority | undefined;
  #offeredInputAuthority: InputAuthority | undefined;
  #rfbReady = false;
  #expandedView: ScreenExpandedView | undefined;
  #rfbUrl: string | undefined;
  #snapshotUrl: string | undefined;
  #inputSequence = 0;
  #releasingEpoch: number | undefined;
  #resumeAfterRelease = false;
  #geometry: ProjectionGeometry | undefined;
  #lastPreviewCapturedAt: string | undefined;
  #browserMetrics: ScreenProjectionBrowserMetricsDto = {
    browserReceives: 0,
    browserDecodes: 0,
    browserPaints: 0,
    decodeDrops: 0,
    paintDrops: 0,
    captureToPaintLatencySamples: 0,
    captureToPaintLatencyTotalMs: 0,
    captureToPaintLatencyMaxMs: 0,
  };
  #lastMetricsSentAt = 0;
  #reconnectRequested = false;

  constructor(
    private readonly endpoint: string,
    private readonly owner: ScreenProjectionOwner,
    private readonly callbacks: ScreenProjectionCallbacks,
  ) {}

  get expandedView(): ScreenExpandedView | undefined {
    return this.#expandedView;
  }

  async connect(): Promise<void> {
    this.callbacks.onState("connecting");
    this.#armConnectionDeadline("Couldn’t connect to the Bot Screen.");
    try {
      const endpoint = this.#projectionEndpoint();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: SCREEN_PROJECTION_PROTOCOL_VERSION }),
        signal: this.#abort.signal,
      });
      const rawSession: unknown = await response.json().catch(() => undefined);
      if (this.#closed) return;
      if (!response.ok) {
        const message =
          rawSession !== null
          && typeof rawSession === "object"
          && "error" in rawSession
          && typeof rawSession.error === "string"
            ? rawSession.error
            : "Couldn’t start the Bot Screen.";
        throw new Error(message);
      }
      const session = ScreenProjectionSessionDto.safeParse(rawSession);
      if (!session.success) throw new Error("The Bot Screen returned an invalid connection response.");
      if (session.data.surfaceId !== this.owner.surfaceId) {
        throw new Error("The Bot Screen connection did not match this screen.");
      }

      this.#sessionId = session.data.sessionId;
      this.#runtimeGeneration = session.data.runtimeGeneration;
      this.#geometry = {
        geometryGeneration: session.data.geometryGeneration,
        logicalWidth: session.data.logicalWidth,
        logicalHeight: session.data.logicalHeight,
        videoWidth: session.data.videoWidth,
        videoHeight: session.data.videoHeight,
        scale: session.data.scale,
      };
      this.#rfbUrl = this.#resolveSessionSocketUrl(session.data.rfbUrl, "RFB");
      this.#snapshotUrl = this.#resolveSnapshotUrl(session.data.snapshotUrl);
      this.#openControlSocket(this.#resolveSessionSocketUrl(session.data.controlUrl, "control"));
    } catch (error) {
      if (this.#closed || (error instanceof DOMException && error.name === "AbortError")) return;
      this.#fail(
        "transport-failed",
        error instanceof Error ? error.message : "Couldn’t connect to the Bot Screen.",
      );
    }
  }

  setMode(mode: ScreenProjectionMode): void {
    if (this.#desiredMode !== mode) {
      if (this.#inputAuthority !== undefined) this.callbacks.onControlStateChange?.(false);
      this.#inputAuthority = undefined;
      this.#offeredInputAuthority = undefined;
      this.#releasingEpoch = undefined;
      this.#resumeAfterRelease = false;
      this.#rfbReady = false;
      this.#clearExpandedView();
      this.#clearHeldInput();
      clearTimeout(this.#firstFrameTimer);
      this.#firstFrameTimer = undefined;
    }
    this.#desiredMode = mode;
    this.#activate();
  }

  previewPainted(): void {
    if (this.#closed || this.#desiredMode !== "preview" || this.#lastPreviewCapturedAt === undefined) return;
    this.#browserMetrics.browserDecodes += 1;
    this.#browserMetrics.browserPaints += 1;
    const capturedAt = Date.parse(this.#lastPreviewCapturedAt);
    if (Number.isFinite(capturedAt)) {
      const latency = Math.max(0, Date.now() - capturedAt);
      this.#browserMetrics.captureToPaintLatencySamples += 1;
      this.#browserMetrics.captureToPaintLatencyTotalMs += latency;
      this.#browserMetrics.captureToPaintLatencyMaxMs = Math.max(
        this.#browserMetrics.captureToPaintLatencyMaxMs,
        latency,
      );
    }
    this.#lastPreviewCapturedAt = undefined;
    this.#sendBrowserMetrics();
  }

  expandedConnected(view: ScreenExpandedView): void {
    if (
      this.#closed
      || this.#desiredMode !== "expanded"
      || this.#acknowledgedMode !== "expanded"
      || this.#expandedView?.url !== view.url
    ) return;
    this.#rfbReady = true;
    clearTimeout(this.#firstFrameTimer);
    this.#firstFrameTimer = undefined;
    this.callbacks.onState("expanded");
    this.#publishInputAuthority();
  }

  expandedFailed(view: ScreenExpandedView, message = "The Bot Screen view connection failed."): void {
    if (this.#closed || this.#desiredMode !== "expanded" || this.#expandedView?.url !== view.url) return;
    this.#fail("view-client-failed", message);
  }

  expandedDisconnected(view: ScreenExpandedView): void {
    if (this.#closed || this.#desiredMode !== "expanded" || this.#expandedView?.url !== view.url) return;
    this.#requestReconnect();
  }

  pointerMotion(clientX: number, clientY: number, renderedVideo: Element, clampToContent = false): void {
    const position = this.#mapPointer(clientX, clientY, renderedVideo.getBoundingClientRect(), clampToContent);
    if (position !== undefined) this.#sendPointer("pointer-motion", position);
  }

  pointerButton(
    clientX: number,
    clientY: number,
    renderedVideo: Element,
    button: number,
    state: "pressed" | "released",
  ): boolean {
    const namedButton: PointerButton | undefined =
      button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : undefined;
    if (namedButton === undefined) return false;
    if (
      (state === "pressed" && this.#heldPointerButtons.has(namedButton))
      || (state === "released" && !this.#heldPointerButtons.has(namedButton))
    ) return false;
    const position = this.#mapPointer(
      clientX,
      clientY,
      renderedVideo.getBoundingClientRect(),
      state === "released",
    );
    if (
      position === undefined
      || !this.#sendPointer("pointer-button", { ...position, button: namedButton, state })
    ) return false;
    if (state === "pressed") this.#heldPointerButtons.add(namedButton);
    else this.#heldPointerButtons.delete(namedButton);
    return true;
  }

  pointerScroll(clientX: number, clientY: number, renderedVideo: Element, deltaX: number, deltaY: number): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) return;
    const position = this.#mapPointer(clientX, clientY, renderedVideo.getBoundingClientRect());
    if (position !== undefined) this.#sendPointer("pointer-scroll", { ...position, deltaX, deltaY });
  }

  keyTransition(
    code: string,
    state: "pressed" | "released",
    modifiers: { control: boolean; alt: boolean; shift: boolean; meta: boolean },
  ): boolean {
    const supported = ScreenKeyCodeDto.safeParse(code);
    if (!supported.success) return false;
    return this.#sendInput({ type: "key", code: supported.data, state, modifiers });
  }

  paste(text: string): boolean {
    if (
      text.length === 0
      || text.includes("\0")
      || new TextEncoder().encode(text).byteLength > 65_536
    ) return false;
    return this.#sendInput({ type: "paste", text });
  }

  releaseControl(reason: "blur" | "visibility-loss" | "navigation" | "teardown"): void {
    const authority = this.#inputAuthority;
    if (authority === undefined) return;
    if (this.#sendInput({ type: "release-control", reason })) {
      this.#releasingEpoch = authority.controllerEpoch;
      this.#inputAuthority = undefined;
      this.callbacks.onControlStateChange?.(false);
      this.#clearHeldInput();
    }
  }

  suspend(reason: "visibility-loss" | "navigation" | "teardown"): void {
    if (this.#closed) return;
    this.releaseControl(reason);
    clearTimeout(this.#firstFrameTimer);
    this.#firstFrameTimer = undefined;
    this.#rfbReady = false;
    this.#clearExpandedView();
    this.#sendViewMode("idle");
  }

  resumeControl(): void {
    if (this.#desiredMode !== "expanded") return;
    if (this.#releasingEpoch !== undefined) {
      this.#resumeAfterRelease = true;
      return;
    }
    this.#activate();
  }

  close(): void {
    if (this.#closed) return;
    clearTimeout(this.#connectionTimer);
    clearTimeout(this.#firstFrameTimer);
    this.#connectionTimer = undefined;
    this.#firstFrameTimer = undefined;
    this.releaseControl("teardown");
    this.#sendViewMode("idle");
    this.#closed = true;
    this.#abort.abort();
    this.#pending = undefined;
    if (this.#inputAuthority !== undefined) this.callbacks.onControlStateChange?.(false);
    this.#inputAuthority = undefined;
    this.#offeredInputAuthority = undefined;
    this.#clearHeldInput();
    this.#geometry = undefined;
    this.#rfbReady = false;
    this.#clearExpandedView();
    this.#releasingEpoch = undefined;
    this.#resumeAfterRelease = false;
    const socket = this.#control;
    this.#control = undefined;
    socket?.close();
    this.callbacks.onFrame(undefined);
    this.callbacks.onState("closed");
    if (this.#sessionId !== undefined) {
      void fetch(this.#projectionEndpoint(), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: this.#sessionId }),
        keepalive: true,
      }).catch(() => {});
    }
  }

  #openControlSocket(url: string): void {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.#control = socket;
    socket.addEventListener("open", () => {
      if (this.#closed || this.#control !== socket) return;
      this.#reconnectRequested = false;
      this.#activate();
    });
    socket.addEventListener("message", (event) => {
      if (!this.#closed && this.#control === socket) this.#receiveControl(event.data);
    });
    socket.addEventListener("error", () => {
      if (!this.#closed && this.#control === socket) {
        this.#fail("transport-failed", "Couldn’t connect to the Bot Screen.");
      }
    });
    socket.addEventListener("close", () => {
      if (!this.#closed && this.#control === socket) this.#requestReconnect();
    });
  }

  #activate(): void {
    if (
      this.#closed
      || this.#control?.readyState !== WebSocket.OPEN
      || this.#sessionId === undefined
      || this.#releasingEpoch !== undefined
      || this.#runtimeGeneration === undefined
    ) return;
    this.#sendViewMode(this.#desiredMode);
    if (this.#acknowledgedMode !== this.#desiredMode) {
      this.callbacks.onState("connecting");
    }
  }

  #sendViewMode(mode: ScreenProjectionModeDto): void {
    if (
      this.#control?.readyState !== WebSocket.OPEN
      || this.#sessionId === undefined
      || this.#runtimeGeneration === undefined
    ) return;
    this.#control.send(JSON.stringify({
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      type: "view",
      sessionId: this.#sessionId,
      surfaceId: this.owner.surfaceId,
      runtimeGeneration: this.#runtimeGeneration,
      mode,
    }));
  }

  #receiveControl(raw: unknown): void {
    if (this.#closed) return;
    if (typeof raw === "string") {
      this.#receiveControlJson(raw);
      return;
    }
    if (raw instanceof Blob) {
      const socket = this.#control;
      void raw.arrayBuffer().then((buffer) => {
        if (!this.#closed && this.#control === socket) this.#receivePreviewBytes(buffer);
      });
      return;
    }
    if (raw instanceof ArrayBuffer) {
      this.#receivePreviewBytes(raw);
      return;
    }
    if (ArrayBuffer.isView(raw)) {
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice();
      this.#receivePreviewBytes(bytes.buffer);
    }
  }

  #receiveControlJson(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#pending = undefined;
      return;
    }

    const viewState = ScreenProjectionViewStateMessageDto.safeParse(parsed);
    if (viewState.success) {
      if (this.#matchesSession(viewState.data)) this.#receiveViewState(viewState.data.mode);
      return;
    }

    const authority = ScreenInputAuthorityMessageDto.safeParse(parsed);
    if (authority.success) {
      if (this.#matchesSession(authority.data)) this.#receiveInputAuthority(authority.data);
      return;
    }

    const failure = ScreenProjectionFailureMessageDto.safeParse(parsed);
    if (failure.success) {
      if (this.#matchesSession(failure.data)) {
        this.#fail(failure.data.reason, FAILURE_MESSAGES[failure.data.reason]);
      }
      return;
    }

    const header = ScreenProjectionPreviewFrameHeaderDto.safeParse(parsed);
    if (
      header.success
      && this.#desiredMode === "preview"
      && this.#matchesSession(header.data)
      && this.#matchesGeometry(header.data)
      && header.data.byteLength <= MAX_FRAME_BYTES
    ) {
      this.#pending = { header: header.data };
      return;
    }
    this.#pending = undefined;
  }

  #receiveViewState(mode: ScreenProjectionModeDto): void {
    this.#acknowledgedMode = mode;
    clearTimeout(this.#connectionTimer);
    this.#connectionTimer = undefined;
    if (mode !== this.#desiredMode) return;

    if (mode === "preview") {
      this.#clearExpandedView();
      this.callbacks.onState("preview");
      if (!this.#receivedPreview) this.#armFirstFrameDeadline("No image arrived from the Bot Screen.");
      return;
    }
    if (mode === "expanded") {
      if (this.#rfbUrl === undefined) {
        this.#fail("view-client-failed", "The Bot Screen returned an invalid RFB connection.");
        return;
      }
      if (this.#expandedView?.url !== this.#rfbUrl) {
        this.#expandedView = { protocol: "rfb", viewOnly: true, url: this.#rfbUrl };
        this.callbacks.onExpandedView?.(this.#expandedView);
      }
      if (this.#rfbReady) {
        this.callbacks.onState("expanded");
        this.#publishInputAuthority();
      } else {
        this.callbacks.onState("connecting");
        this.#armFirstFrameDeadline("No RFB view arrived from the Bot Screen.");
      }
    }
  }

  #requestReconnect(): void {
    if (this.#closed || this.#reconnectRequested) return;
    this.#reconnectRequested = true;
    this.releaseControl("teardown");
    clearTimeout(this.#firstFrameTimer);
    this.#firstFrameTimer = undefined;
    this.#pending = undefined;
    this.#receivedPreview = false;
    this.#rfbReady = false;
    this.#offeredInputAuthority = undefined;
    this.#clearExpandedView();
    this.callbacks.onFrame(undefined);
    this.callbacks.onState("reconnecting");
    if (this.callbacks.onReconnectRequested !== undefined) {
      queueMicrotask(() => {
        if (!this.#closed) this.callbacks.onReconnectRequested?.();
      });
    } else {
      this.#armConnectionDeadline("The screen connection was lost.");
    }
  }

  #receiveInputAuthority(authority: InputAuthority): void {
    if (!this.#matchesGeometry(authority)) return;
    if (!authority.active) {
      if (
        this.#inputAuthority?.controllerEpoch === authority.controllerEpoch
        || this.#offeredInputAuthority?.controllerEpoch === authority.controllerEpoch
        || this.#releasingEpoch === authority.controllerEpoch
      ) {
        if (this.#inputAuthority !== undefined) this.callbacks.onControlStateChange?.(false);
        this.#inputAuthority = undefined;
        this.#offeredInputAuthority = undefined;
        this.#releasingEpoch = undefined;
        this.#clearHeldInput();
        if (this.#resumeAfterRelease) {
          this.#resumeAfterRelease = false;
          queueMicrotask(() => this.#activate());
        }
      }
      return;
    }
    this.#offeredInputAuthority = authority;
    this.#publishInputAuthority();
  }

  #publishInputAuthority(): void {
    const authority = this.#offeredInputAuthority;
    if (
      authority === undefined
      || this.#desiredMode !== "expanded"
      || this.#acknowledgedMode !== "expanded"
      || !this.#rfbReady
    ) return;
    if (this.#inputAuthority?.controllerEpoch === authority.controllerEpoch) return;
    if (this.#inputAuthority !== undefined) this.#clearHeldInput();
    this.callbacks.onControlStateChange?.(true);
    this.#inputAuthority = authority;
    this.#inputSequence = 0;
    this.#releasingEpoch = undefined;
    this.#resumeAfterRelease = false;
  }

  #mapPointer(
    clientX: number,
    clientY: number,
    renderedRect: PointerContentRect,
    clampToContent = false,
  ): { x: number; y: number } | undefined {
    const authority = this.#inputAuthority;
    if (
      authority === undefined
      || !Number.isFinite(clientX)
      || !Number.isFinite(clientY)
      || renderedRect.width <= 0
      || renderedRect.height <= 0
    ) return undefined;
    const contentScale = Math.min(
      renderedRect.width / authority.videoWidth,
      renderedRect.height / authority.videoHeight,
    );
    const contentWidth = authority.videoWidth * contentScale;
    const contentHeight = authority.videoHeight * contentScale;
    const contentLeft = renderedRect.left + (renderedRect.width - contentWidth) / 2;
    const contentTop = renderedRect.top + (renderedRect.height - contentHeight) / 2;
    if (
      !clampToContent
      && (
        clientX < contentLeft
        || clientY < contentTop
        || clientX > contentLeft + contentWidth
        || clientY > contentTop + contentHeight
      )
    ) return undefined;
    const mappedClientX = Math.min(contentLeft + contentWidth, Math.max(contentLeft, clientX));
    const mappedClientY = Math.min(contentTop + contentHeight, Math.max(contentTop, clientY));
    return {
      x: Math.min(
        authority.logicalWidth - 1,
        ((mappedClientX - contentLeft) / contentWidth) * authority.logicalWidth,
      ),
      y: Math.min(
        authority.logicalHeight - 1,
        ((mappedClientY - contentTop) / contentHeight) * authority.logicalHeight,
      ),
    };
  }

  #sendPointer(
    type: "pointer-motion" | "pointer-button" | "pointer-scroll",
    event: Record<string, number | string>,
  ): boolean {
    return this.#sendInput({ type, ...event });
  }

  #sendInput(event: Record<string, unknown>): boolean {
    const authority = this.#inputAuthority;
    if (
      authority === undefined
      || this.#desiredMode !== "expanded"
      || this.#control?.readyState !== WebSocket.OPEN
      || this.#sessionId === undefined
    ) return false;
    this.#control.send(JSON.stringify({
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      surfaceId: this.owner.surfaceId,
      runtimeGeneration: authority.runtimeGeneration,
      geometryGeneration: authority.geometryGeneration,
      controllerEpoch: authority.controllerEpoch,
      sequence: ++this.#inputSequence,
      ...event,
    }));
    return true;
  }

  #clearHeldInput(): void {
    this.#heldPointerButtons.clear();
    this.callbacks.onControlRevoked?.();
  }

  #clearExpandedView(): void {
    if (this.#expandedView === undefined) return;
    this.#expandedView = undefined;
    this.callbacks.onExpandedView?.(undefined);
  }

  #receivePreviewBytes(raw: ArrayBuffer): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (this.#desiredMode !== "preview" || pending === undefined) return;
    if (raw.byteLength !== pending.header.byteLength) return;
    this.#receivedPreview = true;
    this.#browserMetrics.browserReceives += 1;
    this.#lastPreviewCapturedAt = pending.header.capturedAt;
    clearTimeout(this.#firstFrameTimer);
    this.#firstFrameTimer = undefined;
    this.callbacks.onFrame(new Blob([raw], { type: pending.header.mediaType }));
  }

  #armConnectionDeadline(message: string): void {
    if (this.#connectionTimer !== undefined) return;
    this.#connectionTimer = window.setTimeout(
      () => this.#fail("transport-failed", message),
      CONNECTION_TIMEOUT_MS,
    );
  }

  #armFirstFrameDeadline(message: string): void {
    if (this.#firstFrameTimer !== undefined) return;
    this.#firstFrameTimer = window.setTimeout(
      () => this.#fail("missing-first-frame", message),
      FIRST_FRAME_TIMEOUT_MS,
    );
  }

  #sendBrowserMetrics(): void {
    const now = performance.now();
    if (
      (this.#lastMetricsSentAt !== 0 && now - this.#lastMetricsSentAt < 1_000)
      || this.#control?.readyState !== WebSocket.OPEN
      || this.#control.bufferedAmount > 0
      || this.#runtimeGeneration === undefined
      || this.#sessionId === undefined
    ) return;
    try {
      this.#control.send(JSON.stringify({
        version: SCREEN_PROJECTION_PROTOCOL_VERSION,
        type: "browser-metrics",
        sessionId: this.#sessionId,
        surfaceId: this.owner.surfaceId,
        runtimeGeneration: this.#runtimeGeneration,
        metrics: this.#browserMetrics,
      }));
      this.#lastMetricsSentAt = now;
    } catch {
      // A closing metrics socket must not delay control or change Surface state.
    }
  }

  #fail(reason: ScreenProjectionFailureReasonDto, message: string): void {
    if (this.#closed) return;
    this.callbacks.onError(message);
    this.close();
    void this.#loadSnapshotFallback(reason, message);
  }

  async #loadSnapshotFallback(
    reason: ScreenProjectionFailureReasonDto,
    message: string,
  ): Promise<void> {
    let snapshotAvailable = false;
    try {
      const response = await fetch(this.#snapshotUrl ?? this.#defaultSnapshotUrl());
      if (!response.ok || response.headers.get("content-type") !== "image/png") throw new Error();
      this.callbacks.onFrame(await response.blob());
      snapshotAvailable = true;
    } catch {
      this.callbacks.onFrame(undefined);
    }
    this.callbacks.onFailure?.({
      surfaceId: this.owner.surfaceId,
      reason,
      message,
      snapshotAvailable,
    });
    this.callbacks.onState(snapshotAvailable ? "snapshot" : "unavailable");
  }

  #projectionEndpoint(): string {
    const endpoint = new URL(this.endpoint, window.location.href);
    endpoint.searchParams.set("botId", this.owner.botId);
    endpoint.searchParams.set("surfaceId", this.owner.surfaceId);
    return withDeviceToken(endpoint.href);
  }

  #resolveSessionSocketUrl(raw: string, label: string): string {
    if (this.#sessionId === undefined) throw new Error(`The Bot Screen returned an invalid ${label} connection.`);
    const endpoint = new URL(this.endpoint, window.location.href);
    const resolved = new URL(raw, endpoint);
    if (
      (resolved.protocol !== "http:" && resolved.protocol !== "https:")
      || resolved.origin !== endpoint.origin
      || resolved.searchParams.get("botId") !== this.owner.botId
      || resolved.searchParams.get("surfaceId") !== this.owner.surfaceId
      || resolved.searchParams.get("sessionId") !== this.#sessionId
    ) throw new Error(`The Bot Screen returned an invalid ${label} connection.`);
    resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
    return withDeviceToken(resolved.href);
  }

  #resolveSnapshotUrl(raw: string): string {
    const endpoint = new URL(this.endpoint, window.location.href);
    const resolved = new URL(raw, endpoint);
    if (
      (resolved.protocol !== "http:" && resolved.protocol !== "https:")
      || resolved.origin !== endpoint.origin
      || resolved.searchParams.get("botId") !== this.owner.botId
      || resolved.searchParams.get("surfaceId") !== this.owner.surfaceId
    ) throw new Error("The Bot Screen returned an invalid snapshot connection.");
    return withDeviceToken(resolved.href);
  }

  #defaultSnapshotUrl(): string {
    const snapshot = new URL(this.#projectionEndpoint());
    snapshot.pathname = snapshot.pathname.replace(/\/projection$/, "/snapshot");
    return withDeviceToken(snapshot.href);
  }

  #matchesSession(value: { sessionId: string; surfaceId: string; runtimeGeneration: number }): boolean {
    return value.sessionId === this.#sessionId
      && value.surfaceId === this.owner.surfaceId
      && value.runtimeGeneration === this.#runtimeGeneration;
  }

  #matchesGeometry(value: ProjectionGeometry): boolean {
    const geometry = this.#geometry;
    return geometry !== undefined
      && value.geometryGeneration === geometry.geometryGeneration
      && value.logicalWidth === geometry.logicalWidth
      && value.logicalHeight === geometry.logicalHeight
      && value.videoWidth === geometry.videoWidth
      && value.videoHeight === geometry.videoHeight
      && value.scale === geometry.scale;
  }
}
