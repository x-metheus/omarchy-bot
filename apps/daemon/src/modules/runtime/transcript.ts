import { AssistantEntry, type ConversationView, type LiveState } from "@earendil-works/pi-durable";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";

type Segment = { type: "thinking"; thinking: string } | { type: "text"; text: string };

/** Project committed generation updates into the existing Service transcript. */
export class DurableTranscript {
  private readonly initialEntries: Set<number>;
  private readonly blocks: { type: Segment["type"]; text: string; id: string; complete: boolean }[] = [];
  constructor(private readonly threads: ThreadsService, private readonly bots: BotsService, private readonly events: EventLog, private readonly threadId: string, private readonly botId: string, private readonly turnId: string, initial: ConversationView) {
    this.initialEntries = new Set(initial.entries.map((entry) => entry.id));
  }

  update(view: ConversationView): void {
    const entry = view.entries.find((candidate) => !this.initialEntries.has(candidate.id) && AssistantEntry.is(candidate));
    const message = entry?.model?.find((item) => item.role === "assistant")
      ?? (view.docs["pi.live"] as LiveState | undefined)?.generation?.message;
    if (!message || message.role !== "assistant") return;
    const segments = message.content.filter((part): part is Segment => part.type === "thinking" || part.type === "text");
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const text = segment.type === "thinking" ? segment.thinking : segment.text;
      let block = this.blocks[index];
      if (!block) {
        const id = `${this.turnId}-${segment.type}-${index}`;
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
      if (!block.complete && (entry !== undefined || index < segments.length - 1)) {
        const completedAt = new Date().toISOString();
        const updated = block.type === "thinking" ? this.threads.completeThinking(this.threadId, this.turnId, block.id, completedAt) : this.threads.completeResponse(this.threadId, this.turnId, block.id, completedAt);
        block.complete = true;
        if (updated) {
          this.events.append("thread", this.threadId, block.type === "thinking" ? "thinking.updated" : "response.updated", updated);
          if (block.type === "text" && updated.text?.trim()) this.bots.recordResponse(this.botId, this.threadId, updated.text.trim());
        }
      }
    }
  }
}
