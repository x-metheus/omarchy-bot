import type { ComputerWindowListItem } from "@omarchy-bot/agent-contract";
import type { BrowserAction, SurfaceId } from "@omarchy-bot/domain";
import { BotScreenInputRejectedError, BotScreenUnavailableError } from "./botScreenManager.ts";
import type {
  BotScreenCapture,
  BotScreenCaptureStream,
  BotScreenExpandedView,
  BotScreenInputEvent,
  BotScreenProvision,
  BotScreenRuntime,
  BotScreenRuntimeOutcome,
  BotScreenRuntimeAdapter,
} from "./botScreenManager.ts";


type FakePointerEvent = Extract<BotScreenInputEvent, { type: "motion" | "button" | "scroll" }>;
const FAKE_SCREEN_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWMQMgn7D8IAC5MDN627upEAAAAASUVORK5CYII=",
  "base64",
);
const FAKE_RFB_BANNER = new Uint8Array([
  0x52, 0x46, 0x42, 0x20, 0x30, 0x30, 0x33, 0x2e, 0x30, 0x30, 0x38, 0x0a,
]);


interface FakeBotScreenRuntimeOptions {
  pointerDelayMs?: number;
  inputFailureAt?: number;
  releaseDelayMs?: number;
  actionFailureAt?: number;
}

