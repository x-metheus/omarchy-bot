import { randomUUID } from "node:crypto";
import type { SurfaceId } from "@omarchy-bot/domain";
import {
  SCREEN_PROJECTION_PROTOCOL_VERSION,
  ScreenInputMessageDto,
  type ScreenInputAuthorityMessageDto,
  ScreenProjectionClientControlMessageDto,
  type ScreenProjectionFailureMessageDto,
  type ScreenProjectionFailureReasonDto,
  type ScreenProjectionBrowserMetricsDto,
  type ScreenProjectionModeDto,
  type ScreenProjectionSessionDto,
  type ScreenProjectionViewStateMessageDto,
} from "@omarchy-bot/protocol";
import type { ComputerSurfaceOwner } from "./broker.ts";
import type {
  BotScreenManager,
  BotScreenInputEvent,
  BotScreenExpandedView,
  BotScreenProjectionSource,
} from "./botScreenManager.ts";
import { InputDiagnostics, type InputDiagnosticCategory } from "./inputDiagnostics.ts";
import type { ScreenInputLease, WebControlGrant } from "./screenInputLease.ts";

const PREVIEW_INTERVAL_MS = 1_000;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = MAX_BUFFERED_BYTES;
const MAX_INPUT_QUEUE = 256;
const SOCKET_ATTACH_TIMEOUT_MS = 10_000;
const RFB_BACKPRESSURE_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 2_000;
const FAILURE_DELIVERY_GRACE_MS = 100;

export type ProjectionViewMode = ScreenProjectionModeDto;
export type ProjectionLifecycleState = "connecting" | ProjectionViewMode | "closed" | "failed";

export interface ProjectionStatus {
  sessionId: string;
  surfaceId: SurfaceId;
  runtimeGeneration: number;
  state: ProjectionLifecycleState;
  mode: ProjectionViewMode;
  framesSent: number;
  failure?: ScreenProjectionFailureReasonDto;
  snapshotFallback?: true;
}

export interface ProjectionLoadMetrics {
  readonly sessionId: string;
  readonly surfaceId: SurfaceId;
  readonly sequence: number;
  readonly captureAttempts: number;
  readonly sourceFrames: number;
  readonly previewFrames: number;
  readonly previewBytes: number;
  readonly rfbBytesSent: number;
  readonly rfbBytesReceived: number;
  readonly browserReceives: number;
  readonly browserDecodes: number;
  readonly browserPaints: number;
  readonly captureSkips: number;
  readonly invalidFrames: number;
  readonly transportSkips: number;
  readonly sendFailures: number;
  readonly decodeDrops: number;
  readonly paintDrops: number;
  readonly unexplainedShortfalls: number;
  readonly captureLatencySamples: number;
  readonly captureLatencyTotalMs: number;
  readonly captureLatencyMaxMs: number;
  readonly captureToPaintLatencySamples: number;
  readonly captureToPaintLatencyTotalMs: number;
  readonly captureToPaintLatencyMaxMs: number;
}

export interface ProjectionFailureDiagnostic {
  readonly reason: ScreenProjectionFailureReasonDto;
  readonly technicalError?: string;
  readonly metrics: Readonly<ProjectionLoadMetrics>;
}

export interface SurfaceProjectionMedia {
  readonly surfaceId: SurfaceId;
  readonly viewers: number;
  readonly previewViewers: number;
  readonly expandedViewers: number;
  readonly captureActive: boolean;
  readonly rfbActive: boolean;
}

export class ScreenProjectionUnavailableError extends Error {
  constructor(
    readonly reason: ScreenProjectionFailureReasonDto,
    message: string,
  ) {
    super(message);
    this.name = "ScreenProjectionUnavailableError";
  }
}

export interface ProjectionWebSocket {
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

export type ProjectionSocketKind = "control" | "rfb";

export interface ProjectionSocketReservation {
  readonly sessionId: string;
  readonly kind: ProjectionSocketKind;
  readonly token: string;
}

interface ProjectionSession {
  id: string;
  owner: ComputerSurfaceOwner;
  source: BotScreenProjectionSource;
  state: ProjectionLifecycleState;
  mode: ProjectionViewMode;
  control?: ProjectionWebSocket | undefined;
  rfb?: ProjectionWebSocket | undefined;
  controlReservation?: string | undefined;
  rfbReservation?: string | undefined;
  attachmentTimer?: Timer | undefined;
  timer?: Timer | undefined;
  expandedView?: BotScreenExpandedView | undefined;
  viewStart?: Promise<void> | undefined;
  viewRead?: Promise<void> | undefined;
  viewWrite: Promise<void>;
  viewWriteBytes: number;
  captureTask?: Promise<void> | undefined;
  cleanups: Set<Promise<void>>;
  nextFrameAt?: number | undefined;
  sequence: number;
  captureAttempts: number;
  sourceFrames: number;
  previewFrames: number;
  previewBytes: number;
  rfbBytesSent: number;
  rfbBytesReceived: number;
  framesSent: number;
  preCaptureBackpressureSkips: number;
  transportUnavailableSkips: number;
  invalidFrameDrops: number;
  sendFailures: number;
  browserMetrics: ScreenProjectionBrowserMetricsDto;
  captureLatencySamples: number;
  captureLatencyTotalMs: number;
  captureLatencyMaxMs: number;
  captureInFlight: boolean;
  inputSuspended: boolean;
}

interface InputController {
  session: ProjectionSession;
  epoch: number;
  nextSequence: number;
  queue: Array<{
    event: BotScreenInputEvent;
    receivedAt: number;
    category?: InputDiagnosticCategory;
    redactedLength?: number;
  }>;
  draining: boolean;
  revoked: boolean;
  active: boolean;
  provisioned: boolean;
  announced: boolean;
  heldCodes: Set<string>;
  heldButtons: Set<"left" | "middle" | "right">;
  release: Promise<void>;
  grant?: WebControlGrant;
}

const KEY_CODES: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81,
  Numpad0: 82, NumpadDecimal: 83, F11: 87, F12: 88, NumpadEnter: 96, ControlRight: 97,
  NumpadDivide: 98, PrintScreen: 99, AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104,
  ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
};

