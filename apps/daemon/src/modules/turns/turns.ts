
import { DurableRunAborted, type BotRuntime } from "../runtime/runtime.ts";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SendResultDto, TurnDto } from "@omarchy-bot/protocol";
import type { TurnStatus } from "@omarchy-bot/domain";
import { canTransitionTurn, isTerminalTurn } from "@omarchy-bot/domain";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import type { AttachmentsService } from "../attachments/attachments.ts";
import { HttpError } from "../bots/bots.ts";
import { ensurePrivateFolder, resolveWorkCwd } from "../workspace/sharedWorkspace.ts";

interface TerminalTurnWaiter {
  resolve: (turn: TurnDto) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Local title from the first user message — no extra Agent call. */
export function deriveTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length <= 60 ? firstLine || "New conversation" : `${firstLine.slice(0, 57).trimEnd()}…`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Owns Turn admission, steering, recovery, and terminal status. */
export class TurnService {
  #durableTurns = new Set<string>();
  #durableStarts = new Map<string, Promise<void>>();
  #recovery: { registered: Promise<void>; settled: Promise<void> } | undefined;
  #recoveredSettled = new Map<string, Promise<void>>();
  #settleRecovered = new Map<string, () => void>();
  /** Durable Turns left waiting for an approval at shutdown. They stay working and continue on the next start. */
  #suspended = new Set<string>();
  #durableAbortReasons = new Map<string, string>();
  #terminalWaiters = new Map<string, Set<TerminalTurnWaiter>>();
  #stopping = false;
  #restartReason: string | undefined;

  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly threads: ThreadsService,
    private readonly bots: BotsService,
    private readonly attachments: AttachmentsService,
    private readonly cfg: { turnTimeoutMs: number; sharedWorkspaceDir: string },
    private readonly runtime: BotRuntime,
  ) {}

