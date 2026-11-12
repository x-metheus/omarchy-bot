import { AssistantEntry, CompactionEntry, type Conversation, type ConversationView, type Cursor, type EntryId, type LiveState } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";

type Segment = { type: "thinking"; thinking: string } | { type: "text"; text: string };
type Block = { type: Segment["type"]; text: string; id: string; complete: boolean };

/** Project committed generation updates into the existing Service transcript. */
export class DurableTranscript {
  private readonly seenEntries: Set<number>;
  private readonly noticedCompactions: Set<number>;
  private blocks: Block[] = [];
  private generation = 0;
  constructor(private readonly threads: ThreadsService, private readonly bots: BotsService, private readonly events: EventLog, private readonly threadId: string, private readonly botId: string, private readonly turnId: string, initial: ConversationView) {
    this.seenEntries = new Set(initial.entries.filter((entry) => !CompactionEntry.is(entry)).map((entry) => entry.id));
    this.noticedCompactions = new Set(threads.listMessages(threadId).flatMap((message) => {
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
      if (!AssistantEntry.is(entry)) continue;
      const message = entry.model?.find((item) => item.role === "assistant");
      if (message) this.updateMessage(message.content, true);
      this.seenEntries.add(entry.id);
    }
    const message = (view.docs["pi.live"] as LiveState | undefined)?.generation?.message;
    if (message?.role === "assistant") this.updateMessage(message.content, false);
  }

  private updateMessage(content: readonly unknown[], complete: boolean): void {
    const segments = content.filter((part): part is Segment => typeof part === "object" && part !== null && "type" in part && (part.type === "thinking" || part.type === "text"));
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const text = segment.type === "thinking" ? segment.thinking : segment.text;
      let block = this.blocks[index];
      if (!block) {
        const id = `${this.turnId}-${this.generation}-${segment.type}-${index}`;
        block = { id, type: segment.type, text: "", complete: false };
        this.blocks.push(block);
        const startedAt = new Date().toISOString();
        if (segment.type === "thinking") this.threads.appendMessage(this.threadId, { author: { kind: "bot" }, kind: "thinking", text: "", turnId: this.turnId, thinking: { blockId: id, state: "streaming", startedAt } });
        else this.threads.appendMessage(this.threadId, { author: { kind: "bot" }, kind: "response", text: "", turnId: this.turnId, response: { blockId: id, state: "streaming", startedAt } });
      }
      const delta = text.slice(block.text.length);
      if (delta && !block.complete) {
        const updated = block.type === "thinking" ? this.threads.appendThinkingDelta(this.threadId, this.turnId, block.id, delta) : this.threads.appendResponseDelta(this.threadId, this.turnId, block.id, delta);
        block.text = text;
        if (updated) this.events.append("thread", this.threadId, block.type === "thinking" ? "thinking.updated" : "response.updated", updated);
      }
      if (!block.complete && (complete || index < segments.length - 1)) {
        const completedAt = new Date().toISOString();
        const updated = block.type === "thinking" ? this.threads.completeThinking(this.threadId, this.turnId, block.id, completedAt) : this.threads.completeResponse(this.threadId, this.turnId, block.id, completedAt);
        block.complete = true;
        if (updated) {
          this.events.append("thread", this.threadId, block.type === "thinking" ? "thinking.updated" : "response.updated", updated);
          if (block.type === "text" && updated.text?.trim()) this.bots.recordResponse(this.botId, this.threadId, updated.text.trim());
        }
      }
    }
    if (complete) { this.blocks = []; this.generation++; }
  }
}
