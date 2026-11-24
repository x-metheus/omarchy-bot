import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ToolResultEntry, type ConversationId, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { api, makeBot, sendToBot, sendToThread, startDaemon } from "../../../../../../tests/integration/helpers/harness.ts";
import { setSetting } from "../../../persistence/settings.ts";
import { CredentialStore } from "../credentials.ts";
import type { RuntimeServices } from "../runtime.ts";
import { createMailExtension } from "./mail.ts";

const mail = { targetBotId: "bot-target", text: "Check the delivery queue." };
const acknowledgement = "Bot message delivery-id queued. Conclude your response without waiting for the target Bot.";

async function runMailCall(options: {
  mailbox?: RuntimeServices["mailbox"];
  arguments?: ToolCall["arguments"];
  deadlineMs?: number;
  beforeExecute?: (api: ToolExecutionApi, context: Context) => { api: ToolExecutionApi; context: Context };
}) {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall("send_bot_message", options.arguments ?? mail, { id: "mail-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const db = new Database(":memory:");
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const extension = createMailExtension(db, () => options.mailbox, new Map(), options.deadlineMs);
  const tool = extension.tools![0]!;
  const wrapped = {
    ...tool,
    execute(args: Parameters<typeof tool.execute>[0], api: ToolExecutionApi, context: Context) {
      const execution = options.beforeExecute?.(api, context) ?? { api, context };
      return tool.execute(args, execution.api, execution.context);
    },
  };
  registry.install({ ...extension, tools: [wrapped] });
  const models = createModels();
  models.setProvider(fake.provider);
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(storage, { registry, models }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" } }, context);
    db.exec(`
      CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT, bot_id TEXT, status TEXT);
      CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER);
      INSERT INTO turns VALUES ('turn-active', 'thread-active', 'bot-sender', 'working');
    `);
    db.run("INSERT INTO pi_thread_conversations VALUES ('thread-active', 'bot-sender', ?)", [conversation.id]);
    const submission = await conversation.submit({ type: "input", content: "Send mail", requestId: "turn-active" }, context);
    expect((await submission.wait(context)).status).toBe("done");
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const [entry] = items.filter(ToolResultEntry.is);
    const result = entry?.model?.find((message) => message.role === "toolResult");
    if (!result) throw new Error("Missing model tool result");
    expect(items.filter(ToolResultEntry.is)).toHaveLength(1);
    return result;
  } finally {
    await harness.close(context);
    await storage.close(context);
    db.close();
  }
}

function recordingMailbox() {
  const output = { deliveryId: "delivery-id", queued: true } as const;
  const calls: Parameters<RuntimeServices["mailbox"]["enqueue"]>[] = [];
  const mailbox: RuntimeServices["mailbox"] = { enqueue(...args) { calls.push(args); return output; } };
  return { calls, mailbox, output };
}

test("send_bot_message enqueues with active Turn identity and returns one acknowledgement and details", async () => {
  const { calls, mailbox, output } = recordingMailbox();
  const result = await runMailCall({ mailbox });
  expect(calls).toEqual([[{ botId: "bot-sender", turnId: "turn-active", toolCallId: expect.stringMatching(/^pi-task:\d+$/) }, mail.targetBotId, mail.text]]);
  expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: acknowledgement }], details: output });
  expect(result.content).toHaveLength(1);
});

test("send_bot_message rejects caller-supplied botId and turnId through its schema", async () => {
  const { calls, mailbox } = recordingMailbox();
  const result = await runMailCall({ mailbox, arguments: { ...mail, botId: "spoofed-bot", turnId: "spoofed-turn" } });
  expect(calls).toEqual([]);
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining('Validation failed for tool "send_bot_message"') }] });
});

test("send_bot_message fails clearly before mailbox binding", async () => {
  const result = await runMailCall({});
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("mailbox service is not bound") }] });
});

test("send_bot_message honors cancellation before enqueue", async () => {
  const { calls, mailbox } = recordingMailbox();
  const abort = new AbortController();
  abort.abort(new Error("mail call cancelled before enqueue"));
  const result = await runMailCall({ mailbox, beforeExecute: (api, context) => ({ api, context: withAbortSignal(abort.signal, context) }) });
  expect(calls).toEqual([]);
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("mail call cancelled before enqueue") }] });
});

test("send_bot_message times out during identity lookup and passes the deadline to pi-durable", async () => {
  const { calls, mailbox } = recordingMailbox();
  let lookupSignal: AbortSignal | undefined;
  const result = await runMailCall({
    mailbox,
    deadlineMs: 20,
    beforeExecute: (api, context) => ({
      context,
      api: { ...api, getTask: (_id, lookupContext) => {
        lookupSignal = lookupContext.abortSignal;
        return new Promise(() => {});
      } },
    }),
  });
  expect(lookupSignal?.aborted).toBe(true);
  expect(calls).toEqual([]);
  expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("send_bot_message timed out") }] });
});

