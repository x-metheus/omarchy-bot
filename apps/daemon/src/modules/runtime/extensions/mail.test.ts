import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, getCurrentSystemPrompt, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness, ToolResultEntry, type ConversationId, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { api, makeBot, messages, sendToBot, sendToThread, startDaemon } from "../../../../../../tests/integration/helpers/harness.ts";
import { setSetting } from "../../../persistence/settings.ts";
import { FakeBotScreenRuntimeAdapter } from "../../computer/fakeBotScreenRuntime.ts";
import type { RuntimeServices } from "../runtime.ts";
import { createMailExtension } from "./mail.ts";
import { DurableTranscript } from "../transcript.ts";

const mail = { targetBotId: "bot-target", text: "Check the delivery queue." };
const acknowledgement = "Bot message delivery-id queued. Conclude your response without waiting for the target Bot.";

async function runMailCall(options: {
  mailbox?: RuntimeServices["mailbox"];
  arguments?: ToolCall["arguments"];
  deadlineMs?: number;
  writeService?: Parameters<typeof createMailExtension>[4];
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
  const extension = createMailExtension(db, () => options.mailbox, new Map(), options.deadlineMs, options.writeService);
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

test("send_bot_message times out while the writer is held and skips the cancelled enqueue", async () => {
  const { calls, mailbox } = recordingMailbox();
  const releaseWriter = Promise.withResolvers<void>();
  let pendingWrite: Promise<unknown> | undefined;
  const waiting = runMailCall({
    mailbox,
    deadlineMs: 50,
    writeService: (write) => {
      const queued = releaseWriter.promise.then(write);
      pendingWrite = queued.catch(() => {});
      return queued;
    },
  });
  try {
    const result = await Promise.race([waiting, Bun.sleep(500).then(() => "writer still held")]);
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("send_bot_message timed out") }] });
  } finally {
    releaseWriter.resolve();
    await waiting;
    expect(pendingWrite).toBeDefined();
    await pendingWrite;
  }
  expect(calls).toEqual([]);
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
  botScreenAdapter?: FakeBotScreenRuntimeAdapter,
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
    daemon = await startDaemon(undefined, { seedDurableProvider: false, ...(botScreenAdapter ? { botScreenAdapter } : {}) });
    if (!daemon.svc.credentials.getForRuntime("fake")) {
      await daemon.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    }
    setSetting(daemon.svc.db, "default_model", "fake/fake-model");
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

test.each([
  ["includes the live sender ID and does not redispatch delivered mail after readiness rechecks", false],
  ["omits a sender ID deleted before dispatch", "before"],
  ["omits a sender ID deleted inside the claim transaction", "claim"],
] as const)("durable peer-mail dispatch %s", async (_name, deleteSender) => {
  let targetBotId = "";
  const targetInstructions = "Review the release notes.";
  const targetRequest = Promise.withResolvers<{ content: string; model: string; instructions: string }>();
  const releaseReply = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }, { id: "reviewer-model", reasoning: true }] });
  fake.setResponses(Array.from({ length: 10 }, () => async ({ messages }: TranscriptContext, _options, _state, model) => {
    const last = messages.at(-1);
    const user = messages.findLast((message) => message.role === "user");
    if (last?.role === "toolResult") return fauxAssistantMessage("Mail sent.");
    if (user?.content === "Send peer mail") {
      return fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" });
    }
    targetRequest.resolve({ content: typeof user?.content === "string" ? user.content : "", model: model.id, instructions: getCurrentSystemPrompt(messages) });
    await releaseReply.promise;
    return fauxAssistantMessage([fauxThinking("Read the notice."), fauxText("Peer mail handled.")]);
  }));
  await withMailDaemon(fake.provider, async (h, harness) => {
    try {
      const sourceName = "Release coordinator";
      const sourceBotId = await makeBot(h, sourceName);
      targetBotId = await makeBot(h, "Release reviewer", targetInstructions);
      h.svc.db.query("UPDATE bots SET model = ? WHERE id = ?").run("fake/reviewer-model", targetBotId);
      if (deleteSender) h.svc.agents.markOffline("pi", "Keep mail queued until sender deletion");
      const sent = await sendToBot(h, sourceBotId, "Send peer mail");
      expect((await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).status).toBe("completed");
      if (deleteSender) {
        expect(h.svc.db.query("SELECT state FROM bot_mail_deliveries").get()).toEqual({ state: "queued" });
        if (deleteSender === "claim") {
          h.svc.db.exec(`CREATE TEMP TRIGGER delete_mail_sender_on_claim
            AFTER UPDATE OF state ON bot_mail_deliveries WHEN NEW.state = 'dispatching'
            BEGIN DELETE FROM bots WHERE id = NEW.source_bot_id; END`);
        } else {
          expect(await api(h, "DELETE", `/api/bots/${sourceBotId}`, {})).toMatchObject({ status: "deleted" });
        }
        await h.svc.agents.recheck("pi");
      }
      const delivery = await waitForPeerMailDelivery(h);
      const author = deleteSender ? `Message from Bot ${sourceName}` : `Message from Bot ${sourceName} (${sourceBotId})`;
      const content = `${author}: ${mail.text}`;
      expect(h.svc.threads.turnRow(delivery.target_turn_id)?.status).toBe("working");
      if (!deleteSender) {
        h.svc.agents.markOffline("pi", "Trigger another readiness dispatch for the same mailbox");
        await Promise.all([h.svc.agents.recheck("pi"), h.svc.agents.recheck("pi")]);
      }
      const binding = h.svc.db.query<{ conversation_id: ConversationId }, [string]>(
        "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?",
      ).get(delivery.thread_id);
      if (!binding) throw new Error("Missing peer-mail Thread conversation");
      const conversation = await harness.conversation(binding.conversation_id, BACKGROUND_CONTEXT);
      if (!conversation) throw new Error("Missing peer-mail durable conversation");
      const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
      expect(items.filter(({ kind }) => kind === "write")).toEqual([
        expect.objectContaining({ kind: "write", data: { author, text: mail.text, deliveryId: delivery.id }, model: [expect.objectContaining({ role: "user", content })] }),
      ]);
      expect(h.svc.db.query(`
        SELECT json_extract(s.record, '$.type') AS type, json_extract(s.record, '$.requestId') AS request_id,
               json_extract(s.record, '$.entry') AS entry_id
        FROM pi_submissions s WHERE s.conversation_id = ?
      `).all(binding.conversation_id)).toEqual([{ type: "input", request_id: delivery.target_turn_id, entry_id: items.find(({ kind }) => kind === "write")?.id }]);
      expect(await targetRequest.promise).toEqual({ content, model: "reviewer-model", instructions: expect.stringContaining(targetInstructions) });
      releaseReply.resolve();
      expect((await h.svc.turns.waitForTerminal(delivery.target_turn_id, 5_000)).status).toBe("completed");
      expect(h.svc.db.query("SELECT id, native_session_id FROM turns WHERE thread_id = ?").all(delivery.thread_id)).toEqual([
        { id: delivery.target_turn_id, native_session_id: "" },
      ]);
      expect(await messages(h, delivery.thread_id)).toEqual([
        expect.objectContaining({ kind: "text", author: { kind: "system" }, text: mail.text, peerMail: { deliveryId: delivery.id, sourceName, ...(deleteSender ? {} : { sourceBotId }) } }),
        expect.objectContaining({ kind: "thinking", text: "Read the notice.", thinking: expect.objectContaining({ state: "completed" }) }),
        expect.objectContaining({ kind: "response", text: "Peer mail handled.", response: expect.objectContaining({ state: "completed" }) }),
      ]);
    } finally { releaseReply.resolve(); }
  });
}, 15_000);

