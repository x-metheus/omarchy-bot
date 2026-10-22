import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  isAgentToolCallEvent,
  toolCallSummaryFromEvent,
  type AgentBotMessageToolOutput,
  type AgentBotMessageToolRequest,
  type AgentComputerToolOutput,
  type AgentComputerToolRequest,
  type AgentEvent,
  type WorkerUserMessage,
  type AgentPluginToolRequest,
  type AgentPluginToolOutput,
  type AgentLocalToolRequest,
  type AgentLocalToolOutput,
} from "@omarchy-bot/agent-contract";
import type { SendResultDto, TurnDto } from "@omarchy-bot/protocol";
import type { AgentId, SurfaceId, TurnStatus } from "@omarchy-bot/domain";
import { canTransitionTurn, isTerminalTurn } from "@omarchy-bot/domain";
import type { ThreadsService } from "../threads/threads.ts";
import type { AgentsRegistry } from "../agents/registry.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import type { AttachmentsService } from "../attachments/attachments.ts";
import type { Supervisor } from "../../supervision/supervisor.ts";
import { HttpError } from "../bots/bots.ts";
import type { ComputerBroker } from "../computer/broker.ts";
import type { MailboxService } from "../mailbox/mailbox.ts";
import { confinedWorkspacePath, resolveWorkCwd } from "../workspace/sharedWorkspace.ts";
import type { PluginsService, PluginLease } from "../plugins/plugins.ts";
import type { DeviceRoster } from "../devices/deviceRoster.ts";

interface TurnContext {
  turnId: string;
  threadId: string;
  botId: string;
  agentId: AgentId;
  workerSessionId: string;
  computerToolSurfaces: Map<string, SurfaceId>;
  startedComputerToolCalls: Set<string>;
  startedBotMessageToolCalls: Set<string>;
  startedLocalToolCalls: Set<string>;
  pluginLease?: PluginLease;
  startedPluginToolCalls: Map<string, string>;
  dispatchedPluginToolCalls: Set<string>;
  dispatchedLocalToolCalls: Set<string>;
  closeSession(): void;
  turnTimeout: ReturnType<typeof setTimeout>;
  /** Present only when cancellation came from the explicit abort path. */
  abortReason?: string;
  /** A timeout remains a failed Turn even when native abort reports cancellation. */
  timeoutFailureReason?: string;
}

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

function agentEventFamily(event: AgentEvent): string {
  return event.type === "native" ? "native" : event.type.split(".", 1)[0]!;
}

/**
 * Owns the turn lifecycle: send (atomic thread+message+turn when the thread
 * is new), steer (mid-turn redirect), and the worker event routing that ends
 * turns. Completion only arrives via terminal worker events, timeout or abort
 * — fail closed.
 */
