import type { SurfaceId } from "@omarchy-bot/domain";
import type { BotScreenInputAction } from "./botScreenManager.ts";
import type { ComputerSurfaceOwner } from "./broker.ts";

export type ScreenInputTarget = Readonly<{
  surfaceId: SurfaceId;
  runtimeGeneration: number;
}>;

export type HeldInput = Readonly<{
  keys: ReadonlySet<number>;
  buttons: ReadonlySet<"left" | "middle" | "right">;
}>;

/** Runtime delivery. The lease decides who may type; the adapter only delivers. */
export interface ScreenInputDelivery {
  grant(surfaceId: SurfaceId, epoch: number): Promise<number>;
  deliver(surfaceId: SurfaceId, epoch: number, event: BotScreenInputAction): Promise<void>;
  release(surfaceId: SurfaceId, epoch: number, held: HeldInput): Promise<void>;
  capture(surfaceId: SurfaceId): Promise<unknown>;
}

export type TakeoverState = "unavailable" | "available" | "active";
export type ScreenUse = "idle" | "bot" | "human";

type TakeoverPhase = "running" | "takeover-requested" | "held" | "completing" | "waiting" | "settled";

interface AgentTool {
  turnId: string;
  toolCallId: string;
  phase: TakeoverPhase;
  actionDone: Promise<void>;
  resolveActionDone: () => void;
  activated: Promise<void>;
  resolveActivated: () => void;
}

interface SeatHolder {
  surfaceId: SurfaceId;
  epoch: number;
  kind: "web" | "bot";
  keys: Set<number>;
  buttons: Set<"left" | "middle" | "right">;
}

export interface WebControlGrant {
  readonly epoch: number;
  input(event: BotScreenInputAction): Promise<void>;
  release(): Promise<void>;
}

export interface AgentToolHandle {
  actionFinished(action: Promise<unknown>): Promise<void>;
}

const EMPTY_HELD: HeldInput = { keys: new Set(), buttons: new Set() };

/**
 * Who may type into a Bot Screen, and the one shared input seat.
 * A stale epoch is rejected. Capture never waits. A Bot action on another
 * Screen waits until the seat is free or the Turn signal aborts.
 */
export class ScreenInputLease {
  #epoch = new Map<SurfaceId, number>();
  #tools = new Map<SurfaceId, AgentTool>();
  #holder: SeatHolder | undefined;
  #surfaceTail = new Map<SurfaceId, Promise<void>>();
  #free = Promise.withResolvers<void>();
  #grantStarted = Promise.withResolvers<void>();
  #queued = Promise.withResolvers<void>();
  #held = Promise.withResolvers<void>();
  #waiting = 0;
  #webOwners = new Set<SurfaceId>();

  constructor(private readonly delivery: ScreenInputDelivery) {}
  onWebControl?: (owner: ComputerSurfaceOwner, claimed: boolean) => void;

  /** Test seam: resolves once a cross-Screen waiter is registered. */
  seatQueued(): Promise<void> {
    return this.#queued.promise;
  }

  seatHeld(): Promise<void> {
    return this.#held.promise;
  }

  /** Test seam: resolves once delivery.grant has been entered. */
  grantStarted(): Promise<void> {
    return this.#grantStarted.promise;
  }

  takeover(surfaceId: SurfaceId): TakeoverState {
    const phase = this.#tools.get(surfaceId)?.phase;
    if (phase === "held" || phase === "completing" || phase === "waiting") return "active";
    if (phase === "running" || phase === "takeover-requested") return "available";
    return "unavailable";
  }

