// This test helper lives here to satisfy the pi-durable module boundary rule.
// No production module imports this test-only helper.
import type { Database } from "bun:sqlite";
import { Harness, createRegistry, defineExtension, defineTask, defineTool, ToolResultEntry, type Conversation, type ConversationId, type SubmissionDraft, type Tx } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDurableSuiteFakeProvider, createFakeProvider, type FakeReply } from "../../../../../packages/testkit/src/fake-provider.ts";

let durableSuiteHarness: Awaited<ReturnType<typeof Harness.open>> | undefined;

export async function durableSuiteToolResults(db: Database, threadId: string) {
  if (!durableSuiteHarness) throw new Error("Durable suite harness is not installed");
  const binding = db.query<{ conversation_id: ConversationId }, [string]>(
    "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?",
  ).get(threadId);
  if (!binding) throw new Error("Missing Thread conversation binding");
  const conversation = await durableSuiteHarness.conversation(binding.conversation_id, BACKGROUND_CONTEXT);
  if (!conversation) throw new Error("Missing durable conversation");
  const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
  return items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? []);
}

export async function abortDurableSuiteGeneration(): Promise<void> {
  if (!durableSuiteHarness) throw new Error("Durable suite harness is not installed");
  const tasks = (await durableSuiteHarness.inspect(BACKGROUND_CONTEXT)).tasks.filter((task) => task.record.kind === "pi.generation" && task.state.kind === "running");
  if (tasks.length !== 1) throw new Error(`Expected one running generation, found ${tasks.length}`);
  await durableSuiteHarness.abortTask(tasks[0]!.record.id, BACKGROUND_CONTEXT);
}

let durableSuiteCallCount: (() => number) | undefined;

export function durableSuiteProviderCallCount(): number {
  if (!durableSuiteCallCount) throw new Error("Durable suite provider is not installed");
  return durableSuiteCallCount();
}

export function installDurableSuiteProvider(): () => void {
  const fake = createDurableSuiteFakeProvider();
  durableSuiteCallCount = () => fake.state.callCount;
  const waiting = new Map<number, () => void>();
  const steered = new Set<number>();
  const boundaries = new Set<number>();
  const hanging = new Set<number>();
  const wrapped = new WeakSet<Conversation>();
  function wrapConversation(conversation: Conversation): Conversation {
    if (wrapped.has(conversation)) return conversation;
    wrapped.add(conversation);
    conversation.submit = new Proxy(conversation.submit, {
      apply(target, thisArg, args) {
        const draft: unknown = args[0];
        const input = typeof draft === "object" && draft !== null && "type" in draft && draft.type === "input" ? draft : undefined;
        if (input && "whenBusy" in input && input.whenBusy === "steer" && hanging.has(conversation.id)) return Promise.reject(new Error("fake hang is not steerable"));
        const result: unknown = Reflect.apply(target, thisArg, args);
        if (input && "whenBusy" in input && input.whenBusy === "steer" && boundaries.has(conversation.id)) {
          void Promise.resolve(result).then(() => {
            const release = waiting.get(conversation.id);
            if (release) release();
            else steered.add(conversation.id);
          }, () => {});
        } else if (input && "content" in input && typeof input.content === "string") {
          hanging.delete(conversation.id);
          boundaries.delete(conversation.id);
          steered.delete(conversation.id);
          if (input.content === "hang" || input.content === "thinking-hang") hanging.add(conversation.id);
          if (input.content === "ordered-transcript" || input.content === "steer-echo") boundaries.add(conversation.id);
        }
        return result;
      },
    });
    return conversation;
  }
  const steering = defineExtension({ name: "test-steering", tools: [defineTool({
    name: "steer_boundary", description: "Test steering boundary", parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_args, api, context) {
      if (!steered.delete(api.conversationId)) {
        await new Promise<void>((resolve) => {
          const done = () => { waiting.delete(api.conversationId); context.abortSignal?.removeEventListener("abort", done); resolve(); };
          waiting.set(api.conversationId, done);
          if (context.abortSignal?.aborted) done();
          else context.abortSignal?.addEventListener("abort", done, { once: true });
        });
      }
      boundaries.delete(api.conversationId);
      return { output: [{ type: "text", text: "boundary completed" }] };
    },
  })] });
  const originalOpen = Harness.open;
  Harness.open = async (storage, options, context) => {
    const registry = options.registry;
    if (!("install" in registry) || typeof registry.install !== "function") throw new Error("Expected a mutable registry");
    registry.install(steering);
    const harness = await originalOpen.call(Harness, storage, {
      ...options,
      models: () => {
        const models = typeof options.models === "function" ? options.models() : options.models;
        if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
        models.setProvider(fake.provider);
        return models;
      },
    }, context);
    durableSuiteHarness = harness;
    const create = harness.createConversation.bind(harness);
    harness.createConversation = async (...args) => wrapConversation(await create(...args));
    const open = harness.conversation.bind(harness);
    harness.conversation = async (...args) => {
      const conversation = await open(...args);
      return conversation ? wrapConversation(conversation) : conversation;
    };
    return harness;
  };
  return () => { for (const release of waiting.values()) release(); durableSuiteCallCount = undefined; durableSuiteHarness = undefined; Harness.open = originalOpen; };
}