test("send_bot_message acknowledges a successful enqueue that finishes after its deadline", async () => {
  const { calls, mailbox, output } = recordingMailbox();
  const deadlineMs = 50;
  const result = await runMailCall({
    deadlineMs,
    mailbox: {
      enqueue(...args) {
        Bun.sleepSync(deadlineMs);
        return mailbox.enqueue(...args);
      },
    },
  });
  expect(calls).toHaveLength(1);
  expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: acknowledgement }], details: output });
});

async function withMailDaemon(
  provider: ReturnType<typeof fauxProvider>["provider"],
  run: (daemon: Awaited<ReturnType<typeof startDaemon>>, harness: Harness) => Promise<void>,
  onReplay?: (first: ToolExecutionResult, replayed: ToolExecutionResult) => void,
) {
  let harness: Harness | undefined;
  const originalOpen = Harness.open;
  Harness.open = async (storage, options, context) => {
    if (onReplay) {
      const registry = options.registry;
      const extension = registry.snapshot().extension("omarchy-mail");
      const tool = extension?.tools?.find(({ name }) => name === "send_bot_message");
      if (!extension || !tool || !("install" in registry) || typeof registry.install !== "function") throw new Error("Expected the installed mail extension");
      registry.install({ ...extension, tools: [{
        ...tool,
        async execute(args: Parameters<typeof tool.execute>[0], api: ToolExecutionApi, context: Context) {
          const first = await tool.execute(args, api, context);
          onReplay(first, await tool.execute(args, api, context));
          return first;
        },
      }] });
    }
    harness = await originalOpen.call(Harness, storage, {
      ...options,
      models: () => {
        const models = typeof options.models === "function" ? options.models() : options.models;
        if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
        models.setProvider(provider);
        return models;
      },
    }, context);
    return harness;
  };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon();
    if (process.env.OMARCHY_TEST_DURABLE !== "1") {
      new CredentialStore(daemon.svc.cfg.stateDir).add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
      setSetting(daemon.svc.db, "default_model", "fake/fake-model");
      setSetting(daemon.svc.db, "runtime", "durable");
    }
    if (!harness) throw new Error("Expected the daemon's durable Harness");
    await run(daemon, harness);
  } finally {
    try { await daemon?.stop(); }
    finally {
      Harness.open = originalOpen;
      if (daemon) {
        try { rmSync(daemon.svc.cfg.stateDir, { recursive: true, force: true }); }
        finally { rmSync(daemon.home, { recursive: true, force: true }); }
      }
    }
  }
}

test("the daemon queues mail and creates a target Thread for the first Turn while a follow-up is admitted", async () => {
  let targetBotId = "";
  const firstRequest = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  fake.setResponses([
    async () => {
      firstRequest.resolve();
      await release.promise;
      return fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "mail-call" }), { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Mail sent"),
    fauxAssistantMessage("Follow-up answered"),
  ]);
  await withMailDaemon(fake.provider, async (h) => {
    try {
      const sourceBotId = await makeBot(h, "Sender");
      targetBotId = await makeBot(h, "Recipient");
      h.svc.agents.markOffline("pi", "Keep the mail delivery queued during this test");
      const first = await sendToBot(h, sourceBotId, "Send a message to the recipient");
      await firstRequest.promise;
      const followUp = await api<{ turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "A later request", whenBusy: "followUp" });
      expect(h.svc.threads.turnRow(first.turnId)?.status).toBe("working");
      expect(h.svc.threads.turnRow(followUp.turnId)?.status).toBe("working");
      release.resolve();
      expect((await h.svc.turns.waitForTerminal(first.turnId)).status).toBe("completed");
      expect((await h.svc.turns.waitForTerminal(followUp.turnId)).status).toBe("completed");

      const deliveries = h.svc.db.query(`
        SELECT delivery.source_bot_id, delivery.source_turn_id, delivery.source_tool_call_id,
               delivery.target_bot_id, delivery.state, thread.bot_id AS thread_bot_id, thread.title, message.text
        FROM bot_mail_deliveries AS delivery
        JOIN threads AS thread ON thread.id = delivery.thread_id
        JOIN messages AS message ON message.id = delivery.message_id
      `).all();
      expect(deliveries).toEqual([{
        source_bot_id: sourceBotId, source_turn_id: first.turnId, source_tool_call_id: expect.stringMatching(/^pi-task:\d+$/),
        target_bot_id: targetBotId, state: "queued", thread_bot_id: targetBotId, title: "From Sender", text: mail.text,
      }]);
    } finally { release.resolve(); }
  });
});

