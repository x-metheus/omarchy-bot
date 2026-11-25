import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineTool, Harness } from "@earendil-works/pi-durable";
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
    const h = await startDaemon(undefined, { seedDurableProvider: false });
    const { db, cfg, credentials, attachments, turns } = h.svc;
    try {
      await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model" }] });
      setSetting(db, "default_model", "fake/fake-model");

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

test("permanent Bot deletion removes every conversation and rolls back a failure in the second", () => {
  const taskDocument = defineDoc<{ written: boolean }>({
    kind: "test.deletion-task",
    scope: "task",
    version: 1,
    initial: () => ({ written: false }),
    checkpointWhen: () => false,
  });
  const tool = defineTool({
    name: "write_task_document",
    description: "Persist a document owned by this task",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args, api, context) {
      await api.commit(async (tx) => { (await tx.doc(taskDocument, api.taskId)).written = true; }, context);
      return { output: [] };
    },
  });
  const toolCall = () => fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" });
  const reply = { segments: [{ type: "text" as const, text: "ok" }] };
  return withFakeRuntimeProvider([toolCall, reply, toolCall, reply, toolCall, reply, toolCall, reply], {}, async () => {
    const open = Harness.open;
    Harness.open = (storage, options, context) => {
      if (!("install" in options.registry) || typeof options.registry.install !== "function") throw new Error("Expected a mutable registry");
      options.registry.install({ name: "test-conversation-deletion", tools: [tool] });
      return open.call(Harness, storage, options, context);
    };
    try {
      const h = await startDaemon(undefined, { seedDurableProvider: false });
      const { cfg, credentials, db, turns } = h.svc;
      try {
        await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model" }] });
        setSetting(db, "default_model", "fake/fake-model");

        async function send(botId: string, text: string): Promise<number> {
          const { threadId, turnId } = await sendToBot(h, botId, text);
          expect(await turns.waitForTerminal(turnId)).toMatchObject({ status: "completed" });
          const binding = db.query<{ conversation_id: number }, [string, string]>(
            "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ? AND bot_id = ?",
          ).get(threadId, botId);
          if (!binding) throw new Error(`Missing conversation for Thread ${threadId}`);
          const taskDocuments = db.query(`
            SELECT document.id FROM pi_documents AS document
            JOIN pi_tasks AS task ON document.scope_kind = 'task' AND document.owner_id = task.id
            WHERE task.conversation_id = ? AND json_extract(document.record, '$.kind') = ?
          `).all(binding.conversation_id, taskDocument.definition.kind);
          expect(taskDocuments).toHaveLength(1);
          return binding.conversation_id;
        }

        const tableKeys = piTables(db).map((table) => ({
          table,
          // Capture row IDs before deletion so orphaned revisions and record ID claims remain countable.
          keys: () => db.query<{ row_id: number }, []>(`SELECT rowid AS row_id FROM "${table.replaceAll('"', '""')}"`)
            .all().map(({ row_id }) => row_id),
        }));
        const sibling = await makeBot(h, "Keep this Bot");
        await send(sibling, "Keep this conversation");
        const siblingRows = piRows(db);
        const bot = await makeBot(h, "Delete this Bot");
        const conversationRows = [];
        for (const text of ["First conversation", "Second conversation", "Third conversation"]) {
          const previous = tableKeys.map(({ keys }) => new Set(keys()));
          const conversationId = await send(bot, text);
          const rows = tableKeys.map(({ table, keys }, index) => ({
            table,
            rowIds: new Set(keys().filter((id) => !previous[index]!.has(id))),
          }));
          for (const { table, rowIds } of rows) {
            const count = expect(rowIds.size, `${table} for conversation ${conversationId}`);
            if (table === "pi_durable_metadata" || table === "pi_durable_schema") count.toBe(0);
            else count.toBeGreaterThan(0);
          }
          conversationRows.push({ conversationId, rows });
        }
        const conversationIds = new Set(conversationRows.map(({ conversationId }) => conversationId));
        expect(conversationIds.size).toBe(3);
        const idsForTrigger = [...conversationIds].join(",");
        const before = piRows(db);

        // Fail at the second conversation regardless of iteration order. At this point the
        // first conversation is gone and the second conversation's documents are gone.
        db.exec(`CREATE TEMP TRIGGER fail_second_conversation BEFORE DELETE ON pi_submissions
          WHEN OLD.conversation_id IN (${idsForTrigger})
            AND (SELECT COUNT(*) FROM pi_conversations WHERE id IN (${idsForTrigger})) = 2
          BEGIN
            SELECT CASE WHEN EXISTS (
              SELECT 1 FROM pi_documents
              WHERE (scope_kind = 'conversation' AND owner_id = OLD.conversation_id)
                OR (scope_kind = 'task' AND owner_id IN (SELECT id FROM pi_tasks WHERE conversation_id = OLD.conversation_id))
            ) THEN RAISE(FAIL, 'second conversation documents still present')
            ELSE RAISE(FAIL, 'second conversation storage failure') END;
          END`);
        expect(await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${bot}`, {})).toMatchObject({
          status: "failed", botId: bot, failures: [{ stage: "database", message: "second conversation storage failure" }],
        });
        expect(piRows(db)).toEqual(before);
        db.exec("DROP TRIGGER fail_second_conversation");

        expect(await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${bot}`, {})).toMatchObject({
          status: "deleted", botId: bot, removed: { threads: 3, turns: 3 }, failures: [],
        });
        const remaining = tableKeys.map(({ keys }) => keys());
        for (const { conversationId, rows } of conversationRows) {
          for (const [index, { table, rowIds }] of rows.entries()) {
            expect(remaining[index]!.filter((id) => rowIds.has(id)).length, `${table} for conversation ${conversationId}`).toBe(0);
          }
        }
        const after = piRows(db);
        expect(after.filter(({ table }) => table !== "pi_durable_metadata"))
          .toEqual(siblingRows.filter(({ table }) => table !== "pi_durable_metadata"));
        expect(after.find(({ table }) => table === "pi_durable_metadata"))
          .toEqual(before.find(({ table }) => table === "pi_durable_metadata"));
      } finally {
        await h.stop();
        rmSync(h.home, { recursive: true, force: true });
        rmSync(cfg.stateDir, { recursive: true, force: true });
      }
    } finally {
      Harness.open = open;
    }
  });
}, 30_000);

test("a failed first-Turn conversation mapping leaves no durable data and the Bot can still be deleted", () => {
  const reply = { segments: [{ type: "text" as const, text: "ok" }] };
  return withFakeRuntimeProvider([reply], {}, async () => {
    const h = await startDaemon(undefined, { seedDurableProvider: false });
    const { db, cfg, credentials, attachments, threads, turns } = h.svc;
    try {
      await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model" }] });
      setSetting(db, "default_model", "fake/fake-model");

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