test.each([
  ["allows a user steer while mail admission waits and replies once after the user run", false],
  ["can be aborted after queueing behind a user run that starts after configuration", true],
] as const)("peer mail %s", async (_name, abortMail) => {
  let targetBotId = "";
  const userStarted = Promise.withResolvers<void>();
  const releaseUser = Promise.withResolvers<void>();
  const updatedInstructions = "Updated recipient instructions.";
  const releaseMailSubmission = Promise.withResolvers<void>();
  const mailRequest = Promise.withResolvers<{ content: unknown; model: string; instructions: string }>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }, { id: "updated-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    fauxAssistantMessage("Initial reply."),
    async ({ messages }, _options, _state, model) => {
      expect(model.id).toBe("updated-model");
      expect(getCurrentSystemPrompt(messages)).toContain(updatedInstructions);
      userStarted.resolve();
      await releaseUser.promise;
      if (abortMail) return fauxAssistantMessage("User reply.");
      return fauxAssistantMessage(fauxToolCall("read", { path: "peer-mail-test.txt" }), { stopReason: "toolUse" });
    },
    ({ messages }, _options, _state, model) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(user?.content).toBe("A competing user message");
      expect(model.id).toBe("updated-model");
      expect(getCurrentSystemPrompt(messages)).toContain(updatedInstructions);
      return fauxAssistantMessage("User reply.");
    },
    ({ messages }, _options, _state, model) => {
      const user = messages.findLast((message) => message.role === "user");
      mailRequest.resolve({ content: user?.content, model: model.id, instructions: getCurrentSystemPrompt(messages) });
      return fauxAssistantMessage("Mail reply.");
    },
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    try {
      const source = await makeBot(h, "Sender");
      targetBotId = await makeBot(h, "Recipient", "Original recipient instructions.");
      h.svc.agents.markOffline("pi", "Hold mail while setting up its Thread");
      const sent = await sendToBot(h, source, "Send mail");
      expect((await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).status).toBe("completed");
      const initial = h.svc.db.query<{ id: string; thread_id: string; state: string }, []>("SELECT id, thread_id, state FROM bot_mail_deliveries").get()!;
      expect(initial.state).toBe("queued");
      writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "peer-mail-test.txt"), "A tool boundary for the user steer.");
      const seeded = await sendToThread(h, initial.thread_id, "Configure the conversation.");
      expect(await h.svc.turns.waitForTerminal(seeded.turnId, 5_000)).toMatchObject({ status: "completed" });
      const binding = h.svc.db.query<{ conversation_id: ConversationId }, [string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?").get(initial.thread_id)!;
      const conversation = (await harness.conversation(binding.conversation_id, BACKGROUND_CONTEXT))!;
      await api(h, "PATCH", `/api/bots/${targetBotId}`, { instructions: updatedInstructions });
      h.svc.db.query("UPDATE bots SET model = ? WHERE id = ?").run("fake/updated-model", targetBotId);
      const competingUser = Promise.withResolvers<Awaited<ReturnType<typeof sendToThread>>>();
      void competingUser.promise.catch(() => {});
      const open = harness.conversation.bind(harness);
      harness.conversation = async (...args) => {
        const opened = await open(...args);
        if (!opened || opened.id !== conversation.id) return opened;
        opened.submit = new Proxy(opened.submit, {
          async apply(submit, receiver, args) {
            const [draft] = args;
            if (draft.type === "input" && draft.entry?.kind === "write") {
              try {
                const agent = await opened.agent(BACKGROUND_CONTEXT);
                expect(agent.model?.modelId).toBe("updated-model");
                expect(agent.instructions).toContain(updatedInstructions);
                const user = await h.svc.turns.send(targetBotId, initial.thread_id, "A user message", [], undefined, { whenBusy: "followUp" });
                await userStarted.promise;
                competingUser.resolve(user);
                await releaseMailSubmission.promise;
              } catch (error) {
                competingUser.reject(error);
                throw error;
              }
            }
            return Reflect.apply(submit, receiver, args);
          },
        });
        return opened;
      };
      await h.svc.agents.recheck("pi");
      const user = await competingUser.promise;
      if (!abortMail) {
        const bound = withAbortSignal(AbortSignal.timeout(1_000), BACKGROUND_CONTEXT);
        const competing = await awaitWithContext(sendToThread(h, initial.thread_id, "A competing user message"), bound);
        expect(competing).toMatchObject({ action: "steered", turnId: user.turnId });
      }
      releaseMailSubmission.resolve();
      const delivered = await waitForPeerMailDelivery(h);
      expect(delivered.id).toBe(initial.id);
      const submission = h.svc.db.query<{ type: string; status: string }, [string]>(`
        SELECT json_extract(record, '$.type') AS type, status FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?
      `);
      expect(submission.all(delivered.target_turn_id)).toEqual([{ type: "input", status: "queued" }]);
      expect(h.svc.threads.turnRow(user.turnId)?.status).toBe("working");
      if (abortMail) {
        await h.svc.turns.abortTurn(delivered.target_turn_id, "Cancel the queued mail reply");
        expect(await h.svc.turns.waitForTerminal(delivered.target_turn_id, 5_000)).toMatchObject({ status: "cancelled" });
        expect(await waitForPeerMailDelivery(h)).toEqual(delivered);
        expect(submission.all(delivered.target_turn_id)).toEqual([{ type: "input", status: "unanswered" }]);
        expect(h.svc.threads.turnRow(user.turnId)?.status).toBe("working");
        releaseUser.resolve();
        expect(await h.svc.turns.waitForTerminal(user.turnId, 5_000)).toMatchObject({ status: "completed" });
        const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
        expect(items.filter(({ kind }) => kind === "write")).toEqual([]);
        expect(items.filter(AssistantEntry.is)).toHaveLength(2);
        expect(fake.state.callCount).toBe(4);
        return;
      }
      releaseUser.resolve();
      for (const turnId of [user.turnId, delivered.target_turn_id]) {
        expect(await h.svc.turns.waitForTerminal(turnId, 5_000)).toMatchObject({ status: "completed" });
      }
      expect(await mailRequest.promise).toEqual({
        content: `Message from Bot Sender (${source}): ${mail.text}`,
        model: "updated-model",
        instructions: expect.stringContaining(updatedInstructions),
      });
      const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
      expect(items.filter(({ kind }) => kind === "write")).toHaveLength(1);
      expect(submission.all(delivered.target_turn_id)).toEqual([{ type: "input", status: "done" }]);
      expect(h.svc.db.query("SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid").all(initial.thread_id)).toEqual([
        { id: seeded.turnId }, { id: delivered.target_turn_id }, { id: user.turnId },
      ]);
      expect((await messages(h, initial.thread_id)).map(({ kind, text, peerMail }) => ({ kind, text, deliveryId: peerMail?.deliveryId }))).toEqual([
        { kind: "text", text: mail.text, deliveryId: initial.id },
        { kind: "text", text: "Configure the conversation.", deliveryId: undefined },
        { kind: "response", text: "Initial reply.", deliveryId: undefined },
        { kind: "text", text: "A user message", deliveryId: undefined },
        { kind: "text", text: "A competing user message", deliveryId: undefined },
        { kind: "tool", text: undefined, deliveryId: undefined },
        { kind: "response", text: "User reply.", deliveryId: undefined },
        { kind: "response", text: "Mail reply.", deliveryId: undefined },
      ]);
      expect(h.svc.db.query("SELECT turn_id FROM messages WHERE thread_id = ? AND kind = 'response' ORDER BY seq").all(initial.thread_id)).toEqual([
        { turn_id: seeded.turnId }, { turn_id: user.turnId }, { turn_id: delivered.target_turn_id },
      ]);
      expect(fake.state.callCount).toBe(6);
    } finally {
      releaseMailSubmission.resolve();
      releaseUser.resolve();
    }
  });
}, 15_000);