test.each([
  ["queues mail for the Turn that owns the steer", false],
  ["rejects mail when a steer and follow-up belong to different Turns", true],
] as const)("a final-answer boundary %s", async (_name, admitFollowUp) => {
  let targetBotId = "";
  let result: unknown;
  const firstRequest = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  fake.setResponses([
    async () => {
      firstRequest.resolve();
      await release.promise;
      return fauxAssistantMessage("First answer");
    },
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "mail-call" }), { stopReason: "toolUse" }),
    ({ messages }) => {
      result = messages.at(-1);
      return fauxAssistantMessage("Steering answered");
    },
  ]);
  await withMailDaemon(fake.provider, async (h) => {
    try {
      const sourceBotId = await makeBot(h, "Sender");
      targetBotId = await makeBot(h, "Recipient");
      h.svc.agents.markOffline("pi", "Keep the mail delivery queued during this test");
      const first = await sendToBot(h, sourceBotId, "Finish the first answer");
      await firstRequest.promise;
      const steer = await sendToThread(h, first.threadId, "Send mail on the next response");
      expect(steer).toMatchObject({ action: "steered", turnId: first.turnId });
      const followUp = admitFollowUp
        ? await api<{ turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "A different Turn", whenBusy: "followUp" })
        : undefined;
      release.resolve();
      expect((await h.svc.turns.waitForTerminal(first.turnId)).status).toBe("completed");
      const deliveries = h.svc.db.query("SELECT id, source_turn_id, source_bot_id, target_bot_id FROM bot_mail_deliveries").all();
      if (followUp) {
        expect(followUp.turnId).not.toBe(first.turnId);
        expect((await h.svc.turns.waitForTerminal(followUp.turnId)).status).toBe("completed");
        expect(result).toMatchObject({ role: "toolResult", isError: true, content: [{ type: "text", text: expect.stringContaining("live run has no unique Service Turn owner") }] });
        expect(deliveries).toEqual([]);
      } else {
        expect(result).toMatchObject({ role: "toolResult", isError: false, details: { deliveryId: expect.any(String), queued: true } });
        expect(deliveries).toEqual([{ id: expect.any(String), source_turn_id: first.turnId, source_bot_id: sourceBotId, target_bot_id: targetBotId }]);
      }
    } finally { release.resolve(); }
  });
});

test("send_bot_message rejects both calls with the same ID in one assistant response", async () => {
  let firstTarget = "";
  let secondTarget = "";
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  fake.setResponses([
    () => fauxAssistantMessage([
      fauxToolCall("send_bot_message", { targetBotId: firstTarget, text: "First message" }, { id: "duplicate-call" }),
      fauxToolCall("send_bot_message", { targetBotId: secondTarget, text: "Second message" }, { id: "duplicate-call" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const sender = await makeBot(h, "Sender");
    firstTarget = await makeBot(h, "First recipient");
    secondTarget = await makeBot(h, "Second recipient");
    h.svc.agents.markOffline("pi", "Keep any unexpected mail deliveries queued during this test");
    const sent = await sendToBot(h, sender, "Send a message to each recipient");
    expect((await h.svc.turns.waitForTerminal(sent.turnId)).status).toBe("completed");
    const binding = h.svc.db.query<{ conversation_id: ConversationId }, [string]>(
      "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?",
    ).get(sent.threadId);
    if (!binding) throw new Error("Missing Thread conversation binding");
    const conversation = await harness.conversation(binding.conversation_id, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("Missing durable conversation");
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const results = items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? []);
    const error = {
      role: "toolResult",
      toolName: "send_bot_message",
      toolCallId: "duplicate-call",
      isError: true,
      content: [{ type: "text", text: expect.stringContaining('duplicate tool call ID "duplicate-call" in the assistant response') }],
    };
    expect(results).toHaveLength(2);
    expect(results).toMatchObject([error, error]);
    expect(h.svc.db.query("SELECT id FROM bot_mail_deliveries").all()).toEqual([]);
  });
});

test("send_bot_message distinguishes reused call IDs across tool tasks and deduplicates the same task on replay", async () => {
  let firstTarget = "";
  let secondTarget = "";
  const replays: { first: ToolExecutionResult; replayed: ToolExecutionResult }[] = [];
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId: firstTarget, text: "First message" }, { id: "shared-call" }), { stopReason: "toolUse" }),
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId: secondTarget, text: "Second message" }, { id: "shared-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  await withMailDaemon(fake.provider, async (h) => {
    const sender = await makeBot(h, "Sender");
    firstTarget = await makeBot(h, "First recipient");
    secondTarget = await makeBot(h, "Second recipient");
    h.svc.agents.markOffline("pi", "Keep the mail deliveries queued during this test");
    const sent = await sendToBot(h, sender, "Send a message to each recipient");
    expect((await h.svc.turns.waitForTerminal(sent.turnId)).status).toBe("completed");
    const deliveries = h.svc.db.query<{ id: string; target_bot_id: string; text: string }, [string]>(`
      SELECT delivery.id, delivery.target_bot_id, message.text
      FROM bot_mail_deliveries AS delivery
      JOIN messages AS message ON message.id = delivery.message_id
      WHERE delivery.source_turn_id = ?
      ORDER BY message.text
    `).all(sent.turnId);
    expect(replays).toHaveLength(2);
    expect(replays[1]!.first.details).not.toEqual(replays[0]!.first.details);
    expect(deliveries).toEqual([
      { id: expect.any(String), target_bot_id: firstTarget, text: "First message" },
      { id: expect.any(String), target_bot_id: secondTarget, text: "Second message" },
    ]);
    for (const [index, { first, replayed }] of replays.entries()) {
      expect(first.details).toEqual({ deliveryId: deliveries[index]!.id, queued: true });
      expect(replayed).toEqual(first);
    }
  }, (first, replayed) => { replays.push({ first, replayed }); });
});
