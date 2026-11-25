import type { Database } from "bun:sqlite";
import { AssistantEntry, CompactionEntry, ToolResultEntry, ToolTask, type Conversation, type ConversationView, type Cursor, type EntryId, type LiveState, type TaskId, type ToolDiagnostic, type TypedEntry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { redactToolErrorSummary } from "@omarchy-bot/agent-contract";
import { isToolCallSummary, TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH, TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } from "@omarchy-bot/domain";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";

type Segment = Exclude<AssistantMessage["content"][number], { type: "toolCall" }>;
type Position = { id: string; seq: number };
type PendingTool = { name: string; messageId: string | undefined; target: string | undefined };
type Block = {
  position: Position;
  text: string;
  complete: boolean;
  recoveredStartedAt?: number;
};

const INTERRUPTED_TOOL_DIAGNOSTICS = new Set(["aborted", "interrupted", "abandoned", "restart_limit"]);
// Structured target text may contain a private payload in its entirety.
const STRUCTURED_TARGET_TEXT = /\{\s*(?:\\?["']|\})|\[\s*(?:\\?["']|[\[\]{])/;
const JSON_UNQUOTED_SCALAR = String.raw`(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)`;
const JSON_SCALAR_TARGET = new RegExp(String.raw`^\s*(?:"(?:[^"\\]|\\.)*"|${JSON_UNQUOTED_SCALAR})\s*$`);
const JSON_SCALAR_FIRST_ARRAY = new RegExp(String.raw`\[\s*${JSON_UNQUOTED_SCALAR}\s*[,\]]`);

function isJsonLookingTarget(value: string): boolean {
  return STRUCTURED_TARGET_TEXT.test(value) || JSON_SCALAR_FIRST_ARRAY.test(value) || JSON_SCALAR_TARGET.test(value);
}
const TOOL_TARGET_FIELDS = new Map<string, readonly string[]>([
  ["bash", ["command"]],
  ["read", ["path"]], ["write", ["path"]], ["edit", ["path"]],
  ["search", ["query", "path"]], ["glob", ["query", "path", "pattern"]],
  ["web_search", ["query"]],
  ["local", ["command", "path", "query", "action"]],
  ["computer", ["action"]], ["browser", ["action"]],
]);

function redactToolTarget(value: string): string {
  return redactToolErrorSummary(value.replace(/:\/\/[^/?#\s]*@/g, "://[redacted]@"));
}

function toolTarget(call: ToolCall): string | undefined {
  for (const field of TOOL_TARGET_FIELDS.get(call.name) ?? []) {
    const value = call.arguments[field];
    if (typeof value !== "string" || !value.trim()) continue;
    if (isJsonLookingTarget(value)) return undefined;
    return redactToolTarget(value);
  }
}

function toolErrorSummary(toolName: string, result: ToolResultMessage, diagnostics: readonly ToolDiagnostic[]): string {
  if (diagnostics.some(({ severity, code }) => severity === "error" && code !== undefined && INTERRUPTED_TOOL_DIAGNOSTICS.has(code))) return TOOL_CALL_INTERRUPTED_ERROR_SUMMARY;
  const details = result.details;
  const publicError = toolName === "local" && details && typeof details === "object" && "publicError" in details && typeof details.publicError === "string"
    ? details.publicError
    : undefined;
  return redactToolErrorSummary(publicError);
}

/** Project committed generation updates into the existing Service transcript. */
export class DurableTranscript {
  private readonly seenEntries: Set<number>;
  private readonly noticedCompactions: Set<number>;
  private readonly blocks = new Map<string, Block>();
  private readonly pendingTools = new Map<string, (PendingTool | undefined)[]>();
  private pendingAssistant: TypedEntry<never> | undefined;
  private generation = 0;
  constructor(private readonly threads: ThreadsService, private readonly bots: BotsService, private readonly events: EventLog, private readonly threadId: string, private readonly botId: string, private readonly turnId: string, initial: ConversationView, private readonly db?: Database) {
    this.seenEntries = new Set(initial.entries.filter((entry) => !CompactionEntry.is(entry)).map((entry) => entry.id));
    const messages = threads.listMessages(threadId);
    for (const message of messages) {
      const position = { id: message.id, seq: message.seq };
      const block = message.thinking ?? message.response;
      if (!block?.blockId.startsWith(`${turnId}-`)) continue;
      this.blocks.set(block.blockId, {
        position, text: message.text ?? "", complete: block.state === "completed",
        recoveredStartedAt: Date.parse(block.startedAt),
      });
    }
    this.noticedCompactions = new Set(messages.flatMap((message) => {
      const payload = message.payload;
      return payload && typeof payload === "object" && "durableCompactionEntry" in payload && typeof payload.durableCompactionEntry === "number" ? [payload.durableCompactionEntry] : [];
    }));
    this.update({ ...initial, docs: {} });
  }

  updateCompactions(view: ConversationView): void {
    this.update({ ...view, entries: view.entries.filter(CompactionEntry.is), docs: {} });
  }

  async reconcileCompactions(view: ConversationView, conversation: Conversation, writeService: (write: () => void) => void | Promise<void> = (write) => write()): Promise<void> {
    const lastNotice = Math.max(0, ...this.noticedCompactions);
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending", ...(lastNotice ? { minEntryId: lastNotice as EntryId } : {}) }, 100, cursor, BACKGROUND_CONTEXT);
      await writeService(() => this.update({ ...view, entries: page.items.filter(CompactionEntry.is), docs: {} }));
      cursor = page.next;
    } while (cursor);
  }

  update(view: ConversationView): void {
    for (const entry of view.entries) {
      if (this.seenEntries.has(entry.id)) continue;
      if (CompactionEntry.is(entry)) {
        const alreadyNoticed = this.threads.listMessages(this.threadId).some((message) => {
          const payload = message.payload;
          return payload && typeof payload === "object" && "durableCompactionEntry" in payload && payload.durableCompactionEntry === entry.id;
        });
        if (!this.noticedCompactions.has(entry.id) && !alreadyNoticed) {
          this.threads.appendMessage(this.threadId, { author: { kind: "system" }, kind: "text", text: "Earlier conversation history was compacted.", turnId: this.turnId, payload: { durableCompactionEntry: entry.id } });
        }
        this.noticedCompactions.add(entry.id);
        this.seenEntries.add(entry.id);
        continue;
      }
      if (AssistantEntry.is(entry)) {
        const message = entry.model?.find((item) => item.role === "assistant");
        if (message) this.updateMessage(message, { entry });
      } else if (ToolResultEntry.is(entry)) {
        this.updateToolResult(entry);
      }
      this.seenEntries.add(entry.id);
    }
    const message = (view.docs["pi.live"] as LiveState | undefined)?.generation?.message;
    if (message?.role === "assistant") this.updateMessage(message, "live");
  }

  /** Discard rows that had no counterpart in the journal or its persisted live snapshot. */
  resume(view: ConversationView): void {
    const message = (view.docs["pi.live"] as LiveState | undefined)?.generation?.message;
    if (message?.role === "assistant") this.updateMessage(message, "resume");
    else this.removeBlocks([...this.blocks.keys()]);
  }

  private updateToolResult(entry: TypedEntry<{ diagnostics: ToolDiagnostic[] }>): void {
    const result = entry.model?.find((item) => item.role === "toolResult");
    const assistant = this.pendingAssistant;
    if (!result || !assistant) return;
    const pending = this.pendingTools.get(result.toolCallId);
    if (!pending) return;
    let index: number;
    if (pending.length > 1 && this.db && entry.byTaskId !== undefined) {
      // Pi creates tasks in assistant call order, even when results commit out of order.
      // For a repeated ID, Pi reports the first call's name for every result.
      const tasks = this.db.query<{ id: TaskId }, [number, number, number, string, number, string]>(`
        SELECT id FROM pi_tasks
        WHERE conversation_id = ? AND id > ? AND id < ? AND kind = ?
          AND json_extract(record, '$.input.assistant') = ? AND record -> '$.input.callId' = ?
        ORDER BY id
      `).all(entry.conversationId, assistant.id, entry.id, JSON.stringify(ToolTask.definition.name), assistant.id, JSON.stringify(result.toolCallId));
      // The generation itself writes results for the unstarted suffix when it aborts a sequential round.
      index = entry.byTaskId === assistant.byTaskId
        ? pending.findIndex((tool, position) => position >= tasks.length && tool !== undefined)
        : tasks.findIndex(({ id }) => id === entry.byTaskId);
    } else {
      index = pending.findIndex((tool) => tool?.name === result.toolName);
    }
    const tool = pending[index];
    if (!tool) return;
    if (tool.messageId !== undefined) {
      const details = result.details;
      const hostname = tool.name === "local" && details && typeof details === "object" && "hostname" in details && typeof details.hostname === "string"
        ? details.hostname.trim()
        : undefined;
      const target = hostname && !isJsonLookingTarget(hostname) && tool.target !== undefined
        ? `${redactToolTarget(hostname)} ${tool.target}`.slice(0, TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH)
        : tool.target;
      this.threads.projectToolResult(tool.messageId, {
        id: result.toolCallId,
        name: tool.name,
        status: result.isError ? "error" : "completed",
        ...(target === undefined ? {} : { target }),
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        ...(result.isError ? { errorSummary: toolErrorSummary(tool.name, result, entry.data.diagnostics) } : {}),
      });
    }
    pending[index] = undefined;
  }

  private removeBlocks(ids: string[]): void {
    if (ids.length === 0) return;
    this.threads.removeAgentBlocks(this.threadId, this.turnId, ids);
    for (const id of ids) this.blocks.delete(id);
  }

  private updateMessage(message: Pick<AssistantMessage, "content" | "timestamp" | "stopReason">, mode: "live" | "resume" | { entry: TypedEntry<never> }): void {
    const committed = typeof mode === "object";
    if (committed) {
      this.pendingTools.clear();
      this.pendingAssistant = mode.entry;
    }
    // Pi commits this assistant entry and its tool round together. Failed replies can carry unexecuted calls.
    const projectsCalls = committed && message.stopReason === "toolUse";
    const toolPositions = projectsCalls
      ? new Map(this.threads.listToolCallPositions(this.threadId, this.turnId).map(({ callId, id, seq, occurrence }) => [occurrence ?? JSON.stringify([callId]), { id, seq }]))
      : undefined;
    const seenCallIds = new Set<string>();
    const duplicateCallIds = new Set<string>();
    const occurrences = projectsCalls ? message.content.map((part, index) => {
      if (part.type !== "toolCall") return undefined;
      if (seenCallIds.has(part.id)) duplicateCallIds.add(part.id);
      seenCallIds.add(part.id);
      return JSON.stringify([mode.entry.id, index, part.id]);
    }) : undefined;
    const generation = `${this.turnId}-${this.generation}-`;
    const segments = message.content.filter((part) => part.type !== "toolCall");
    const blockIds = segments.map(({ type }, index) => `${generation}${type}-${index}`);
    if (mode !== "live") {
      const expected = new Set(blockIds);
      this.removeBlocks([...this.blocks].flatMap(([id, block]) => {
        if (!id.startsWith(generation)) return mode === "resume" ? [id] : [];
        // A request that began after the stored block is a retry whose original partial never reached the journal.
        return !expected.has(id) || (block.recoveredStartedAt !== undefined && block.recoveredStartedAt < message.timestamp) ? [id] : [];
      }));
    }

    // Anchor each part before the earliest persisted row that follows it in the journal.
    const following: (string | undefined)[] = [];
    let before = [...this.blocks].find(([id]) => !id.startsWith(generation))?.[1].position;
    let blockIndex = blockIds.length;
    for (let index = message.content.length - 1; index >= 0; index--) {
      const part = message.content[index]!;
      let position: Position | undefined;
      if (part.type === "toolCall") {
        const occurrence = occurrences?.[index];
        if (occurrence !== undefined) position = toolPositions?.get(occurrence) ?? toolPositions?.get(JSON.stringify([part.id]));
      } else {
        position = this.blocks.get(blockIds[--blockIndex]!)?.position;
      }
      following[index] = before?.id;
      if (position && (!before || position.seq < before.seq)) before = position;
    }
    let previousMessageId: string | undefined;
    for (const [index, part] of message.content.entries()) {
      if (part.type === "toolCall") {
        const occurrence = occurrences?.[index];
        if (occurrence !== undefined) {
          // Pi resolves duplicate IDs to the first call's arguments, so a target would be ambiguous.
          const target = duplicateCallIds.has(part.id) ? undefined : toolTarget(part);
          const toolCall = { id: part.id, name: part.name, status: "running", ...(target === undefined ? {} : { target }) } as const;
          const row = isToolCallSummary(toolCall)
            ? this.threads.projectToolCall(this.threadId, this.turnId, occurrence, toolCall, previousMessageId, following[index])
            : undefined;
          // Preserve task positions even when a call has no Service row.
          const pending = this.pendingTools.get(part.id) ?? [];
          pending.push({ name: part.name, messageId: row?.id, target });
          this.pendingTools.set(part.id, pending);
          if (row) previousMessageId = row.id;
        }
        continue;
      }
      const complete = committed || blockIndex < blockIds.length - 1;
      previousMessageId = this.updateBlock(part, blockIds[blockIndex]!, complete, mode !== "live", following[index]);
      blockIndex++;
    }
    if (committed) {
      for (const id of blockIds) this.blocks.delete(id);
      this.generation++;
    }
  }

  private updateBlock(segment: Segment, id: string, complete: boolean, authoritative: boolean, beforeMessageId: string | undefined): string {
    const thinking = segment.type === "thinking";
    const text = thinking ? segment.thinking : segment.text;
    let block = this.blocks.get(id);
    if (!block) {
      const startedAt = new Date().toISOString();
      const lifecycle = { blockId: id, state: "streaming", startedAt } as const;
      const message = this.events.transaction(() => this.threads.appendMessage(this.threadId, {
        author: { kind: "bot" }, text: "", turnId: this.turnId,
        ...(thinking ? { kind: "thinking", thinking: lifecycle } : { kind: "response", response: lifecycle }),
      }, beforeMessageId));
      block = { position: { id: message.id, seq: message.seq }, text: "", complete: false };
      this.blocks.set(id, block);
    }

    if (block.text === text && block.complete === complete) return block.position.id;
    const event = thinking ? "thinking.updated" : "response.updated";
    let writtenText = block.text;
    let completed = block.complete;
    const write = () => {
      const reopen = authoritative && completed && !complete;
      const replace = authoritative && text !== writtenText && (completed || !text.startsWith(writtenText));
      if ((reopen || replace) && this.threads.reconcileAgentBlock(this.threadId, this.turnId, id, text, reopen)) {
        writtenText = text;
        if (reopen) completed = false;
      }
      if (completed) return;
      const delta = text.slice(writtenText.length);
      if (delta) {
        const updated = thinking ? this.threads.appendThinkingDelta(this.threadId, this.turnId, id, delta) : this.threads.appendResponseDelta(this.threadId, this.turnId, id, delta);
        if (updated) {
          this.events.append("thread", this.threadId, event, updated);
          writtenText = text;
        }
      }
      if (complete) {
        const completedAt = new Date().toISOString();
        const updated = thinking ? this.threads.completeThinking(this.threadId, this.turnId, id, completedAt) : this.threads.completeResponse(this.threadId, this.turnId, id, completedAt);
        if (updated) {
          this.events.append("thread", this.threadId, event, updated);
          if (!thinking && updated.text?.trim()) this.bots.recordResponse(this.botId, this.threadId, updated.text.trim());
          completed = true;
        }
      }
    };
    this.events.transaction(write);
    block.text = writtenText;
    block.complete = completed;
    return block.position.id;
  }
}