test("peer mail preserves an active user reply's configuration and refreshes its own model prompt with new instructions and Skills", async () => {
  let targetBotId = "";
  const originalInstructions = "Use the original release checklist.";
  const updatedInstructions = "Use the updated release evidence.";
  const skill = { name: "release-review", description: "Review release evidence from the workspace Skill" };
  const relativePath = `.agents/skills/${skill.name}/SKILL.md`;
  const userStarted = Promise.withResolvers<void>();
  const releaseUser = Promise.withResolvers<void>();
  const configurationAttempted = Promise.withResolvers<void>();
  const requests: { model: string; prompt: string }[] = [];
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }, { id: "updated-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    fauxAssistantMessage("Initial reply."),
    async ({ messages }, _options, _state, model) => {
      requests.push({ model: model.id, prompt: getCurrentSystemPrompt(messages) });
      userStarted.resolve();
      await releaseUser.promise;
      return fauxAssistantMessage(fauxToolCall("read", { path: "release.txt" }), { stopReason: "toolUse" });
    },
    ({ messages }, _options, _state, model) => {
      requests.push({ model: model.id, prompt: getCurrentSystemPrompt(messages) });
      return fauxAssistantMessage("User reply.");
    },
    ({ messages }, _options, _state, model) => {
      requests.push({ model: model.id, prompt: getCurrentSystemPrompt(messages) });
      return fauxAssistantMessage("Mail reply.");
    },
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const source = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient", originalInstructions);
    h.svc.agents.markOffline("pi", "Hold mail while setting up the existing conversation");
    const sent = await sendToBot(h, source, "Send mail");
    expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
    const delivery = h.svc.db.query<{ thread_id: string; state: string }, []>("SELECT thread_id, state FROM bot_mail_deliveries").get()!;
    expect(delivery.state).toBe("queued");
    const seeded = await sendToThread(h, delivery.thread_id, "Review the release checklist.");
    expect(await h.svc.turns.waitForTerminal(seeded.turnId, 5_000)).toMatchObject({ status: "completed" });
    const binding = h.svc.db.query<{ conversation_id: ConversationId }, [string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?");
    const before = binding.get(delivery.thread_id)!;
    const open = harness.conversation.bind(harness);
    const conversation = (await open(before.conversation_id, BACKGROUND_CONTEXT))!;
    writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "release.txt"), "Release evidence.");

    let userTurnId: string | undefined;
    harness.conversation = async (...args) => {
      const opened = await open(...args);
      if (!opened || opened.id !== conversation.id) return opened;
      harness.conversation = open;
      const waitForIdle = opened.waitForIdle.bind(opened);
      opened.waitForIdle = async (context) => {
        await waitForIdle(context);
        opened.waitForIdle = waitForIdle;
        // Start a real user run after mail observes idle and before it can commit configuration.
        const user = await h.svc.turns.send(targetBotId, delivery.thread_id, "Review the release evidence.", [], undefined, { whenBusy: "followUp" });
        userTurnId = user.turnId;
        await userStarted.promise;
        const skillPath = path.join(h.svc.cfg.sharedWorkspaceDir, relativePath);
        mkdirSync(path.dirname(skillPath), { recursive: true });
        writeFileSync(skillPath, `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nReview the release evidence.\n`);
        await api(h, "PATCH", `/api/bots/${targetBotId}`, { instructions: updatedInstructions });
        h.svc.db.query("UPDATE bots SET model = ? WHERE id = ?").run("fake/updated-model", targetBotId);
      };
      const commit = opened.commit.bind(opened);
      opened.commit = (change, context, options) => {
        opened.commit = commit;
        const result = commit(change, context, options);
        void result.then(() => configurationAttempted.resolve(), configurationAttempted.reject);
        return result;
      };
      return opened;
    };
    try {
      await h.svc.agents.recheck("pi");
      const bound = withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT);
      await awaitWithContext(configurationAttempted.promise, bound);
      releaseUser.resolve();
      expect(await h.svc.turns.waitForTerminal(userTurnId!, 5_000)).toMatchObject({ status: "completed" });
      const delivered = await waitForPeerMailDelivery(h);
      expect(delivered.thread_id).toBe(delivery.thread_id);
      expect(await h.svc.turns.waitForTerminal(delivered.target_turn_id, 5_000)).toMatchObject({ status: "completed" });
      expect(binding.get(delivered.thread_id)).toEqual(before);
      expect(requests.map(({ model }) => model)).toEqual(["fake-model", "fake-model", "updated-model"]);
      for (const { prompt } of requests.slice(0, 2)) {
        expect(prompt).toContain(originalInstructions);
        expect(prompt).not.toContain(updatedInstructions);
        expect(prompt).not.toContain(skill.name);
      }
      expect(requests[2]?.prompt).toContain(`${skill.name}: ${skill.description} (${relativePath})`);
      expect(requests[2]?.prompt).toContain(updatedInstructions);
      expect(requests[2]?.prompt).not.toContain(originalInstructions);
      expect(h.svc.db.query("SELECT text FROM messages WHERE turn_id = ? AND kind = 'response'").all(delivered.target_turn_id)).toEqual([{ text: "Mail reply." }]);
    } finally {
      releaseUser.resolve();
      harness.conversation = open;
    }
  });
}, 15_000);

