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
  deliver(surfaceId: SurfaceId, epoch: number, event: BotScreenInputAction, sequence?: number): Promise<void>;
  release(surfaceId: SurfaceId, epoch: number, held: HeldInput, nextSequence?: number): Promise<void>;
  capture(surfaceId: SurfaceId): Promise<unknown>;
}

export type TakeoverState = "unavailable" | "available" | "active";
export type ScreenUse = "idle" | "bot" | "human";

export type TakeoverPhase = "running" | "takeover-requested" | "held" | "completing" | "waiting" | "settled";

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
  /** Frees this holder's place in the shared-seat queue. Idempotent. */
  turn: () => void;
  keys: Set<number>;
  buttons: Set<"left" | "middle" | "right">;
  sequence: number;
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
  #generation = new Map<SurfaceId, number>();
  #tools = new Map<SurfaceId, AgentTool>();
  #holder: SeatHolder | undefined;
  /** Releases in flight, so a second drop of one holder waits for the first. */
  #releases = new Map<SeatHolder, Promise<void>>();
  /** One shared-seat queue: call order is grant order for Bot input and Web Control. */
  #seatChain: Promise<void> = Promise.resolve();
  #waiting = 0;
  #grantStarted = Promise.withResolvers<void>();
  #queued = Promise.withResolvers<void>();
  #held = Promise.withResolvers<void>();
  #webOwners = new Set<SurfaceId>();

  constructor(private readonly delivery: ScreenInputDelivery) {}
  onWebControl?: (owner: ComputerSurfaceOwner, claimed: boolean) => void;

  /** Test seam: resolves while an acquirer is waiting for the seat. */
  seatQueued(): Promise<void> {
    return this.#waiting > 0 ? Promise.resolve() : this.#queued.promise;
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

  /** The one Takeover phase machine. Nothing else tracks phases. */
  agentToolPhase(surfaceId: SurfaceId): TakeoverPhase | undefined {
    return this.#tools.get(surfaceId)?.phase;
  }

  /** A Takeover observation started: the Agent stopped typing and the Screen is handed back. */
  beginCompletion(surfaceId: SurfaceId, toolCallId: string): boolean {
    const tool = this.#tools.get(surfaceId);
    if (tool === undefined || tool.toolCallId !== toolCallId || tool.phase !== "held") return false;
    tool.phase = "completing";
    return true;
  }

  /** The observation failed: Takeover resumes, or the Screen waits for Web Control to return. */
  failCompletion(surfaceId: SurfaceId, toolCallId: string, phase: "held" | "waiting"): void {
    const tool = this.#tools.get(surfaceId);
    if (tool === undefined || tool.toolCallId !== toolCallId || tool.phase !== "completing") return;
    tool.phase = phase;
  }

  takeoverRequested(surfaceId: SurfaceId): boolean {
    const phase = this.#tools.get(surfaceId)?.phase;
    return phase === "takeover-requested" || phase === "held" || phase === "completing" || phase === "waiting";
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
    surfaceId: SurfaceId,
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
    this.#tools.set(surfaceId, tool);
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
    if (tool === undefined) return { ok: false };
    const phase = tool.phase;
    if (phase === "held" || phase === "completing" || phase === "waiting") return { ok: true };
    if (phase === "running") tool.phase = "takeover-requested";
    await tool.actionDone;
    // Settling during the wait removes the tool, so this request has nothing to take over.
    if (this.#tools.get(surfaceId) !== tool) return { ok: false };
    // Another request may have held the same tool while this one waited.
    if (tool.phase === "held" || tool.phase === "completing" || tool.phase === "waiting") return { ok: true };
    if (tool.phase !== "takeover-requested") return { ok: false };
    tool.phase = "held";
    tool.resolveActivated();
    return { ok: true };
  }

  async settleAgentTool(surfaceId: SurfaceId, toolCallId: string): Promise<void> {
    const tool = this.#tools.get(surfaceId);
    if (tool === undefined || tool.toolCallId !== toolCallId) return;
    tool.phase = "settled";
    this.#tools.delete(surfaceId);
    // A waiting requestTakeover sees the tool gone and reports no Takeover.
    if (this.#holder?.surfaceId === surfaceId) await this.revoke(surfaceId);
  }

  async acquireWebControl(
    target: ScreenInputTarget,
    options?: { epoch?: number },
  ): Promise<WebControlGrant> {
    // A stale request fails at once instead of queueing behind the holder it duplicates.
    const requested = options?.epoch;
    if (requested !== undefined && requested <= (this.#epoch.get(target.surfaceId) ?? 0)) {
      throw new Error(`stale controller epoch ${requested}`);
    }
    this.#requireGeneration(target);
    const turn = await this.#takeSeat();
    try {
      const current = this.#epoch.get(target.surfaceId) ?? 0;
      const epoch = requested ?? current + 1;
      if (epoch <= current) throw new Error(`stale controller epoch ${epoch}`);
      this.#requireGeneration(target);
      const holder = this.#hold(target.surfaceId, epoch, "web", turn);
      this.#grantStarted.resolve();
      let accepted: number;
      try {
        accepted = await this.delivery.grant(target.surfaceId, epoch);
        if (accepted !== epoch) throw new Error(`stale controller epoch ${accepted}`);
      } catch (error) {
        this.#abandon(holder);
        throw error;
      }
      this.#epoch.set(target.surfaceId, epoch);
      this.#generation.set(target.surfaceId, target.runtimeGeneration);
      return {
        epoch,
        input: (event) => this.#deliver(holder, event),
        release: () => this.revoke(target.surfaceId),
      };
    } catch (error) {
      turn();
      throw error;
    }
  }

  async performBotInput<T>(
    target: ScreenInputTarget,
    input: {
      turnId: string;
      signal: AbortSignal;
      run: (send: (event: BotScreenInputAction) => Promise<void>) => Promise<T>;
    },
  ): Promise<T> {
    if (input.signal.aborted) throw abortError(input.signal);
    this.#requireGeneration(target);
    return this.#runBot(target, input, await this.#takeSeat(input.signal));
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
    turn: () => void,
  ): Promise<T> {
    try {
      if (input.signal.aborted) throw abortError(input.signal);
      this.#requireGeneration(target);
      const epoch = (this.#epoch.get(target.surfaceId) ?? 0) + 1;
      const holder = this.#hold(target.surfaceId, epoch, "bot", turn);
      this.#generation.set(target.surfaceId, target.runtimeGeneration);
      this.#held.resolve();
      let accepted: number;
      try {
        accepted = await this.delivery.grant(target.surfaceId, epoch);
        if (accepted !== epoch) throw new Error(`stale controller epoch ${accepted}`);
      } catch (error) {
        this.#abandon(holder);
        throw error;
      }
      this.#epoch.set(target.surfaceId, epoch);
      try {
        return await input.run((event) => this.#deliver(holder, event));
      } finally {
        await this.#drop(holder);
      }
    } finally {
      turn();
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
    const sequence = ++holder.sequence;
    await this.delivery.deliver(holder.surfaceId, holder.epoch, event, sequence);
  }

  #hold(surfaceId: SurfaceId, epoch: number, kind: "web" | "bot", turn: () => void): SeatHolder {
    const holder: SeatHolder = {
      surfaceId,
      epoch,
      kind,
      turn,
      keys: new Set(),
      buttons: new Set(),
      sequence: 0,
    };
    this.#holder = holder;
    return holder;
  }

  /**
   * Releases the holder's authority and then hands the seat on. A second drop of the
   * same holder waits for the release already in flight instead of letting the next
   * acquirer type while held keys are still down.
   */
  #drop(holder: SeatHolder): Promise<void> {
    const inFlight = this.#releases.get(holder);
    if (inFlight !== undefined) return inFlight;
    if (this.#holder !== holder) return Promise.resolve();
    this.#holder = undefined;
    const held: HeldInput = holder.keys.size === 0 && holder.buttons.size === 0
      ? EMPTY_HELD
      : { keys: holder.keys, buttons: holder.buttons };
    const release = (async (): Promise<void> => {
      try {
        await this.delivery.release(holder.surfaceId, holder.epoch, held, holder.sequence + 1);
      } finally {
        this.#releases.delete(holder);
        holder.turn();
      }
    })();
    this.#releases.set(holder, release);
    return release;
  }

  /** Drops the seat without a release: the runtime never accepted this grant. */
  #abandon(holder: SeatHolder): void {
    if (this.#holder !== holder) return;
    this.#holder = undefined;
    holder.turn();
  }

  /**
   * The shared-seat queue. Every acquirer takes its place in call order, so a Bot
   * action cannot overtake Web Control that asked later, or the reverse.
   */
  async #takeSeat(signal?: AbortSignal): Promise<() => void> {
    const previous = this.#seatChain;
    const turn = Promise.withResolvers<void>();
    this.#seatChain = previous.then(() => turn.promise);
    const leave = (): void => turn.resolve();
    if (signal === undefined) {
      this.#noteQueued(1);
      try {
        await previous;
      } finally {
        this.#noteQueued(-1);
      }
      return leave;
    }
    if (signal.aborted) {
      leave();
      throw abortError(signal);
    }
    const aborted = Promise.withResolvers<void>();
    const onAbort = (): void => {
      aborted.resolve();
      leave();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.#noteQueued(1);
    try {
      await Promise.race([previous, aborted.promise]);
    } finally {
      this.#noteQueued(-1);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortError(signal);
    return leave;
  }

  #noteQueued(delta: number): void {
    this.#waiting += delta;
    if (this.#waiting > 0) {
      this.#queued.resolve();
      return;
    }
    this.#queued = Promise.withResolvers<void>();
  }

  #requireGeneration(target: ScreenInputTarget): void {
    const current = this.#generation.get(target.surfaceId);
    if (current !== undefined && current !== target.runtimeGeneration) {
      throw new Error(`stale runtime generation ${target.runtimeGeneration}`);
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("computer input aborted");
}
