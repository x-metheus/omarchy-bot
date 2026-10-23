import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentComputerToolOutput } from "@omarchy-bot/agent-contract";
import { isInputAction, isSurfaceId, type ComputerAction, type SurfaceId } from "@omarchy-bot/domain";
import type { EventLog } from "../events/eventLog.ts";
import type {
  BotScreenBoundActionResult,
  BotScreenManager,
  BotScreenTransition,
} from "./botScreenManager.ts";
import type { ScreenInputLease } from "./screenInputLease.ts";



type ComputerAuthority = "idle" | "agent" | "web" | "takeover";
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface PendingAgentTool {
  owner: ComputerSurfaceOwner;
  turnId: string;
  toolCallId: string;
  actionDone: Deferred<void>;
  activated: Deferred<void>;
  completion: Deferred<AgentComputerToolOutput>;
  actionError?: unknown;
  cancellation?: Error;
}

export type WebControlRevoker = (surfaceId: SurfaceId) => Promise<void>;
export type WebControlRestorer = (surfaceId: SurfaceId) => Promise<void>;
export interface ComputerBrokerState {
  botId: string;
  surfaceId: SurfaceId;
  screenUse: "idle" | "bot" | "human";
  takeover: "unavailable" | "available" | "active";
  lastImageAt?: string;
}

export interface ComputerSurfaceOwner {
  botId: string;
  surfaceId: SurfaceId;
}

/**
 * Coordinates Bot and Web Control for each Computer Surface independently.
 * BotScreenManager owns runtime lifecycle and operation serialization.
 */