  async shutdown(options: { reason?: "daemon restart" } = {}): Promise<void> {
    this.#stopping = true;
    this.#restartReason ??= options.reason;
    await this.#recovery?.registered;
    // A reply waiting for an approval keeps waiting through a restart: only the Harness closes under it, which is not a
    // crash and uses none of its restarts. Its run settles only after that close, so shutdown does not wait for it.
    for (const turnId of this.#durableTurns) {
      const row = this.threads.turnRow(turnId);
      if (row && this.runtime.approvals?.hasPending(row.thread_id, row.bot_id)) this.#suspended.add(turnId);
    }
    const running = (turnId: string) => !this.#suspended.has(turnId);
    await Promise.allSettled([...this.#durableTurns].filter(running).map((turnId) => this.runtime.abortTurn(turnId)));
    if (this.#suspended.size === 0) await this.#recovery?.settled;
    else await Promise.allSettled([...this.#recoveredSettled].filter(([turnId]) => running(turnId)).map(([, settled]) => settled));
    await Promise.allSettled([...this.#durableStarts].filter(([turnId]) => running(turnId)).map(([, start]) => start));
  }

  recoverTurns(): void {
    if (this.#recovery) return;
    this.#recovery = this.runtime.recoverTurns({
      db: this.db, threads: this.threads, bots: this.bots, events: this.events,
      registered: (turnId) => {
        this.#durableTurns.add(turnId);
        this.#recoveredSettled.set(turnId, new Promise((resolve) => this.#settleRecovered.set(turnId, resolve)));
      },
      settled: (turnId, outcome) => {
        this.#settleRecovered.get(turnId)?.();
        this.#settleRecovered.delete(turnId);
        this.#recoveredSettled.delete(turnId);
        if (outcome.status === "completed") {
          this.#setTurnStatus(turnId, "completed");
        } else {
          const threadId = this.threads.turnRow(turnId)?.thread_id;
          const reason = outcome.status === "failed" ? outcome.reason : this.#durableAbortReasons.get(turnId) ?? "aborted";
          this.#finishInterruptedDurableTurn(turnId, threadId, outcome.status, reason);
        }
        this.#durableTurns.delete(turnId);
        this.#durableAbortReasons.delete(turnId);
      },
    });
  }

  #turnDto(id: string): TurnDto | undefined {
    const r = this.threads.turnRow(id);
    return r ? this.threads.turnToDto(r) : undefined;
  }

  #setTurnStatus(turnId: string, next: TurnStatus, reason?: string): void {
    const t = this.threads.turnRow(turnId);
    if (!t) return;
    const from = t.status as TurnStatus;
    if (from === next || isTerminalTurn(from) || !canTransitionTurn(from, next)) return;
    const finished = isTerminalTurn(next);
    this.db
      .query(`UPDATE turns SET status = ?${finished ? ", finished_at = ?" : ""}${reason !== undefined ? ", outcome_reason = ?" : ""} WHERE id = ?`)
      .run(...(finished && reason !== undefined ? [next, new Date().toISOString(), reason, turnId] : finished ? [next, new Date().toISOString(), turnId] : reason !== undefined ? [next, reason, turnId] : [next, turnId]));
    this.events.append("turn", turnId, "turn.status", {
      turnId,
      from,
      to: next,
      threadId: t.thread_id,
      botId: t.bot_id,
      ...(reason !== undefined ? { reason } : {}),
    });
    this.#recordDurableActivity(t.bot_id, t.thread_id, turnId);
    if (finished) {
      const terminal = this.#turnDto(turnId);
      const waiters = this.#terminalWaiters.get(turnId);
      if (terminal !== undefined && waiters !== undefined) {
        this.#terminalWaiters.delete(turnId);
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
          waiter.resolve(terminal);
        }
      }
    }
  }

  #recordDurableActivity(botId: string, threadId: string, turnId: string): void {
    const status = this.threads.activeTurnForBot(botId) === undefined ? "inactive" : "active";
    this.events.append("bot", botId, "bot.activity", { status, threadId, turnId });
  }

  /**
   * Send a user message. `threadId: null` creates the thread atomically with
   * the first message and turn (lazy threads — abandoned blanks persist nothing).
   */
  async send(
    botId: string,
    threadId: string | null,
    text: string,
    attachmentIds: string[] = [],
    attachmentDraftToken?: string,
    opts: { cwd?: string; deviceId?: string; whenBusy?: "steer" | "followUp" } = {},
  ): Promise<SendResultDto> {
    if (this.#stopping) throw new HttpError(503, "Daemon is stopping; new work cannot start");
    const bot = this.db.query<{ instructions: string }, [string]>(`SELECT instructions FROM bots WHERE id = ?`).get(botId);
    if (!bot) throw new HttpError(404, `unknown bot ${botId}`);
    if (
      this.db.query(`SELECT bot_id FROM bot_deletions WHERE bot_id = ? AND state = 'cleaning'`).get(botId) !== null
    ) {
      throw new HttpError(409, "bot deletion is in progress; new work cannot start");
    }
    // Active turn on the thread -> steer instead of a new turn.
    let durableFollowUp = false;
    const existingThreadId = threadId ?? undefined;
    if (existingThreadId !== undefined) {
      const thread = this.threads.getThread(existingThreadId);
      if (!thread || thread.botId !== botId) throw new HttpError(404, `unknown thread ${existingThreadId} for bot ${botId}`);
      const active = this.threads.activeTurn(existingThreadId);
      if (active !== undefined) {
        if (opts.whenBusy === "followUp") {
          if (attachmentIds.length > 0) throw new HttpError(409, "attachments cannot be added while a durable turn is active");
          durableFollowUp = true;
        } else {
          if (attachmentIds.length > 0) throw new HttpError(409, "attachments cannot be added while steering an active turn");
          const activeId = await this.runtime.activeTurn(existingThreadId);
          const current = activeId === undefined ? active : this.#turnDto(activeId) ?? active;
          return this.#steerDurable(current, text);
        }
      }
    }

    const turnId = `turn_${randomUUID().replace(/-/g, "")}`;
    const result = this.db.transaction(() => {
      let tid = existingThreadId;
      let title = "New conversation";
      if (tid === undefined) {
        tid = randomUUID();
        title = deriveTitle(text);
        this.threads.insertThreadRow(tid, botId, title, opts.cwd);
      }
      const userMsg = this.threads.appendMessageQuiet(tid, { author: { kind: "user" }, kind: "text", text });
      if (existingThreadId === undefined) {
        // First message derives the title for pre-existing blank threads too.
        const t = this.threads.getThread(tid);
        if (t && t.title === "New conversation") {
          this.db.query(`UPDATE threads SET title = ? WHERE id = ?`).run(title, tid);
        }
      }
      this.threads.insertTurnRow({ id: turnId, threadId: tid, botId, nativeSessionId: this.threads.getNativeSession(tid) ?? "" });
      const attachments = this.attachments.promoteForMessage({
        attachmentIds,
        botId,
        threadId: tid,
        messageId: userMsg.id,
        draftToken: attachmentDraftToken,
      });
      return { threadId: tid, messageId: userMsg.id, attachments };
    })();

    this.events.append("thread", result.threadId, "thread.created", { botId, threadId: result.threadId, turnId });
    const userMsgDto = this.threads.getMessage(result.messageId)!;
    this.events.append("thread", result.threadId, "message.appended", userMsgDto);
    this.events.append("turn", turnId, "turn.created", { turnId, threadId: result.threadId, botId });
    this.#recordDurableActivity(botId, result.threadId, turnId);
    this.bots.recordUserMessage(botId, result.threadId);
    const sent: SendResultDto = { threadId: result.threadId, messageId: result.messageId, turnId, action: "sent" };
    let privateDir: string;
    try {
      privateDir = ensurePrivateFolder(botId, this.cfg.sharedWorkspaceDir);
    } catch (error) {
      this.#setTurnStatus(turnId, "failed", errorMessage(error));
      if (durableFollowUp) throw new HttpError(409, `follow-up unavailable: ${errorMessage(error)}`);
      return sent;
    }
    const admission = this.#startDurableTurn(turnId, result.threadId, (admitted, working) => {
      resolveWorkCwd(this.threads.getThread(result.threadId)!.cwd);
      return this.runtime.startTurn({
        db: this.db, threads: this.threads, bots: this.bots, events: this.events,
        threadId: result.threadId, botId, turnId, text, instructions: bot.instructions,
        attachments: result.attachments, workspaceDir: this.cfg.sharedWorkspaceDir, privateDir, admitted, working,
        ...(opts.deviceId === undefined ? {} : { deviceId: opts.deviceId }),
        ...(durableFollowUp ? { whenBusy: "followUp" } : {}),
      });
    });
    if (durableFollowUp) {
      try { await admission; } catch (error) { throw new HttpError(409, `follow-up unavailable: ${errorMessage(error)}`); }
    }
    return sent;
  }

  #startDurableTurn(
    turnId: string,
    threadId: string,
    start: (admitted: () => void, working: () => void) => Promise<void>,
    acceptanceFailureReason?: string,
  ): Promise<void> {
    this.#durableTurns.add(turnId);
    const admission = Promise.withResolvers<void>();
    void admission.promise.catch(() => {});
    let accepted = false;
    const tracked = (async () => {
      try {
        await start(() => {
          accepted = true;
          admission.resolve();
        }, () => this.#setTurnStatus(turnId, "working"));
        await this.runtime.writeService(() => this.#setTurnStatus(turnId, "completed"));
      } catch (error) {
        admission.reject(error);
        const settle = () => {
          if (!accepted && acceptanceFailureReason !== undefined) {
            console.error(`peer-mail Turn ${turnId} failed before durable acceptance`, error);
            this.#finishInterruptedDurableTurn(turnId, threadId, "failed", acceptanceFailureReason);
          } else {
            const aborted = error instanceof DurableRunAborted;
            const reason = aborted ? this.#durableAbortReasons.get(turnId) ?? "aborted" : errorMessage(error);
            this.#finishInterruptedDurableTurn(turnId, threadId, aborted ? "cancelled" : "failed", reason);
          }
        };
        await this.runtime.writeService(settle);
      }
    })().finally(() => {
      this.#durableTurns.delete(turnId);
      this.#durableAbortReasons.delete(turnId);
      this.#durableStarts.delete(turnId);
    });
    this.#durableStarts.set(turnId, tracked);
    return admission.promise;
  }

  /** Start a mailbox-owned Turn and resolve once its reply has been admitted. */
  async startPeerMailTurn(input: {
    turnId: string;
    threadId: string;
    botId: string;
    sourceName: string;
    sourceBotId?: string;
    text: string;
    deliveryId: string;
    acceptanceFailureReason: string;
    markDelivered(): void;
  }): Promise<void> {
    const { turnId, threadId, botId } = input;
    const author = `Message from Bot ${input.sourceName}${input.sourceBotId === undefined ? "" : ` (${input.sourceBotId})`}`;
    return this.#startDurableTurn(turnId, threadId, (admitted, working) => this.runtime.startPeerMailTurn({
      db: this.db, threads: this.threads, bots: this.bots, events: this.events, threadId, botId, turnId,
      peerMail: { author, text: input.text, deliveryId: input.deliveryId },
      workspaceDir: this.cfg.sharedWorkspaceDir, working, admitted,
      admissionTimeoutMs: this.cfg.turnTimeoutMs, markDelivered: input.markDelivered,
      announce: () => {
        if (this.#stopping) throw new HttpError(503, "Daemon is stopping; new work cannot start");
        this.events.append("turn", turnId, "turn.created", { turnId, threadId, botId });
        this.#recordDurableActivity(botId, threadId, turnId);
        const privateDir = ensurePrivateFolder(botId, this.cfg.sharedWorkspaceDir);
        resolveWorkCwd(this.threads.getThread(threadId)!.cwd);
        return privateDir;
      },
    }), input.acceptanceFailureReason);
  }

