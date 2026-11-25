import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord/context";
import type { AgentChange, Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";

const pending = new WeakMap<Harness, Map<string, Promise<Conversation>>>();

/** Open the Service-owned index entry. The shared open outlives an individual caller's wait. */
export async function openThreadConversation(
  db: Database,
  harness: Harness,
  threadId: string,
  botId: string,
  runtimeContext: Context,
  options?: {
    writeService?: (write: () => void) => void | Promise<void>;
    initialSettings?: () => AgentChange;
    seed?: (conversation: Conversation, context: Context) => Promise<void>;
  },
): Promise<Conversation> {
  let inFlight = pending.get(harness);
  if (!inFlight) {
    inFlight = new Map();
    pending.set(harness, inFlight);
  }
  const key = JSON.stringify([threadId, botId]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const row = db.query<{ conversation_id: number }, [string, string]>(
      "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ? AND bot_id = ?",
    ).get(threadId, botId);
    if (row) {
      const conversation = await harness.conversation(row.conversation_id as ConversationId, runtimeContext);
      if (!conversation) throw new Error("Indexed durable conversation not found");
      return conversation;
    }
    const agent = options?.initialSettings?.();
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, ...(agent ? { agent } : {}) }, runtimeContext);
    if (options?.seed) {
      try {
        await options.seed(conversation, runtimeContext);
      } catch {
        console.warn(`Unable to seed first durable conversation for thread ${threadId}`);
      }
    }
    // pi-durable 1.5.2 has no conversation deletion API. An insert failure can
    // orphan this conversation; Task 19 must sweep conversations without an index row.
    try {
      const writeService = options?.writeService ?? ((write) => write());
      await writeService(() => {
        db.query("INSERT INTO pi_thread_conversations (thread_id, bot_id, conversation_id, created_at) VALUES (?, ?, ?, ?)")
          .run(threadId, botId, conversation.id, new Date().toISOString());
      });
    } catch {
      throw new Error("Unable to index durable conversation");
    }
    return conversation;
  })();
  inFlight.set(key, promise);
  try { return await promise; } finally { inFlight.delete(key); }
}