test("peer mail resolves the current Bot's custom model outside the provider catalog on an existing conversation", async () => {
  let targetBotId = "";
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
  ]);
  const requested = Promise.withResolvers<string>();
  const reply = "Mail answered using its current custom model.";
  const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string };
    requested.resolve(body.model);
    const chunk = JSON.stringify({ id: "mail-reply", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: "stop" }] });
    return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    await withMailDaemon(fake.provider, async (h, harness) => {
      const source = await makeBot(h, "Sender");
      targetBotId = await makeBot(h, "Recipient");
      h.svc.agents.markOffline("pi", "Hold dispatch while seeding the persisted conversation");
      const sent = await sendToBot(h, source, "Send mail");
      expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
      const { thread_id: threadId } = h.svc.db.query<{ thread_id: string }, []>("SELECT thread_id FROM bot_mail_deliveries").get()!;
      const model = { provider: "custom", modelId: "uncatalogued-model" };
      await h.svc.credentials.add({ id: model.provider, name: "Custom", protocol: "openai-compatible", baseUrl: endpoint.url.href, apiKey: "test-key" });
      h.svc.db.query("UPDATE bots SET model = ? WHERE id = ?").run(`${model.provider}/${model.modelId}`, targetBotId);
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "fake", modelId: "fake-model" } } }, BACKGROUND_CONTEXT);
      h.svc.db.query("INSERT INTO pi_thread_conversations (thread_id, bot_id, conversation_id, created_at) VALUES (?, ?, ?, ?)")
        .run(threadId, targetBotId, conversation.id, new Date().toISOString());
      await h.svc.agents.recheck("pi");
      const delivery = await waitForPeerMailDelivery(h);
      expect(await h.svc.turns.waitForTerminal(delivery.target_turn_id, 5_000)).toMatchObject({ status: "completed" });
      expect(await requested.promise).toBe(model.modelId);
      expect(await messages(h, threadId)).toContainEqual(expect.objectContaining({ kind: "response", text: reply }));
    });
  } finally { endpoint.stop(true); }
}, 15_000);

test.each(["final answer", "failed predecessor", "reply past the admission deadline"] as const)("peer mail projects replies under their owning Turns at the %s", async (boundary) => {
  let targetBotId = "";
  const userStarted = Promise.withResolvers<void>();
  const releaseUser = Promise.withResolvers<void>();
  const steerStarted = Promise.withResolvers<void>();
  const releaseSteer = Promise.withResolvers<void>();
  const mailStarted = Promise.withResolvers<void>();
  const releaseMail = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    async () => {
      userStarted.resolve();
      await releaseUser.promise;
      if (boundary === "failed predecessor") {
        return fauxAssistantMessage("Predecessor partial.", { stopReason: "error", errorMessage: "The predecessor reply failed." });
      }
      return fauxAssistantMessage("User reply.");
    },
    ...(boundary === "reply past the admission deadline" ? [] : [async () => {
      steerStarted.resolve();
      await releaseSteer.promise;
      return fauxAssistantMessage("Steer reply.");
    }]),
    () => boundary === "reply past the admission deadline"
      ? fauxAssistantMessage([fauxText("Intermediate mail reply."), fauxToolCall("read", { path: "peer-mail-test.txt" })], { stopReason: "toolUse" })
      : fauxAssistantMessage("Mail reply."),
    async () => {
      mailStarted.resolve();
      await releaseMail.promise;
      return fauxAssistantMessage("Mail reply.");
    },
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const replies = (threadId: string) => h.svc.db.query(
      "SELECT text, turn_id FROM messages WHERE thread_id = ? AND kind = 'response' AND block_state = 'completed' ORDER BY seq",
    ).all(threadId);
    try {
      const source = await makeBot(h, "Sender");
      targetBotId = await makeBot(h, "Recipient");
      h.svc.agents.markOffline("pi", "Hold mail while a user replies in its Thread");
      const sent = await sendToBot(h, source, "Send mail");
      expect((await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).status).toBe("completed");
      const { thread_id: threadId } = h.svc.db.query<{ thread_id: string }, []>("SELECT thread_id FROM bot_mail_deliveries").get()!;
      writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "peer-mail-test.txt"), "Mail tool boundary");
      const user = await sendToThread(h, threadId, "A user message");
      await userStarted.promise;
      const deadlineMs = 500;
      if (boundary === "reply past the admission deadline") {
        h.svc.cfg.turnTimeoutMs = deadlineMs;
      } else {
        expect(await sendToThread(h, threadId, "A competing user steer")).toMatchObject({ action: "steered", turnId: user.turnId });
        releaseUser.resolve();
        // Let the steer begin its own run before queueing mail so each run has its own reply.
        await steerStarted.promise;
      }
      const waitingForIdle = Promise.withResolvers<void>();
      const open = harness.conversation.bind(harness);
      harness.conversation = async (...args) => {
        const conversation = await open(...args);
        if (conversation) {
          const waitForIdle = conversation.waitForIdle.bind(conversation);
          conversation.waitForIdle = (context) => {
            waitingForIdle.resolve();
            return waitForIdle(context);
          };
        }
        return conversation;
      };
      await h.svc.agents.recheck("pi");
      await waitingForIdle.promise;
      const { target_turn_id: mailTurnId } = await waitForPeerMailDelivery(h, "dispatching");
      expect(h.svc.db.query("SELECT id FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?").all(mailTurnId)).toEqual([]);
      releaseUser.resolve();
      releaseSteer.resolve();
      expect(await waitForPeerMailDelivery(h)).toMatchObject({ target_turn_id: mailTurnId });
      const expected = [{ text: boundary === "failed predecessor" ? "Predecessor partial." : "User reply.", turn_id: user.turnId }];
      if (boundary === "reply past the admission deadline") {
        await mailStarted.promise;
        await Bun.sleep(deadlineMs + 50);
        expected.push({ text: "Intermediate mail reply.", turn_id: mailTurnId });
        const until = Date.now() + 1_000;
        while (replies(threadId).length < expected.length && Date.now() < until) await Bun.sleep(10);
        expect(replies(threadId)).toEqual(expected);
        releaseMail.resolve();
      }
      for (const turnId of [user.turnId, mailTurnId]) {
        expect(await h.svc.turns.waitForTerminal(turnId, 5_000)).toMatchObject({ status: "completed" });
      }
      if (boundary === "failed predecessor") {
        expect(h.svc.db.query("SELECT status FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?").get(user.turnId)).toEqual({ status: "unanswered" });
      }
      if (boundary !== "reply past the admission deadline") expected.push({ text: "Steer reply.", turn_id: user.turnId });
      expected.push({ text: "Mail reply.", turn_id: mailTurnId });
      expect(replies(threadId)).toEqual(expected);
    } finally {
      releaseUser.resolve();
      releaseSteer.resolve();
      releaseMail.resolve();
    }
  });
}, 15_000);