export async function withBlockingRuntimeTool<T>(fn: (tool: { started: Promise<void>; release(): void; seen(): string }) => Promise<T>): Promise<T> {
  let start!: () => void;
  let release!: () => void;
  let seen = "";
  const started = new Promise<void>((resolve) => { start = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  fake.setResponses([
    fauxAssistantMessage([fauxToolCall("blocking", {}, { id: "blocking-call" })], { stopReason: "toolUse" }),
    (context) => { seen = JSON.stringify(context.messages); return fauxAssistantMessage("after tool"); },
  ]);
  const registry = createRegistry();
  registry.install({ name: "test", tools: [defineTool({ name: "blocking", description: "Blocking test tool", parameters: { type: "object", properties: {}, additionalProperties: false }, async execute() { start(); await blocked; return { output: [{ type: "text", text: "tool finished" }] }; } })] });
  const originalOpen = Harness.open;
  Harness.open = (storage, options, context) => originalOpen.call(Harness, storage, {
    ...options,
    registry,
    models: () => {
      const models = typeof options.models === "function" ? options.models() : options.models;
      if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
      models.setProvider(fake.provider);
      return models;
    },
  }, context);
  try { return await fn({ started, release, seen: () => seen }); }
  finally { release(); Harness.open = originalOpen; }
}
export async function withFakeRuntimeProvider<T>(script: FakeReply[], options: { tokensPerSecond?: number; onMaxTurns?: (maxTurns: number | null | undefined) => void; onSystemPrompt?: (systemPrompt: string) => void }, fn: () => Promise<T>): Promise<T> {
  const fake = createFakeProvider(script, options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond });
  const provider: typeof fake.provider = {
    ...fake.provider,
    streamSimple(model, transcript, streamOptions) {
      options.onSystemPrompt?.(getCurrentSystemPrompt(transcript.messages));
      return fake.provider.streamSimple(model, transcript, streamOptions);
    },
  };
  const originalOpen = Harness.open;
  Harness.open = async (storage, harnessOptions, context) => {
    const harness = await originalOpen.call(Harness, storage, {
    ...harnessOptions,
      models: () => {
        const models = typeof harnessOptions.models === "function" ? harnessOptions.models() : harnessOptions.models;
        if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
        models.setProvider(provider);
        return models;
      },
    }, context);
    if (options.onMaxTurns) {
      const create = harness.createConversation.bind(harness);
      harness.createConversation = async (conversationOptions, conversationContext) => {
        const conversation = await create(conversationOptions, conversationContext);
        const configure = conversation.configure.bind(conversation);
        conversation.configure = async (change, configureContext) => {
          options.onMaxTurns?.(change.maxTurns);
          await configure(change, configureContext);
        };
        return conversation;
      };
      const open = harness.conversation.bind(harness);
      harness.conversation = async (id, conversationContext) => {
        const conversation = await open(id, conversationContext);
        if (!conversation) return conversation;
        const configure = conversation.configure.bind(conversation);
        conversation.configure = async (change, configureContext) => {
          options.onMaxTurns?.(change.maxTurns);
          await configure(change, configureContext);
        };
        return conversation;
      };
    }
    return harness;
  };
  try {
    return await fn();
  } finally {
    Harness.open = originalOpen;
  }
}

/** Child-process-only fake provider and durable timer used by restart tests. */
export function installDurableCrashProvider(): () => void {
  let holdRecoveryWrite: (() => Promise<void>) | undefined;
  if (process.env.OMARCHY_TEST_RECOVERY_WRITE_COLLISION === "1") {
    const openSqliteStorage = SqliteStorage.open;
    SqliteStorage.open = (database, options) => {
      SqliteStorage.open = openSqliteStorage;
      const holdWrite = async () => {
        const locked = Promise.withResolvers<void>();
        void database.transaction(async () => {
          locked.resolve();
          // Give the competing Service write a turn while pi still holds SQLite's write lock.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }).catch(locked.reject);
        await locked.promise;
      };
      holdRecoveryWrite = holdWrite;
      return openSqliteStorage.call(SqliteStorage, database, options);
    };
  }
  const sleepTask = defineTask<{ at: number; text: string }, { phase: "wait" } | { phase: "deliver" }, null>({
    name: "test.sleep", version: 1, initial: () => ({ phase: "wait" }),
    phases: {
      wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
      deliver: (task, runtime, context) => runtime.commit(async (tx) => {
        await tx.appendEntry(runtime.conversationId, { kind: "write", data: { text: task.input.text, author: "test.sleep" } });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context),
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const crashExtension = defineExtension({ name: "test-crash", tasks: [sleepTask], sections: [{ key: "test-crash-gate", async render() {
    if (process.env.OMARCHY_TEST_CRASH_MODE === "1") {
      console.log(JSON.stringify({ event: "before-request" }));
      await new Promise<never>(() => {});
    }
    return undefined;
  } }], tools: [
    defineTool({
      name: "sleep_until", description: "Schedule a test post", replay: "safe",
      parameters: { type: "object", properties: { at: { type: "number" }, text: { type: "string" } }, required: ["at", "text"], additionalProperties: false },
      async execute(args, api, context) {
        const { at, text } = args as { at: number; text: string };
        await api.createTask(sleepTask, { at, text }, { ownership: { kind: "conversation" } }, context);
        return { output: [{ type: "text", text: "scheduled" }] };
      },
    }),
    defineTool({
      name: "hang", description: "Wait until killed", replay: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { console.log(JSON.stringify({ event: "hang" })); return await new Promise<never>(() => {}); },
    }),
  ] });
  const fake = fauxProvider({ provider: "fake", api: "openai-completions", tokensPerSecond: 15, tokenSize: { min: 1, max: 1 } });
  fake.setResponses(Array.from({ length: 100 }, () => async ({ messages }) => {
    const latest = messages.filter((message) => message.role === "user").at(-1);
    const text = typeof latest?.content === "string" ? latest.content : "";
    if (text.startsWith("send-peer-mail:")) {
      if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Mail sent.");
      return fauxAssistantMessage(fauxToolCall("send_bot_message", { targetBotId: text.slice("send-peer-mail:".length), text: "Check the restart." }, { id: "restart-mail" }), { stopReason: "toolUse" });
    }
    if (text === "Hold the target reply.") {
      if (process.env.OMARCHY_TEST_PEER_MAIL_HOLD === "queued") await new Promise<never>(() => {});
      if (process.env.OMARCHY_TEST_PEER_MAIL_PREDECESSOR_FAILS === "1") {
        return fauxAssistantMessage("Predecessor partial.", { stopReason: "error", errorMessage: "The predecessor reply failed." });
      }
      return fauxAssistantMessage("User reply recovered.");
    }
    if (text === "A competing steer." || text.startsWith("Message from Bot ")) {
      if (process.env.OMARCHY_TEST_PEER_MAIL_HOLD === "placed") await new Promise<never>(() => {});
      return fauxAssistantMessage("Peer mail survived restart.");
    }
    if (text === "hang") return fauxAssistantMessage([fauxToolCall("hang", {}, { id: "hang-call" })], { stopReason: "toolUse" });
    if (text === "approval-write") {
      if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Approval write finished.");
      return fauxAssistantMessage([fauxToolCall("write", { path: process.env.OMARCHY_TEST_APPROVAL_PATH ?? "", content: "approved content\n" }, { id: "approval-call" })], { stopReason: "toolUse" });
    }
    if (text === "first-request") return fauxAssistantMessage("First request streaming text stays visible after interruption and the continuation completes.");
    if (!JSON.stringify(messages).includes("scheduled")) return fauxAssistantMessage([fauxToolCall("sleep_until", { at: Number(process.env.OMARCHY_TEST_SLEEP_AT), text: "scheduled post" }, { id: "sleep-call" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("A long reply that keeps streaming across the restart and eventually completes.");
  }));
  const originalOpen = Harness.open;
  Harness.open = async (storage, options, context) => {
    const runtimeRegistry: unknown = options.registry;
    if (typeof runtimeRegistry !== "object" || runtimeRegistry === null || !("install" in runtimeRegistry) || typeof runtimeRegistry.install !== "function") throw new Error("Expected a mutable registry");
    runtimeRegistry.install(crashExtension);
    const harness = await originalOpen.call(Harness, storage, {
      ...options,
      models: () => {
        const models = typeof options.models === "function" ? options.models() : options.models;
        if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
        const provider = models.getProvider(fake.provider.id);
        if (!provider) throw new Error("Expected stored fake provider");
        // Preserve runtime model resolution and replace only network streaming.
        models.setProvider({ ...provider, streamSimple: fake.provider.streamSimple });
        return models;
      },
    }, context);
    if (holdRecoveryWrite) {
      const open = harness.conversation.bind(harness);
      harness.conversation = async (...args) => {
        const conversation = await open(...args);
        if (conversation) {
          const watch = conversation.watch.bind(conversation);
          conversation.watch = async (...args) => {
            const attached = await watch(...args);
            const hold = holdRecoveryWrite;
            holdRecoveryWrite = undefined;
            await hold?.();
            return attached;
          };
        }
        return conversation;
      };
    }
    if (process.env.OMARCHY_TEST_PEER_MAIL_HOLD) {
      const holdPeerMailBookkeeping = (conversation: Conversation) => {
        conversation.submit = new Proxy(conversation.submit, {
          async apply(target, thisArg, args: [SubmissionDraft | Tx, unknown]) {
            const draft = args[0];
            const submission: unknown = await Reflect.apply(target, thisArg, args);
            // Hold the Service between the durable commit and its bookkeeping.
            if ("type" in draft && draft.type === "input" && draft.entry?.kind === "write") {
              await new Promise<never>(() => {});
            }
            return submission;
          },
        });
        return conversation;
      };
      const create = harness.createConversation.bind(harness);
      harness.createConversation = async (...args) => holdPeerMailBookkeeping(await create(...args));
      const open = harness.conversation.bind(harness);
      harness.conversation = async (...args) => {
        const conversation = await open(...args);
        return conversation && holdPeerMailBookkeeping(conversation);
      };
    }
    return harness;
  };
  return () => { Harness.open = originalOpen; };
}
