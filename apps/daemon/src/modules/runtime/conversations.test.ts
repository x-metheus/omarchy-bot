import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openThreadConversation } from "./conversations.ts";

test("thread conversations are reused after reopening the harness and are isolated by bot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bot-conversations-"));
  const dbPath = path.join(dir, "service.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE pi_thread_conversations (thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, bot_id))");
  try {
    let firstId: ConversationId | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
      try {
        const [first, concurrent] = await Promise.all([
          openThreadConversation(db, harness, "thread", "bot1", BACKGROUND_CONTEXT),
          openThreadConversation(db, harness, "thread", "bot1", BACKGROUND_CONTEXT),
        ]);
        expect(concurrent.id).toBe(first.id);
        const second = await openThreadConversation(db, harness, "thread", "bot2", BACKGROUND_CONTEXT);
        expect(first.id).not.toBe(second.id);
        if (firstId !== undefined) expect(first.id).toBe(firstId);
        firstId = first.id;
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
        await storage.close(BACKGROUND_CONTEXT);
      }
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an index insert failure stops before returning an unindexed conversation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bot-conversation-index-failure-"));
  const dbPath = path.join(dir, "service.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER, created_at TEXT)");
  db.exec("CREATE TRIGGER reject_conversation BEFORE INSERT ON pi_thread_conversations BEGIN SELECT RAISE(FAIL, 'private detail'); END");
  const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
  try {
    await expect(openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT)).rejects.toThrow("Unable to index durable conversation");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