  screenUse(surfaceId: SurfaceId): ScreenUse {
    if (this.#webOwners.has(surfaceId)) return "human";
    const phase = this.#tools.get(surfaceId)?.phase;
    if (phase === "held" || phase === "completing") return "human";
    if (phase === "running" || phase === "takeover-requested") return "bot";
    return "idle";
  }

  webControlClaimed(owner: ComputerSurfaceOwner): void {
    const tool = this.#tools.get(owner.surfaceId);
    if (tool?.phase === "waiting") tool.phase = "held";
    else if (tool !== undefined && tool.phase !== "held" && tool.phase !== "completing") return;
    this.#webOwners.add(owner.surfaceId);
    this.onWebControl?.(owner, true);
  }

  webControlReleased(owner: ComputerSurfaceOwner): void {
    this.#webOwners.delete(owner.surfaceId);
    const tool = this.#tools.get(owner.surfaceId);
    if (tool?.phase === "held") tool.phase = "waiting";
    this.onWebControl?.(owner, false);
  }

  canAcceptWebControl(surfaceId: SurfaceId): boolean {
    const phase = this.#tools.get(surfaceId)?.phase;
    return phase === undefined || phase === "held" || phase === "waiting";
  }

  webSurfaceIds(): SurfaceId[] {
    return [...this.#webOwners];
  }

  beginAgentTool(
    target: ScreenInputTarget,
    input: { turnId: string; toolCallId: string },
  ): AgentToolHandle {
    const action = Promise.withResolvers<void>();
    const activated = Promise.withResolvers<void>();
    const tool: AgentTool = {
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      phase: "running",
      actionDone: action.promise,
      resolveActionDone: action.resolve,
      activated: activated.promise,
      resolveActivated: activated.resolve,
    };
    this.#tools.set(target.surfaceId, tool);
    return {
      actionFinished: async (pending) => {
        try {
          await pending;
        } finally {
          tool.resolveActionDone();
        }
      },
    };
  }

  async requestTakeover(surfaceId: SurfaceId): Promise<{ ok: boolean }> {
    const tool = this.#tools.get(surfaceId);
    if (tool === undefined || tool.phase === "settled") return { ok: false };
    if (tool.phase === "held" || tool.phase === "completing" || tool.phase === "waiting") {
      return { ok: true };
    }
    if (tool.phase === "running") tool.phase = "takeover-requested";
    await tool.actionDone;
    if (this.#tools.get(surfaceId) !== tool) return { ok: false };
    if (tool.phase === "takeover-requested") {
      tool.phase = "held";
      tool.resolveActivated();
    }
    return { ok: tool.phase === "held" || tool.phase === "completing" || tool.phase === "waiting" };
  }

  async settleAgentTool(surfaceId: SurfaceId, toolCallId: string): Promise<void> {
    const tool = this.#tools.get(surfaceId);
    if (tool === undefined || tool.toolCallId !== toolCallId) return;
    if (this.#holder?.surfaceId === surfaceId) await this.revoke(surfaceId);
    tool.phase = "settled";
    this.#tools.delete(surfaceId);
  }

  async acquireWebControl(
    target: ScreenInputTarget,
    options?: { epoch?: number },
  ): Promise<WebControlGrant> {
    const current = this.#epoch.get(target.surfaceId) ?? 0;
    const requested = options?.epoch;
    if (requested !== undefined && requested <= current) {
      throw new Error(`stale controller epoch ${requested}`);
    }
    const epoch = requested ?? current + 1;
    if (epoch <= current) throw new Error(`stale controller epoch ${epoch}`);
    if (this.#holder !== undefined && this.#holder.surfaceId !== target.surfaceId) {
      await this.#whenFree();
    }
    this.#grantStarted.resolve();
    let accepted: number;
    try {
      accepted = await this.delivery.grant(target.surfaceId, epoch);
    } catch (error) {
      this.#wake();
      throw error;
    }
    if (accepted !== epoch) {
      this.#wake();
      throw new Error(`stale controller epoch ${accepted}`);
    }
    this.#epoch.set(target.surfaceId, epoch);
    const holder = this.#hold(target.surfaceId, epoch, "web");
    return {
      epoch,
      input: (event) => this.#deliver(holder, event),
      release: () => this.revoke(target.surfaceId),
    };
  }

  performBotInput<T>(
    target: ScreenInputTarget,
    input: {
      turnId: string;
      signal: AbortSignal;
      run: (send: (event: BotScreenInputAction) => Promise<void>) => Promise<T>;
    },
  ): Promise<T> {
    const previous = this.#surfaceTail.get(target.surfaceId) ?? Promise.resolve();
    const run = previous.then(() => this.#runBot(target, input), () => this.#runBot(target, input));
    this.#surfaceTail.set(target.surfaceId, run.then(() => {}, () => {}));
    return run;
  }

  capture(surfaceId: SurfaceId): Promise<unknown> {
    return this.delivery.capture(surfaceId);
  }

  async revoke(surfaceId: SurfaceId): Promise<void> {
    const holder = this.#holder;
    if (holder === undefined || holder.surfaceId !== surfaceId) return;
    const tool = this.#tools.get(surfaceId);
    if (tool?.phase === "held") tool.phase = "waiting";
    await this.#drop(holder);
  }

  async #runBot<T>(
    target: ScreenInputTarget,
    input: {
      turnId: string;
      signal: AbortSignal;
      run: (send: (event: BotScreenInputAction) => Promise<void>) => Promise<T>;
    },
  ): Promise<T> {
    if (input.signal.aborted) throw abortError(input.signal);
    if (this.#holder !== undefined && this.#holder.surfaceId !== target.surfaceId) {
      await this.#whenFree(input.signal);
    }
    if (input.signal.aborted) throw abortError(input.signal);
    const epoch = (this.#epoch.get(target.surfaceId) ?? 0) + 1;
    const holder = this.#hold(target.surfaceId, epoch, "bot");
    this.#held.resolve();
    try {
      const accepted = await this.delivery.grant(target.surfaceId, epoch);
      if (accepted !== epoch) throw new Error(`stale controller epoch ${accepted}`);
      this.#epoch.set(target.surfaceId, epoch);
      return await input.run((event) => this.#deliver(holder, event));
    } finally {
      await this.#drop(holder);
    }
  }

  async #deliver(holder: SeatHolder, event: BotScreenInputAction): Promise<void> {
    if (this.#holder !== holder) throw new Error("stale controller epoch");
    if (event.type === "key") {
      if (event.state === "pressed") holder.keys.add(event.keyCode);
      else holder.keys.delete(event.keyCode);
    } else if (event.type === "button") {
      if (event.state === "pressed") holder.buttons.add(event.button);
      else holder.buttons.delete(event.button);
    }
    await this.delivery.deliver(holder.surfaceId, holder.epoch, event);
  }

  #hold(surfaceId: SurfaceId, epoch: number, kind: "web" | "bot"): SeatHolder {
    const holder: SeatHolder = {
      surfaceId,
      epoch,
      kind,
      keys: new Set(),
      buttons: new Set(),
    };
    this.#holder = holder;
    return holder;
  }

  async #drop(holder: SeatHolder): Promise<void> {
    if (this.#holder !== holder) return;
    this.#holder = undefined;
    const held: HeldInput = holder.keys.size === 0 && holder.buttons.size === 0
      ? EMPTY_HELD
      : { keys: holder.keys, buttons: holder.buttons };
    try {
      await this.delivery.release(holder.surfaceId, holder.epoch, held);
    } finally {
      this.#wake();
    }
  }

  async #whenFree(signal?: AbortSignal): Promise<void> {
    if (this.#holder === undefined) return;
    this.#waiting += 1;
    if (this.#waiting === 1) this.#queued.resolve();
    const gate = this.#free.promise;
    if (signal === undefined) {
      await gate;
      return;
    }
    if (signal.aborted) throw abortError(signal);
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => aborted.reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([gate, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  #wake(): void {
    const pending = this.#free;
    this.#free = Promise.withResolvers<void>();
    this.#waiting = 0;
    this.#queued = Promise.withResolvers<void>();
    pending.resolve();
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("computer input aborted");
}
