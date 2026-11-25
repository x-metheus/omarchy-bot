import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AgentCapabilityInventory } from "@omarchy-bot/agent-contract";
import {
  TOOL_CALL_INTERRUPTED_ERROR_SUMMARY,
  canTransitionToolCall,
  isStoredPeerMailPayload,
  isToolCallSummary,
  type AgentId,
  type PeerMailMessage,
  type ToolCallSummary,
} from "@omarchy-bot/domain";
import { MessageDto, type AttachmentDto, type ThreadDto, type TurnDto } from "@omarchy-bot/protocol";
import type { EventLog } from "../events/eventLog.ts";

interface ThreadRow {
  id: string; bot_id: string; title: string; cwd: string | null; created_at: string; updated_at: string;
}
interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  author_kind: string;
  kind: string;
  text: string | null;
  payload: string | null;
  created_at: string;
  turn_id: string | null;
  block_id: string | null;
  block_state: string | null;
  block_started_at: string | null;
  block_completed_at: string | null;
}
interface MessageInput {
  author: MessageDto["author"];
  kind: MessageDto["kind"];
  text?: string;
  payload?: unknown;
  peerMail?: PeerMailMessage;
  turnId?: string;
  response?: NonNullable<MessageDto["response"]>;
  thinking?: NonNullable<MessageDto["thinking"]>;
  toolCall?: ToolCallSummary;
  durableToolOccurrence?: string;
}

type ToolCallRow = { id: string; payload: string };

function readToolCall(payload: string): { summary?: ToolCallSummary; durableToolOccurrence?: string } {
  const stored: unknown = JSON.parse(payload);
  if (stored && typeof stored === "object" && "durableToolOccurrence" in stored) {
    const { durableToolOccurrence, ...summary } = stored;
    if (typeof durableToolOccurrence === "string" && isToolCallSummary(summary)) return { summary, durableToolOccurrence };
    return {};
  }
  return isToolCallSummary(stored) ? { summary: stored } : {};
}

function assertMessageInput(message: MessageInput): void {
  if (message.kind === "text") {
    if (message.author.kind === "bot" || message.text === undefined) {
      throw new Error("text messages are required user or system content");
    }
  } else if (message.author.kind !== "bot") {
    throw new Error("ordered Agent transcript records must be Bot-authored");
  }
  if (message.peerMail !== undefined) {
    if (
      message.kind !== "text"
      || message.author.kind !== "system"
      || message.payload !== undefined
      || message.peerMail.deliveryId.length === 0
      || message.peerMail.sourceName.trim().length === 0
    ) {
      throw new Error("peer mail requires a typed system text projection");
    }
  }

  if (message.kind === "response") {
    if (message.text === undefined || message.response === undefined) {
      throw new Error("Responses require text and lifecycle metadata");
    }
  } else if (message.response !== undefined) {
    throw new Error("only Responses can persist Response lifecycle metadata");
  }

  if (message.kind === "thinking") {
    if (message.text === undefined || message.thinking === undefined) {
      throw new Error("Thinking Blocks require text and lifecycle metadata");
    }
  } else if (message.thinking !== undefined) {
    throw new Error("only Thinking Blocks can persist Thinking lifecycle metadata");
  }

  if (message.kind === "tool") {
    if (message.payload !== undefined || !isToolCallSummary(message.toolCall)) {
      throw new Error("Tool Calls require only a validated safe summary");
    }
  } else if (message.toolCall !== undefined || message.durableToolOccurrence !== undefined) {
    throw new Error("only Tool Calls can persist Tool Call summaries");
  }

  if (message.kind === "event" && message.payload === undefined) {
    throw new Error("Native Events require retained metadata");
  }
  if (message.kind !== "text" && message.kind !== "event" && message.payload !== undefined) {
    throw new Error("only text records and Native Events can persist payloads");
  }
  if (
    message.kind !== "text" &&
    message.kind !== "response" &&
    message.kind !== "thinking" &&
    message.text !== undefined
  ) {
    throw new Error("this transcript record cannot persist text");
  }
}
interface MessageAttachmentRow {
  id: string; name: string; media_type: string; size: number;
}
interface TurnRow {
  id: string; thread_id: string; bot_id: string; status: string; worker_session_id: string | null; native_session_id: string; steer_count: number; started_at: string; finished_at: string | null; outcome_reason: string | null;
}