async function withinProjectionDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), CAPTURE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class ScreenProjectionService {
  #sessions = new Map<string, ProjectionSession>();
  #failures = new Map<string, {
    botId: string;
    surfaceId: SurfaceId;
    runtimeGeneration: number;
    diagnostic: ProjectionFailureDiagnostic;
  }>();
  #terminalCleanups = new Set<Promise<void>>();
  #terminations = new Map<string, {
    botId: string;
    surfaceId: SurfaceId;
    promise: Promise<void>;
  }>();
  #controllers = new Map<SurfaceId, InputController>();
  #releaseBarriers = new Map<SurfaceId, Promise<void>>();
  #unsubscribeScreens: () => void;

  constructor(
    private readonly screens: BotScreenManager,
    private readonly diagnostics: InputDiagnostics,
    private readonly lease: ScreenInputLease,
  ) {
    this.#unsubscribeScreens = screens.subscribe((transition) => {
      if (transition.state === "failed" || transition.state === "stopped") {
        void this.closeSurface(transition.surfaceId);
      }
    });
  }

  async createSession(owner: ComputerSurfaceOwner): Promise<ScreenProjectionSessionDto> {
    const source = await this.screens.projectionSource(owner);
    if (source === undefined) {
      throw new Error(this.screens.status(owner).failure ?? "Bot Screen is unavailable");
    }

    const id = randomUUID();
    const session: ProjectionSession = {
      id,
      owner,
      source,
      state: "connecting",
      mode: "idle",
      viewWrite: Promise.resolve(),
      viewWriteBytes: 0,
      sequence: 0,
      captureAttempts: 0,
      sourceFrames: 0,
      previewFrames: 0,
      previewBytes: 0,
      rfbBytesSent: 0,
      rfbBytesReceived: 0,
      framesSent: 0,
      preCaptureBackpressureSkips: 0,
      transportUnavailableSkips: 0,
      invalidFrameDrops: 0,
      sendFailures: 0,
      browserMetrics: {
        browserReceives: 0,
        browserDecodes: 0,
        browserPaints: 0,
        decodeDrops: 0,
        paintDrops: 0,
        captureToPaintLatencySamples: 0,
        captureToPaintLatencyTotalMs: 0,
        captureToPaintLatencyMaxMs: 0,
      },
      captureLatencySamples: 0,
      captureLatencyTotalMs: 0,
      captureLatencyMaxMs: 0,
      captureInFlight: false,
      inputSuspended: false,
      cleanups: new Set(),
    };
    session.attachmentTimer = setTimeout(() => this.#close(session, false), SOCKET_ATTACH_TIMEOUT_MS);
    session.attachmentTimer.unref?.();
    this.#sessions.set(id, session);

    const query = `botId=${encodeURIComponent(owner.botId)}&surfaceId=${encodeURIComponent(owner.surfaceId)}`;
    const sessionQuery = `${query}&sessionId=${encodeURIComponent(id)}`;
    return {
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      sessionId: id,
      surfaceId: source.surfaceId,
      runtimeGeneration: source.runtimeGeneration,
      geometryGeneration: source.geometryGeneration,
      logicalWidth: source.logicalWidth,
      logicalHeight: source.logicalHeight,
      videoWidth: source.videoWidth,
      videoHeight: source.videoHeight,
      scale: source.scale,
      state: "connecting",
      controlUrl: `/api/computer/projection/control?${sessionQuery}`,
      rfbUrl: `/api/computer/projection/rfb?${sessionQuery}`,
      snapshotUrl: `/api/computer/snapshot?${query}`,
      security: { authentication: "none", httpsRequired: false },
    };
  }

  reserveSocket(
    owner: ComputerSurfaceOwner,
    sessionId: string,
    kind: ProjectionSocketKind,
  ): ProjectionSocketReservation | undefined {
    const session = this.#session(owner, sessionId);
    if (session === undefined || session.state === "failed") return undefined;
    if (kind === "control") {
      if (session.control !== undefined || session.controlReservation !== undefined) return undefined;
    } else if (
      session.mode !== "expanded"
      || session.control === undefined
      || session.rfb !== undefined
      || session.rfbReservation !== undefined
      || session.source.expandedProjection !== "rfb"
    ) {
      return undefined;
    }
    const reservation = { sessionId, kind, token: randomUUID() } as const;
    if (kind === "control") session.controlReservation = reservation.token;
    else session.rfbReservation = reservation.token;
    return reservation;
  }

  cancelSocketReservation(reservation: ProjectionSocketReservation): void {
    const session = this.#sessions.get(reservation.sessionId);
    if (session === undefined) return;
    if (reservation.kind === "control" && session.controlReservation === reservation.token && session.control === undefined) {
      session.controlReservation = undefined;
    }
    if (reservation.kind === "rfb" && session.rfbReservation === reservation.token && session.rfb === undefined) {
      session.rfbReservation = undefined;
    }
  }

  openSocket(reservation: ProjectionSocketReservation, socket: ProjectionWebSocket): boolean {
    const session = this.#sessions.get(reservation.sessionId);
    if (session === undefined || session.state === "failed") return false;
    if (reservation.kind === "control") {
      if (session.controlReservation !== reservation.token || session.control !== undefined) return false;
      session.control = socket;
      clearTimeout(session.attachmentTimer);
      session.attachmentTimer = undefined;
      session.state = session.mode;
      this.#sendViewState(session);
      return true;
    }
    if (
      session.rfbReservation !== reservation.token
      || session.rfb !== undefined
      || session.control === undefined
      || session.mode !== "expanded"
    ) return false;
    session.rfb = socket;
    this.#startRfbView(session);
    return true;
  }

  socketMessage(reservation: ProjectionSocketReservation, raw: string | Uint8Array): void {
    const session = this.#sessions.get(reservation.sessionId);
    if (session === undefined || session.state === "failed") return;
    if (reservation.kind === "control") {
      if (session.controlReservation !== reservation.token || session.control === undefined) return;
      this.#control(session, raw);
    } else {
      if (session.rfbReservation !== reservation.token || session.rfb === undefined) return;
      this.#rfbInput(session, raw);
    }
  }

  socketClosed(reservation: ProjectionSocketReservation): void {
    const session = this.#sessions.get(reservation.sessionId);
    if (session === undefined) return;
    if (reservation.kind === "control" && session.controlReservation === reservation.token) {
      session.control = undefined;
      session.controlReservation = undefined;
      this.#close(session, false);
    } else if (reservation.kind === "rfb" && session.rfbReservation === reservation.token) {
      session.rfb = undefined;
      session.rfbReservation = undefined;
      this.#stopExpandedView(session);
    }
  }

  status(owner: ComputerSurfaceOwner, sessionId: string): ProjectionStatus | undefined {
    const session = this.#session(owner, sessionId);
    if (session !== undefined) {
      const failure = this.#failures.get(sessionId)?.diagnostic.reason;
      return {
        sessionId,
        surfaceId: session.source.surfaceId,
        runtimeGeneration: session.source.runtimeGeneration,
        state: session.state,
        mode: session.mode,
        framesSent: session.framesSent,
        ...(failure === undefined ? {} : { failure, snapshotFallback: true as const }),
      };
    }
    const failure = this.#failures.get(sessionId);
    if (failure === undefined || failure.botId !== owner.botId || failure.surfaceId !== owner.surfaceId) return undefined;
    return {
      sessionId,
      surfaceId: failure.surfaceId,
      runtimeGeneration: failure.runtimeGeneration,
      state: "failed",
      mode: "idle",
      framesSent: failure.diagnostic.metrics.previewFrames,
      failure: failure.diagnostic.reason,
      snapshotFallback: true,
    };
  }

  loadMetrics(owner: ComputerSurfaceOwner, sessionId: string): Readonly<ProjectionLoadMetrics> | undefined {
    const session = this.#session(owner, sessionId);
    if (session !== undefined) return this.#metricsSnapshot(session);
    const failure = this.#failures.get(sessionId);
    if (failure === undefined || failure.botId !== owner.botId || failure.surfaceId !== owner.surfaceId) return undefined;
    return failure.diagnostic.metrics;
  }

  surfaceMedia(surfaceId: SurfaceId): SurfaceProjectionMedia {
    const sessions = [...this.#sessions.values()].filter((session) => session.source.surfaceId === surfaceId);
    return {
      surfaceId,
      viewers: sessions.filter((session) => session.control !== undefined).length,
      previewViewers: sessions.filter((session) => session.control !== undefined && session.mode === "preview").length,
      expandedViewers: sessions.filter((session) => session.control !== undefined && session.mode === "expanded").length,
      captureActive: sessions.some((session) => session.captureTask !== undefined || session.timer !== undefined || session.captureInFlight),
      rfbActive: sessions.some((session) => session.expandedView !== undefined || session.viewStart !== undefined),
    };
  }

  failureDiagnostic(owner: ComputerSurfaceOwner, sessionId: string): ProjectionFailureDiagnostic | undefined {
    const failure = this.#failures.get(sessionId);
    if (failure === undefined || failure.botId !== owner.botId || failure.surfaceId !== owner.surfaceId) return undefined;
    return failure.diagnostic;
  }

  async close(owner: ComputerSurfaceOwner, sessionId: string): Promise<boolean> {
    const session = this.#session(owner, sessionId);
    if (session === undefined) {
      const termination = this.#terminations.get(sessionId);
      if (termination !== undefined && termination.botId === owner.botId && termination.surfaceId === owner.surfaceId) {
        await termination.promise;
      }
      return false;
    }
    this.#close(session, false);
    const termination = this.#terminations.get(sessionId);
    if (termination !== undefined) await termination.promise;
    return true;
  }

  async closeSurface(surfaceId: SurfaceId): Promise<void> {
    const sessions = [...this.#sessions.values()].filter((session) => session.owner.surfaceId === surfaceId);
    for (const session of sessions) this.#close(session, false);
    await Promise.allSettled(
      [...this.#terminations.values()]
        .filter((termination) => termination.surfaceId === surfaceId)
        .map((termination) => termination.promise),
    );
  }

  suspendInput(surfaceId: SurfaceId): void {
    for (const session of this.#sessions.values()) {
      if (session.source.surfaceId === surfaceId) session.inputSuspended = true;
    }
  }

  async restoreInput(surfaceId: SurfaceId): Promise<void> {
    const session = [...this.#sessions.values()].find((candidate) =>
      candidate.source.surfaceId === surfaceId
      && candidate.mode === "expanded"
      && candidate.control !== undefined
    );
    if (session === undefined) throw new Error("Web Control session is unavailable");
    session.inputSuspended = false;
    if (!await this.#claimInput(session, true)) {
      session.inputSuspended = true;
      throw new Error("Web Control could not be restored");
    }
  }

  async shutdown(): Promise<void> {
    this.#unsubscribeScreens();
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) this.#close(session, false);
    await Promise.allSettled([
      ...sessions.flatMap((session) => [
        ...(session.captureTask === undefined ? [] : [session.captureTask]),
        ...(session.viewStart === undefined ? [] : [session.viewStart]),
        ...(session.viewRead === undefined ? [] : [session.viewRead]),
        session.viewWrite,
        ...session.cleanups,
      ]),
      ...this.#terminalCleanups,
      ...[...this.#terminations.values()].map((termination) => termination.promise),
    ]);
    await Promise.allSettled(this.#releaseBarriers.values());
    this.diagnostics.shutdown();
  }

  #session(owner: ComputerSurfaceOwner, sessionId: string): ProjectionSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.owner.botId !== owner.botId || session.owner.surfaceId !== owner.surfaceId) {
      return undefined;
    }
    return session;
  }

  #control(session: ProjectionSession, raw: string | Uint8Array): void {
    if (typeof raw !== "string") {
      this.#rejectInput(session);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#rejectInput(session);
      return;
    }

    const control = ScreenProjectionClientControlMessageDto.safeParse(parsed);
    if (control.success) {
      if (!this.#matches(session, control.data)) {
        this.#rejectInput(session);
        return;
      }
      if (control.data.type === "browser-metrics") {
        this.#mergeBrowserMetrics(session, control.data.metrics);
      } else {
        this.#setMode(session, control.data.mode);
      }
      return;
    }
    this.#input(session, parsed);
  }

  #matches(
    session: ProjectionSession,
    envelope: { sessionId: string; surfaceId: SurfaceId; runtimeGeneration: number },
  ): boolean {
    return this.#sessions.get(session.id) === session
      && envelope.sessionId === session.id
      && envelope.surfaceId === session.source.surfaceId
      && envelope.runtimeGeneration === session.source.runtimeGeneration
      && session.state !== "failed";
  }

  #mergeBrowserMetrics(session: ProjectionSession, next: ScreenProjectionBrowserMetricsDto): void {
    const current = session.browserMetrics;
    session.browserMetrics = {
      browserReceives: Math.max(current.browserReceives, next.browserReceives),
      browserDecodes: Math.max(current.browserDecodes, next.browserDecodes),
      browserPaints: Math.max(current.browserPaints, next.browserPaints),
      decodeDrops: Math.max(current.decodeDrops, next.decodeDrops),
      paintDrops: Math.max(current.paintDrops, next.paintDrops),
      captureToPaintLatencySamples: Math.max(current.captureToPaintLatencySamples, next.captureToPaintLatencySamples),
      captureToPaintLatencyTotalMs: Math.max(current.captureToPaintLatencyTotalMs, next.captureToPaintLatencyTotalMs),
      captureToPaintLatencyMaxMs: Math.max(current.captureToPaintLatencyMaxMs, next.captureToPaintLatencyMaxMs),
    };
  }

  #setMode(session: ProjectionSession, mode: ProjectionViewMode): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    const changed = session.mode !== mode;
    if (session.mode === "expanded" && mode !== "expanded") {
      void this.#revokeInputFor(session);
      this.#detachRfb(session);
    }
    session.inputSuspended = false;
    session.mode = mode;
    session.nextFrameAt = mode === "idle" ? undefined : performance.now();
    session.state = mode;
    this.#sendViewState(session);
    if (mode === "expanded") {
      if (changed || !this.#isInputController(session)) void this.#claimInput(session).catch(() => {});
    } else if (mode === "preview") {
      this.#schedule(session, 0);
    }
  }

  #sendViewState(session: ProjectionSession): void {
    const message: ScreenProjectionViewStateMessageDto = {
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      type: "view-state",
      sessionId: session.id,
      surfaceId: session.source.surfaceId,
      runtimeGeneration: session.source.runtimeGeneration,
      mode: session.mode,
    };
    try {
      if (session.control !== undefined) session.control.send(JSON.stringify(message));
    } catch (error) {
      this.#close(session, true, error);
    }
  }

  #schedule(session: ProjectionSession, delay: number): void {
    if (session.timer !== undefined || session.mode !== "preview" || this.#sessions.get(session.id) !== session) return;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      const captureTask = this.#projectFrame(session);
      session.captureTask = captureTask;
      void captureTask.finally(() => {
        if (session.captureTask === captureTask) session.captureTask = undefined;
      });
    }, delay);
    session.timer.unref?.();
  }

  async #projectFrame(session: ProjectionSession): Promise<void> {
    if (session.captureInFlight || session.mode !== "preview" || this.#sessions.get(session.id) !== session) return;
    const control = session.control;
    if (control === undefined) {
      session.transportUnavailableSkips += 1;
      this.#scheduleNext(session);
      return;
    }
    if (control.getBufferedAmount() > 0) {
      session.preCaptureBackpressureSkips += 1;
      this.#scheduleNext(session);
      return;
    }

    session.captureInFlight = true;
    session.captureAttempts += 1;
    const captureStartedAt = performance.now();
    try {
      const image = await withinProjectionDeadline(
        session.source.capture(),
        "Screen capture did not produce a frame within its latency bound",
      );
      if (session.mode !== "preview" || this.#sessions.get(session.id) !== session) return;
      session.sourceFrames += 1;
      if (image.mediaType !== "image/png" || image.bytes.byteLength === 0 || image.bytes.byteLength > MAX_FRAME_BYTES) {
        session.invalidFrameDrops += 1;
        return;
      }
      this.#sendPreviewPng(session, image.bytes, new Date());
    } catch (error) {
      queueMicrotask(() => this.#fail(session, "capture-failed", error));
    } finally {
      const captureLatency = Math.max(0, performance.now() - captureStartedAt);
      session.captureLatencySamples += 1;
      session.captureLatencyTotalMs += captureLatency;
      session.captureLatencyMaxMs = Math.max(session.captureLatencyMaxMs, captureLatency);
      session.captureInFlight = false;
      this.#scheduleNext(session);
    }
  }

  #sendPreviewPng(session: ProjectionSession, bytes: Uint8Array, capturedAt: Date): void {
    const control = session.control;
    if (control === undefined) {
      session.transportUnavailableSkips += 1;
      return;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) {
      session.invalidFrameDrops += 1;
      return;
    }
    if (control.getBufferedAmount() + bytes.byteLength > MAX_BUFFERED_BYTES) {
      session.preCaptureBackpressureSkips += 1;
      return;
    }
    const header = JSON.stringify({
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      type: "preview-frame",
      sessionId: session.id,
      surfaceId: session.source.surfaceId,
      runtimeGeneration: session.source.runtimeGeneration,
      geometryGeneration: session.source.geometryGeneration,
      logicalWidth: session.source.logicalWidth,
      logicalHeight: session.source.logicalHeight,
      videoWidth: session.source.videoWidth,
      videoHeight: session.source.videoHeight,
      scale: session.source.scale,
      sequence: ++session.sequence,
      mediaType: "image/png" as const,
      capturedAt: capturedAt.toISOString(),
      byteLength: bytes.byteLength,
    });
    try {
      if (control.send(header) === 0 || control.send(bytes) === 0) {
        session.sendFailures += 1;
        return;
      }
      session.previewFrames += 1;
      session.previewBytes += bytes.byteLength;
      session.framesSent += 1;
    } catch {
      session.sendFailures += 1;
    }
  }

  #scheduleNext(session: ProjectionSession): void {
    if (session.mode !== "preview" || this.#sessions.get(session.id) !== session) return;
    const now = performance.now();
    session.nextFrameAt = Math.max((session.nextFrameAt ?? now) + PREVIEW_INTERVAL_MS, now);
    this.#schedule(session, session.nextFrameAt - now);
  }

  #input(session: ProjectionSession, parsed: unknown): void {
    const controller = this.#controllers.get(session.source.surfaceId);
    if (
      controller?.session !== session
      || controller.revoked
      || !controller.active
      || session.mode !== "expanded"
    ) {
      this.#rejectInput(session);
      return;
    }
    if (!this.lease.canAcceptWebControl(session.owner.surfaceId)) {
      void this.#revokeInput(controller).catch((error) => this.#close(session, true, error));
      return;
    }
    const message = ScreenInputMessageDto.safeParse(parsed);
    if (
      !message.success
      || !this.#matches(session, message.data)
      || message.data.geometryGeneration !== session.source.geometryGeneration
      || message.data.controllerEpoch !== controller.epoch
      || message.data.sequence !== controller.nextSequence
      || controller.queue.length >= MAX_INPUT_QUEUE
      || (
        (message.data.type === "pointer-motion"
          || message.data.type === "pointer-button"
          || message.data.type === "pointer-scroll")
        && (message.data.x >= session.source.logicalWidth || message.data.y >= session.source.logicalHeight)
      )
      || (message.data.type === "pointer-scroll" && message.data.deltaX === 0 && message.data.deltaY === 0)
      || (
        message.data.type === "paste"
        && (message.data.text.includes("\0") || new TextEncoder().encode(message.data.text).byteLength > 65_536)
      )
    ) {
      this.#rejectInput(session);
      return;
    }
    const { surfaceId, runtimeGeneration, geometryGeneration, controllerEpoch, sequence } = message.data;
    if (message.data.type === "release-control") {
      controller.nextSequence += 1;
      void this.#revokeInput(controller);
      return;
    }

    let event: BotScreenInputEvent;
    if (message.data.type === "pointer-motion") {
      event = { surfaceId, runtimeGeneration, geometryGeneration, controllerEpoch, sequence, type: "motion", x: message.data.x, y: message.data.y };
    } else if (message.data.type === "pointer-button") {
      if (message.data.state === "pressed") {
        if (controller.heldButtons.has(message.data.button)) {
          this.#rejectInput(session);
          return;
        }
        controller.heldButtons.add(message.data.button);
      } else if (!controller.heldButtons.delete(message.data.button)) {
        this.#rejectInput(session);
        return;
      }
      event = {
        surfaceId,
        runtimeGeneration,
        geometryGeneration,
        controllerEpoch,
        sequence,
        type: "button",
        x: message.data.x,
        y: message.data.y,
        button: message.data.button,
        state: message.data.state,
      };
    } else if (message.data.type === "pointer-scroll") {
      event = {
        surfaceId,
        runtimeGeneration,
        geometryGeneration,
        controllerEpoch,
        sequence,
        type: "scroll",
        x: message.data.x,
        y: message.data.y,
        deltaX: message.data.deltaX,
        deltaY: message.data.deltaY,
      };
    } else if (message.data.type === "paste") {
      event = { surfaceId, runtimeGeneration, geometryGeneration, controllerEpoch, sequence, type: "paste", text: message.data.text };
    } else {
      const heldCodes = new Set(controller.heldCodes);
      if (message.data.state === "pressed") {
        if (heldCodes.has(message.data.code)) {
          this.#rejectInput(session);
          return;
        }
        heldCodes.add(message.data.code);
      } else if (!heldCodes.delete(message.data.code)) {
        this.#rejectInput(session);
        return;
      }
      const actualModifiers = {
        control: heldCodes.has("ControlLeft") || heldCodes.has("ControlRight"),
        alt: heldCodes.has("AltLeft") || heldCodes.has("AltRight"),
        shift: heldCodes.has("ShiftLeft") || heldCodes.has("ShiftRight"),
        meta: heldCodes.has("MetaLeft") || heldCodes.has("MetaRight"),
      };
      if (
        actualModifiers.control !== message.data.modifiers.control
        || actualModifiers.alt !== message.data.modifiers.alt
        || actualModifiers.shift !== message.data.modifiers.shift
        || actualModifiers.meta !== message.data.modifiers.meta
      ) {
        this.#rejectInput(session);
        return;
      }
      controller.heldCodes = heldCodes;
      event = {
        surfaceId,
        runtimeGeneration,
        geometryGeneration,
        controllerEpoch,
        sequence,
        type: "key",
        keyCode: KEY_CODES[message.data.code]!,
        state: message.data.state,
      };
    }

    controller.nextSequence += 1;
    const category: InputDiagnosticCategory | undefined = message.data.type === "pointer-button"
      ? "pointer-button"
      : message.data.type === "pointer-scroll"
        ? "pointer-scroll"
        : message.data.type === "paste"
          ? "paste"
          : message.data.type === "key"
            ? (message.data.state === "pressed" && (message.data.modifiers.control || message.data.modifiers.alt || message.data.modifiers.meta) ? "shortcut" : "key")
            : undefined;
    const queued = {
      event,
      receivedAt: Date.now(),
      ...(category === undefined ? {} : { category }),
      ...(message.data.type === "paste" ? { redactedLength: Array.from(message.data.text).length } : {}),
    };
    if (queued.category !== undefined) {
      this.#recordDiagnostic(session.source.surfaceId, queued.category, "accepted", 0, queued.redactedLength);
    }
    const last = controller.queue.at(-1);
    if (event.type === "motion" && last?.event.type === "motion") controller.queue[controller.queue.length - 1] = queued;
    else controller.queue.push(queued);
    if (!controller.draining) {
      controller.draining = true;
      queueMicrotask(() => void this.#drainInput(controller));
    }
  }

  async #drainInput(controller: InputController): Promise<void> {
    try {
      while (!controller.revoked && controller.active && this.#controllers.get(controller.session.source.surfaceId) === controller) {
        const queued = controller.queue.shift();
        if (queued === undefined) return;
        try {
          if (controller.grant === undefined) throw new Error("Web Control grant is unavailable");
          await controller.grant.input(queued.event);
        } catch (error) {
          if (queued.category !== undefined) {
            this.#recordDiagnostic(
              controller.session.source.surfaceId,
              queued.category,
              "failed",
              Date.now() - queued.receivedAt,
              queued.redactedLength,
            );
          }
          this.#fail(controller.session, "transport-failed", error);
          return;
        }
      }
    } finally {
      controller.draining = false;
      if (!controller.revoked && controller.active && controller.queue.length > 0) {
        controller.draining = true;
        queueMicrotask(() => void this.#drainInput(controller));
      }
    }
  }

  async #claimInput(session: ProjectionSession, force = false): Promise<boolean> {
    if (
      this.#sessions.get(session.id) !== session
      || session.mode !== "expanded"
      || session.control === undefined
      || (!force && !this.lease.canAcceptWebControl(session.owner.surfaceId))
      || this.#isInputController(session)
      || session.inputSuspended
    ) return false;
    const surfaceId = session.source.surfaceId;
    const previous = this.#controllers.get(surfaceId);
    if (previous !== undefined && previous.session !== session) void this.#revokeInput(previous);
    const controller: InputController = {
      session,
      epoch: 0,
      nextSequence: 1,
      queue: [],
      draining: false,
      revoked: false,
      active: false,
      provisioned: false,
      announced: false,
      heldCodes: new Set(),
      heldButtons: new Set(),
      release: Promise.resolve(),
    };
    this.#controllers.set(surfaceId, controller);
    const barrier = this.#releaseBarriers.get(surfaceId) ?? Promise.resolve();
    let activationFailed = false;
    controller.release = barrier.then(async () => {
      if (
        controller.revoked
        || this.#controllers.get(surfaceId) !== controller
        || this.#sessions.get(session.id) !== session
        || session.mode !== "expanded"
      ) return;
      const grant = await this.lease.acquireWebControl({
        surfaceId,
        runtimeGeneration: session.source.runtimeGeneration,
      });
      controller.epoch = grant.epoch;
      controller.grant = grant;
      controller.provisioned = true;
      if (
        controller.revoked
        || this.#controllers.get(surfaceId) !== controller
        || this.#sessions.get(session.id) !== session
        || session.mode !== "expanded"
        || (!force && !this.lease.canAcceptWebControl(session.owner.surfaceId))
      ) return;
      controller.active = true;
      this.lease.webControlClaimed(session.owner);
      controller.announced = true;
      this.#sendInputAuthority(controller, true);
      this.#recordDiagnostic(surfaceId, "controller", "accepted", 0);
    }).catch(() => {
      activationFailed = true;
    });
    await controller.release;
    if (activationFailed) {
      if (!controller.revoked) void this.#revokeInput(controller).catch(() => {});
      return false;
    }
    if (!controller.active && controller.provisioned && !controller.revoked) await this.#revokeInput(controller);
    return controller.active;
  }

  #rejectInput(session: ProjectionSession): void {
    this.#recordDiagnostic(session.source.surfaceId, "invalid", "rejected", 0);
    this.#close(session, true, new Error("invalid Web Control input"));
  }

  #recordDiagnostic(
    surfaceId: SurfaceId,
    category: InputDiagnosticCategory,
    outcome: "accepted" | "rejected" | "failed" | "released",
    latencyMs: number,
    redactedLength?: number,
  ): void {
    try {
      this.diagnostics.record(surfaceId, category, outcome, latencyMs, redactedLength);
    } catch {
      // Local diagnostics must never interrupt control or held-input cleanup.
    }
  }

  #isInputController(session: ProjectionSession): boolean {
    return this.#controllers.get(session.source.surfaceId)?.session === session;
  }

  #revokeInputFor(session: ProjectionSession): Promise<void> {
    const controller = this.#controllers.get(session.source.surfaceId);
    return controller?.session === session ? this.#revokeInput(controller) : Promise.resolve();
  }

  #revokeInput(controller: InputController): Promise<void> {
    if (controller.revoked) return controller.release;
    controller.revoked = true;
    controller.active = false;
    controller.queue.length = 0;
    const surfaceId = controller.session.source.surfaceId;
    if (this.#controllers.get(surfaceId) === controller) this.#controllers.delete(surfaceId);
    this.#sendInputAuthority(controller, false);
    const activation = controller.release;
    const priorRelease = this.#releaseBarriers.get(surfaceId) ?? Promise.resolve();
    const prior = Promise.all([activation.catch(() => {}), priorRelease.catch(() => {})]);
    const startedAt = Date.now();
    const release = prior.then(async () => {
      try {
        if (controller.grant !== undefined) await controller.grant.release();
        else if (controller.provisioned) await controller.session.source.releaseInput(controller.epoch);
        this.#recordDiagnostic(surfaceId, "release", "released", Date.now() - startedAt);
      } catch (error) {
        this.#recordDiagnostic(surfaceId, "release", "failed", Date.now() - startedAt);
        throw error;
      } finally {
        if (controller.announced) {
          controller.announced = false;
          this.lease.webControlReleased(controller.session.owner);
        }
      }
    });
    controller.release = release;
    this.#releaseBarriers.set(surfaceId, release);
    void release.finally(() => {
      if (this.#releaseBarriers.get(surfaceId) === release) this.#releaseBarriers.delete(surfaceId);
    }).catch(() => {});
    return release;
  }

  #sendInputAuthority(controller: InputController, active: boolean): void {
    const { session } = controller;
    const { source } = session;
    if (session.control === undefined) return;
    const message: ScreenInputAuthorityMessageDto = {
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      type: "input-authority",
      active,
      sessionId: session.id,
      surfaceId: source.surfaceId,
      runtimeGeneration: source.runtimeGeneration,
      geometryGeneration: source.geometryGeneration,
      controllerEpoch: controller.epoch,
      logicalWidth: source.logicalWidth,
      logicalHeight: source.logicalHeight,
      videoWidth: source.videoWidth,
      videoHeight: source.videoHeight,
      scale: source.scale,
    };
    try {
      session.control.send(JSON.stringify(message));
    } catch {
      // Revocation may race the control socket closing.
    }
  }

  #rfbInput(session: ProjectionSession, raw: string | Uint8Array): void {
    if (typeof raw === "string" || raw.byteLength === 0 || raw.byteLength > MAX_FRAME_BYTES) {
      this.#fail(session, "view-client-failed", new Error("RFB WebSocket accepts bounded binary messages only"));
      return;
    }
    if (session.viewWriteBytes + raw.byteLength > MAX_BUFFERED_BYTES) {
      this.#fail(session, "view-client-failed", new Error("RFB client queue exceeded its byte bound"));
      return;
    }
    const bytes = raw.slice();
    session.viewWriteBytes += bytes.byteLength;
    const write = session.viewWrite.then(async () => {
      if (session.viewStart !== undefined) await session.viewStart;
      const lease = session.expandedView;
      if (lease === undefined || session.rfb === undefined || session.mode !== "expanded") {
        throw new Error("RFB bridge is unavailable");
      }
      await lease.send(bytes);
      session.rfbBytesReceived += bytes.byteLength;
    }).catch((error) => {
      this.#fail(session, "rfb-bridge-failed", error);
    }).finally(() => {
      session.viewWriteBytes -= bytes.byteLength;
    });
    session.viewWrite = write;
  }

  #startRfbView(session: ProjectionSession): void {
    if (
      session.mode !== "expanded"
      || session.rfb === undefined
      || session.source.expandedProjection !== "rfb"
      || session.expandedView !== undefined
      || session.viewStart !== undefined
      || this.#sessions.get(session.id) !== session
    ) return;
    const start = (async () => {
      await Promise.allSettled([
        ...session.cleanups,
        ...[...this.#terminations.values()]
          .filter((termination) => termination.surfaceId === session.source.surfaceId)
          .map((termination) => termination.promise),
      ]);
      if (session.mode !== "expanded" || session.rfb === undefined || this.#sessions.get(session.id) !== session) return;
      let lease: BotScreenExpandedView;
      try {
        lease = await session.source.acquireExpandedView();
      } catch (error) {
        this.#fail(session, "rfb-start-failed", error);
        return;
      }
      if (session.mode !== "expanded" || session.rfb === undefined || this.#sessions.get(session.id) !== session) {
        await lease.close().catch(() => {});
        return;
      }
      session.expandedView = lease;
      const read = this.#readRfb(session, lease);
      session.viewRead = read;
      void read.finally(() => {
        if (session.viewRead === read) session.viewRead = undefined;
      });
    })();
    session.viewStart = start;
    void start.finally(() => {
      if (session.viewStart === start) session.viewStart = undefined;
    });
  }

  async #readRfb(session: ProjectionSession, lease: BotScreenExpandedView): Promise<void> {
    try {
      while (session.expandedView === lease && session.rfb !== undefined && this.#sessions.get(session.id) === session) {
        const bytes = await lease.receive();
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) {
          throw new Error("RFB source produced an invalid message size");
        }
        await this.#sendRfb(session, bytes);
      }
    } catch (error) {
      if (session.expandedView === lease && this.#sessions.get(session.id) === session) {
        this.#fail(session, "rfb-bridge-failed", error);
      }
    }
  }

  async #sendRfb(session: ProjectionSession, bytes: Uint8Array): Promise<void> {
    const deadline = performance.now() + RFB_BACKPRESSURE_TIMEOUT_MS;
    for (;;) {
      const socket = session.rfb;
      if (socket === undefined || session.mode !== "expanded" || this.#sessions.get(session.id) !== session) {
        throw new Error("RFB client disconnected");
      }
      if (socket.getBufferedAmount() + bytes.byteLength <= MAX_BUFFERED_BYTES) {
        if (socket.send(bytes) === 0) throw new Error("RFB WebSocket send failed");
        session.rfbBytesSent += bytes.byteLength;
        return;
      }
      if (performance.now() >= deadline) throw new Error("RFB WebSocket remained backpressured");
      await Bun.sleep(10);
    }
  }

  #detachRfb(session: ProjectionSession): void {
    const socket = session.rfb;
    session.rfb = undefined;
    session.rfbReservation = undefined;
    this.#stopExpandedView(session);
    try {
      socket?.close(1000, "RFB view ended");
    } catch {
      // The peer may already be closed.
    }
  }

  #stopExpandedView(session: ProjectionSession): void {
    const lease = session.expandedView;
    session.expandedView = undefined;
    if (lease === undefined) return;
    let cleanup: Promise<void>;
    try {
      cleanup = lease.close();
    } catch {
      cleanup = Promise.resolve();
    }
    session.cleanups.add(cleanup);
    this.#terminalCleanups.add(cleanup);
    void cleanup.finally(() => {
      session.cleanups.delete(cleanup);
      this.#terminalCleanups.delete(cleanup);
    }).catch(() => {});
  }

  #metricsSnapshot(session: ProjectionSession): Readonly<ProjectionLoadMetrics> {
    const browser = session.browserMetrics;
    const captureOutstanding = session.captureInFlight ? 1 : 0;
    const captureShortfall = session.state === "failed"
      ? 0
      : Math.max(0, session.captureAttempts - session.sourceFrames - session.preCaptureBackpressureSkips - captureOutstanding);
    const receiveShortfall = Math.max(0, session.previewFrames - browser.browserReceives);
    const decodeShortfall = Math.max(0, browser.browserReceives - browser.browserDecodes - browser.decodeDrops);
    const paintShortfall = Math.max(0, browser.browserDecodes - browser.browserPaints - browser.paintDrops);
    return Object.freeze({
      sessionId: session.id,
      surfaceId: session.source.surfaceId,
      sequence: session.sequence,
      captureAttempts: session.captureAttempts,
      sourceFrames: session.sourceFrames,
      previewFrames: session.previewFrames,
      previewBytes: session.previewBytes,
      rfbBytesSent: session.rfbBytesSent,
      rfbBytesReceived: session.rfbBytesReceived,
      browserReceives: browser.browserReceives,
      browserDecodes: browser.browserDecodes,
      browserPaints: browser.browserPaints,
      captureSkips: session.preCaptureBackpressureSkips,
      invalidFrames: session.invalidFrameDrops,
      transportSkips: session.transportUnavailableSkips,
      sendFailures: session.sendFailures,
      decodeDrops: browser.decodeDrops,
      paintDrops: browser.paintDrops,
      unexplainedShortfalls: captureShortfall + receiveShortfall + decodeShortfall + paintShortfall,
      captureLatencySamples: session.captureLatencySamples,
      captureLatencyTotalMs: session.captureLatencyTotalMs,
      captureLatencyMaxMs: session.captureLatencyMaxMs,
      captureToPaintLatencySamples: browser.captureToPaintLatencySamples,
      captureToPaintLatencyTotalMs: browser.captureToPaintLatencyTotalMs,
      captureToPaintLatencyMaxMs: browser.captureToPaintLatencyMaxMs,
    });
  }

  #recordFailure(
    session: ProjectionSession,
    reason: ScreenProjectionFailureReasonDto,
    technicalError?: unknown,
  ): void {
    if (this.#failures.has(session.id)) return;
    this.#failures.set(session.id, {
      botId: session.owner.botId,
      surfaceId: session.owner.surfaceId,
      runtimeGeneration: session.source.runtimeGeneration,
      diagnostic: Object.freeze({
        reason,
        ...(technicalError === undefined ? {} : { technicalError: technicalError instanceof Error ? technicalError.message : String(technicalError) }),
        metrics: this.#metricsSnapshot(session),
      }),
    });
    const oldest = this.#failures.keys().next();
    if (this.#failures.size > 64 && !oldest.done) this.#failures.delete(oldest.value);
  }

  #fail(session: ProjectionSession, reason: ScreenProjectionFailureReasonDto, technicalError?: unknown): void {
    if (this.#sessions.get(session.id) !== session || session.state === "failed") return;
    session.state = "failed";
    session.mode = "idle";
    this.#recordFailure(session, reason, technicalError);
    const detail = technicalError instanceof Error ? technicalError.message : String(technicalError ?? "no technical detail");
    console.error(
      `Screen Projection ${reason} for ${session.source.surfaceId} session ${session.id}: ${detail}`,
    );
    session.inputSuspended = true;
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    void this.#revokeInputFor(session).catch(() => {});
    this.#detachRfb(session);
    const message: ScreenProjectionFailureMessageDto = {
      version: SCREEN_PROJECTION_PROTOCOL_VERSION,
      type: "projection-failure",
      sessionId: session.id,
      surfaceId: session.source.surfaceId,
      runtimeGeneration: session.source.runtimeGeneration,
      reason,
      snapshotFallback: true,
    };
    try {
      session.control?.send(JSON.stringify(message));
    } catch {
      // The control socket may close before failure delivery.
    }
    session.timer = setTimeout(() => {
      session.timer = undefined;
      this.#close(session, false);
    }, FAILURE_DELIVERY_GRACE_MS);
    session.timer.unref?.();
  }

  #close(session: ProjectionSession, failed: boolean, technicalError?: unknown): void {
    if (this.#sessions.get(session.id) !== session) return;
    if (failed) this.#recordFailure(session, "transport-failed", technicalError);
    this.#sessions.delete(session.id);
    clearTimeout(session.attachmentTimer);
    clearTimeout(session.timer);
    session.attachmentTimer = undefined;
    session.timer = undefined;
    void this.#revokeInputFor(session).catch(() => {});
    const control = session.control;
    session.control = undefined;
    session.controlReservation = undefined;
    this.#detachRfb(session);
    session.mode = "idle";
    session.state = failed ? "failed" : "closed";
    try {
      control?.close(1000, "Screen Projection ended");
    } catch {
      // The peer may already be closed.
    }
    const termination = Promise.allSettled([
      ...(session.captureTask === undefined ? [] : [session.captureTask]),
      ...(session.viewStart === undefined ? [] : [session.viewStart]),
      ...(session.viewRead === undefined ? [] : [session.viewRead]),
      session.viewWrite,
      ...session.cleanups,
    ]).then(() => {});
    const terminal = { botId: session.owner.botId, surfaceId: session.owner.surfaceId, promise: termination };
    this.#terminations.set(session.id, terminal);
    void termination.finally(() => {
      if (this.#terminations.get(session.id) === terminal) this.#terminations.delete(session.id);
    });
  }
}
