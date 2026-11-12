import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Harness, createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { api, makeBot, sendToBot, sendToThread, startDaemon, waitThreadIdle } from "../../../../../tests/integration/helpers/harness.ts";
import { setSetting } from "../../persistence/settings.ts";
import { withFakeRuntimeProvider } from "./harness-test-support.ts";
import { CredentialStore } from "./credentials.ts";
import { openBotRuntime } from "./runtime.ts";

test("runtime creates durable tables and can close and reopen", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-runtime-"));
  const dbPath = path.join(directory, "service.sqlite");
  const stateDir = path.join(directory, "state");
  const store = new CredentialStore(stateDir);
  store.add({ id: "openai", name: "OpenAI", protocol: "built-in", apiKey: "test-key" });
  expect(existsSync(path.join(stateDir, "model-credentials.json"))).toBe(true);
  expect(existsSync(path.join(directory, "model-credentials.json"))).toBe(false);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = await openBotRuntime(dbPath, stateDir);
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*'").all();
          expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
            "pi_durable_schema",
            "pi_durable_metadata",
            "pi_record_ids",
            "pi_conversations",
            "pi_entries",
            "pi_tasks",
            "pi_submissions",
            "pi_documents",
            "pi_document_revisions",
          ]));
        } finally {
          db.close();
        }
      } finally {
        await runtime.close();
        await expect(runtime.close()).resolves.toBeUndefined();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime opens and creates durable tables with corrupt credentials", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-runtime-corrupt-"));
  const stateDir = path.join(directory, "state");
  const dbPath = path.join(directory, "service.sqlite");
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, "model-credentials.json"), "");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const originalOpen = Harness.open;
  const open = spyOn(Harness, "open").mockImplementation((storage, options, context) => {
    const settings = typeof options.settings === "function" ? options.settings() : options.settings;
    expect(settings?.afterFailedRun).toBe("continue");
    expect(settings?.restartLimit).toBe(5);
    if (typeof options.models === "function") {
      options.models();
      options.models();
    }
    return originalOpen.call(Harness, storage, options, context);
  });
  try {
    const runtime = await openBotRuntime(dbPath, stateDir);
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*'").all();
        expect(tables.map(({ name }) => name)).toContain("pi_durable_schema");
      } finally { db.close(); }
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("Unable to load model credential store; continuing without stored providers");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("test-key");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("apiKey");
    } finally { await runtime.close(); }
  } finally { open.mockRestore(); warning.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});


test("configured conversation uses the Service limit for unset and null Bots and the Bot override otherwise", () => withFakeRuntimeProvider(Array.from({ length: 3 }, () => ({ segments: [{ type: "text" as const, text: "ok" }] })), {}, async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Default limit");
    const custom = await api<{ id: string }>(h, "POST", "/api/bots", { name: "Custom limit", agentId: "pi", maxTurns: 3 });
    new CredentialStore(h.svc.cfg.stateDir).add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");
    async function limit(threadId: string): Promise<number | undefined> {
      const storage = await openNodeSqliteStorage(path.join(h.home, "db.sqlite"), { prefix: "pi_" });
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
      try {
        const indexed = h.svc.db.query<{ conversation_id: number }, [string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?").get(threadId);
        if (!indexed) throw new Error("Conversation not indexed");
        const conversation = await harness.conversation(indexed.conversation_id as ConversationId, BACKGROUND_CONTEXT);
        if (!conversation) throw new Error("Conversation not found");
        return (await conversation.agent(BACKGROUND_CONTEXT)).maxTurns;
      } finally { await harness.close(BACKGROUND_CONTEXT); await storage.close(BACKGROUND_CONTEXT); }
    }
    const first = await sendToBot(h, botId, "default");
    await waitThreadIdle(h, first.threadId);
    expect(await limit(first.threadId)).toBe(50);
    const second = await sendToBot(h, custom.id, "custom");
    await waitThreadIdle(h, second.threadId);
    expect(await limit(second.threadId)).toBe(3);
    await api(h, "PATCH", `/api/bots/${custom.id}`, { maxTurns: null });
    await sendToThread(h, second.threadId, "reset");
    await waitThreadIdle(h, second.threadId);
    expect(await limit(second.threadId)).toBe(50);
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));