const NONTERMINAL_TURN_SQL = "status NOT IN ('completed','cancelled','failed')";
export interface NativeThreadTitleUpdater {
  renameThread(input: {
    agentId: string;
    threadId: string;
    title: string;
    nativeSessionId?: string;
  }): Promise<void>;
}

export interface NativeThreadCapabilitySource {
  capabilityInventory(agentId: AgentId): AgentCapabilityInventory | undefined;
}

/**
 * Operations execute actions authorized by the probed Agent inventory. Their
 * presence alone never declares support.
 */
export type NativeThreadOperationAdapters = Readonly<
  Partial<Record<AgentId, NativeThreadTitleUpdater>>
>;

const NO_NATIVE_THREAD_OPERATIONS: NativeThreadOperationAdapters = Object.freeze({});

export class ThreadTitleConflict extends Error {
  readonly status = 409;
  readonly code = "THREAD_TITLE_RENAME_UNSUPPORTED";

  constructor(readonly agentId: string) {
    super(`rename not supported by ${agentId}`);
    this.name = "ThreadTitleConflict";
  }
}

/** Threads are created lazily on first send; the message index is the source of truth. */
export class ThreadsService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly capabilities: NativeThreadCapabilitySource,
    private readonly nativeOperations: NativeThreadOperationAdapters = NO_NATIVE_THREAD_OPERATIONS,
  ) {}

  #toThreadDto(row: ThreadRow): ThreadDto {
    const active = this.activeTurn(row.id);
    const latest = this.latestTurn(row.id);
    return {
      id: row.id,
      botId: row.bot_id,
      title: row.title,
      ...(row.cwd !== null ? { cwd: row.cwd } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(active !== undefined ? { activeTurn: active } : {}),
      ...(latest !== undefined ? { latestTurn: latest } : {}),
    };
  }

  /** Insert without events — used inside multi-row transactions. */
  insertThreadRow(threadId: string, botId: string, title: string, cwd?: string): void {
    const now = new Date().toISOString();
    this.db
      .query(`INSERT INTO threads (id, bot_id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(threadId, botId, title, cwd ?? null, now, now);
  }

  createThread(botId: string, opts: { title?: string; cwd?: string }): ThreadDto {
    const id = randomUUID();
    this.insertThreadRow(id, botId, opts.title ?? "New conversation", opts.cwd);
    this.events.append("thread", id, "thread.created", { botId });
    return this.getThread(id)!;
  }

  getThread(id: string): ThreadDto | undefined {
    const r = this.db.query(`SELECT * FROM threads WHERE id = ?`).get(id) as ThreadRow | null;
    return r === null ? undefined : this.#toThreadDto(r);
  }

  listThreads(botId?: string): ThreadDto[] {
    const rows = (
      botId !== undefined
        ? this.db.query(`SELECT * FROM threads WHERE bot_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC`).all(botId)
        : this.db.query(`SELECT * FROM threads ORDER BY updated_at DESC, created_at DESC, id DESC`).all()
    ) as ThreadRow[];
    return rows.map((row) => this.#toThreadDto(row));
  }

  listThreadsForBot(botId: string, q?: string): ThreadDto[] {
    const all = this.listThreads(botId);
    const needle = q?.trim().toLowerCase() ?? "";
    if (needle === "") return all;
    return all.filter((thread) => thread.title.toLowerCase().includes(needle));
  }

  hasRetainedThinkingForBot(botId: string): boolean {
    const row = this.db.query(`
      SELECT 1
      FROM messages
      JOIN threads ON threads.id = messages.thread_id
      WHERE threads.bot_id = ? AND messages.kind = 'thinking'
      LIMIT 1
    `).get(botId);
    return row !== null && row !== undefined;
  }

  /**
   * Rename only through an Agent operation declared by the adapter inventory.
   * The local title changes after the native operation succeeds, never before.
   */
  async updateTitle(id: string, title: string): Promise<ThreadDto | undefined> {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0 || normalizedTitle.length > 120) {
      throw new RangeError("title must contain 1 to 120 characters");
    }

    const identity = this.db
      .query(`
        SELECT bots.agent_id, thread_sessions.native_session_id
        FROM threads
        JOIN bots ON bots.id = threads.bot_id
        LEFT JOIN thread_sessions ON thread_sessions.thread_id = threads.id
        WHERE threads.id = ?
      `)
      .get(id) as { agent_id: string; native_session_id: string | null } | undefined;
    if (identity === undefined) return undefined;

    const agentId = identity.agent_id as AgentId;
    const inventory = this.capabilities.capabilityInventory(agentId);
    if (!inventory?.nativeThreadActions.includes("rename")) throw new ThreadTitleConflict(agentId);
    const updater = this.nativeOperations[agentId];
    if (updater === undefined) throw new ThreadTitleConflict(agentId);

    await updater.renameThread({
      agentId,
      threadId: id,
      title: normalizedTitle,
      ...(identity.native_session_id !== null ? { nativeSessionId: identity.native_session_id } : {}),
    });

    const now = new Date().toISOString();
    this.db.query(`UPDATE threads SET title = ?, updated_at = ? WHERE id = ?`).run(normalizedTitle, now, id);
    this.events.append("thread", id, "thread.updated", { title: normalizedTitle });
    return this.getThread(id);
  }

  touch(id: string): void {
    this.db.query(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  private toMessageDto(m: MessageRow): MessageDto {
    const attachmentRows = this.db
      .query(`SELECT id, name, media_type, size FROM attachments WHERE message_id = ? AND kind = 'managed' ORDER BY created_at, id`)
      .all(m.id) as MessageAttachmentRow[];
    const attachments: AttachmentDto[] = attachmentRows.map((attachment) => ({
      id: attachment.id,
      kind: "managed",
      name: attachment.name,
      mediaType: attachment.media_type,
      size: attachment.size,
      url: `/api/attachments/${attachment.id}`,
    }));
    const storedPayload: unknown = m.payload === null || m.kind === "tool" ? undefined : JSON.parse(m.payload);
    const peerMailPayload =
      m.kind === "text" && m.author_kind === "system" && isStoredPeerMailPayload(storedPayload)
        ? storedPayload
        : undefined;
    const livePeerSource = peerMailPayload === undefined
      ? undefined
      : this.db.query(
          `SELECT source_bot_id FROM bot_mail_deliveries WHERE id = ?`,
        ).get(peerMailPayload.deliveryId) as { source_bot_id: string | null } | null;
    const peerMail = peerMailPayload === undefined
      ? undefined
      : {
          deliveryId: peerMailPayload.deliveryId,
          ...(livePeerSource?.source_bot_id !== null && livePeerSource?.source_bot_id !== undefined
            ? { sourceBotId: livePeerSource.source_bot_id }
            : {}),
          sourceName: peerMailPayload.sourceName,
        };
    const toolCall = m.kind === "tool" && m.payload !== null ? readToolCall(m.payload).summary : undefined;
    if (m.kind === "tool" && toolCall === undefined) {
      throw new Error(`Tool Call message ${m.id} has no valid safe summary`);
    }
    const block =
      (m.kind === "response" || m.kind === "thinking") &&
        m.block_id !== null &&
        m.block_state !== null &&
        m.block_started_at !== null
        ? {
            blockId: m.block_id,
            state: m.block_state as "streaming" | "completed",
            startedAt: m.block_started_at,
            ...(m.block_completed_at !== null ? { completedAt: m.block_completed_at } : {}),
          }
        : undefined;
    return MessageDto.parse({
      id: m.id, threadId: m.thread_id, seq: m.seq,
      author: { kind: m.author_kind },
      kind: m.kind,
      ...(m.text !== null ? { text: m.text } : {}),
      ...(m.kind === "response" && block !== undefined ? { response: block } : {}),
      ...(m.kind === "thinking" && block !== undefined ? { thinking: block } : {}),
      ...(toolCall !== undefined ? { toolCall } : {}),
      ...(peerMail !== undefined ? { peerMail } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(m.kind !== "tool" && peerMail === undefined && storedPayload !== undefined ? { payload: storedPayload } : {}),
      createdAt: m.created_at,
    });
  }

  /**
   * Append without emitting an event — callers inside a turn own the event
   * shape (delta flush, tool cards). Used by TurnService.
   */
  appendMessageQuiet(threadId: string, m: MessageInput): MessageDto {
    assertMessageInput(m);
    const seq = (this.db.query(`SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE thread_id = ?`).get(threadId) as { s: number }).s + 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO messages (
           id, thread_id, seq, author_kind, kind, text, payload, created_at,
           turn_id, block_id, block_state, block_started_at, block_completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        threadId,
        seq,
        m.author.kind,
        m.kind,
        m.text ?? null,
        m.kind === "tool"
          ? JSON.stringify({ ...m.toolCall, durableToolOccurrence: m.durableToolOccurrence })
          : m.peerMail !== undefined
            ? JSON.stringify({ type: "peer-mail", ...m.peerMail })
            : m.payload === undefined
              ? null
              : JSON.stringify(m.payload),
        now,
        m.turnId ?? null,
        (m.response ?? m.thinking)?.blockId ?? null,
        (m.response ?? m.thinking)?.state ?? null,
        (m.response ?? m.thinking)?.startedAt ?? null,
        (m.response ?? m.thinking)?.completedAt ?? null,
      );
    this.touch(threadId);
    return this.getMessage(id)!;
  }

  appendMessage(threadId: string, m: MessageInput, beforeMessageId?: string): MessageDto {
    const append = () => {
      const dto = this.appendMessageQuiet(threadId, m);
      const placed = this.moveMessageBefore(threadId, dto, beforeMessageId) ?? dto;
      this.events.append("thread", threadId, "message.appended", placed);
      return placed;
    };
    return beforeMessageId === undefined ? append() : this.events.transaction(append);
  }

  hasResponseBlock(blockId: string): boolean {
    const row = this.db.query(
      `SELECT 1 FROM messages WHERE kind = 'response' AND block_id = ?`,
    ).get(blockId);
    return row !== null && row !== undefined;
  }

  hasThinkingBlock(blockId: string): boolean {
    const row = this.db.query(
      `SELECT 1 FROM messages WHERE kind = 'thinking' AND block_id = ?`,
    ).get(blockId);
    return row !== null && row !== undefined;
  }

  appendResponseDelta(
    threadId: string,
    turnId: string,
    blockId: string,
    text: string,
  ): MessageDto | undefined {
    const updated = this.db.query(
      `UPDATE messages
       SET text = text || ?
       WHERE thread_id = ? AND turn_id = ? AND kind = 'response'
         AND block_id = ? AND block_state = 'streaming'`,
    ).run(text, threadId, turnId, blockId);
    if (updated.changes !== 1) return undefined;
    const row = this.db.query(
      `SELECT id FROM messages WHERE thread_id = ? AND turn_id = ? AND block_id = ?`,
    ).get(threadId, turnId, blockId) as { id: string };
    return this.getMessage(row.id);
  }

  completeResponse(
    threadId: string,
    turnId: string,
    blockId: string,
    completedAt: string,
  ): MessageDto | undefined {
    const updated = this.db.query(
      `UPDATE messages
       SET block_state = 'completed', block_completed_at = ?
       WHERE thread_id = ? AND turn_id = ? AND kind = 'response'
         AND block_id = ? AND block_state = 'streaming'
         AND block_started_at <= ?`,
    ).run(completedAt, threadId, turnId, blockId, completedAt);
    if (updated.changes !== 1) return undefined;
    const row = this.db.query(
      `SELECT id FROM messages WHERE thread_id = ? AND turn_id = ? AND block_id = ?`,
    ).get(threadId, turnId, blockId) as { id: string };
    return this.getMessage(row.id);
  }

  appendThinkingDelta(
    threadId: string,
    turnId: string,
    blockId: string,
    text: string,
  ): MessageDto | undefined {
    const updated = this.db.query(
      `UPDATE messages
       SET text = text || ?
       WHERE thread_id = ? AND turn_id = ? AND kind = 'thinking'
         AND block_id = ? AND block_state = 'streaming'`,
    ).run(text, threadId, turnId, blockId);
    if (updated.changes !== 1) return undefined;
    const row = this.db.query(
      `SELECT id FROM messages WHERE thread_id = ? AND turn_id = ? AND block_id = ?`,
    ).get(threadId, turnId, blockId) as { id: string };
    return this.getMessage(row.id);
  }

  completeThinking(
    threadId: string,
    turnId: string,
    blockId: string,
    completedAt: string,
  ): MessageDto | undefined {
    const updated = this.db.query(
      `UPDATE messages
       SET block_state = 'completed', block_completed_at = ?
       WHERE thread_id = ? AND turn_id = ? AND kind = 'thinking'
         AND block_id = ? AND block_state = 'streaming'
         AND block_started_at <= ?`,
    ).run(completedAt, threadId, turnId, blockId, completedAt);
    if (updated.changes !== 1) return undefined;
    const row = this.db.query(
      `SELECT id FROM messages WHERE thread_id = ? AND turn_id = ? AND block_id = ?`,
    ).get(threadId, turnId, blockId) as { id: string };
    return this.getMessage(row.id);
  }

  removeIncompleteAgentBlocks(turnId: string): { responses: number; thinking: number } {
    const responses = this.db.query(
      `DELETE FROM messages
       WHERE turn_id = ? AND kind = 'response' AND block_state = 'streaming'`,
    ).run(turnId).changes;
    const thinking = this.db.query(
      `DELETE FROM messages
       WHERE turn_id = ? AND kind = 'thinking' AND block_state = 'streaming'`,
    ).run(turnId).changes;
    return { responses, thinking };
  }

  reconcileAgentBlock(threadId: string, turnId: string, blockId: string, text: string, reopen: boolean): MessageDto | undefined {
    return this.events.transaction(() => {
      const row = this.db.query<{ id: string }, [string, boolean, boolean, string, string, string]>(
        `UPDATE messages SET text = ?,
           block_state = CASE WHEN ? THEN 'streaming' ELSE block_state END,
           block_completed_at = CASE WHEN ? THEN NULL ELSE block_completed_at END
         WHERE thread_id = ? AND turn_id = ? AND block_id = ?
           AND kind IN ('response', 'thinking') RETURNING id`,
      ).get(text, reopen, reopen, threadId, turnId, blockId);
      if (!row) return;
      const message = this.getMessage(row.id)!;
      // Cached completed blocks require a refetch to accept streaming updates again.
      if (reopen) this.events.append("thread", threadId, "message.appended", message);
      this.events.append("thread", threadId, `${message.kind}.updated`, message);
      return message;
    });
  }

  removeAgentBlocks(threadId: string, turnId: string, blockIds: readonly string[]): void {
    if (blockIds.length === 0) return;
    this.events.transaction(() => {
      const counts = new Map<string, number>();
      const remove = this.db.query<{ kind: string }, [string, string, string]>(
        `DELETE FROM messages WHERE thread_id = ? AND turn_id = ? AND block_id = ?
         AND kind IN ('response', 'thinking') RETURNING kind`,
      );
      for (const blockId of blockIds) {
        const row = remove.get(threadId, turnId, blockId);
        if (row) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
      }
      for (const [kind, count] of counts) {
        this.events.append("thread", threadId, `${kind}.removed`, { threadId, turnId, count });
      }
    });
  }

  private moveMessageBefore(threadId: string, message: { id: string; seq: number }, beforeMessageId: string | undefined): MessageDto | undefined {
    if (beforeMessageId === undefined) return undefined;
    const before = this.db.query<{ seq: number }, [string, string]>(
      `SELECT seq FROM messages WHERE thread_id = ? AND id = ?`,
    ).get(threadId, beforeMessageId);
    if (!before || message.seq <= before.seq) return undefined;

    // Open the slot backwards to satisfy UNIQUE(thread_id, seq) on every write.
    const move = this.db.query("UPDATE messages SET seq = ? WHERE id = ?");
    move.run(0, message.id);
    const shifted = this.db.query<{ id: string; seq: number }, [string, number, number]>(
      `SELECT id, seq FROM messages WHERE thread_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC`,
    ).all(threadId, before.seq, message.seq);
    for (const row of shifted) move.run(row.seq + 1, row.id);
    move.run(before.seq, message.id);
    return this.getMessage(message.id);
  }

  listToolCallPositions(threadId: string, turnId: string): { id: string; seq: number; callId: string; occurrence: string | null }[] {
    return this.db.query<{ id: string; seq: number; callId: string; occurrence: string | null }, [string, string]>(
      `SELECT id, seq, json_extract(payload, '$.id') AS callId,
         json_extract(payload, '$.durableToolOccurrence') AS occurrence
       FROM messages WHERE thread_id = ? AND turn_id = ? AND kind = 'tool' ORDER BY seq`,
    ).all(threadId, turnId);
  }

  /** Place a durable call around rows that already streamed. */
  projectToolCall(threadId: string, turnId: string, occurrence: string, toolCall: ToolCallSummary, afterMessageId?: string, beforeMessageId?: string): MessageDto | undefined {
    return this.events.transaction(() => {
      const existing = this.db.query<{ id: string; seq: number; occurrence: string | null }, [string, string, string, string, string]>(
        `SELECT id, seq, json_extract(payload, '$.durableToolOccurrence') AS occurrence
         FROM messages WHERE thread_id = ? AND turn_id = ? AND kind = 'tool'
         AND (occurrence = ? OR (occurrence IS NULL AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.name') = ?))
         ORDER BY occurrence IS NULL, seq LIMIT 1`,
      ).get(threadId, turnId, occurrence, toolCall.id, toolCall.name);
      if (existing) {
        if (existing.occurrence === null) {
          this.db.run("UPDATE messages SET payload = json_set(payload, '$.durableToolOccurrence', ?) WHERE id = ?", [occurrence, existing.id]);
        }
        const moved = this.moveMessageBefore(threadId, existing, beforeMessageId);
        // An append event invalidates the transcript when its neighbors' sequences change.
        if (moved) this.events.append("thread", threadId, "message.appended", moved);
        return moved ?? this.getMessage(existing.id);
      }
      // Legacy rows use the worker's per-Thread deduplication rule.
      if (this.db.query(`SELECT 1 FROM messages WHERE thread_id = ? AND turn_id != ? AND kind = 'tool'
        AND json_extract(payload, '$.durableToolOccurrence') IS NULL AND json_extract(payload, '$.id') = ?`,
      ).get(threadId, turnId, toolCall.id)) return undefined;

      const next = afterMessageId === undefined ? undefined : this.db.query<{ id: string }, [string, string]>(
        `SELECT id FROM messages WHERE thread_id = ? AND seq > (SELECT seq FROM messages WHERE id = ?) ORDER BY seq LIMIT 1`,
      ).get(threadId, afterMessageId);
      return this.appendMessage(threadId, { author: { kind: "bot" }, kind: "tool", turnId, toolCall, durableToolOccurrence: occurrence }, next?.id ?? beforeMessageId);
    });
  }

  hasToolCall(threadId: string, toolCallId: string): boolean {
    const row = this.db.query(
      `SELECT 1 FROM messages
       WHERE thread_id = ? AND kind = 'tool' AND json_extract(payload, '$.id') = ?`,
    ).get(threadId, toolCallId);
    return row !== null && row !== undefined;
  }

  updateToolCall(
    threadId: string,
    summary: ToolCallSummary,
    turnId?: string,
  ): MessageDto | undefined {
    if (!isToolCallSummary(summary)) return undefined;
    const row = this.db
      .query<ToolCallRow, [string, string, string | null, string | null]>(
        `SELECT id, payload FROM messages
         WHERE thread_id = ? AND kind = 'tool' AND json_extract(payload, '$.id') = ?
           AND (? IS NULL OR turn_id = ?)
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(threadId, summary.id, turnId ?? null, turnId ?? null);
    return this.updateToolCallRow(row, summary);
  }

  private updateToolCallRow(row: ToolCallRow | null, summary: ToolCallSummary): MessageDto | undefined {
    if (!row) return undefined;
    const { summary: stored, durableToolOccurrence } = readToolCall(row.payload);
    if (!stored || stored.id !== summary.id || stored.name !== summary.name || !canTransitionToolCall(stored.status, summary.status)) return undefined;
    const updated = { ...stored, ...summary };
    if (!isToolCallSummary(updated)) return undefined;
    this.db.query(`UPDATE messages SET payload = ? WHERE id = ?`).run(JSON.stringify({ ...updated, durableToolOccurrence }), row.id);
    return this.getMessage(row.id);
  }

  projectToolResult(messageId: string, summary: ToolCallSummary): void {
    this.events.transaction(() => {
      const row = this.db.query<ToolCallRow, [string]>("SELECT id, payload FROM messages WHERE id = ? AND kind = 'tool'").get(messageId);
      const updated = this.updateToolCallRow(row, summary);
      if (updated) this.publishToolUpdate(updated);
    });
  }

  finalizeDurableToolCalls(turnId: string): void {
    this.events.transaction(() => {
      for (const message of this.finalizeIncompleteToolCalls(turnId)) this.publishToolUpdate(message);
    });
  }

  private publishToolUpdate({ threadId, id: messageId, toolCall }: MessageDto): void {
    this.events.append("thread", threadId, "tool.updated", { threadId, messageId, toolCall });
  }

  finalizeIncompleteToolCalls(turnId: string): MessageDto[] {
    const rows = this.db.query(
      `SELECT id, payload FROM messages
       WHERE turn_id = ? AND kind = 'tool' AND json_extract(payload, '$.status') = 'running'
       ORDER BY seq`,
    ).all(turnId) as ToolCallRow[];
    const finalized: MessageDto[] = [];
    for (const row of rows) {
      const { summary } = readToolCall(row.payload);
      if (summary?.status !== "running") continue;
      const message = this.updateToolCallRow(row, { ...summary, status: "error", errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY });
      if (message !== undefined) finalized.push(message);
    }
    return finalized;
  }

  getMessage(id: string): MessageDto | undefined {
    const m = this.db.query(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return m ? this.toMessageDto(m) : undefined;
  }

  listMessages(threadId: string): MessageDto[] {
    const rows = this.db.query(`SELECT * FROM messages WHERE thread_id = ? ORDER BY seq ASC`).all(threadId) as MessageRow[];
    return rows.map((r) => this.toMessageDto(r));
  }

  getNativeSession(threadId: string): string | undefined {
    const r = this.db.query(`SELECT native_session_id FROM thread_sessions WHERE thread_id = ?`).get(threadId) as { native_session_id: string } | undefined;
    return r?.native_session_id;
  }

  setNativeSession(threadId: string, nativeSessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(`INSERT INTO thread_sessions (thread_id, native_session_id, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(thread_id) DO UPDATE SET native_session_id = excluded.native_session_id, updated_at = excluded.updated_at`)
      .run(threadId, nativeSessionId, now);
  }

  // ----- turns -----

  insertTurnRow(turn: { id: string; threadId: string; botId: string; nativeSessionId: string }): void {
    this.db
      .query(`INSERT INTO turns (id, thread_id, bot_id, status, native_session_id, started_at) VALUES (?, ?, ?, 'working', ?, ?)`)
      .run(turn.id, turn.threadId, turn.botId, turn.nativeSessionId, new Date().toISOString());
  }

  turnRow(id: string): TurnRow | undefined {
    return this.db.query(`SELECT * FROM turns WHERE id = ?`).get(id) as TurnRow | undefined;
  }

  activeTurn(threadId: string): TurnDto | undefined {
    const r = this.db
      .query(`SELECT * FROM turns WHERE thread_id = ? AND ${NONTERMINAL_TURN_SQL} ORDER BY started_at DESC LIMIT 1`)
      .get(threadId) as TurnRow | undefined;
    return r ? this.turnToDto(r) : undefined;
  }

  latestTurn(threadId: string): TurnDto | undefined {
    const r = this.db
      .query(`SELECT * FROM turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .get(threadId) as TurnRow | undefined;
    return r ? this.turnToDto(r) : undefined;
  }

  activeTurnForBot(botId: string): TurnDto | undefined {
    const r = this.db
      .query(`SELECT * FROM turns WHERE bot_id = ? AND ${NONTERMINAL_TURN_SQL} ORDER BY started_at DESC LIMIT 1`)
      .get(botId) as TurnRow | undefined;
    return r ? this.turnToDto(r) : undefined;
  }

  activeTurnIdsForBot(botId: string): string[] {
    const rows = this.db
      .query(`SELECT id FROM turns WHERE bot_id = ? AND ${NONTERMINAL_TURN_SQL} ORDER BY started_at, id`)
      .all(botId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  turnToDto(r: TurnRow): TurnDto {
    return {
      id: r.id, threadId: r.thread_id, botId: r.bot_id, status: r.status as TurnDto["status"],
      steerCount: r.steer_count, startedAt: r.started_at,
      ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
      ...(r.outcome_reason !== null ? { reason: r.outcome_reason } : {}),
    };
  }
}