export class ComputerBroker {
  #surfaceOperations = new Map<SurfaceId, Promise<void>>();
  #pendingAgentTools = new Map<SurfaceId, PendingAgentTool>();
  #unsubscribeScreens: () => void;

  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly screens: BotScreenManager,
    private readonly artifactsDir: string,
    private readonly lease: ScreenInputLease,
    private readonly projections: { suspendInput(surfaceId: SurfaceId): void; restoreInput(surfaceId: SurfaceId): Promise<void> },
  ) {
    this.lease.onWebControl = (owner, claimed) => this.#noteWebControl(owner, claimed);
    this.db
      .query(
        `UPDATE computer_surface_coordination
         SET authority_kind = 'idle', updated_at = ?`,
      )
      .run(new Date().toISOString());
    this.events.subscribe((event) => {
      if (event.aggregateType !== "bot" || event.type !== "bot.deleted") return;
      const payload = event.payload as { surfaceId?: unknown } | undefined;
      if (typeof payload?.surfaceId !== "string" || !isSurfaceId(payload.surfaceId)) {
        throw new Error("Bot deletion event requires a valid Surface");
      }
      this.#clearSurface(payload.surfaceId, "Computer Surface was removed during pending tool");
    });
    this.#unsubscribeScreens = this.screens.subscribe((transition) => {
      const owner = this.#ownerForSurface(transition.surfaceId);
      if (owner !== undefined) this.#lifecycleEvent(owner, transition);
      if (transition.state === "failed") {
        this.#clearSurface(transition.surfaceId, "Bot Screen became unavailable during pending tool");
      } else if (transition.state === "stopped") {
        this.#clearSurface(transition.surfaceId, "Bot Screen stopped during pending tool");
      }
    });
  }

  resolveOwner(botId: string, surfaceId: string): ComputerSurfaceOwner | undefined {
    const row = this.db
      .query(
        `SELECT surface_id
         FROM bot_surfaces
         WHERE bot_id = ? AND surface_id = ?`,
      )
      .get(botId, surfaceId) as { surface_id: SurfaceId } | null;
    return row === null ? undefined : { botId, surfaceId: row.surface_id };
  }


  #ownerForSurface(surfaceId: SurfaceId): ComputerSurfaceOwner | undefined {
    const row = this.db
      .query(`SELECT bot_id FROM bot_surfaces WHERE surface_id = ?`)
      .get(surfaceId) as { bot_id: string } | null;
    return row === null ? undefined : { botId: row.bot_id, surfaceId };
  }

  #requireOwner(owner: ComputerSurfaceOwner): ComputerSurfaceOwner {
    const resolved = this.resolveOwner(owner.botId, owner.surfaceId);
    if (resolved === undefined) throw new Error("unknown or mismatched Computer Surface owner");
    return resolved;
  }

  #event(owner: ComputerSurfaceOwner): void {
    this.events.append("computer", owner.surfaceId, "computer.state.changed", owner);
  }

  #lifecycleEvent(owner: ComputerSurfaceOwner, transition: BotScreenTransition): void {
    this.events.append("computer", owner.surfaceId, "computer.state.changed", {
      ...owner,
      lifecycle: transition.state,
    });
  }

  #transitionAuthority(owner: ComputerSurfaceOwner, authority: ComputerAuthority): void {
    const current = this.#authority(owner.surfaceId);
    if (current === authority) return;
    this.db
      .query(
        `INSERT INTO computer_surface_coordination
           (surface_id, authority_kind, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(surface_id) DO UPDATE SET
           authority_kind = excluded.authority_kind,
           updated_at = excluded.updated_at`,
      )
      .run(owner.surfaceId, authority, new Date().toISOString());
  }

  #authority(surfaceId: SurfaceId): ComputerAuthority {
    const row = this.db
      .query(`SELECT authority_kind FROM computer_surface_coordination WHERE surface_id = ?`)
      .get(surfaceId) as { authority_kind: ComputerAuthority } | null;
    return row?.authority_kind ?? "idle";
  }

  state(input: ComputerSurfaceOwner): ComputerBrokerState {
    const owner = this.#requireOwner(input);
    const surface = this.db
      .query(`SELECT last_image_at FROM bot_surfaces WHERE surface_id = ?`)
      .get(owner.surfaceId) as { last_image_at: string | null };
    const takeover = this.lease.takeover(owner.surfaceId);
    const screenUse = this.lease.screenUse(owner.surfaceId);
    return {
      ...owner,
      screenUse,
      takeover,
      ...(surface.last_image_at !== null ? { lastImageAt: surface.last_image_at } : {}),
    };
  }

  states(): ComputerBrokerState[] {
    const owners = this.db
      .query(`SELECT bot_id, surface_id FROM bot_surfaces`)
      .all() as Array<{ bot_id: string; surface_id: SurfaceId }>;
    return owners.map((owner) => this.state({ botId: owner.bot_id, surfaceId: owner.surface_id }));
  }

  async takeOver(input: ComputerSurfaceOwner): Promise<{ ok: boolean }> {
    const owner = this.#requireOwner(input);
    const pending = this.#pendingAgentTools.get(owner.surfaceId);
    if (pending === undefined) return { ok: false };
    if (this.lease.takeover(owner.surfaceId) === "active") return { ok: true };
    if (this.lease.takeover(owner.surfaceId) !== "available") return { ok: false };
    this.#transitionAuthority(owner, "takeover");
    this.#event(owner);
    const takeover = await this.lease.requestTakeover(owner.surfaceId);
    if (
      !takeover.ok
      || this.#pendingAgentTools.get(owner.surfaceId) !== pending
      || pending.cancellation !== undefined
      || pending.actionError !== undefined
    ) {
      return { ok: false };
    }
    pending.activated.resolve();
    this.#event(owner);
    return { ok: true };
  }

  async imDone(input: ComputerSurfaceOwner): Promise<{ observation?: string }> {
    const owner = this.#requireOwner(input);
    const pending = this.#pendingAgentTools.get(owner.surfaceId);
    if (pending === undefined || !this.lease.beginCompletion(owner.surfaceId, pending.toolCallId)) {
      throw new Error("Takeover is not active");
    }
    this.#event(owner);
    try {
      await this.lease.revoke(owner.surfaceId);
      this.projections.suspendInput(owner.surfaceId);
      if (pending.cancellation !== undefined) throw pending.cancellation;
      const capture = await this.#invokeAction(
        owner,
        pending.turnId,
        { name: "observe", args: {} },
      );
      if (pending.cancellation !== undefined) throw pending.cancellation;
      const result = await this.#withImageFile(
        owner,
        await this.#recordActionResult(owner, capture),
      );
      if (pending.cancellation !== undefined) throw pending.cancellation;
      await this.lease.settleAgentTool(owner.surfaceId, pending.toolCallId);
      this.#transitionAuthority(owner, "idle");
      pending.completion.resolve(result);
      this.#event(owner);
      return result.text === undefined ? {} : { observation: result.text };
    } catch (error) {
      if (pending.cancellation === undefined) {
        try {
          await this.projections.restoreInput(owner.surfaceId);
        } catch (restoreError) {
          this.lease.failCompletion(owner.surfaceId, pending.toolCallId, "waiting");
          this.#transitionAuthority(owner, "idle");
          this.#event(owner);
          throw new AggregateError(
            [error, restoreError],
            "Bot Screen observation failed and Web Control could not be restored",
          );
        }
        this.lease.failCompletion(owner.surfaceId, pending.toolCallId, "held");
        this.#transitionAuthority(owner, "takeover");
        this.#event(owner);
      }
      throw error;
    }
  }

  #noteWebControl(input: ComputerSurfaceOwner, claimed: boolean): void {
    const owner = this.#requireOwner(input);
    const phase = this.lease.agentToolPhase(owner.surfaceId);
    this.#transitionAuthority(
      owner,
      claimed && phase === undefined
        ? "web"
        : phase === "running"
          ? "agent"
          : phase === undefined || phase === "settled"
            ? "idle"
            : "takeover",
    );
    this.#event(owner);
  }

  async #invokeAction(
    input: ComputerSurfaceOwner,
    turnId: string,
    action: ComputerAction,
    signal?: AbortSignal,
  ): Promise<BotScreenBoundActionResult> {
    const owner = this.#requireOwner(input);
    const inputAuthority = isInputAction(action.name)
      ? { surfaceId: owner.surfaceId, botId: owner.botId, turnId }
      : undefined;
    if (inputAuthority === undefined) return this.screens.act(owner, action);
    await this.screens.ensureReady(owner);
    const generation = this.db
      .query(`SELECT runtime_generation FROM bot_surfaces WHERE surface_id = ?`)
      .get(owner.surfaceId) as { runtime_generation: number } | null;
    if (generation === null) throw new Error("unknown Computer Surface");
    return this.lease.performBotInput(
      { surfaceId: owner.surfaceId, runtimeGeneration: generation.runtime_generation },
      {
        turnId,
        signal: signal ?? new AbortController().signal,
        run: (_send, epoch) => this.screens.act(owner, action, { ...inputAuthority, controllerEpoch: epoch }),
      },
    );
  }

  async #recordActionResult(
    owner: ComputerSurfaceOwner,
    result: BotScreenBoundActionResult,
  ): Promise<AgentComputerToolOutput> {
    let imageRef: string | undefined;
    if (result.image !== undefined) {
      const id = randomUUID();
      const extension = result.image.mediaType === "image/png" ? "png" : "jpg";
      const artifactPath = path.join(this.artifactsDir, `snapshot-${id}.${extension}`);
      const observedAt = new Date().toISOString();
      await writeFile(artifactPath, result.image.bytes);
      this.db
        .query(`INSERT INTO artifacts (id, kind, media_type, path, created_at, surface_id) VALUES (?, 'snapshot', ?, ?, ?, ?)`)
        .run(id, result.image.mediaType, artifactPath, observedAt, owner.surfaceId);
      this.db.query(`UPDATE bot_surfaces SET last_image_at = ? WHERE surface_id = ?`).run(observedAt, owner.surfaceId);
      imageRef = id;
    }
    this.#event(owner);
    return {
      desktopSession: result.desktopSession,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(imageRef !== undefined ? { imageRef } : {}),
      ...(result.windowList !== undefined ? { windowList: result.windowList } : {}),
    };
  }

  async #act(
    input: ComputerSurfaceOwner,
    turnId: string,
    action: ComputerAction,
  ): Promise<AgentComputerToolOutput> {
    const owner = this.#requireOwner(input);
    return this.#recordActionResult(owner, await this.#invokeAction(owner, turnId, action));
  }

  /** Executes one SDK computer tool call for its authoritative Bot Screen. */
  async agentToolAct(
    input: ComputerSurfaceOwner,
    turnId: string,
    toolCallId: string,
    action: ComputerAction,
    signal: AbortSignal,
  ): Promise<AgentComputerToolOutput> {
    const owner = this.#requireOwner(input);
    return this.#serializeSurfaceOperation(owner.surfaceId, async () => {
      signal.throwIfAborted();
      this.#requireOwner(owner);

      const pending: PendingAgentTool = {
        owner,
        turnId,
        toolCallId,
        actionDone: deferred<void>(),
        activated: deferred<void>(),
        completion: deferred<AgentComputerToolOutput>(),
      };
      pending.activated.promise.catch(() => {});
      pending.completion.promise.catch(() => {});
      this.#pendingAgentTools.set(owner.surfaceId, pending);
      const handle = this.lease.beginAgentTool(owner.surfaceId, { turnId, toolCallId });
      void handle.actionFinished(pending.actionDone.promise);
      this.lease.webControlReleased(owner);
      this.#transitionAuthority(owner, "agent");
      this.#event(owner);
      const cancel = (): void => {
        const reason = signal.reason instanceof Error
          ? signal.reason
          : new Error("computer tool call cancelled");
        void this.#cancelPending(pending, reason);
      };
      signal.addEventListener("abort", cancel, { once: true });

      try {
        let initial: BotScreenBoundActionResult;
        try {
          this.projections.suspendInput(owner.surfaceId);
          await this.lease.revoke(owner.surfaceId);
          signal.throwIfAborted();
          initial = await this.#invokeAction(owner, turnId, action, signal);
          signal.throwIfAborted();
        } catch (error) {
          pending.actionError = error;
          // The action is dead, so the lease must stop offering Takeover; the action error is the one to report.
          await this.lease.settleAgentTool(owner.surfaceId, toolCallId).catch(() => {});
          throw error;
        } finally {
          pending.actionDone.resolve();
        }

        if (pending.cancellation !== undefined) throw pending.cancellation;
        if (!this.lease.takeoverRequested(owner.surfaceId)) {
          await this.lease.settleAgentTool(owner.surfaceId, toolCallId);
          this.#transitionAuthority(owner, "idle");
          return this.#withImageFile(owner, await this.#recordActionResult(owner, initial));
        }
        await pending.activated.promise;
        if (pending.cancellation !== undefined) throw pending.cancellation;
        return await pending.completion.promise;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (this.#pendingAgentTools.get(owner.surfaceId) === pending && !this.lease.takeoverRequested(owner.surfaceId)) {
          this.#transitionAuthority(owner, "idle");
          this.#pendingAgentTools.delete(owner.surfaceId);
        }
        this.#event(owner);
      }
    });
  }

  async snapshot(input: ComputerSurfaceOwner): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
    const owner = this.#requireOwner(input);
    const result = await this.screens.capture(owner).catch(() => undefined);
    if (result === undefined) return undefined;
    const observedAt = new Date().toISOString();
    this.db
      .query(`UPDATE bot_surfaces SET last_image_at = ? WHERE surface_id = ?`)
      .run(observedAt, owner.surfaceId);
    this.#event(owner);
    return { mediaType: result.mediaType, bytes: result.bytes };
  }

  shutdown(): void {
    this.#unsubscribeScreens();
    for (const pending of this.#pendingAgentTools.values()) {
      const error = new Error("daemon stopped during pending computer tool");
      pending.cancellation = error;
      this.#transitionAuthority(pending.owner, "idle");
      pending.activated.reject(error);
      pending.completion.reject(error);
    }
    for (const surfaceId of this.lease.webSurfaceIds()) {
      const owner = this.#ownerForSurface(surfaceId);
      if (owner !== undefined) this.#transitionAuthority(owner, "idle");
    }
    this.#pendingAgentTools.clear();
    this.#surfaceOperations.clear();
  }

  #clearSurface(surfaceId: SurfaceId, reason: string): void {
    const pending = this.#pendingAgentTools.get(surfaceId);
    if (pending !== undefined) {
      void this.#cancelPending(pending, new Error(reason));
    }
  }

  async #withImageFile(
    owner: ComputerSurfaceOwner,
    result: AgentComputerToolOutput,
  ): Promise<AgentComputerToolOutput> {
    if (result.imageRef === undefined) return result;
    const artifact = this.db
      .query(`SELECT media_type, path FROM artifacts WHERE id = ? AND surface_id = ?`)
      .get(result.imageRef, owner.surfaceId) as { media_type: string; path: string } | null;
    if (
      artifact === null
      || (artifact.media_type !== "image/png" && artifact.media_type !== "image/jpeg")
    ) {
      throw new Error("Bot Screen observation artifact is unavailable");
    }
    return {
      ...result,
      imageFile: { mediaType: artifact.media_type, path: artifact.path },
    };
  }

  async #cancelPending(pending: PendingAgentTool, error: Error): Promise<void> {
    if (
      pending.cancellation !== undefined
      || this.#pendingAgentTools.get(pending.owner.surfaceId) !== pending
    ) return;
    pending.cancellation = error;
    let releaseError: unknown;
    try {
      // The lease owns the phase machine: settle it here or Takeover stays active after the turn dies.
      await this.lease.settleAgentTool(pending.owner.surfaceId, pending.toolCallId);
    } catch (caught) {
      releaseError = caught;
    } finally {
      this.#transitionAuthority(pending.owner, "idle");
      const failure = releaseError === undefined
        ? error
        : new AggregateError([error, releaseError], "Bot Screen held input could not be released");
      pending.activated.reject(failure);
      pending.completion.reject(failure);
      this.#event(pending.owner);
    }
  }

  async #serializeSurfaceOperation<T>(
    surfaceId: SurfaceId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#surfaceOperations.get(surfaceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.#surfaceOperations.set(surfaceId, settled);
    try {
      return await result;
    } finally {
      if (this.#surfaceOperations.get(surfaceId) === settled) {
        this.#surfaceOperations.delete(surfaceId);
      }
    }
  }
}