  async #steerDurable(turn: TurnDto, text: string): Promise<SendResultDto> {
    const userMsg = this.threads.appendMessage(turn.threadId, {
      author: { kind: "user" }, kind: "text", text, payload: { turnId: turn.id },
    });
    this.bots.recordUserMessage(turn.botId, turn.threadId);
    try {
      await this.runtime.steer(turn.id, text, userMsg.id);
      this.db.query(`UPDATE turns SET steer_count = steer_count + 1 WHERE id = ?`).run(turn.id);
      this.events.append("turn", turn.id, "turn.steered", { turnId: turn.id, threadId: turn.threadId, messageId: userMsg.id });
    } catch (err) {
      const reason = errorMessage(err);
      this.#emitSystemNote(turn.threadId, `steer unavailable: ${reason}`);
      throw new HttpError(409, `steer unavailable: ${reason}`);
    }
    return { threadId: turn.threadId, messageId: userMsg.id, turnId: turn.id, action: "steered" };
  }

  #finishInterruptedDurableTurn(turnId: string, threadId: string | undefined, status: "failed" | "cancelled", reason: string): void {
    if (this.#suspended.has(turnId)) return;
    if (threadId !== undefined) this.#removeIncompleteAgentBlocks(threadId, turnId);
    const restartReason = status === "cancelled" && !this.#durableAbortReasons.has(turnId) ? this.#restartReason : undefined;
    this.#setTurnStatus(turnId, restartReason === undefined ? status : "failed", restartReason ?? reason);
  }

  #removeIncompleteAgentBlocks(threadId: string, turnId: string): void {
    const removed = this.threads.removeIncompleteAgentBlocks(turnId);
    if (removed.responses > 0) this.events.append("thread", threadId, "response.removed", { threadId, turnId, count: removed.responses });
    if (removed.thinking > 0) this.events.append("thread", threadId, "thinking.removed", { threadId, turnId, count: removed.thinking });
  }

  #emitSystemNote(threadId: string, text: string): void {
    this.threads.appendMessage(threadId, { author: { kind: "system" }, kind: "text", text });
  }

  /**
   * Resolve only after the persisted turn is terminal. Bot lifecycle services
   * use this barrier so a Bot cannot disappear while its Turn is still working.
   */
  waitForTerminal(turnId: string, timeoutMs = 30_000): Promise<TurnDto> {
    const current = this.#turnDto(turnId);
    if (current === undefined) return Promise.reject(new HttpError(404, `unknown turn ${turnId}`));
    if (isTerminalTurn(current.status)) return Promise.resolve(current);

    return new Promise<TurnDto>((resolve, reject) => {
      let waiter: TerminalTurnWaiter;
      const timeout = setTimeout(() => {
        const waiters = this.#terminalWaiters.get(turnId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.#terminalWaiters.delete(turnId);
        reject(new HttpError(502, `turn ${turnId} did not stop`));
      }, timeoutMs);
      waiter = { resolve, timeout };
      const waiters = this.#terminalWaiters.get(turnId) ?? new Set<TerminalTurnWaiter>();
      waiters.add(waiter);
      this.#terminalWaiters.set(turnId, waiters);
    });
  }

  /** Internal cancellation for lifecycle services and timeout recovery. */
  async abortTurn(turnId: string, reason: string): Promise<void> {
    const t = this.threads.turnRow(turnId);
    if (!t || isTerminalTurn(t.status as TurnStatus) || !this.#durableTurns.has(turnId)) return;
    this.#durableAbortReasons.set(turnId, reason);
    try {
      await this.runtime.abortTurn(turnId);
    } catch (error) {
      this.#durableAbortReasons.delete(turnId);
      throw new HttpError(409, `turn abort failed: ${errorMessage(error)}`);
    }
  }
}