test("peer mail survives a transient association insert failure after its input commits", async () => {
  let targetBotId = "";
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    fauxAssistantMessage("Mail reply after bookkeeping retry."),
  ]);
  await withMailDaemon(fake.provider, async (h) => {
    const source = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient");
    h.svc.agents.markOffline("pi", "Hold mail until the association failure is armed");
    const sent = await sendToBot(h, source, "Send mail");
    expect((await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).status).toBe("completed");
    const { db } = h.svc;
    const initial = db.query<{ id: string }, []>("SELECT id FROM bot_mail_deliveries").get()!;
    const query = db.query;
    let failedTurnId: string | undefined;
    db.query = new Proxy(query, {
      apply(target, receiver, args) {
        if (!failedTurnId && /^INSERT\b.*\bINTO pi_turn_submissions/.test(String(args[0]))) {
          const admitted = db.query<{ target_turn_id: string; type: string }, [string]>(`
            SELECT d.target_turn_id, json_extract(s.record, '$.type') AS type
            FROM bot_mail_deliveries d JOIN pi_submissions s ON json_extract(s.record, '$.requestId') = d.target_turn_id
            WHERE d.id = ? AND d.state = 'dispatching'
          `).get(initial.id);
          expect(admitted?.type).toBe("input");
          failedTurnId = admitted!.target_turn_id;
          throw Object.assign(new Error("Injected busy association insert"), { code: "SQLITE_BUSY" });
        }
        return Reflect.apply(target, receiver, args);
      },
    });
    try {
      await h.svc.agents.recheck("pi");
      const delivered = await waitForPeerMailDelivery(h);
      expect(delivered).toMatchObject({ id: initial.id, target_turn_id: failedTurnId, failure_reason: null });
      expect(failedTurnId).toBeDefined();
      expect((await h.svc.turns.waitForTerminal(delivered.target_turn_id, 5_000)).status).toBe("completed");
      expect(db.query("SELECT kind FROM pi_turn_submissions WHERE turn_id = ?").all(delivered.target_turn_id)).toEqual([{ kind: "input" }]);
      expect(await messages(h, delivered.thread_id)).toEqual([
        expect.objectContaining({ kind: "text", peerMail: expect.objectContaining({ deliveryId: initial.id }) }),
        expect.objectContaining({ kind: "response", text: "Mail reply after bookkeeping retry.", response: expect.objectContaining({ state: "completed" }) }),
      ]);
    } finally { db.query = query; }
  });
}, 15_000);

test.each(["private folder", "announce write"] as const)("a durable peer-mail admission failure at the %s keeps the bounded Turn and delivery reason", async (failure) => {
  let targetBotId = "";
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
  ]);
  await withMailDaemon(fake.provider, async (h) => {
    const sourceBotId = await makeBot(h, "Release sender");
    targetBotId = await makeBot(h, "Release recipient");
    const { events } = h.svc;
    const append = events.append;
    if (failure === "private folder") {
      const botsDir = path.join(h.svc.cfg.sharedWorkspaceDir, "bots");
      mkdirSync(botsDir, { recursive: true });
      writeFileSync(path.join(botsDir, targetBotId), "Block the target's private folder");
    } else {
      events.append = function (aggregate, id, type, payload) {
        if (type === "turn.created" && (payload as { botId: string }).botId === targetBotId) throw new Error("Injected mailbox announce failure");
        return append.call(this, aggregate, id, type, payload);
      };
    }
    try {
      const sent = await sendToBot(h, sourceBotId, "Send the release notice");
      expect((await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).status).toBe("completed");
      const delivery = await waitForPeerMailDelivery(h, "failed");
      expect(delivery.failure_reason).toBe("Target Agent could not accept this message.");
      expect(await h.svc.turns.waitForTerminal(delivery.target_turn_id, 2_000)).toMatchObject({
        status: "failed", reason: delivery.failure_reason,
      });
      expect(h.svc.db.query("SELECT submission_id FROM pi_turn_submissions WHERE turn_id = ?").all(delivery.target_turn_id)).toEqual([]);
      expect(await messages(h, delivery.thread_id)).toEqual([
        expect.objectContaining({ kind: "text", text: mail.text, peerMail: expect.objectContaining({ deliveryId: delivery.id }) }),
      ]);
    } finally { events.append = append; }
  });
}, 15_000);