export class TurnService {
  #turns = new Map<string, TurnContext>(); // workerSessionId -> ctx
  #turnStarts = new Map<string, Promise<TurnContext>>();
  #terminalWaiters = new Map<string, Set<TerminalTurnWaiter>>();
  #timeoutQueues = new Map<AgentId, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly threads: ThreadsService,
    private readonly agents: AgentsRegistry,
    private readonly bots: BotsService,
    private readonly attachments: AttachmentsService,
    private readonly supervisor: Supervisor,
    private readonly cfg: { turnTimeoutMs: number; sharedWorkspaceDir: string },
    private readonly plugins: PluginsService,
    private readonly devices: DeviceRoster,
  ) {}

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
    this.bots.recordActivityStatus(t.bot_id, t.thread_id, turnId);
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
    opts: { cwd?: string } = {},
  ): Promise<SendResultDto> {
    const bot = this.db.query(`SELECT * FROM bots WHERE id = ?`).get(botId) as { id: string; agent_id: string; instructions: string } | undefined;
    if (!bot) throw new HttpError(404, `unknown bot ${botId}`);
    if (
      this.db.query(`SELECT bot_id FROM bot_deletions WHERE bot_id = ? AND state = 'cleaning'`).get(botId) !== null
    ) {
      throw new HttpError(409, "bot deletion is in progress; new work cannot start");
    }
    const agentId = bot.agent_id as AgentId;
    if (this.#timeoutQueues.has(agentId)) {
      throw new HttpError(409, `agent '${agentId}' is stopping a timed-out session; the bot cannot chat right now`);
    }
    const capabilities = this.agents.capabilityInventory(agentId);
    if (!this.agents.isReady(agentId) || capabilities === undefined) {
      throw new HttpError(409, `agent '${agentId}' is not ready; the bot cannot chat right now`);
    }

    // Active turn on the thread -> steer instead of a new turn.
    const existingThreadId = threadId ?? undefined;
    if (existingThreadId !== undefined) {
      const thread = this.threads.getThread(existingThreadId);
      if (!thread || thread.botId !== botId) throw new HttpError(404, `unknown thread ${existingThreadId} for bot ${botId}`);
      const active = this.threads.activeTurn(existingThreadId);
      if (active !== undefined) {
        if (attachmentIds.length > 0) throw new HttpError(409, "attachments cannot be added while steering an active turn");
        return this.#steer(active, text, agentId);
      }
      if (
        this.threads.getNativeSession(existingThreadId) !== undefined
        && !capabilities.nativeThreadActions.includes("resume")
      ) {
        throw new HttpError(409, `session resume is not supported by ${agentId}`);
      }
    }

    const turnId = `turn_${randomUUID().replace(/-/g, "")}`;
    const result: {
      threadId: string;
      messageId: string;
      workerAttachments: NonNullable<WorkerUserMessage["attachments"]>;
    } = this.db.transaction(() => {
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
      const workerAttachments = this.attachments.promoteForMessage({
        attachmentIds,
        botId,
        threadId: tid,
        messageId: userMsg.id,
        draftToken: attachmentDraftToken,
      });
      return { threadId: tid, messageId: userMsg.id, workerAttachments };
    })();

    this.events.append("thread", result.threadId, "thread.created", { botId, threadId: result.threadId, turnId });
    const userMsgDto = this.threads.getMessage(result.messageId)!;
    this.events.append("thread", result.threadId, "message.appended", userMsgDto);
    this.events.append("turn", turnId, "turn.created", { turnId, threadId: result.threadId, botId });
    this.bots.recordActivityStatus(botId, result.threadId, turnId);
    this.bots.recordUserMessage(botId, result.threadId);
    const start = this.#startTurn(turnId, result.threadId, botId, agentId, text, result.workerAttachments);
    this.#turnStarts.set(turnId, start);
    void start
      .catch((err: unknown) => {
        const row = this.threads.turnRow(turnId);
        if (!row || isTerminalTurn(row.status as TurnStatus)) return;
        const reason = errorMessage(err);
        this.#setTurnStatus(turnId, "failed", reason);
      })
      .finally(() => {
        if (this.#turnStarts.get(turnId) === start) this.#turnStarts.delete(turnId);
      });
    return { threadId: result.threadId, messageId: result.messageId, turnId, action: "sent" };
  }

  /**
   * Start a daemon-authored peer-mail Turn that was already persisted by the
   * mailbox claim transaction. It always opens a fresh Native Session and
   * resolves only when the worker accepts message.send, not when the Turn ends.
   */
  async startPeerMailTurn(input: {
    turnId: string;
    threadId: string;
    botId: string;
    agentId: AgentId;
    envelope: string;
    acceptanceFailureReason: string;
  }): Promise<void> {
    this.events.append("turn", input.turnId, "turn.created", {
      turnId: input.turnId,
      threadId: input.threadId,
      botId: input.botId,
    });
    this.bots.recordActivityStatus(input.botId, input.threadId, input.turnId);
    const start = this.#startTurn(
      input.turnId,
      input.threadId,
      input.botId,
      input.agentId,
      input.envelope,
      [],
      {
        freshSession: true,
        awaitAcceptance: true,
        acceptanceFailureReason: input.acceptanceFailureReason,
      },
    );
    this.#turnStarts.set(input.turnId, start);
    try {
      await start;
    } catch (err) {
      console.error(
        `peer-mail Turn ${input.turnId} failed before worker acceptance`,
        err,
      );
      const row = this.threads.turnRow(input.turnId);
      if (row !== undefined && !isTerminalTurn(row.status as TurnStatus)) {
        this.#setTurnStatus(input.turnId, "failed", input.acceptanceFailureReason);
      }
      throw err;
    } finally {
      if (this.#turnStarts.get(input.turnId) === start) {
        this.#turnStarts.delete(input.turnId);
      }
    }
  }

  async #startTurn(
    turnId: string,
    threadId: string,
    botId: string,
    agentId: AgentId,
    text: string,
    attachments: NonNullable<WorkerUserMessage["attachments"]>,
    startOptions: {
      freshSession?: boolean;
      awaitAcceptance?: boolean;
      acceptanceFailureReason?: string;
    } = {},
  ): Promise<TurnContext> {
    const botRow = this.db.query(`SELECT instructions FROM bots WHERE id = ?`).get(botId) as { instructions: string } | undefined;
    const thread = this.threads.getThread(threadId)!;
    const pluginLease = this.agents.capabilityInventory(agentId)?.plugins ? await this.plugins.acquire() : undefined;
    let leaseTransferred = false;
    try {
    const worker = await this.supervisor.agentWorker(agentId);
    const nativeSessionId = startOptions.freshSession
      ? undefined
      : this.threads.getNativeSession(threadId);
    const options = { cwd: resolveWorkCwd(thread.cwd), instructions: botRow?.instructions ?? "", ...(pluginLease ? { plugins: pluginLease.snapshot } : {}) };
    if (
      nativeSessionId !== undefined
      && !this.agents.capabilityInventory(agentId)?.nativeThreadActions.includes("resume")
    ) {
      throw new HttpError(409, `session resume is not supported by ${agentId}`);
    }
    const opened = nativeSessionId === undefined
      ? await worker.request({ type: "session.open", botId, threadId, options }, 30_000)
      : await worker.request({ type: "session.resume", botId, threadId, nativeSessionId, options }, 30_000);

    this.threads.setNativeSession(threadId, opened.nativeSessionId);
    const surface = this.db
      .query(`SELECT surface_id FROM bot_surfaces WHERE bot_id = ?`)
      .get(botId) as { surface_id: SurfaceId } | null;
    if (surface === null) throw new Error(`Bot ${botId} has no Computer Surface`);
    this.db.query(`UPDATE turns SET worker_session_id = ?, native_session_id = ? WHERE id = ?`).run(opened.sessionId, opened.nativeSessionId, turnId);

    const turnTimeout = setTimeout(() => {
      const active = this.#turns.get(opened.sessionId);
      if (active !== undefined) this.#queueTimeout(active);
    }, this.cfg.turnTimeoutMs);
    turnTimeout.unref?.();

    const ctx: TurnContext = {
      turnId,
      threadId,
      botId,
      agentId,
      workerSessionId: opened.sessionId,
      computerToolSurfaces: new Map(),
      startedComputerToolCalls: new Set(),
      startedBotMessageToolCalls: new Set(),
      startedLocalToolCalls: new Set(),
      ...(pluginLease ? { pluginLease } : {}),
      startedPluginToolCalls: new Map(),
      dispatchedPluginToolCalls: new Set(),
      dispatchedLocalToolCalls: new Set(),
      closeSession: () => {
        if (worker.alive) void worker.request({ type: "session.close", sessionId: opened.sessionId }, 5_000).catch(() => {
          this.events.append("agent", agentId, "agent.error", { agentId, message: "Could not close an idle native session", retryable: false });
        });
      },
      turnTimeout,
    };
    this.#turns.set(opened.sessionId, ctx);
    leaseTransferred = true;
    this.#setTurnStatus(turnId, "working");

    // Worker acceptance is separate from terminal Turn output. Conversational
    // starts remain steerable as soon as the session opens; peer mail awaits
    // only message.send acceptance so its durable delivery boundary is exact.
    const message: WorkerUserMessage = {
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const acceptance = worker.request({
      type: "message.send",
      sessionId: opened.sessionId,
      turnId,
      message,
      computer: {
        botId,
        turnId,
        workerSessionId: opened.sessionId,
        surfaceId: surface.surface_id,
      },
      botMessage: {
        botId,
        turnId,
        workerSessionId: opened.sessionId,
      },
      ...(pluginLease ? { plugins: { botId, turnId, workerSessionId: opened.sessionId } } : {}),
      ...(this.devices.list().length > 0
        ? { local: { botId, turnId, workerSessionId: opened.sessionId } }
        : {}),
    }, 60_000);
    const failSend = (err: unknown): void => {
      if (this.#turns.get(opened.sessionId) !== ctx) return;
      this.#routeTurnEvent(ctx, {
        type: "error",
        sessionId: opened.sessionId,
        message: errorMessage(err),
        retryable: false,
      });
    };
    if (startOptions.awaitAcceptance) {
      try {
        await acceptance;
      } catch (err) {
        this.#finishTurn(
          ctx,
          "failed",
          startOptions.acceptanceFailureReason ?? errorMessage(err),
        );
        throw err;
      }
    } else {
      void acceptance.catch(failSend);
    }
    return ctx;
    } finally {
      if (!leaseTransferred) pluginLease?.release();
    }
  }

  async #steer(turn: TurnDto, text: string, agentId: AgentId): Promise<SendResultDto> {
    if (!this.agents.capabilityInventory(agentId)?.steering) {
      throw new HttpError(409, `steering is not supported by ${agentId}`);
    }
    // Supported redirects appear immediately, even while the initial worker
    // session is still opening.
    const userMsg = this.threads.appendMessage(turn.threadId, {
      author: { kind: "user" }, kind: "text", text, payload: { turnId: turn.id },
    });
    this.bots.recordUserMessage(turn.botId, turn.threadId);
    try {
      let ctx = [...this.#turns.values()].find((candidate) => candidate.turnId === turn.id);
      if (!ctx) {
        const starting = this.#turnStarts.get(turn.id);
        if (!starting) throw new Error("active turn has no worker session");
        ctx = await starting;
      }
      const current = this.threads.turnRow(turn.id);
      if (!current || isTerminalTurn(current.status as TurnStatus) || this.#turns.get(ctx.workerSessionId) !== ctx) {
        throw new Error("turn is no longer active");
      }
      if (!this.agents.capabilityInventory(ctx.agentId)?.steering) {
        throw new Error(`steering is no longer supported by ${ctx.agentId}`);
      }
      const worker = await this.supervisor.agentWorker(ctx.agentId);
      await worker.request({ type: "message.steer", sessionId: ctx.workerSessionId, text }, 30_000);
      this.db.query(`UPDATE turns SET steer_count = steer_count + 1 WHERE id = ?`).run(turn.id);
      this.events.append("turn", turn.id, "turn.steered", {
        turnId: turn.id,
        threadId: turn.threadId,
        messageId: userMsg.id,
      });
    } catch (err) {
      // A rejected native steer is transcript-visible but never changes,
      // aborts, or replaces the original turn.
      const reason = errorMessage(err);
      this.#emitSystemNote(turn.threadId, `steer unavailable: ${reason}`);
      throw new HttpError(409, `steer unavailable: ${reason}`);
    }
    return { threadId: turn.threadId, messageId: userMsg.id, turnId: turn.id, action: "steered" };
  }

  onAgentWorkerCrash(agentId: AgentId, error: Error): void {
    for (const context of [...this.#turns.values()]) {
      if (context.agentId !== agentId) continue;
      this.#routeTurnEvent(context, {
        type: "error",
        sessionId: context.workerSessionId,
        message: error.message,
        retryable: false,
      });
    }
  }

  /** Routes a reverse worker RPC only after matching every authoritative turn identity. */
  async onAgentComputerRequest(
    agentId: AgentId,
    request: AgentComputerToolRequest,
    computer: ComputerBroker,
    signal: AbortSignal,
  ): Promise<AgentComputerToolOutput> {
    const context = request.context;
    const active = this.#turns.get(context.workerSessionId);
    if (
      active === undefined
      || active.agentId !== agentId
      || active.botId !== context.botId
      || active.turnId !== context.turnId
      || active.workerSessionId !== context.workerSessionId
    ) {
      throw new Error("computer tool context is stale or mismatched");
    }
    if (context.toolCallId.length === 0) {
      throw new Error("computer tool context has no tool-call identity");
    }
    if (!active.startedComputerToolCalls.has(context.toolCallId)) {
      throw new Error("computer tool context has no active native tool call");
    }
    const owner = computer.resolveOwner(context.botId, context.surfaceId);
    if (owner === undefined) {
      throw new Error("computer tool context has a mismatched Computer Surface");
    }
    if (active.computerToolSurfaces.has(context.toolCallId)) {
      throw new Error("computer tool call was already dispatched");
    }
    active.computerToolSurfaces.set(context.toolCallId, owner.surfaceId);
    return computer.agentToolAct(owner, context.turnId, context.toolCallId, request.action, signal);
  }

  /** Authenticate a reverse Bot-message request against one active native Tool Call. */
  async onAgentBotMessageRequest(
    agentId: AgentId,
    request: AgentBotMessageToolRequest,
    mailbox: MailboxService,
  ): Promise<AgentBotMessageToolOutput> {
    const requested = request.context;
    const active = this.#turns.get(requested.workerSessionId);
    if (
      active === undefined
      || active.agentId !== agentId
      || active.botId !== requested.botId
      || active.turnId !== requested.turnId
      || active.workerSessionId !== requested.workerSessionId
    ) {
      throw new Error("Bot message tool context is stale or mismatched");
    }
    if (!this.agents.capabilityInventory(agentId)?.botMail) {
      throw new Error(`Bot mail is not supported by ${agentId}`);
    }
    if (requested.toolCallId.length === 0) {
      throw new Error("Bot message tool context has no tool-call identity");
    }
    if (!active.startedBotMessageToolCalls.has(requested.toolCallId)) {
      throw new Error("Bot message tool context has no active native tool call");
    }
    return mailbox.enqueue(
      {
        botId: active.botId,
        turnId: active.turnId,
        workerSessionId: active.workerSessionId,
        toolCallId: requested.toolCallId,
      },
      request.targetBotId,
      request.text,
    );
  }

  /** Fan a Turn-bound `local` request to one online Sidecar; never execute it here. */
  async onAgentLocalRequest(
    agentId: AgentId,
    request: AgentLocalToolRequest,
    devices: DeviceRoster,
    signal: AbortSignal,
  ): Promise<AgentLocalToolOutput> {
    const requested = request.context;
    const active = this.#turns.get(requested.workerSessionId);
    if (
      active === undefined
      || active.agentId !== agentId
      || active.botId !== requested.botId
      || active.turnId !== requested.turnId
      || active.workerSessionId !== requested.workerSessionId
    ) {
      throw new Error("local tool context is stale or mismatched");
    }
    if (requested.toolCallId.length === 0) {
      throw new Error("local tool context has no tool-call identity");
    }
    if (!active.startedLocalToolCalls.has(requested.toolCallId)) {
      throw new Error("local tool context has no active native tool call");
    }
    if (active.dispatchedLocalToolCalls.has(requested.toolCallId)) {
      throw new Error("local tool call was already dispatched");
    }
    signal.throwIfAborted();
    const device = devices.resolve(request.target);
    const needed =
      request.action === "run" ? "shell"
      : request.action === "search" ? "search"
      : request.action === "transfer" ? "transfer"
      : "files";
    if (!device.capabilities.includes(needed)) {
      throw new Error(`Local Sidecar ${device.hostname} cannot ${request.action}`);
    }
    if (request.action === "search" && (request.query === "/" || request.path === "/")) {
      throw new Error("Local Sidecar search cannot scan /");
    }
    const job = this.#workspaceTransfer(request);
    signal.throwIfAborted();
    active.dispatchedLocalToolCalls.add(requested.toolCallId);
    const result = await devices.dispatch({
      deviceId: device.id,
      action: request.action,
      botId: active.botId,
      turnId: active.turnId,
      ...(request.command !== undefined ? { command: request.command } : {}),
      ...(request.path !== undefined ? { path: request.path } : {}),
      ...(request.destination !== undefined ? { destination: request.destination } : {}),
      ...(request.query !== undefined ? { query: request.query } : {}),
      ...(job.contents !== undefined ? { contents: job.contents } : {}),
      ...(request.direction !== undefined ? { direction: request.direction } : {}),
    });
    signal.throwIfAborted();
    if (request.action === "transfer" && request.direction === "to-workspace") {
      if (request.destination === undefined) {
        throw new Error("transfer into Shared Workspace requires an explicit destination path");
      }
      const dest = confinedWorkspacePath(request.destination, this.cfg.sharedWorkspaceDir);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, result.text);
    }
    return {
      deviceId: result.deviceId,
      hostname: result.hostname,
      text: result.text,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
  }

  #workspaceTransfer(request: AgentLocalToolRequest): { contents?: string } {
    if (request.action !== "transfer" || request.direction !== "from-workspace") {
      return request.contents === undefined ? {} : { contents: request.contents };
    }
    if (request.path === undefined || request.destination === undefined) {
      throw new Error("transfer onto a Sidecar requires an explicit destination path");
    }
    const source = confinedWorkspacePath(request.path, this.cfg.sharedWorkspaceDir);
    return { contents: readFileSync(source, "utf8") };
  }

  async onAgentPluginRequest(agentId: AgentId, request: AgentPluginToolRequest, signal: AbortSignal): Promise<AgentPluginToolOutput> {
    const context = request.context;
    const active = this.#turns.get(context.workerSessionId);
    if (!active || active.agentId !== agentId || active.botId !== context.botId || active.turnId !== context.turnId
      || active.workerSessionId !== context.workerSessionId || !active.pluginLease) throw new Error("Plugin tool context is stale or mismatched");
    if (active.startedPluginToolCalls.get(context.toolCallId) !== request.name) throw new Error("Plugin request does not match an active native tool call");
    if (active.dispatchedPluginToolCalls.has(context.toolCallId)) throw new Error("Plugin tool call was already dispatched");
    active.dispatchedPluginToolCalls.add(context.toolCallId);
    return active.pluginLease.call(request.name, request.arguments, signal);
  }

  /** Central agent-event router: worker events become ordered transcript records and Turn transitions. */
  onAgentEvent(agentId: AgentId, event: AgentEvent): void {
    const family = agentEventFamily(event);
    const inventory = this.agents.capabilityInventory(agentId);
    if (inventory === undefined) {
      this.events.append("agent", agentId, "agent.event_rejected", {
        agentId,
        family,
        eventType: event.type,
        reason: "event was not emitted by the exact ready agent capability inventory",
      });
      return;
    }
    if (family === "tool" && !isAgentToolCallEvent(event)) {
      this.events.append("agent", agentId, "agent.event_rejected", {
        agentId,
        family,
        eventType: event.type,
        reason: "Tool Call event was not a validated safe summary",
      });
      return;
    }
    if (
      family === "thinking" &&
      (!inventory.thinking.supported ||
        (event.type === "thinking.delta" && !inventory.thinking.streaming))
    ) {
      this.events.append("agent", agentId, "agent.event_rejected", {
        agentId,
        family,
        eventType: event.type,
        reason: "Thinking event was not declared by the ready agent capability inventory",
      });
      return;
    }
    if (
      event.type === "native" &&
      (
        event.agentId !== agentId ||
        typeof event.capability !== "string" ||
        event.capability.length === 0 ||
        (
          event.sensitivity !== "public" &&
          event.sensitivity !== "diagnostic" &&
          event.sensitivity !== "secret"
        ) ||
        !inventory.nativeEventFamilies.includes(event.capability)
      )
    ) {
      this.events.append("agent", agentId, "agent.event_rejected", {
        agentId,
        family,
        eventType: event.type,
        capability: event.capability,
        sensitivity: event.sensitivity,
        reason: "Native Event capability was not declared by the exact ready agent inventory",
      });
      return;
    }
    const sessionId = event.sessionId;
    if (event.type !== "error" || sessionId !== undefined) {
      const ctx = sessionId !== undefined ? this.#turns.get(sessionId) : undefined;
      if (ctx) return this.#routeTurnEvent(ctx, event);
    }
    if (event.type === "error") this.events.append("agent", agentId, "agent.error", { agentId, message: event.message, retryable: event.retryable });
  }

  #routeTurnEvent(ctx: TurnContext, event: AgentEvent): void {
    switch (event.type) {
      case "response.start": {
        if (
          event.blockId.length === 0 ||
          !Number.isFinite(Date.parse(event.startedAt)) ||
          this.threads.hasResponseBlock(event.blockId)
        ) break;
        this.threads.appendMessage(ctx.threadId, {
          author: { kind: "bot" },
          kind: "response",
          text: "",
          turnId: ctx.turnId,
          response: {
            blockId: event.blockId,
            state: "streaming",
            startedAt: event.startedAt,
          },
        });
        break;
      }
      case "response.delta": {
        if (event.text.length === 0) break;
        const response = this.threads.appendResponseDelta(
          ctx.threadId,
          ctx.turnId,
          event.blockId,
          event.text,
        );
        if (response !== undefined) {
          this.events.append("thread", ctx.threadId, "response.updated", response);
        }
        break;
      }
      case "response.end": {
        if (!Number.isFinite(Date.parse(event.completedAt))) break;
        const response = this.threads.completeResponse(
          ctx.threadId,
          ctx.turnId,
          event.blockId,
          event.completedAt,
        );
        if (response !== undefined) {
          this.events.append("thread", ctx.threadId, "response.updated", response);
          if (response.text?.trim()) {
            this.bots.recordResponse(ctx.botId, ctx.threadId, response.text.trim());
          }
        }
        break;
      }
      case "thinking.start": {
        if (
          event.blockId.length === 0 ||
          !Number.isFinite(Date.parse(event.startedAt)) ||
          this.threads.hasThinkingBlock(event.blockId)
        ) break;
        this.threads.appendMessage(ctx.threadId, {
          author: { kind: "bot" },
          kind: "thinking",
          text: "",
          turnId: ctx.turnId,
          thinking: {
            blockId: event.blockId,
            state: "streaming",
            startedAt: event.startedAt,
          },
        });
        break;
      }
      case "thinking.delta": {
        if (event.text.length === 0) break;
        const thinking = this.threads.appendThinkingDelta(
          ctx.threadId,
          ctx.turnId,
          event.blockId,
          event.text,
        );
        if (thinking !== undefined) {
          this.events.append("thread", ctx.threadId, "thinking.updated", thinking);
        }
        break;
      }
      case "thinking.end": {
        if (!Number.isFinite(Date.parse(event.completedAt))) break;
        const thinking = this.threads.completeThinking(
          ctx.threadId,
          ctx.turnId,
          event.blockId,
          event.completedAt,
        );
        if (thinking !== undefined) {
          this.events.append("thread", ctx.threadId, "thinking.updated", thinking);
        }
        break;
      }
      case "tool.started": {
        if (!isAgentToolCallEvent(event) || this.threads.hasToolCall(ctx.threadId, event.id)) break;
        const toolCall = toolCallSummaryFromEvent(event);
        this.threads.appendMessage(ctx.threadId, {
          author: { kind: "bot" },
          kind: "tool",
          turnId: ctx.turnId,
          toolCall,
        });
        if (event.name === "computer") {
          ctx.startedComputerToolCalls.add(event.id);
        }
        if (event.name === "send_bot_message") {
          ctx.startedBotMessageToolCalls.add(event.id);
        }
        if (event.name === "local") {
          ctx.startedLocalToolCalls.add(event.id);
        }
        if (ctx.pluginLease?.snapshot.tools.some((tool) => tool.name === event.name)) {
          ctx.startedPluginToolCalls.set(event.id, event.name);
        }
        break;
      }
      case "tool.updated":
      case "tool.completed": {
        if (!isAgentToolCallEvent(event)) break;
        const toolCall = toolCallSummaryFromEvent(event);
        const updated = this.threads.updateToolCall(ctx.threadId, toolCall);
        if (updated !== undefined) {
          this.events.append("thread", ctx.threadId, "tool.updated", {
            threadId: ctx.threadId,
            messageId: updated.id,
            toolCall: updated.toolCall,
          });
        }
        if (event.type === "tool.completed") {
          ctx.startedComputerToolCalls.delete(event.id);
          ctx.startedBotMessageToolCalls.delete(event.id);
          ctx.startedLocalToolCalls.delete(event.id);
          ctx.dispatchedLocalToolCalls.delete(event.id);
          ctx.startedPluginToolCalls.delete(event.id);
        }
        break;
      }
      case "turn.completed": {
        this.#finishTurn(ctx, "completed");
        break;
      }
      case "turn.cancelled": {
        if (ctx.timeoutFailureReason !== undefined) {
          this.#finishTurn(ctx, "failed", ctx.timeoutFailureReason);
        } else {
          this.#finishTurn(ctx, "cancelled", ctx.abortReason);
        }
        break;
      }
      case "error": {
        this.#finishTurn(ctx, "failed", event.message);
        break;
      }
      case "native": {
        const transcriptPayload = {
          capability: event.capability,
          sensitivity: event.sensitivity,
          ...(event.sensitivity === "public" ? { payload: event.payload } : { redacted: true }),
        };
        this.threads.appendMessage(ctx.threadId, {
          author: { kind: "bot" },
          kind: "event",
          payload: transcriptPayload,
        });
        this.events.append("turn", ctx.turnId, "agent.native", {
          threadId: ctx.threadId,
          botId: ctx.botId,
          ...transcriptPayload,
        });
        break;
      }
    }
  }


  #finishTurn(ctx: TurnContext, outcome: "completed" | "cancelled" | "failed", reason?: string): void {
    if (this.#turns.get(ctx.workerSessionId) !== ctx) return;
    clearTimeout(ctx.turnTimeout);
    this.#turns.delete(ctx.workerSessionId);
    ctx.pluginLease?.release();
    ctx.closeSession();
    const removedIncompleteBlocks = this.threads.removeIncompleteAgentBlocks(ctx.turnId);
    if (removedIncompleteBlocks.responses > 0) {
      this.events.append("thread", ctx.threadId, "response.removed", {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        count: removedIncompleteBlocks.responses,
      });
    }
    if (removedIncompleteBlocks.thinking > 0) {
      this.events.append("thread", ctx.threadId, "thinking.removed", {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        count: removedIncompleteBlocks.thinking,
      });
    }
    const interruptedToolCalls = this.threads.finalizeIncompleteToolCalls(ctx.turnId);
    for (const message of interruptedToolCalls) {
      this.events.append("thread", ctx.threadId, "tool.updated", {
        threadId: ctx.threadId,
        messageId: message.id,
        toolCall: message.toolCall,
      });
    }



    if (outcome === "cancelled") {
      this.#emitSystemNote(
        ctx.threadId,
        reason === undefined ? "turn cancelled" : `turn cancelled: ${reason}`,
      );
    }

    this.#setTurnStatus(ctx.turnId, outcome, reason);
  }

  #emitSystemNote(threadId: string, text: string): void {
    this.threads.appendMessage(threadId, { author: { kind: "system" }, kind: "text", text });
  }

  #queueTimeout(ctx: TurnContext): void {
    const previous = this.#timeoutQueues.get(ctx.agentId) ?? Promise.resolve();
    const queued = previous
      .catch(() => {
        // A prior timeout still must not prevent this expired turn from settling.
      })
      .then(() => this.#timeoutTurn(ctx))
      .finally(() => {
        if (this.#timeoutQueues.get(ctx.agentId) === queued) {
          this.#timeoutQueues.delete(ctx.agentId);
        }
      });
    this.#timeoutQueues.set(ctx.agentId, queued);
  }

  async #timeoutTurn(ctx: TurnContext): Promise<void> {
    if (this.#turns.get(ctx.workerSessionId) !== ctx) return;
    const reason = `timed out after ${Math.round(this.cfg.turnTimeoutMs / 1000)}s`;
    let cancellationConfirmed = false;
    try {
      if (this.agents.capabilityInventory(ctx.agentId)?.abort) {
        ctx.timeoutFailureReason = reason;
        const worker = await this.supervisor.agentWorker(ctx.agentId);
        await worker.request({ type: "turn.abort", sessionId: ctx.workerSessionId }, 30_000);
        await this.waitForTerminal(ctx.turnId, 5_000);
        cancellationConfirmed = true;
      }
    } catch {
      // A failed or unconfirmed native abort falls through to worker quarantine.
    }
    if (cancellationConfirmed) return;

    await this.supervisor.stopAgentWorker(ctx.agentId);
    this.agents.markOffline(ctx.agentId, `worker stopped after ${reason}`);
    for (const active of [...this.#turns.values()]) {
      if (active.agentId !== ctx.agentId) continue;
      const failureReason =
        active === ctx ? reason : `agent worker stopped after another turn ${reason}`;
      this.#finishTurn(active, "failed", failureReason);
    }
  }


  /**
   * Resolve only after the persisted turn is terminal. Bot lifecycle services
   * use this barrier so a Bot cannot disappear while its native Agent is still working.
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
    if (!t || isTerminalTurn(t.status as TurnStatus)) return;
    const bot = this.db.query(`SELECT agent_id FROM bots WHERE id = ?`).get(t.bot_id) as { agent_id: AgentId } | undefined;
    const agentId = bot?.agent_id;
    if (agentId === undefined || !this.agents.capabilityInventory(agentId)?.abort) {
      throw new HttpError(409, `turn abort is not supported by ${agentId ?? "the turn's agent"}`);
    }
    let ctx = [...this.#turns.values()].find((candidate) => candidate.turnId === turnId);
    if (!ctx) {
      const starting = this.#turnStarts.get(turnId);
      if (starting) ctx = await starting.catch(() => undefined);
    }
    if (ctx) {
      if (!this.agents.capabilityInventory(ctx.agentId)?.abort) {
        throw new HttpError(409, `turn abort is not supported by ${ctx.agentId}`);
      }
      ctx.abortReason = reason;
      try {
        const worker = await this.supervisor.agentWorker(ctx.agentId);
        await worker.request({ type: "turn.abort", sessionId: ctx.workerSessionId }, 30_000);
      } catch (error) {
        throw new HttpError(409, `turn abort failed: ${errorMessage(error)}`);
      }
      return;
    }
    this.#setTurnStatus(turnId, "cancelled", reason);
    this.#emitSystemNote(t.thread_id, `turn cancelled: ${reason}`);
  }
}

