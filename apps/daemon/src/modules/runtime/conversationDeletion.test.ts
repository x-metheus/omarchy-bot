import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { DeleteBotResultDto } from "@omarchy-bot/protocol";
import { api, makeBot, sendToBot, startDaemon } from "../../../../../tests/integration/helpers/harness.ts";
import { setSetting } from "../../persistence/settings.ts";
import { deleteConversation, durableConversationTables } from "./conversationDeletion.ts";
import { openThreadConversation } from "./conversations.ts";
import { withFakeRuntimeProvider } from "./harness-test-support.ts";

function piTables(db: Database): string[] {
  return db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'pi_*' ORDER BY name",
  ).all().map(({ name }) => name);
}

function piRows(db: Database) {
  return piTables(db).map((table) => ({
    table,
    rows: db.query(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all(),
  }));
}

async function withFreshHarness(run: (db: Database, harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "durable-conversation-deletion-"));
  const dbPath = path.join(directory, "durable.sqlite");
  try {
    const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
    try {
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
      try {
        using db = new Database(dbPath);
        await run(db, harness);
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("conversation deletion accounts for every pi_ table a fresh SQLite Harness creates", () => withFreshHarness(async (db) => {
  expect([...durableConversationTables].sort()).toEqual(piTables(db));
}));

test("conversation deletion rejects unknown tables and rolls back failed writes", () => withFreshHarness(async (db, harness) => {
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const content = crypto.randomUUID();
  const write = await conversation.submit({ type: "write", entry: { kind: "test.message", data: { content } } }, BACKGROUND_CONTEXT);
  await write.wait(BACKGROUND_CONTEXT);
  const before = piRows(db);
  expect(JSON.stringify(before)).toContain(content);

  db.exec("CREATE TABLE pi_future_records (conversation_id INTEGER, content TEXT)");
  expect(() => deleteConversation(db, conversation.id)).toThrow("Unknown pi-durable tables: pi_future_records");
  db.exec("DROP TABLE pi_future_records");
  expect(piRows(db)).toEqual(before);

  db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON pi_conversations BEGIN SELECT RAISE(FAIL, 'conversation storage failure'); END");
  expect(() => deleteConversation(db, conversation.id)).toThrow("conversation storage failure");
  expect(piRows(db)).toEqual(before);
}));

test("a failed mapping insert prevents the first write from persisting message and attachment content", () => withFreshHarness(async (db, harness) => {
  db.exec(`CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER, created_at TEXT);
    CREATE TRIGGER reject_conversation BEFORE INSERT ON pi_thread_conversations
      BEGIN SELECT RAISE(FAIL, 'private mapping error'); END;`);
  const before = piRows(db).filter(({ table }) => table !== "pi_durable_metadata");
  const message = crypto.randomUUID();
  const attachment = crypto.randomUUID();
  const firstWrite = openThreadConversation(db, harness, "thread", "bot", BACKGROUND_CONTEXT).then(async (conversation) => {
    await conversation.commit(async (tx) => {
      await tx.appendEntry(conversation.id, { kind: "test.message", data: { message, attachment } });
    }, BACKGROUND_CONTEXT);
  });

  await expect(firstWrite).rejects.toThrow("Unable to index durable conversation");
  const after = piRows(db);
  expect(JSON.stringify(after)).not.toContain(message);
  expect(JSON.stringify(after)).not.toContain(attachment);
  expect(after.filter(({ table }) => table !== "pi_durable_metadata")).toEqual(before);
}));

test("permanent Bot deletion removes durable messages and attachment contents while preserving another Bot's conversation", () => {
  const reply = { segments: [{ type: "text" as const, text: "ok" }] };
  return withFakeRuntimeProvider([reply, reply, reply], {}, async () => {
    const h = await startDaemon();
    const { db, cfg, credentials, attachments, turns } = h.svc;
    try {
      await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model" }] });
      setSetting(db, "default_model", "fake/fake-model");
      setSetting(db, "runtime", "durable");

      const sibling = await makeBot(h, "Keep this Bot");
      const siblingMessage = crypto.randomUUID();
      const kept = await sendToBot(h, sibling, siblingMessage);
      expect(await turns.waitForTerminal(kept.turnId)).toMatchObject({ status: "completed" });
      const siblingRows = piRows(db);
      expect(JSON.stringify(siblingRows)).toContain(siblingMessage);

      const bot = await makeBot(h, "Delete this Bot");
      const userMessage = crypto.randomUUID();
      const attachmentContent = crypto.randomUUID();
      const secondThreadMessage = crypto.randomUUID();
      const draftToken = crypto.randomUUID();
      const attachment = await attachments.stage(bot, draftToken, new File([JSON.stringify({ private: attachmentContent })], "notes.json", { type: "application/json" }));
      const first = await turns.send(bot, null, userMessage, [attachment.id], draftToken);
      expect(await turns.waitForTerminal(first.turnId)).toMatchObject({ status: "completed" });
      const second = await sendToBot(h, bot, secondThreadMessage);
      expect(await turns.waitForTerminal(second.turnId)).toMatchObject({ status: "completed" });
      const before = piRows(db);
      const stored = JSON.stringify(before);
      for (const sentinel of [userMessage, attachmentContent, secondThreadMessage]) expect(stored).toContain(sentinel);

      db.exec("CREATE TRIGGER fail_bot_delete BEFORE DELETE ON bots BEGIN SELECT RAISE(FAIL, 'bot storage failure'); END");
      expect(await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${bot}`, {})).toMatchObject({
        status: "failed", botId: bot, failures: [{ stage: "database", message: "bot storage failure" }],
      });
      expect(piRows(db)).toEqual(before);
      db.exec("DROP TRIGGER fail_bot_delete");

      expect(await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${bot}`, {})).toMatchObject({
        status: "deleted", botId: bot, removed: { threads: 2, turns: 2, attachments: 1 }, failures: [],
      });
      const after = piRows(db);
      const remaining = JSON.stringify(after);
      for (const sentinel of [userMessage, attachmentContent, secondThreadMessage]) expect(remaining).not.toContain(sentinel);
      expect(after.filter(({ table }) => table !== "pi_durable_metadata"))
        .toEqual(siblingRows.filter(({ table }) => table !== "pi_durable_metadata"));
    } finally {
      await h.stop();
      rmSync(h.home, { recursive: true, force: true });
      rmSync(cfg.stateDir, { recursive: true, force: true });
    }
  });
});

test("a failed first-Turn conversation mapping leaves no durable data and the Bot can still be deleted", () => {
  const reply = { segments: [{ type: "text" as const, text: "ok" }] };
  return withFakeRuntimeProvider([reply], {}, async () => {
    const h = await startDaemon();
    const { db, cfg, credentials, attachments, threads, turns } = h.svc;
    try {
      await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model" }] });
      setSetting(db, "default_model", "fake/fake-model");
      setSetting(db, "runtime", "durable");

      const sibling = await makeBot(h, "Keep this Bot");
      const siblingMessage = crypto.randomUUID();
      const kept = await sendToBot(h, sibling, siblingMessage);
      expect(await turns.waitForTerminal(kept.turnId)).toMatchObject({ status: "completed" });
      const siblingRows = piRows(db).filter(({ table }) => table !== "pi_durable_metadata");
      expect(JSON.stringify(siblingRows)).toContain(siblingMessage);

      const bot = await makeBot(h, "Delete this Bot");
      const userMessage = crypto.randomUUID();
      const attachmentContent = crypto.randomUUID();
      const draftToken = crypto.randomUUID();
      const attachment = await attachments.stage(bot, draftToken, new File([attachmentContent], "notes.txt", { type: "text/plain" }));
      db.exec(`CREATE TEMP TRIGGER reject_conversation_mapping AFTER INSERT ON pi_thread_conversations
        BEGIN SELECT RAISE(FAIL, 'private mapping error'); END`);
      const sent = await turns.send(bot, null, userMessage, [attachment.id], draftToken);
      expect(threads.getMessage(sent.messageId)).toMatchObject({ text: userMessage });
      expect(await turns.waitForTerminal(sent.turnId)).toMatchObject({ status: "failed", reason: "Unable to index durable conversation" });

      const afterFailure = piRows(db);
      const stored = JSON.stringify(afterFailure);
      for (const sentinel of [userMessage, attachmentContent]) expect(stored).not.toContain(sentinel);
      expect(afterFailure.filter(({ table }) => table !== "pi_durable_metadata")).toEqual(siblingRows);

      expect(await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${bot}`, {})).toMatchObject({
        status: "deleted", botId: bot, removed: { threads: 1, turns: 1, attachments: 1 }, failures: [],
      });
      expect(piRows(db).filter(({ table }) => table !== "pi_durable_metadata")).toEqual(siblingRows);
    } finally {
      await h.stop();
      rmSync(h.home, { recursive: true, force: true });
      rmSync(cfg.stateDir, { recursive: true, force: true });
    }
  });
});