test("aborting peer mail while its announcement writer is held creates no pi submission", async () => {
  let targetBotId = "";
  const writerHeld = Promise.withResolvers<void>();
  const releaseWriter = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    fauxAssistantMessage("The cancelled reply should never run."),
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const source = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient");
    h.svc.agents.markOffline("pi", "Hold dispatch until the writer can be locked");
    const sent = await sendToBot(h, source, "Send mail");
    expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
    const { db, threads } = h.svc;
    const insertTurnRow = threads.insertTurnRow;
    let heldWrite: Promise<void> | undefined;
    threads.insertTurnRow = function (input) {
      insertTurnRow.call(this, input);
      if (input.botId === targetBotId) {
        heldWrite = harness.commit(async () => {
          writerHeld.resolve();
          await releaseWriter.promise;
        }, BACKGROUND_CONTEXT);
        void heldWrite.catch(writerHeld.reject);
      }
    };
    try {
      await h.svc.agents.recheck("pi");
      await writerHeld.promise;
      const claim = db.query<{ target_turn_id: string; state: string }, []>("SELECT target_turn_id, state FROM bot_mail_deliveries").get()!;
      expect(claim.state).toBe("dispatching");
      await h.svc.turns.abortTurn(claim.target_turn_id, "Cancel the queued announcement");
      releaseWriter.resolve();
      await heldWrite;
      expect(await h.svc.turns.waitForTerminal(claim.target_turn_id, 5_000)).toMatchObject({ status: "failed" });
      expect(db.query("SELECT id FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?").all(claim.target_turn_id)).toEqual([]);
      expect(await waitForPeerMailDelivery(h, "failed")).toMatchObject({ target_turn_id: claim.target_turn_id });
      expect(fake.state.callCount).toBe(2);
    } finally {
      releaseWriter.resolve();
      threads.insertTurnRow = insertTurnRow;
    }
  });
}, 15_000);

test("peer mail admission settles on abort while its configuration commit is queued", async () => {
  let targetBotId = "";
  const commitHeld = Promise.withResolvers<void>();
  const releaseCommit = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    fauxAssistantMessage("Initial reply."),
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const source = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient", "Original recipient instructions.");
    h.svc.agents.markOffline("pi", "Hold mail while setting up the existing conversation");
    const sent = await sendToBot(h, source, "Send mail");
    expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
    const { db } = h.svc;
    const { thread_id: threadId } = db.query<{ thread_id: string }, []>("SELECT thread_id FROM bot_mail_deliveries WHERE state = 'queued'").get()!;
    const seeded = await sendToThread(h, threadId, "Configure the conversation.");
    expect(await h.svc.turns.waitForTerminal(seeded.turnId, 5_000)).toMatchObject({ status: "completed" });
    const binding = db.query<{ conversation_id: ConversationId }, [string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?").get(threadId)!;
    await api(h, "PATCH", `/api/bots/${targetBotId}`, { instructions: "Updated recipient instructions." });
    const open = harness.conversation.bind(harness);
    harness.conversation = async (...args) => {
      const opened = await open(...args);
      if (!opened || opened.id !== binding.conversation_id) return opened;
      harness.conversation = open;
      const commit = opened.commit.bind(opened);
      opened.commit = (change, context, options) => {
        void harness.commit(async () => {
          commitHeld.resolve();
          await releaseCommit.promise;
        }, BACKGROUND_CONTEXT).catch(commitHeld.reject);
        return commit(change, context, options);
      };
      return opened;
    };
    try {
      await h.svc.agents.recheck("pi");
      const { target_turn_id: turnId } = await waitForPeerMailDelivery(h, "dispatching");
      await awaitWithContext(commitHeld.promise, withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT));
      const bound = withAbortSignal(AbortSignal.timeout(1_000), BACKGROUND_CONTEXT);
      await awaitWithContext(h.svc.turns.abortTurn(turnId, "Cancel while the configuration commit is queued"), bound);
      const failed = await waitForPeerMailDelivery(h, "failed");
      expect(failed).toMatchObject({ target_turn_id: turnId, failure_reason: "Target Agent could not accept this message." });
      expect(await h.svc.turns.waitForTerminal(turnId, 1_000)).toMatchObject({ status: "failed", reason: failed.failure_reason });
      releaseCommit.resolve();
      await harness.commit(() => {}, BACKGROUND_CONTEXT);
      expect(db.query("SELECT id FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?").all(turnId)).toEqual([]);
      const conversation = (await open(binding.conversation_id, BACKGROUND_CONTEXT))!;
      expect((await conversation.agent(BACKGROUND_CONTEXT)).instructions).toContain("Original recipient instructions.");
      expect(fake.state.callCount).toBe(3);
    } finally {
      releaseCommit.resolve();
      harness.conversation = open;
    }
  });
}, 15_000);

test.each(["abort", "admission deadline"] as const)("peer mail settles on %s while conversation open is held after announcement", async (interruption) => {
  let targetBotId = "";
  const opening = Promise.withResolvers<void>();
  const releaseOpen = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    fauxAssistantMessage("The interrupted reply should never run."),
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const source = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient");
    h.svc.agents.markOffline("pi", "Hold dispatch until conversation open can be intercepted");
    const sent = await sendToBot(h, source, "Send mail");
    expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
    const { createConversation } = harness;
    let openingConversation: ReturnType<typeof createConversation> | undefined;
    harness.createConversation = (...args) => {
      openingConversation = (async () => {
        const conversation = await createConversation.apply(harness, args);
        opening.resolve();
        await releaseOpen.promise;
        return conversation;
      })();
      void openingConversation.catch(opening.reject);
      return openingConversation;
    };
    try {
      if (interruption === "admission deadline") h.svc.cfg.turnTimeoutMs = 300;
      await h.svc.agents.recheck("pi");
      await opening.promise;
      const { target_turn_id: turnId, thread_id: threadId } = await waitForPeerMailDelivery(h, "dispatching");
      expect(h.svc.db.query("SELECT type FROM events WHERE aggregate_id = ? AND type = 'turn.created'").get(turnId)).toEqual({ type: "turn.created" });
      if (interruption === "abort") {
        const bound = withAbortSignal(AbortSignal.timeout(1_000), BACKGROUND_CONTEXT);
        await awaitWithContext(h.svc.turns.abortTurn(turnId, "Cancel while opening the conversation"), bound);
      }
      const failed = await waitForPeerMailDelivery(h, "failed");
      expect(failed).toMatchObject({ target_turn_id: turnId, failure_reason: "Target Agent could not accept this message." });
      expect(await h.svc.turns.waitForTerminal(turnId, 1_000)).toMatchObject({ status: "failed", reason: failed.failure_reason });
      releaseOpen.resolve();
      await openingConversation;
      await harness.waitForIdle(BACKGROUND_CONTEXT);
      expect(h.svc.db.query("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?").get(threadId)).toMatchObject({ conversation_id: expect.any(Number) });
      expect(h.svc.db.query("SELECT id FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?").all(turnId)).toEqual([]);
      expect(fake.state.callCount).toBe(2);
    } finally {
      releaseOpen.resolve();
      harness.createConversation = createConversation;
    }
  });
}, 15_000);

