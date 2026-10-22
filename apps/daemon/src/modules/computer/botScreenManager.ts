import type { Database } from "bun:sqlite";
import type { ComputerAction, SurfaceId } from "@omarchy-bot/domain";
import type { AgentComputerToolOutput, ComputerInputAuthority } from "@omarchy-bot/agent-contract";
import type { ComputerSurfaceOwner } from "./broker.ts";

export type BotScreenLifecycleState = "stopped" | "starting" | "ready" | "failed";

export interface BotScreenCapture {
  mediaType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

/** A lossless RGBA source frame timestamped when capture completed. */
export interface BotScreenCaptureFrame {
  pixelFormat: "rgba";
  width: number;
  height: number;
  bytes: Uint8Array;
  capturedAt: Date;
}

/** Pull-based stream with one in-flight capture and no stale frame queue. */
export interface BotScreenCaptureStream {
  next(): Promise<BotScreenCaptureFrame>;
  close(): Promise<void>;
}

/** Opaque expanded-view lease. Bidirectional protocol bytes; no input authority. */
export interface BotScreenExpandedView {
  send(bytes: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BotScreenActionResult {
  text?: string;
  image?: BotScreenCapture;
  windowList?: unknown;
}

/** Manager-authored identity captured inside the same serialized action as its result. */
export interface BotScreenBoundActionResult extends BotScreenActionResult {
  desktopSession: AgentComputerToolOutput["desktopSession"];
}

export type BotScreenInputContext = Readonly<{
  surfaceId: SurfaceId;
  runtimeGeneration: number;
  geometryGeneration: number;
  controllerEpoch: number;
  sequence: number;
}>;

export type BotScreenInputAction =
  | { type: "motion"; x: number; y: number }
  | { type: "button"; x: number; y: number; button: "left" | "middle" | "right"; state: "pressed" | "released" }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; keyCode: number; state: "pressed" | "released" }
  | { type: "paste"; text: string };

export type BotScreenInputEvent = BotScreenInputContext & BotScreenInputAction;

export class BotScreenInputRejectedError extends Error {
  constructor(message = "Bot Screen input was rejected") {
    super(message);
    this.name = "BotScreenInputRejectedError";
  }
}



export interface BotScreenProvision {
  surfaceId: SurfaceId;
  generation: number;
  geometryGeneration: number;
  logicalWidth: number;
  logicalHeight: number;
  scale: number;
  refreshRate: number;
}
/**
 * Evidence returned only after every component required for a usable Bot Screen
 * is ready. It deliberately exposes no socket name, process identifier, command,
 * or compositor choice.
 */
export interface BotScreenRuntimeReadiness {
  compositor: "ready";
  waylandSocket: "private";
  output: {
    geometryGeneration: number;
    logicalWidth: number;
    logicalHeight: number;
    scale: number;
    refreshRate: number;
  };
  desktopSurface: "ready";
  capture: "ready";
  input: "ready";
  computerWorker: "ready";
}

export type BotScreenRuntimeOutcome =
  | { type: "compositor-exited"; error: Error }
  | { type: "session-bus-exited"; error: Error }
  | { type: "desktop-exited"; error: Error }
  | { type: "input-helper-exited"; error: Error }
  | { type: "computer-worker-exited"; error: Error };


export interface BotScreenProjectionSource {
  surfaceId: SurfaceId;
  runtimeGeneration: number;
  geometryGeneration: number;
  logicalWidth: number;
  logicalHeight: number;
  videoWidth: number;
  videoHeight: number;
  scale: number;
  /** Present only when the runtime opts into RFB expanded viewing. */
  expandedProjection?: "rfb";
  capture(): Promise<BotScreenCapture>;
  openCaptureStream(): Promise<BotScreenCaptureStream>;
  acquireExpandedView(): Promise<BotScreenExpandedView>;
  setInputAuthority(controllerEpoch: number): Promise<number>;
  input(event: BotScreenInputEvent): Promise<void>;
  releaseInput(controllerEpoch?: number): Promise<void>;
}

/**
 * Internal platform seam. A runtime is returned only after its readiness
 * evidence is complete; process trees, sockets, and compositor commands remain
 * private to the adapter.
 */
export interface BotScreenRuntime {
  readonly readiness: BotScreenRuntimeReadiness;
  readonly expandedProjection?: "rfb";
  capture(): Promise<BotScreenCapture>;
  openCaptureStream(): Promise<BotScreenCaptureStream>;
  acquireExpandedView(): Promise<BotScreenExpandedView>;
  act(action: ComputerAction, inputAuthority?: ComputerInputAuthority): Promise<BotScreenActionResult>;
  setInputAuthority(controllerEpoch: number): Promise<number>;
  input(event: BotScreenInputEvent): Promise<void>;
  releaseInput(controllerEpoch?: number): Promise<void>;
  /** Resolves only for an unexpected component exit; deliberate stops are ignored by the manager. */
  outcome: Promise<BotScreenRuntimeOutcome>;
  stop(): Promise<void>;
}

export interface BotScreenRuntimeAdapter {
  start(provision: BotScreenProvision): Promise<BotScreenRuntime>;
  /** Returns a still-valid supervised runtime after daemon restart, when reconnectable. */
  reconcile?(provision: BotScreenProvision): Promise<BotScreenRuntime | undefined>;
  /** Removes retained runtime/profile resources for permanent Bot deletion. */
  destroy?(surfaceId: SurfaceId): Promise<void>;
}

export interface BotScreenLifecycle {
  state: BotScreenLifecycleState;
  failure?: string;
  admission?: {
    reason: "capacity";
    active: number;
    limit: number;
  };
}

export interface BotScreenManagerOptions {
  capacity: number;
  logicalWidth: number;
  logicalHeight: number;
}

interface SurfaceRow {
  lifecycle_state: BotScreenLifecycleState;
  runtime_generation: number;
  logical_width: number;
  logical_height: number;
  scale: number;
  refresh_rate: number;
  last_failure: string | null;
}

interface RuntimeEntry {
  start: Promise<BotScreenRuntime>;
  provision: BotScreenProvision;
  runtime?: BotScreenRuntime;
}

interface RecoveryRow extends SurfaceRow {
  surface_id: SurfaceId;
  bot_id: string;
}

export interface BotScreenTransition {
  surfaceId: SurfaceId;
  state: BotScreenLifecycleState;
  runtimeGeneration: number;
  failure?: string;
}

export type BotScreenTransitionListener = (transition: BotScreenTransition) => void;

/**
 * Deep Bot-owned lifecycle module. Callers can inspect, open, capture, and destroy a Screen;
 * process trees, sockets, runtime directories, output setup, and child env stay
 * inside the runtime adapter.
 */
export class BotScreenManager {
  #entries = new Map<SurfaceId, RuntimeEntry>();
  #stops = new Map<SurfaceId, Promise<void>>();
  #cleanupRuntimes = new Map<SurfaceId, BotScreenRuntime>();
  #operations = new Map<SurfaceId, Promise<void>>();
  #listeners = new Set<BotScreenTransitionListener>();

