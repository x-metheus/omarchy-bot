import { expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openThreadConversation } from "./conversations.ts";

async function withConversationIndex(check: (db: Database, harness: Harness) => Promise<void>) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE pi_thread_conversations (thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (thread_id, bot_id))");
  try {
    const storage = await openNodeSqliteStorage(":memory:");
    try {
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
      try {
        await check(db, harness);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    db.close();
  }
}

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

test("a new thread conversation seeds once before the index row becomes visible", () => withConversationIndex(async (db, harness) => {
  const indexed = db.query("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = 'thread' AND bot_id = 'bot'");
  const rowsDuringSeed: unknown[] = [];
  const seed = mock(async (conversation: Conversation) => {
    await conversation.commit(async (tx) => {
      await tx.appendEntry(conversation.id, { kind: "test.seed" });
    }, BACKGROUND_CONTEXT);
    rowsDuringSeed.push(indexed.get());
  });
  const [first, concurrent] = await Promise.all([
    openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT, { seed }),
    openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT, { seed }),
  ]);
  expect(seed).toHaveBeenCalledTimes(1);
  expect(rowsDuringSeed).toEqual([null]);
  expect(indexed.get()).toEqual({ conversation_id: first.id });
  expect(concurrent.id).toBe(first.id);
  expect((await first.context(BACKGROUND_CONTEXT)).entries.map(({ kind }) => kind)).toEqual(["test.seed"]);
}));

test("a seed rejection still indexes and returns the new thread conversation", () => withConversationIndex(async (db, harness) => {
  const seed = mock(async () => { throw new Error("seed failed"); });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const conversation = await openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT, { seed });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([["Unable to seed first durable conversation for thread thread"]]);
    expect(db.query("SELECT conversation_id FROM pi_thread_conversations").get()).toEqual({ conversation_id: conversation.id });
  } finally {
    warn.mockRestore();
  }
}));

test("an existing thread conversation ignores seed options", () => withConversationIndex(async (db, harness) => {
  const first = await openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT);
  const seed = mock(async () => {});
  const reopened = await openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT, { seed });
  expect(reopened.id).toBe(first.id);
  expect(seed).not.toHaveBeenCalled();
  expect((await reopened.context(BACKGROUND_CONTEXT)).entries).toEqual([]);
}));

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