test("a user follow-up completes when the mail caller aborts their shared first conversation open", async () => {
  let targetBotId = "";
  const opening = Promise.withResolvers<void>();
  const releaseCreate = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    ({ messages }) => {
      expect(messages.findLast(({ role }) => role === "user")?.content).toBe("A user follow-up");
      return fauxAssistantMessage("User follow-up answered.");
    },
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const source = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient");
    h.svc.agents.markOffline("pi", "Hold dispatch until conversation creation can be intercepted");
    const sent = await sendToBot(h, source, "Send mail");
    expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
    const { createConversation } = harness;
    let createCalls = 0;
    harness.createConversation = async (...args) => {
      createCalls++;
      opening.resolve();
      await releaseCreate.promise;
      return createConversation.apply(harness, args);
    };
    try {
      await h.svc.agents.recheck("pi");
      await opening.promise;
      const { target_turn_id: mailTurnId, thread_id: threadId } = await waitForPeerMailDelivery(h, "dispatching");
      const indexed = h.svc.db.query("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?");
      expect(indexed.get(threadId)).toBeNull();
      const followUp = h.svc.turns.send(targetBotId, threadId, "A user follow-up", [], undefined, { whenBusy: "followUp" });
      void followUp.catch(() => {});
      // Let the follow-up reach the shared open while the create commit is held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createCalls).toBe(1);
      const bound = withAbortSignal(AbortSignal.timeout(1_000), BACKGROUND_CONTEXT);
      await awaitWithContext(h.svc.turns.abortTurn(mailTurnId, "Cancel mail before the create commit"), bound);
      const failed = await waitForPeerMailDelivery(h, "failed");
      expect(failed).toMatchObject({ target_turn_id: mailTurnId, failure_reason: "Target Agent could not accept this message." });
      expect(indexed.get(threadId)).toBeNull();
      releaseCreate.resolve();
      const user = await followUp;
      expect(await h.svc.turns.waitForTerminal(user.turnId, 5_000)).toMatchObject({ status: "completed" });
      expect(createCalls).toBe(1);
      expect(h.svc.db.query(`
        SELECT json_extract(record, '$.requestId') AS request_id, status FROM pi_submissions
        WHERE json_extract(record, '$.requestId') IN (?, ?)
      `).all(mailTurnId, user.turnId)).toEqual([{ request_id: user.turnId, status: "done" }]);
      expect(await messages(h, threadId)).toContainEqual(expect.objectContaining({ kind: "response", text: "User follow-up answered." }));
    } finally {
      releaseCreate.resolve();
      harness.createConversation = createConversation;
    }
  });
}, 15_000);

async function waitForPeerMailDelivery(h: Awaited<ReturnType<typeof startDaemon>>, state: "dispatching" | "delivered" | "failed" = "delivered") {
  const query = h.svc.db.query<{ id: string; thread_id: string; state: string; target_turn_id: string; failure_reason: string | null }, []>(
    "SELECT id, thread_id, state, target_turn_id, failure_reason FROM bot_mail_deliveries",
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = query.all();
    if (rows.length === 1 && rows[0]?.state === state) return rows[0];
    if (rows.some((row) => row.state === "failed" || row.state === "delivered")) break;
    await Bun.sleep(25);
  }
  throw new Error(`Expected one peer mail with state ${state}, got ${JSON.stringify(query.all())}`);
}

test("two simultaneous durable sends to the same idle Thread create one Turn and a steer", async () => {
  const release = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([
    async () => { await release.promise; return fauxAssistantMessage("First reply."); },
    fauxAssistantMessage("Steer reply."),
  ]);
  await withMailDaemon(fake.provider, async (h) => {
    try {
      const botId = await makeBot(h, "Recipient");
      const threadId = crypto.randomUUID();
      h.svc.threads.insertThreadRow(threadId, botId, "Simultaneous sends");
      const [first, second] = await Promise.all([
        h.svc.turns.send(botId, threadId, "First send"),
        h.svc.turns.send(botId, threadId, "Second send"),
      ]);
      expect(first.action).toBe("sent");
      expect(second).toMatchObject({ action: "steered", turnId: first.turnId });
      expect(h.svc.db.query("SELECT id FROM turns WHERE thread_id = ?").all(threadId)).toEqual([{ id: first.turnId }]);
      release.resolve();
      expect(await h.svc.turns.waitForTerminal(first.turnId, 5_000)).toMatchObject({ status: "completed" });
    } finally { release.resolve(); }
  });
}, 15_000);

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