  constructor(
    private readonly db: Database,
    private readonly adapter: BotScreenRuntimeAdapter,
    private readonly options: BotScreenManagerOptions,
  ) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Bot Screen capacity must be a positive integer");
    }
  }

  subscribe(listener: BotScreenTransitionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Reconciles Screens which were active, or still cleaning up a failure, when
   * the daemon stopped. An adapter may reconnect a complete supervised tree;
   * otherwise the manager removes stale runtime facts and advances active
   * Screens to a fresh generation.
   */
  async recover(): Promise<void> {
    const rows = this.db
      .query(
        `SELECT surface_id, bot_id, lifecycle_state, runtime_generation,
                logical_width, logical_height, scale, refresh_rate, last_failure
         FROM bot_surfaces
         WHERE lifecycle_state IN ('starting', 'ready', 'failed')
         ORDER BY transitioned_at, surface_id`,
      )
      .all() as RecoveryRow[];

    for (const row of rows) {
      await this.#serialize(row.surface_id, async () => {
        const provision = this.#provision(row.surface_id, row.runtime_generation, row);
        const runtime = await this.adapter.reconcile?.(provision).catch(() => undefined);
        if (row.lifecycle_state === "failed") {
          await runtime?.releaseInput().catch(() => {});
          await runtime?.stop().catch(() => {});
          this.#transition(row.surface_id, "failed", row.last_failure);
          return;
        }
        if (this.#reservedCapacity() >= this.options.capacity) {
          await runtime?.releaseInput().catch(() => {});
          await runtime?.stop().catch(() => {});
          this.#transition(row.surface_id, "stopped", null);
          return;
        }
        if (runtime !== undefined) {
          this.#install(row.surface_id, provision, Promise.resolve(runtime), runtime);
          return;
        }
        this.#transition(row.surface_id, "stopped", null);
        await this.#start({ botId: row.bot_id, surfaceId: row.surface_id }, this.#row(row.surface_id));
      });
    }
  }

  open(owner: ComputerSurfaceOwner): BotScreenLifecycle {
    if (this.#stops.has(owner.surfaceId)) return { state: "stopped" };
    let row = this.#row(owner.surfaceId);
    const entry = this.#entries.get(owner.surfaceId);

    if ((row.lifecycle_state === "ready" || row.lifecycle_state === "starting") && entry === undefined) {
      this.#transition(owner.surfaceId, "stopped", null);
      row = this.#row(owner.surfaceId);
    }
    if (row.lifecycle_state !== "stopped" && row.lifecycle_state !== "failed") return this.#lifecycle(row);
    const active = this.#reservedCapacity();
    const ownerReservation = this.#cleanupRuntimes.has(owner.surfaceId) ? 1 : 0;
    if (active - ownerReservation >= this.options.capacity) {
      return {
        state: row.lifecycle_state,
        admission: { reason: "capacity", active, limit: this.options.capacity },
      };
    }

    void this.#start(owner, row);
    return { state: "starting" };
  }

  status(owner: ComputerSurfaceOwner): BotScreenLifecycle {
    const lifecycle = this.#lifecycle(this.#row(owner.surfaceId));
    if (lifecycle.state !== "stopped" || this.#stops.has(owner.surfaceId)) return lifecycle;
    const active = this.#reservedCapacity();
    return active < this.options.capacity
      ? lifecycle
      : {
          state: "stopped",
          admission: { reason: "capacity", active, limit: this.options.capacity },
        };
  }

  async capture(owner: ComputerSurfaceOwner): Promise<BotScreenCapture | undefined> {
    return this.#serialize(owner.surfaceId, async () => {
      const runtime = await this.#readyRuntime(owner);
      const entry = this.#entries.get(owner.surfaceId);
      if (runtime === undefined || entry?.runtime !== runtime) return undefined;
      return this.#invoke(owner.surfaceId, entry, () => runtime.capture());
    });
  }

  async projectionSource(owner: ComputerSurfaceOwner): Promise<BotScreenProjectionSource | undefined> {
    return this.#serialize(owner.surfaceId, async () => {
      const runtime = await this.#readyRuntime(owner);
      const entry = this.#entries.get(owner.surfaceId);
      if (runtime === undefined || entry?.runtime !== runtime) return undefined;
      const { geometryGeneration, logicalWidth, logicalHeight, scale } = runtime.readiness.output;
      const generation = this.#row(owner.surfaceId).runtime_generation;
      const currentEntry = (): RuntimeEntry => {
        const row = this.#row(owner.surfaceId);
        if (
          row.lifecycle_state !== "ready"
          || row.runtime_generation !== generation
          || this.#entries.get(owner.surfaceId) !== entry
          || entry.runtime !== runtime
        ) {
          throw new Error("Screen Projection source is stale");
        }
        return entry;
      };
      return {
        surfaceId: owner.surfaceId,
        runtimeGeneration: generation,
        geometryGeneration,
        logicalWidth,
        logicalHeight,
        videoWidth: Math.round(logicalWidth * scale),
        videoHeight: Math.round(logicalHeight * scale),
        scale,
        ...(runtime.expandedProjection === undefined ? {} : { expandedProjection: runtime.expandedProjection }),
        capture: () =>
          this.#serialize(owner.surfaceId, async () => {
            currentEntry();
            return runtime.capture();
          }),
        openCaptureStream: async () => {
          currentEntry();
          const captureStream = await runtime.openCaptureStream();
          let closed = false;
          try {
            currentEntry();
          } catch (error) {
            await captureStream.close().catch(() => {});
            throw error;
          }
          return {
            next: async () => {
              if (closed) throw new Error("Screen Projection capture stream is closed");
              try {
                currentEntry();
                const frame = await captureStream.next();
                currentEntry();
                return frame;
              } catch (error) {
                closed = true;
                await captureStream.close().catch(() => {});
                throw error;
              }
            },
            close: async () => {
              if (closed) return;
              closed = true;
              await captureStream.close();
            },
          };
        },
        acquireExpandedView: async () => {
          currentEntry();
          const expandedView = await runtime.acquireExpandedView();
          let closed = false;
          try {
            currentEntry();
          } catch (error) {
            await expandedView.close().catch(() => {});
            throw error;
          }
          return {
            send: async (bytes) => {
              if (closed) throw new Error("Screen Projection expanded view is closed");
              currentEntry();
              await expandedView.send(bytes);
              currentEntry();
            },
            receive: async () => {
              if (closed) throw new Error("Screen Projection expanded view is closed");
              try {
                currentEntry();
                const bytes = await expandedView.receive();
                currentEntry();
                return bytes;
              } catch (error) {
                closed = true;
                await expandedView.close().catch(() => {});
                throw error;
              }
            },
            close: async () => {
              if (closed) return;
              closed = true;
              await expandedView.close();
            },
          };
        },
        setInputAuthority: (controllerEpoch) =>
          this.#serialize(owner.surfaceId, () =>
            this.#invoke(owner.surfaceId, currentEntry(), () => runtime.setInputAuthority(controllerEpoch))
          ),
        input: (event) =>
          this.#serialize(owner.surfaceId, () =>
            this.#invoke(owner.surfaceId, currentEntry(), () => runtime.input(event))
          ),
        releaseInput: (controllerEpoch) =>
          this.#serialize(owner.surfaceId, async () => {
            currentEntry();
            await runtime.releaseInput(controllerEpoch);
          }),
      };
    });
  }

  async act(
    owner: ComputerSurfaceOwner,
    action: ComputerAction,
    inputAuthority?: ComputerInputAuthority,
  ): Promise<BotScreenBoundActionResult> {
    if (inputAuthority !== undefined && inputAuthority.surfaceId !== owner.surfaceId) {
      throw new Error("input authority does not belong to this Computer Surface");
    }
    const prepared = await this.#serialize(owner.surfaceId, async () => {
      const runtime = await this.#readyRuntime(owner);
      const entry = this.#entries.get(owner.surfaceId);
      if (runtime === undefined || entry?.runtime !== runtime) {
        throw new Error(this.status(owner).failure ?? "Bot Screen is unavailable");
      }
      return { runtime, entry, runtimeGeneration: this.#row(owner.surfaceId).runtime_generation };
    });
    const result = await prepared.runtime.act(action, inputAuthority);
    return this.#serialize(owner.surfaceId, async () => {
      if (this.#entries.get(owner.surfaceId) !== prepared.entry || prepared.entry.runtime !== prepared.runtime) {
        throw new Error(this.status(owner).failure ?? "Bot Screen is unavailable");
      }
      return {
        ...result,
        desktopSession: { botId: owner.botId, surfaceId: owner.surfaceId, runtimeGeneration: prepared.runtimeGeneration },
      };
    });
  }

  async ensureReady(owner: ComputerSurfaceOwner): Promise<boolean> {
    return (await this.#readyRuntime(owner)) !== undefined;
  }
  async destroy(surfaceId: SurfaceId): Promise<void> {
    await this.#stop(surfaceId);
    try {
      await this.adapter.destroy?.(surfaceId);
    } catch (error) {
      if (this.#exists(surfaceId)) this.#transition(surfaceId, "failed", this.#failure(error));
      throw error;
    }
  }
  async shutdown(): Promise<void> {
    const surfaceIds = new Set([
      ...this.#entries.keys(),
      ...this.#cleanupRuntimes.keys(),
      ...this.#stops.keys(),
      ...this.#operations.keys(),
    ]);
    await Promise.all([...surfaceIds].map((surfaceId) => this.#stop(surfaceId)));
  }

  /** Leaves supervised runtime trees alive for a replacement daemon to reconcile. */
  detach(): void {
    this.#entries.clear();
    this.#cleanupRuntimes.clear();
    this.#stops.clear();
    this.#operations.clear();
  }

  async #start(owner: ComputerSurfaceOwner, existingRow: SurfaceRow): Promise<void> {
    if (this.#entries.has(owner.surfaceId)) return;
    const row = existingRow.runtime_generation === 0
      ? {
          ...existingRow,
          logical_width: this.options.logicalWidth,
          logical_height: this.options.logicalHeight,
        }
      : existingRow;
    const generation = row.runtime_generation + 1;
    this.db
      .query(
        `UPDATE bot_surfaces
         SET runtime_generation = ?, logical_width = ?, logical_height = ?
         WHERE surface_id = ?`,
      )
      .run(generation, row.logical_width, row.logical_height, owner.surfaceId);
    const provision = this.#provision(owner.surfaceId, generation, row);
    const cleanupRuntime = this.#cleanupRuntimes.get(owner.surfaceId);
    const start = Promise.resolve().then(async () => {
      if (cleanupRuntime !== undefined) {
        await cleanupRuntime.releaseInput().catch(() => {});
        await cleanupRuntime.stop();
        if (this.#cleanupRuntimes.get(owner.surfaceId) === cleanupRuntime) {
          this.#cleanupRuntimes.delete(owner.surfaceId);
        }
      }
      return this.adapter.start(provision);
    });
    const entry: RuntimeEntry = { provision, start };
    this.#entries.set(owner.surfaceId, entry);
    this.#transition(owner.surfaceId, "starting", null);
    try {
      const runtime = await start;
      if (this.#entries.get(owner.surfaceId) !== entry) {
        await runtime.releaseInput().catch(() => {});
        await runtime.stop();
        return;
      }
      this.#install(owner.surfaceId, provision, start, runtime);
    } catch (error) {
      if (this.#entries.get(owner.surfaceId) !== entry) return;
      this.#entries.delete(owner.surfaceId);
      this.#transition(owner.surfaceId, "failed", this.#failure(error));
    }
  }

  #install(
    surfaceId: SurfaceId,
    provision: BotScreenProvision,
    start: Promise<BotScreenRuntime>,
    runtime: BotScreenRuntime,
  ): void {
    const entry: RuntimeEntry = { provision, start, runtime };
    this.#entries.set(surfaceId, entry);
    this.#transition(surfaceId, "ready", null);
    void runtime.outcome.then((outcome) =>
      this.#failRuntime(surfaceId, entry, this.#outcomeFailure(outcome))
    );
  }

  async #stop(surfaceId: SurfaceId): Promise<void> {
    const activeStop = this.#stops.get(surfaceId);
    if (activeStop !== undefined) return activeStop;
    const operation = this.#serialize(surfaceId, () => this.#stopSurface(surfaceId));
    this.#stops.set(surfaceId, operation);
    try {
      await operation;
    } finally {
      if (this.#stops.get(surfaceId) === operation) this.#stops.delete(surfaceId);
    }
  }

  async #stopSurface(surfaceId: SurfaceId): Promise<void> {
    const entry = this.#entries.get(surfaceId);
    this.#entries.delete(surfaceId);
    const activeRuntime = entry === undefined
      ? undefined
      : entry.runtime ?? await entry.start.catch(() => undefined);
    const cleanupRuntime = this.#cleanupRuntimes.get(surfaceId);
    try {
      for (const runtime of new Set([activeRuntime, cleanupRuntime])) {
        if (runtime === undefined) continue;
        await runtime.releaseInput().catch(() => {});
        await runtime.stop();
      }
      this.#cleanupRuntimes.delete(surfaceId);
      if (this.#exists(surfaceId)) this.#transition(surfaceId, "stopped", null);
    } catch (error) {
      const runtime = cleanupRuntime ?? activeRuntime;
      if (runtime !== undefined) this.#cleanupRuntimes.set(surfaceId, runtime);
      if (this.#exists(surfaceId)) this.#transition(surfaceId, "failed", this.#failure(error));
      throw error;
    }
  }

  async #readyRuntime(owner: ComputerSurfaceOwner): Promise<BotScreenRuntime | undefined> {
    const lifecycle = this.open(owner);
    if (lifecycle.state === "failed" || lifecycle.state === "stopped") return undefined;
    const entry = this.#entries.get(owner.surfaceId);
    if (entry === undefined) return undefined;
    await entry.start.catch(() => undefined);
    return this.#entries.get(owner.surfaceId)?.runtime;
  }

  async #invoke<T>(surfaceId: SurfaceId, entry: RuntimeEntry, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof BotScreenInputRejectedError) && this.#entries.get(surfaceId) === entry) {
        await this.#failRuntime(surfaceId, entry, error);
      }
      throw error;
    }
  }

  async #failRuntime(surfaceId: SurfaceId, entry: RuntimeEntry, error: unknown): Promise<void> {
    if (this.#entries.get(surfaceId) !== entry) return;
    this.#entries.delete(surfaceId);
    if (this.#exists(surfaceId)) this.#transition(surfaceId, "failed", this.#failure(error));
    const runtime = entry.runtime ?? await entry.start.catch(() => undefined);
    if (runtime === undefined) return;
    this.#cleanupRuntimes.set(surfaceId, runtime);
    await runtime.releaseInput().catch(() => {});
    try {
      await runtime.stop();
      if (this.#cleanupRuntimes.get(surfaceId) === runtime) this.#cleanupRuntimes.delete(surfaceId);
    } catch {
      // stop()/destroy() will retry this retained failed-runtime handle.
    }
  }


  #provision(surfaceId: SurfaceId, generation: number, row: SurfaceRow): BotScreenProvision {
    return {
      surfaceId,
      generation,
      geometryGeneration: 1,
      logicalWidth: row.logical_width,
      logicalHeight: row.logical_height,
      scale: row.scale,
      refreshRate: row.refresh_rate,
    };
  }

  #row(surfaceId: SurfaceId): SurfaceRow {
    const row = this.db
      .query(
        `SELECT lifecycle_state, runtime_generation, logical_width, logical_height, scale, refresh_rate, last_failure
         FROM bot_surfaces WHERE surface_id = ?`,
      )
      .get(surfaceId) as SurfaceRow | null;
    if (row === null) throw new Error("unknown Computer Surface");
    return row;
  }

  #exists(surfaceId: SurfaceId): boolean {
    return this.db.query(`SELECT 1 FROM bot_surfaces WHERE surface_id = ?`).get(surfaceId) !== null;
  }

  #transition(surfaceId: SurfaceId, state: BotScreenLifecycleState, failure: string | null): void {
    this.db
      .query(
        `UPDATE bot_surfaces
         SET lifecycle_state = ?, last_failure = ?, transitioned_at = ?
         WHERE surface_id = ?`,
      )
      .run(state, failure, new Date().toISOString(), surfaceId);
    const runtimeGeneration = this.#row(surfaceId).runtime_generation;
    const transition: BotScreenTransition = {
      surfaceId,
      state,
      runtimeGeneration,
      ...(failure === null ? {} : { failure }),
    };
    for (const listener of this.#listeners) listener(transition);
  }

  #reservedCapacity(): number {
    return new Set([
      ...this.#entries.keys(),
      ...this.#stops.keys(),
      ...this.#cleanupRuntimes.keys(),
    ]).size;
  }

  #lifecycle(row: SurfaceRow): BotScreenLifecycle {
    return {
      state: row.lifecycle_state,
      ...(row.last_failure === null ? {} : { failure: row.last_failure }),
    };
  }

  async #serialize<T>(surfaceId: SurfaceId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(surfaceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#operations.set(surfaceId, settled);
    try {
      return await result;
    } finally {
      if (this.#operations.get(surfaceId) === settled) this.#operations.delete(surfaceId);
    }
  }

  #outcomeFailure(outcome: BotScreenRuntimeOutcome): Error {
    const component = {
      "compositor-exited": "Bot Computer compositor",
      "session-bus-exited": "Bot Computer session bus",
      "desktop-exited": "Bot Desktop",
      "input-helper-exited": "Bot Screen input helper",
      "computer-worker-exited": "Bot Screen computer worker",
    }[outcome.type];
    return new Error(`${component} failed: ${this.#failure(outcome.error)}`);
  }

  #failure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, " ").slice(0, 240) || "Bot Screen could not start";
  }
}
