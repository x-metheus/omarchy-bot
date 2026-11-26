import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineTool, GenerationTask, Harness, LiveDoc, UserEntry, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { DeleteBotResultDto } from "@omarchy-bot/protocol";
import { api, makeBot, sendToBot, startDaemon } from "../../../../../tests/integration/helpers/harness.ts";
import { until } from "../../../../../tests/integration/helpers/bot-screen-load-observe.ts";
import type { Config } from "../../bootstrap/config.ts";
import { openDb } from "../../persistence/db.ts";
import { setSetting } from "../../persistence/settings.ts";
import { deleteConversation, durableConversationTables } from "./conversationDeletion.ts";
import { openThreadConversation } from "./conversations.ts";
import { withFakeRuntimeProvider } from "./harness-test-support.ts";
import { openBotRuntime } from "./runtime.ts";

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

test.each(["shared database", "split databases"] as const)("runtime startup sweeps unmapped conversations before resuming mapped generation (%s)", async (layout) => {
  const directory = mkdtempSync(path.join(tmpdir(), "durable-conversation-sweep-"));
  const paths = {
    dbPath: path.join(directory, "service.sqlite"), stateDir: directory, homeDir: directory, dataDir: directory,
    sharedWorkspaceDir: directory, downloadsDir: directory, artifactsDir: path.join(directory, "artifacts"),
  };
  const context = BACKGROUND_CONTEXT;
  const agent = { model: { provider: "fake", modelId: "fake-model" } };
  const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  const providerInputs: string[] = [];
  const reply = ({ messages }: { messages: readonly unknown[] }) => {
    providerInputs.push(JSON.stringify(messages));
    return fauxAssistantMessage("resumed generation");
  };
  provider.setResponses([reply, reply]);
  const models = createModels();
  models.setProvider(provider.provider);
  const taskDocument = defineDoc({
    kind: "test.sweep-task", scope: "task", version: 1, initial: () => ({ input: "" }), checkpointWhen: () => false,
  });
  async function seedGeneration(conversation: Conversation, input: string) {
    // Commit a placed input and its pending generation without enabling the fixture's scheduler.
    return conversation.commit(async (tx) => {
      const entry = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: input, timestamp: 0 }] });
      const submission = await tx.createSubmission({ type: "input", status: "placed", entry: entry.id, requestId: input, conversationId: conversation.id });
      const taskId = await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
      (await tx.doc(LiveDoc, conversation.id)).run = { first: entry.id, inputs: [submission.id], taskId, turns: 0 };
      (await tx.doc(taskDocument, taskId)).input = input;
      return submission.id;
    }, context);
  }
  function conversationRows(db: Database) {
    return piRows(db).filter(({ table }) => table !== "pi_durable_metadata");
  }

  try {
    const servicePath = layout === "split databases" ? path.join(directory, "mapping.sqlite") : paths.dbPath;
    using db = openDb({ ...paths, dbPath: servicePath } as Config);
    using separateDurableDb = servicePath === paths.dbPath ? undefined : new Database(paths.dbPath);
    const durableDb = separateDurableDb ?? db;
    db.exec(`INSERT INTO bots (id, name, agent_id, created_at, updated_at) VALUES ('bot', 'Bot', 'pi', '', '');
      INSERT INTO threads (id, bot_id, title, created_at, updated_at) VALUES ('mapped-thread', 'bot', 'Mapped', '', '');`);
    const storage = await openNodeSqliteStorage(paths.dbPath, { prefix: "pi_" });
    const harness = await Harness.open(storage, { registry: createRegistry(), models }, context);
    const fixture = await (async () => {
      try {
        const mapped = await openThreadConversation(db, harness, "mapped-thread", "bot", context, { initialSettings: () => agent });
        const submissionId = await seedGeneration(mapped, "mapped input");
        const mappedRows = conversationRows(durableDb);
        const orphan = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
        await seedGeneration(orphan, "orphan input");

        // Simulate a crash at a rejected index insert, before the caller can compensate.
        const interrupted = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
        expect(() => db.run("INSERT INTO pi_thread_conversations VALUES ('missing-thread', 'bot', ?, '')", [interrupted.id]))
          .toThrow("FOREIGN KEY constraint failed");
        expect(durableDb.query("SELECT id FROM pi_conversations ORDER BY id").all()).toEqual([mapped, orphan, interrupted].map(({ id }) => ({ id })));
        expect(durableDb.query("SELECT conversation_id, json_extract(record, '$.kind') AS kind, status FROM pi_tasks ORDER BY id").all()).toEqual([mapped, orphan].map(({ id }) => ({
          conversation_id: id, kind: "pi.generation", status: "pending",
        })));
        expect(providerInputs).toEqual([]);
        return { mappedRows, submissionId, mappedId: mapped.id };
      } finally {
        await harness.close(context);
        await storage.close(context);
      }
    })();

    const atOpen: ReturnType<typeof conversationRows>[] = [];
    const atResume: ReturnType<typeof conversationRows>[] = [];
    const originalOpen = Harness.open;
    const open = spyOn(Harness, "open").mockImplementation(async (storage, options, context) => {
      atOpen.push(conversationRows(durableDb));
      const harness = await originalOpen.call(Harness, storage, { ...options, models }, context);
      const resume = harness.resume.bind(harness);
      harness.resume = () => {
        atResume.push(conversationRows(durableDb));
        resume();
      };
      return harness;
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const runtime = await openBotRuntime(paths, db);
      try {
        // The full snapshot covers entries, submissions, tasks, documents, revisions, and record ID claims.
        expect(atOpen).toEqual([fixture.mappedRows]);
        expect(atResume).toEqual([fixture.mappedRows]);
        await until(
          () => durableDb.query("SELECT id FROM pi_submissions WHERE id = ? AND status = 'done'").get(fixture.submissionId) ?? undefined,
          5000, "mapped generation did not finish after startup",
        );
      } finally {
        await runtime.close();
      }
      expect(providerInputs).toEqual([expect.stringContaining("mapped input")]);
      expect(providerInputs[0]).not.toContain("orphan input");
      expect(db.query("SELECT id FROM turns").all()).toEqual([]);
      expect(db.query("SELECT conversation_id FROM pi_thread_conversations").all()).toEqual([{ conversation_id: fixture.mappedId }]);
      expect(durableDb.query("SELECT id FROM pi_conversations").all()).toEqual([{ id: fixture.mappedId }]);
      const settledRows = conversationRows(durableDb);
      const reopened = await openBotRuntime(paths, db);
      await reopened.close();
      expect(conversationRows(durableDb)).toEqual(settledRows);
      expect(log.mock.calls).toEqual([["Removed 2 orphaned durable conversations on startup"]]);
    } finally {
      log.mockRestore();
      open.mockRestore();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

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
