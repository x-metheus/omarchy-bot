import { AssistantEntry, CompactionEntry, ToolResultEntry, type Conversation, type ConversationView, type Cursor, type EntryId, type LiveState, type ToolDiagnostic, type TypedEntry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isToolCallSummary, TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } from "@omarchy-bot/domain";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";

type Segment = Exclude<AssistantMessage["content"][number], { type: "toolCall" }>;
type Position = { id: string; seq: number };
type Block = {
  position: Position;
  text: string;
  complete: boolean;
  recoveredStartedAt?: number;
};

// Match the Pi worker's public summary. Result text and diagnostics can contain private data.
const PI_TOOL_ERROR_SUMMARY = "Tool call failed.";
const INTERRUPTED_TOOL_DIAGNOSTICS = new Set(["aborted", "interrupted", "abandoned", "restart_limit"]);

/** Project committed generation updates into the existing Service transcript. */
export class DurableTranscript {
  private readonly seenEntries: Set<number>;
  private readonly noticedCompactions: Set<number>;
  private readonly blocks = new Map<string, Block>();
  private toolPositions?: Map<string, Position>;
  private generation = 0;
  constructor(private readonly threads: ThreadsService, private readonly bots: BotsService, private readonly events: EventLog, private readonly threadId: string, private readonly botId: string, private readonly turnId: string, initial: ConversationView) {
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

  async reconcileCompactions(view: ConversationView, conversation: Conversation): Promise<void> {
    const lastNotice = Math.max(0, ...this.noticedCompactions);
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending", ...(lastNotice ? { minEntryId: lastNotice as EntryId } : {}) }, 100, cursor, BACKGROUND_CONTEXT);
      this.update({ ...view, entries: page.items.filter(CompactionEntry.is), docs: {} });
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
        if (message) this.updateMessage(message, "committed");
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
    if (!result) return;
    const interrupted = entry.data.diagnostics.some(({ severity, code }) => severity === "error" && code !== undefined && INTERRUPTED_TOOL_DIAGNOSTICS.has(code));
    this.threads.projectToolResult(this.threadId, this.turnId, {
      id: result.toolCallId,
      name: result.toolName,
      status: result.isError ? "error" : "completed",
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
      ...(result.isError ? { errorSummary: interrupted ? TOOL_CALL_INTERRUPTED_ERROR_SUMMARY : PI_TOOL_ERROR_SUMMARY } : {}),
    });
  }

  private removeBlocks(ids: string[]): void {
    if (ids.length === 0) return;
    this.threads.removeAgentBlocks(this.threadId, this.turnId, ids);
    for (const id of ids) this.blocks.delete(id);
  }

  private updateMessage(message: Pick<AssistantMessage, "content" | "timestamp" | "stopReason">, mode: "live" | "committed" | "resume"): void {
    const toolPositions = mode === "committed" && message.stopReason === "toolUse"
      ? (this.toolPositions ??= new Map(this.threads.listToolCallPositions(this.threadId, this.turnId).map(({ callId, id, seq }) => [callId, { id, seq }])))
      : undefined;
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
      const position = part.type === "toolCall"
        ? toolPositions?.get(part.id)
        : this.blocks.get(blockIds[--blockIndex]!)?.position;
      following[index] = before?.id;
      if (position && (!before || position.seq < before.seq)) before = position;
    }
    let previousMessageId: string | undefined;
    for (const [index, part] of message.content.entries()) {
      if (part.type === "toolCall") {
        if (toolPositions) {
          const toolCall = { id: part.id, name: part.name, status: "running" } as const;
          if (isToolCallSummary(toolCall)) {
            const row = this.threads.projectToolCall(this.threadId, this.turnId, toolCall, previousMessageId, following[index]);
            if (row) {
              toolPositions.set(part.id, { id: row.id, seq: row.seq });
              previousMessageId = row.id;
            }
          }
        }
        continue;
      }
      const complete = mode === "committed" || blockIndex < blockIds.length - 1;
      previousMessageId = this.updateBlock(part, blockIds[blockIndex]!, complete, mode !== "live", following[index]);
      blockIndex++;
    }
    if (mode === "committed") {
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