test.each([
  ["runs a computer action before Service bookkeeping", false],
  ["refuses a computer action when a steer and follow-up have different owners", true],
] as const)("peer mail %s", async (_name, mixedOwners) => {
  let targetBotId = "";
  let result: unknown;
  const adapter = new FakeBotScreenRuntimeAdapter();
  const releaseBookkeeping = Promise.withResolvers<void>();
  const mailStarted = Promise.withResolvers<void>();
  const releaseMail = Promise.withResolvers<void>();
  const toolFinished = Promise.withResolvers<void>();
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  const computerCall = () => fauxAssistantMessage(fauxToolCall("computer", { action: "click", args: { x: 3, y: 4 } }, { id: "peer-computer" }), { stopReason: "toolUse" });
  fake.setResponses([
    () => fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId, text: mail.text }, { id: "peer-mail" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Mail queued."),
    async () => {
      mailStarted.resolve();
      await releaseMail.promise;
      return mixedOwners ? fauxAssistantMessage("Mail reply.") : computerCall();
    },
    ...(mixedOwners ? [computerCall] : []),
    ({ messages }) => {
      result = messages.at(-1);
      toolFinished.resolve();
      return fauxAssistantMessage("Finished.");
    },
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    try {
      if (!mixedOwners) {
        const create = harness.createConversation.bind(harness);
        harness.createConversation = async (...args) => {
          const conversation = await create(...args);
          const submit = conversation.submit.bind(conversation);
          conversation.submit = new Proxy(submit, {
            async apply(target, receiver, args) {
              const [draft] = args;
              const submission = await Reflect.apply(target, receiver, args);
              if (draft.type === "input" && draft.entry?.kind === "write") await releaseBookkeeping.promise;
              return submission;
            },
          });
          return conversation;
        };
      }
      const source = await makeBot(h, "Sender");
      targetBotId = await makeBot(h, "Recipient");
      h.svc.agents.markOffline("pi", "Hold delivery until the sender's reply settles");
      const sent = await sendToBot(h, source, "Send mail");
      expect(await h.svc.turns.waitForTerminal(sent.turnId, 5_000)).toMatchObject({ status: "completed" });
      await h.svc.agents.recheck("pi");
      await mailStarted.promise;
      const { thread_id: threadId, target_turn_id: turnId } = await waitForPeerMailDelivery(h, mixedOwners ? "delivered" : "dispatching");
      let followUp: { turnId: string } | undefined;
      if (mixedOwners) {
        expect(await sendToThread(h, threadId, "Steer the reply")).toMatchObject({ action: "steered", turnId });
        followUp = await api(h, "POST", `/api/threads/${threadId}/messages`, { text: "A different Turn", whenBusy: "followUp" });
      }
      releaseMail.resolve();
      await toolFinished.promise;
      if (mixedOwners) {
        expect(followUp?.turnId).not.toBe(turnId);
        expect(result).toMatchObject({ role: "toolResult", isError: true, content: [{ type: "text", text: expect.stringContaining("live run has no unique Service Turn owner") }] });
        expect(adapter.inputEvents).toEqual([]);
        expect(await h.svc.turns.waitForTerminal(followUp!.turnId, 5_000)).toMatchObject({ status: "completed" });
      } else {
        expect(h.svc.db.query("SELECT 1 FROM pi_turn_submissions WHERE turn_id = ?").get(turnId)).toBeNull();
        const { surfaceId } = await api<{ surfaceId: string }>(h, "GET", `/api/bots/${targetBotId}`);
        expect(result).toMatchObject({ role: "toolResult", isError: false, details: { desktopSession: { botId: targetBotId, surfaceId } } });
        expect(adapter.inputEvents.map((event) => event.surfaceId)).toEqual([surfaceId, surfaceId, surfaceId]);
      }
      releaseBookkeeping.resolve();
      expect(await h.svc.turns.waitForTerminal(turnId, 5_000)).toMatchObject({ status: "completed" });
    } finally {
      releaseBookkeeping.resolve();
      releaseMail.resolve();
    }
  }, undefined, adapter);
}, 15_000);

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

test("DurableTranscript settles send_bot_message and computer sharing a call ID in one assistant entry", async () => {
  let targetBotId = "";
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  fake.setResponses([
    () => fauxAssistantMessage([
      fauxToolCall("send_bot_message", { targetBotId, text: "First message" }, { id: "mixed-call" }),
      fauxToolCall("computer", { action: "screenshot" }, { id: "mixed-call" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  await withMailDaemon(fake.provider, async (h, harness) => {
    const sender = await makeBot(h, "Sender");
    targetBotId = await makeBot(h, "Recipient");
    h.svc.agents.markOffline("pi", "Keep any unexpected mail deliveries queued during this test");
    const sent = await sendToBot(h, sender, "Try both tools");
    expect((await h.svc.turns.waitForTerminal(sent.turnId)).status).toBe("completed");

    const { db, threads, bots, events } = h.svc;
    const binding = db.query<{ conversation_id: ConversationId }, [string]>(
      "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?",
    ).get(sent.threadId)!;
    const conversation = (await harness.conversation(binding.conversation_id, BACKGROUND_CONTEXT))!;
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    try {
      const view = { ...watch.value, docs: {} };
      const results = view.entries.filter(ToolResultEntry.is);
      expect(results).toHaveLength(2);
      expect(results[0]!.byTaskId).toBeDefined();
      expect(results[1]!.byTaskId).toBeDefined();
      expect(results[0]!.byTaskId).not.toBe(results[1]!.byTaskId);
      for (const entry of results) {
        expect(entry.model?.[0]).toMatchObject({ role: "toolResult", toolCallId: "mixed-call", toolName: "send_bot_message", isError: true });
      }

      const rows = threads.listMessages(sent.threadId).filter(({ kind }) => kind === "tool");
      expect(rows.map(({ toolCall }) => toolCall)).toEqual(["send_bot_message", "computer"].map((name, index) => {
        const result = results[index]!.model?.[0];
        if (result?.role !== "toolResult") throw new Error("Missing model tool result");
        return { id: "mixed-call", name, status: "error", errorSummary: "Tool call failed.", durationMs: result.durationMs };
      }));
      expect(rows[0]!.id).not.toBe(rows[1]!.id);
      const published = events.replay(0, events.oldestCursor());
      expect(published.events.filter(({ type, aggregateId }) => type === "tool.updated" && aggregateId === sent.threadId).map(({ payload }) => payload))
        .toEqual(rows.map(({ id: messageId, threadId, toolCall }) => ({ messageId, threadId, toolCall })));
      new DurableTranscript(threads, bots, events, sent.threadId, sender, sent.turnId, { ...view, entries: [] }, db).update(view);
      expect(threads.listMessages(sent.threadId).filter(({ kind }) => kind === "tool")).toEqual(rows);
      expect(events.replay(0, events.oldestCursor())).toEqual(published);
      expect(db.query("SELECT id FROM bot_mail_deliveries").all()).toEqual([]);
    } finally { await watch.stop(); }
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
  await withMailDaemon(fake.provider, async (h, harness) => {
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
    const { db, threads, bots, events } = h.svc;
    const binding = db.query<{ conversation_id: ConversationId }, [string]>(
      "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?",
    ).get(sent.threadId)!;
    const conversation = (await harness.conversation(binding.conversation_id, BACKGROUND_CONTEXT))!;
    const watch = await conversation.watch(BACKGROUND_CONTEXT);
    try {
      const view = { ...watch.value, docs: {} };
      const rows = threads.listMessages(sent.threadId).filter(({ kind }) => kind === "tool");
      expect(rows).toMatchObject(Array.from({ length: 2 }, () => ({
        toolCall: { id: "shared-call", name: "send_bot_message", status: "completed" },
      })));
      expect(rows[0]!.id).not.toBe(rows[1]!.id);
      const published = events.replay(0, events.oldestCursor());
      new DurableTranscript(threads, bots, events, sent.threadId, sender, sent.turnId, { ...view, entries: [] }).update(view);
      expect(threads.listMessages(sent.threadId).filter(({ kind }) => kind === "tool")).toEqual(rows);
      expect(events.replay(0, events.oldestCursor())).toEqual(published);
    } finally { await watch.stop(); }
  }, (first, replayed) => { replays.push({ first, replayed }); });
});