interface FakeRuntimeRecord {
  runtime: BotScreenRuntime;
  finish(outcome: BotScreenRuntimeOutcome): void;
}
/** Deterministic in-process platform adapter used by daemon integration tests. */
export class FakeBotScreenRuntimeAdapter implements BotScreenRuntimeAdapter {
  readonly pointerEvents: Array<{ surfaceId: string; runtimeGeneration: number; event: FakePointerEvent }> = [];
  readonly inputEvents: Array<{ surfaceId: string; runtimeGeneration: number; event: BotScreenInputEvent }> = [];
  readonly browserActions: Array<{ surfaceId: string; action: BrowserAction }> = [];
  browserDelayMs = 0;
  releaseCount = 0;
  readonly starts: BotScreenProvision[] = [];
  readonly stops: Array<{ surfaceId: string; runtimeGeneration: number }> = [];
  readonly destroyed = new Set<string>();
  readonly applicationExits: Array<{ surfaceId: string; runtimeGeneration: number }> = [];
  captureStreamsOpened = 0;
  captureStreamsClosed = 0;
  expandedViewsAcquired = 0;
  expandedViewsReleased = 0;
  captureRequestsInFlight = 0;
  maximumCaptureRequestsInFlight = 0;
  /** Windows each Screen routes, keyed by Surface. */
  #windows = new Map<string, ComputerWindowListItem[]>();
  readonly focusRequests: string[] = [];
  #captureStarts = new Map<string, number>();
  #liveCaptureChildren = new Map<string, number>();
  #maxCapturesInFlight = new Map<string, number>();
  /** Live child count each capture saw when it started, oldest first. */
  #captureStartLiveChildren = new Map<string, number[]>();
  #blockedCaptureSurface: string | undefined;
  #blockedCaptureStarted = Promise.withResolvers<void>();
  #blockedCaptureRelease = Promise.withResolvers<void>();
  #captureSpawnHook: ((surfaceId: string, signal: AbortSignal | undefined) => void) | undefined;
  #captureTeardownGate: Promise<void> | undefined;
  #captureTeardownStarted = Promise.withResolvers<void>();
  #captureTeardownRelease = Promise.withResolvers<void>();
  #inputsInFlight = 0;
  #inputSurfacesInFlight = new Set<string>();
  maximumInputsInFlight = 0;
  maximumInputSurfacesInFlight = 0;
  #unreconciled = new Set<string>();
  #runtimes = new Map<string, FakeRuntimeRecord>();
  #pointerWaiters: Array<{ count: number; resolve: () => void }> = [];
  #inputWaiters: Array<{ count: number; resolve: () => void }> = [];
  #pointerEventWaiters: Array<{
    predicate: (event: { surfaceId: string; runtimeGeneration: number; event: FakePointerEvent }) => boolean;
    resolve: () => void;
  }> = [];
  #inputAttempts = 0;
  #releaseWaiters: Array<{ count: number; resolve: () => void }> = [];
  #captureStreamCloseWaiters: Array<{ count: number; resolve: () => void }> = [];
  #captureStreamFailures = new Set<string>();
  #captureFailures = new Set<string>();
  /** Captures each Surface still owes as a stall, and the stalls it already aborted. */
  #stalledCaptures = new Map<string, number>();
  #abortedCaptures = new Map<string, number>();
  #unavailableCaptures = new Map<string, string>();
  #releaseFailures = new Set<string>();
  #blockActions = false;
  #actionsStarted = 0;
  #actionWaiters: Array<{ count: number; resolve: () => void }> = [];
  #actionGate = Promise.withResolvers<void>();
  #blockInputs = false;
  #inputGate = Promise.withResolvers<void>();
  #inputAttemptWaiters: Array<{ count: number; resolve: () => void }> = [];
  #blockStarts = false;
  #startGate = Promise.withResolvers<void>();
  #startAttempts = 0;
  #startAttemptWaiters: Array<{ count: number; resolve: () => void }> = [];
  #startFailures = new Map<string, string>();
  /** The fake Bot Computer generation every attached Screen reports. */
  #generation = 0;

  constructor(
    private readonly failure?: string,
    private readonly options: FakeBotScreenRuntimeOptions = {},
  ) {}

  failStart(surfaceId: string, message: string): void {
    this.#startFailures.set(surfaceId, message);
  }

  blockStarts(): void {
    this.#blockStarts = true;
    this.#startGate = Promise.withResolvers<void>();
  }

  waitForStartAttempts(count: number): Promise<void> {
    if (this.#startAttempts >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#startAttemptWaiters.push({ count, resolve });
    return promise;
  }

  releaseStarts(): void {
    this.#blockStarts = false;
    this.#startGate.resolve();
  }

  blockActions(): void {
    this.#blockActions = true;
    this.#actionGate = Promise.withResolvers<void>();
  }

  waitForActions(count: number): Promise<void> {
    if (this.#actionsStarted >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#actionWaiters.push({ count, resolve });
    return promise;
  }

  releaseActions(): void {
    this.#blockActions = false;
    this.#actionGate.resolve();
  }

  blockInputs(): void {
    this.#blockInputs = true;
    this.#inputGate = Promise.withResolvers<void>();
  }

  waitForInputAttempts(count: number): Promise<void> {
    if (this.#inputAttempts >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#inputAttemptWaiters.push({ count, resolve });
    return promise;
  }

  releaseInputs(): void {
    this.#blockInputs = false;
    this.#inputGate.resolve();
  }


  waitForInputEvents(count: number): Promise<void> {
    if (this.inputEvents.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#inputWaiters.push({ count, resolve });
    return promise;
  }

  waitForPointerEvents(count: number): Promise<void> {
    if (this.pointerEvents.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#pointerWaiters.push({ count, resolve });
    return promise;
  }

  waitForPointerEvent(
    predicate: (event: { surfaceId: string; runtimeGeneration: number; event: FakePointerEvent }) => boolean,
  ): Promise<void> {
    if (this.pointerEvents.some(predicate)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#pointerEventWaiters.push({ predicate, resolve });
    return promise;
  }

  waitForReleases(count: number): Promise<void> {
    if (this.releaseCount >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#releaseWaiters.push({ count, resolve });
    return promise;
  }

  waitForCaptureStreamsClosed(count: number): Promise<void> {
    if (this.captureStreamsClosed >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#captureStreamCloseWaiters.push({ count, resolve });
    return promise;
  }

  failNextCaptureStreamFrame(surfaceId: string): void {
    this.#captureStreamFailures.add(surfaceId);
  }

  failNextCapture(surfaceId: string): void {
    this.#captureFailures.add(surfaceId);
  }

  /** The next `count` captures on this Screen stall until their AbortSignal fires. */
  stallNextCaptures(surfaceId: string, count: number): void {
    this.#stalledCaptures.set(surfaceId, (this.#stalledCaptures.get(surfaceId) ?? 0) + count);
  }

  /** Captures on this Screen that ended because their AbortSignal fired. */
  captureAborts(surfaceId: string): number {
    return this.#abortedCaptures.get(surfaceId) ?? 0;
  }

  /** Every capture on this Screen fails the way a runtime reports an unusable Screen. */
  failCapturesWith(surfaceId: string, message: string): void {
    this.#unavailableCaptures.set(surfaceId, message);
  }

  failNextRelease(surfaceId: string): void {
    this.#releaseFailures.add(surfaceId);
  }

  /** Windows this Screen routes, in Screen coordinates. */
  setWindows(surfaceId: string, windows: ComputerWindowListItem[]): void {
    this.#windows.set(surfaceId, windows);
  }

  blockFirstCapture(surfaceId: string): void {
    this.#blockedCaptureSurface = surfaceId;
  }

  captureStarts(surfaceId: string): number {
    return this.#captureStarts.get(surfaceId) ?? 0;
  }

  maxConcurrentCaptures(surfaceId: string): number {
    return this.#maxCapturesInFlight.get(surfaceId) ?? 0;
  }

  /** Runs at the first line of a capture, before it installs its abort listener. */
  onCaptureSpawn(hook: (surfaceId: string, signal: AbortSignal | undefined) => void): void {
    this.#captureSpawnHook = hook;
  }

  /**
   * Holds the teardown of an aborted capture child, so a capture that lost its
   * deadline keeps its child alive until the test releases the kill.
   */
  blockCaptureTeardown(): void {
    this.#captureTeardownGate = this.#captureTeardownRelease.promise;
  }

  waitForCaptureTeardown(): Promise<void> {
    return this.#captureTeardownStarted.promise;
  }

  releaseCaptureTeardown(): void {
    this.#captureTeardownRelease.resolve();
  }

  /** Capture children this Screen still has running. */
  liveCaptureChildren(surfaceId: string): number {
    return this.#liveCaptureChildren.get(surfaceId) ?? 0;
  }

  /** For each capture on this Screen, the children already running when it began. */
  captureStartLiveChildren(surfaceId: string): number[] {
    return this.#captureStartLiveChildren.get(surfaceId) ?? [];
  }

  waitForBlockedCapture(): Promise<void> {
    return this.#blockedCaptureStarted.promise;
  }

  releaseBlockedCapture(): void {
    this.#blockedCaptureRelease.resolve();
  }

  /** Actions that reached a Screen (window listing, focus, launch). */
  get actionsStarted(): number {
    return this.#actionsStarted;
  }

  /** The Bot Computer generation every attached Screen reports. */
  get generation(): number {
    return this.#generation;
  }

  running(surfaceId: string): { generation: number } | undefined {
    const record = this.#runtimes.get(surfaceId);
    return record === undefined ? undefined : { generation: record.runtime.generation };
  }

  runtimeOutcome(surfaceId: string): Promise<BotScreenRuntimeOutcome> {
    const record = this.#runtimes.get(surfaceId);
    if (record === undefined) throw new Error("fake Bot Screen is not running");
    return record.runtime.outcome;
  }

  crash(surfaceId: string, message: string): void {
    this.exitInputHelper(surfaceId, message);
  }

  exitApplication(surfaceId: string): void {
    const record = this.#record(surfaceId);
    this.applicationExits.push({
      surfaceId,
      runtimeGeneration: record.runtime.generation,
    });
  }

  exitDesktop(surfaceId: string, message = "fake Bot Desktop exited"): void {
    this.#finish(surfaceId, { type: "desktop-exited", error: new Error(message) });
  }

  exitInputHelper(surfaceId: string, message = "fake Bot Screen input helper exited"): void {
    this.#finish(surfaceId, { type: "input-helper-exited", error: new Error(message) });
  }


  exitCompositor(surfaceId: string, message = "fake Bot Screen compositor exited"): void {
    this.#compositorExited();
    this.#finish(surfaceId, { type: "compositor-exited", error: new Error(message) });
  }

  /** The fake Bot Screens share one compositor, so all of them exit together. */
  exitSharedCompositor(message = "fake shared compositor exited"): void {
    this.#compositorExited();
    for (const surfaceId of [...this.#runtimes.keys()]) {
      this.#finish(surfaceId, { type: "compositor-exited", error: new Error(message) });
    }
  }

  /** A new compositor means a new generation for every Screen attached to it. */
  #compositorExited(): void {
    this.#generation += 1;
  }

  #record(surfaceId: string): FakeRuntimeRecord {
    const record = this.#runtimes.get(surfaceId);
    if (record === undefined) throw new Error("fake Bot Screen is not running");
    return record;
  }

  #finish(surfaceId: string, outcome: BotScreenRuntimeOutcome): void {
    this.#record(surfaceId).finish(outcome);
  }

  /**
   * Waits while a stalled capture keeps its child alive. A signal that landed
   * before this child's abort hook was installed still ends the child, matching
   * the real adapter's kill hook. Without a signal the child never ends.
   */
  async #stallCapture(surfaceId: string, signal: AbortSignal | undefined): Promise<void> {
    const ended = Promise.withResolvers<never>();
    let killed = false;
    const abort = (): void => {
      if (killed) return;
      killed = true;
      this.#abortedCaptures.set(surfaceId, (this.#abortedCaptures.get(surfaceId) ?? 0) + 1);
      ended.reject(signal?.reason instanceof Error ? signal.reason : new Error("fake Bot Screen capture was aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    try {
      await ended.promise;
    } catch (error) {
      // A killed child still runs its teardown before it is gone.
      await this.#captureTeardown();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  /** The time a real adapter spends ending a capture child before it exits. */
  async #captureTeardown(): Promise<void> {
    this.#captureTeardownStarted.resolve();
    await this.#captureTeardownGate;
  }

  /**
   * Runs one capture. Its child exists from the first statement, so the live
   * count a later capture records is the count that was still running, and the
   * child is only reaped once this capture is about to settle.
   */
  async #capture(surfaceId: string, signal: AbortSignal | undefined): Promise<BotScreenCapture> {
    const unavailable = this.#unavailableCaptures.get(surfaceId);
    if (unavailable !== undefined) throw new BotScreenUnavailableError(unavailable);
    if (this.#captureFailures.delete(surfaceId)) throw new Error("fake Bot Screen capture failed");
    const live = this.#spawnCaptureChild(surfaceId);
    try {
      // The child exists before the capture installs its abort listener, so an
      // abort landing here must still end it.
      this.#captureSpawnHook?.(surfaceId, signal);
      const count = this.captureStarts(surfaceId) + 1;
      this.#captureStarts.set(surfaceId, count);
      const blocked = surfaceId === this.#blockedCaptureSurface && count === 1;
      const stalls = this.#stalledCaptures.get(surfaceId) ?? 0;
      if (stalls > 0) this.#stalledCaptures.set(surfaceId, stalls - 1);
      if (blocked) {
        this.#blockedCaptureStarted.resolve();
        await this.#blockedCaptureRelease.promise;
      }
      if (stalls > 0) await this.#stallCapture(surfaceId, signal);
      signal?.throwIfAborted();
      return { mediaType: "image/png", bytes: FAKE_SCREEN_PNG };
    } finally {
      this.#liveCaptureChildren.set(surfaceId, live - 1);
    }
  }

  #spawnCaptureChild(surfaceId: string): number {
    const live = this.liveCaptureChildren(surfaceId) + 1;
    const starts = this.#captureStartLiveChildren.get(surfaceId) ?? [];
    starts.push(live - 1);
    this.#captureStartLiveChildren.set(surfaceId, starts);
    this.#liveCaptureChildren.set(surfaceId, live);
    this.#maxCapturesInFlight.set(
      surfaceId,
      Math.max(live, this.#maxCapturesInFlight.get(surfaceId) ?? 0),
    );
    return live;
  }

  #countAction(): void {
    this.#actionsStarted += 1;
    for (const waiter of this.#actionWaiters.splice(0)) {
      if (this.#actionsStarted >= waiter.count) waiter.resolve();
      else this.#actionWaiters.push(waiter);
    }
  }

  async #gateAction(): Promise<void> {
    if (this.#blockActions) await this.#actionGate.promise;
  }

  rejectReconciliation(surfaceId: string): void {
    this.#unreconciled.add(surfaceId);
  }


  async reconcile(provision: BotScreenProvision): Promise<BotScreenRuntime | undefined> {
    const record = this.#runtimes.get(provision.surfaceId);
    if (record === undefined || record.runtime.generation !== this.#generation) return undefined;
    if (!this.#unreconciled.delete(provision.surfaceId)) return record.runtime;
    await record.runtime.stop();
    return undefined;
  }

  async destroy(surfaceId: SurfaceId): Promise<void> {
    await this.#runtimes.get(surfaceId)?.runtime.stop();
    this.destroyed.add(surfaceId);
  }

  async start(provision: BotScreenProvision): Promise<BotScreenRuntime> {
    this.#startAttempts += 1;
    for (const waiter of this.#startAttemptWaiters.splice(0)) {
      if (this.#startAttempts >= waiter.count) waiter.resolve();
      else this.#startAttemptWaiters.push(waiter);
    }
    if (this.#blockStarts) await this.#startGate.promise;
    await Promise.resolve();
    const failure = this.#startFailures.get(provision.surfaceId) ?? this.failure;
    if (failure !== undefined) throw new Error(failure);
    this.starts.push(provision);
    this.#generation ||= 1;
    const generation = this.#generation;
    let stopped = false;
    let controllerEpoch: number | undefined;
    let highestControllerEpoch = 0;
    let lastInputSequence = 0;
    let actionCount = 0;
    let browserSnapshot = 0;
    const videoWidth = Math.round(provision.logicalWidth * provision.scale);
    const videoHeight = Math.round(provision.logicalHeight * provision.scale);
    const rawFrame = Buffer.alloc(videoWidth * videoHeight * 4);
    const outcome = Promise.withResolvers<BotScreenRuntimeOutcome>();
    let record!: FakeRuntimeRecord;
    const captureStreams = new Set<BotScreenCaptureStream>();
    const expandedViews = new Set<BotScreenExpandedView>();
    const runtime: BotScreenRuntime = {
      generation,
      sessionEnv: {},
      expandedProjection: "rfb",
      readiness: {
        compositor: "ready",
        waylandSocket: "private",
        output: {
          geometryGeneration: provision.geometryGeneration,
          logicalWidth: provision.logicalWidth,
          logicalHeight: provision.logicalHeight,
          scale: provision.scale,
          refreshRate: provision.refreshRate,
        },
        desktopSurface: "ready",
        capture: "ready",
        input: "ready",
      },
      capture: (signal?: AbortSignal): Promise<BotScreenCapture> => {
        if (stopped) return Promise.reject(new Error("fake Bot Screen is stopped"));
        return this.#capture(provision.surfaceId, signal);
      },
      openCaptureStream: async (): Promise<BotScreenCaptureStream> => {
        if (stopped) throw new Error("fake Bot Screen is stopped");
        this.captureStreamsOpened += 1;
        let closed = false;
        const stream: BotScreenCaptureStream = {
          next: async () => {
            if (closed || stopped) throw new Error("fake Bot Screen capture stream is closed");
            this.captureRequestsInFlight += 1;
            this.maximumCaptureRequestsInFlight = Math.max(
              this.maximumCaptureRequestsInFlight,
              this.captureRequestsInFlight,
            );
            try {
              await Promise.resolve();
              if (this.#captureStreamFailures.delete(provision.surfaceId)) {
                throw new Error("fake Bot Screen capture stream failed");
              }
              return {
                pixelFormat: "rgba",
                width: videoWidth,
                height: videoHeight,
                bytes: rawFrame,
                capturedAt: new Date(),
              };
            } finally {
              this.captureRequestsInFlight -= 1;
            }
          },
          close: async () => {
            if (closed) return;
            closed = true;
            captureStreams.delete(stream);
            this.captureStreamsClosed += 1;
            for (const waiter of this.#captureStreamCloseWaiters.splice(0)) {
              if (this.captureStreamsClosed >= waiter.count) waiter.resolve();
              else this.#captureStreamCloseWaiters.push(waiter);
            }
          },
        };
        captureStreams.add(stream);
        return stream;
      },
      acquireExpandedView: async (): Promise<BotScreenExpandedView> => {
        if (stopped) throw new Error("fake Bot Screen is stopped");
        this.expandedViewsAcquired += 1;
        const inbound: Uint8Array[] = [FAKE_RFB_BANNER];
        const waiters: Array<{ resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }> = [];
        let closed = false;
        const view: BotScreenExpandedView = {
          send: async (bytes) => {
            if (closed || stopped) throw new Error("fake Bot Screen expanded view is closed");
            const copy = bytes.slice();
            const waiter = waiters.shift();
            if (waiter !== undefined) waiter.resolve(copy);
            else inbound.push(copy);
          },
          receive: async () => {
            if (closed || stopped) throw new Error("fake Bot Screen expanded view is closed");
            const queued = inbound.shift();
            if (queued !== undefined) return queued;
            const waiter = Promise.withResolvers<Uint8Array>();
            waiters.push(waiter);
            return waiter.promise;
          },
          close: async () => {
            if (closed) return;
            closed = true;
            expandedViews.delete(view);
            this.expandedViewsReleased += 1;
            const error = new Error("fake Bot Screen expanded view is closed");
            for (const waiter of waiters.splice(0)) waiter.reject(error);
          },
        };
        expandedViews.add(view);
        return view;
      },
      listWindows: async () => {
        if (stopped) throw new Error("fake Bot Screen is stopped");
        this.#countAction();
        await this.#gateAction();
        return (this.#windows.get(provision.surfaceId) ?? []).map((window) => ({ ...window }));
      },
      focusWindow: async (window) => {
        if (stopped) throw new Error("fake Bot Screen is stopped");
        this.#countAction();
        await this.#gateAction();
        const windows = this.#windows.get(provision.surfaceId);
        const target = windows?.find((candidate) => candidate.id === window.id);
        if (target === undefined) throw new Error("fake Bot Screen does not route that window");
        this.focusRequests.push(window.id);
        this.#windows.set(
          provision.surfaceId,
          windows!.map((candidate) => ({ ...candidate, focused: candidate.id === window.id })),
        );
      },
      launch: async (request) => {
        if (stopped) throw new Error("fake Bot Screen is stopped");
        this.#countAction();
        await this.#gateAction();
        if (this.options.actionFailureAt === this.#actionsStarted) {
          throw new Error("fake application launch failed");
        }
        return { text: `fake-open#${this.#actionsStarted}:${request.app ?? request.url ?? ""}` };
      },
      browser: async (action, input, signal) => {
        signal.throwIfAborted();
        if (stopped) throw new Error("fake Bot Screen is stopped");
        if (action.name === "request_takeover") return { text: "Browser is available for Takeover" };
        this.#countAction();
        this.browserActions.push({ surfaceId: provision.surfaceId, action });
        await this.#gateAction();
        if (this.browserDelayMs > 0) await Bun.sleep(this.browserDelayMs);
        signal.throwIfAborted();
        if (action.name === "snapshot") {
          browserSnapshot += 1;
          return { text: `[e1-${browserSnapshot}] textbox Name\n[e2-${browserSnapshot}] button Submit` };
        }
        if (["click", "type", "select"].includes(action.name)) {
          const ref = action.args.ref;
          if (ref !== `e1-${browserSnapshot}` && ref !== `e2-${browserSnapshot}`) {
            throw new Error(`Stale Element Ref ${String(ref)}; take a new snapshot before acting.`);
          }
          await input({ name: "click", args: { x: 100, y: 100 } });
          if (action.name === "type") await input({ name: "type", args: { text: action.args.text } });
        }
        return { text: `fake-browser:${action.name}` };
      },
      setInputAuthority: async (epoch): Promise<number> => {
        if (!Number.isSafeInteger(epoch) || epoch <= highestControllerEpoch) {
          throw new BotScreenInputRejectedError("fake Bot Screen rejected stale input authority");
        }
        controllerEpoch = epoch;
        highestControllerEpoch = epoch;
        lastInputSequence = 0;
        return epoch;
      },
      input: async (event): Promise<void> => {
        this.#inputAttempts += 1;
        for (const waiter of this.#inputAttemptWaiters.splice(0)) {
          if (this.#inputAttempts >= waiter.count) waiter.resolve();
          else this.#inputAttemptWaiters.push(waiter);
        }
        if (
          event.surfaceId !== provision.surfaceId
          || event.runtimeGeneration !== generation
          || event.geometryGeneration !== provision.geometryGeneration
          || event.controllerEpoch !== controllerEpoch
          || !Number.isSafeInteger(event.sequence)
          || event.sequence <= lastInputSequence
        ) {
          throw new BotScreenInputRejectedError("fake Bot Screen rejected the input envelope");
        }
        if (this.options.inputFailureAt === this.#inputAttempts) {
          throw new Error("fake Bot Screen input helper failed");
        }
        this.#inputsInFlight += 1;
        this.#inputSurfacesInFlight.add(provision.surfaceId);
        this.maximumInputsInFlight = Math.max(this.maximumInputsInFlight, this.#inputsInFlight);
        this.maximumInputSurfacesInFlight = Math.max(
          this.maximumInputSurfacesInFlight,
          this.#inputSurfacesInFlight.size,
        );
        try {
          if (this.#blockInputs) await this.#inputGate.promise;
          if (stopped) throw new Error("fake Bot Screen is stopped");
          lastInputSequence = event.sequence;
          if (this.options.pointerDelayMs !== undefined && event.type === "motion") {
            await Bun.sleep(this.options.pointerDelayMs);
          }
          const recorded = {
            surfaceId: provision.surfaceId,
            runtimeGeneration: generation,
            event,
          };
          this.inputEvents.push(recorded);
          for (const waiter of this.#inputWaiters.splice(0)) {
            if (this.inputEvents.length >= waiter.count) waiter.resolve();
            else this.#inputWaiters.push(waiter);
          }
          if (event.type === "key" || event.type === "paste") return;
          this.pointerEvents.push({
            surfaceId: provision.surfaceId,
            runtimeGeneration: generation,
            event,
          });
          for (const waiter of this.#pointerWaiters.splice(0)) {
            if (this.pointerEvents.length >= waiter.count) waiter.resolve();
            else this.#pointerWaiters.push(waiter);
          }
          for (const waiter of this.#pointerEventWaiters.splice(0)) {
            if (waiter.predicate(this.pointerEvents.at(-1)!)) waiter.resolve();
            else this.#pointerEventWaiters.push(waiter);
          }
        } finally {
          this.#inputsInFlight -= 1;
          this.#inputSurfacesInFlight.delete(provision.surfaceId);
        }
      },
      releaseInput: async (epoch): Promise<void> => {
        if (stopped) return;
        if (this.#releaseFailures.delete(provision.surfaceId)) {
          throw new Error("fake Bot Screen input release failed");
        }
        if (epoch !== undefined && epoch !== controllerEpoch) {
          throw new BotScreenInputRejectedError("fake Bot Screen rejected stale input authority release");
        }
        controllerEpoch = undefined;
        lastInputSequence = 0;
        if (this.options.releaseDelayMs !== undefined) await Bun.sleep(this.options.releaseDelayMs);
        this.releaseCount += 1;
        for (const waiter of this.#releaseWaiters.splice(0)) {
          if (this.releaseCount >= waiter.count) waiter.resolve();
          else this.#releaseWaiters.push(waiter);
        }
      },
      outcome: outcome.promise,
      stop: async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        this.stops.push({ surfaceId: provision.surfaceId, runtimeGeneration: generation });
        await Promise.allSettled([...captureStreams].map((stream) => stream.close()));
        await Promise.allSettled([...expandedViews].map((view) => view.close()));
        if (this.#runtimes.get(provision.surfaceId) === record) this.#runtimes.delete(provision.surfaceId);
      },
    };
    record = { runtime, finish: outcome.resolve };
    this.#runtimes.set(provision.surfaceId, record);
    return runtime;
  }
}
