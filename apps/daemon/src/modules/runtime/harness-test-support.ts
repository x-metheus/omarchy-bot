// This test helper lives here to satisfy the pi-durable module boundary rule.
// No production module imports this test-only helper.
import { Harness, createRegistry, defineExtension, defineTask, defineTool, type Conversation } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createDurableSuiteFakeProvider, createFakeProvider, type FakeReply } from "../../../../../packages/testkit/src/fake-provider.ts";

let durableSuiteHarness: Awaited<ReturnType<typeof Harness.open>> | undefined;

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
  const registry = createRegistry();
  registry.install({ name: "test-steering", tools: [defineTool({
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
    const harness = await originalOpen.call(Harness, storage, {
      ...options,
      registry,
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
export async function withFakeRuntimeProvider<T>(script: FakeReply[], options: { tokensPerSecond?: number; onMaxTurns?: (maxTurns: number | null | undefined) => void }, fn: () => Promise<T>): Promise<T> {
  const fake = createFakeProvider(script, options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond });
  const originalOpen = Harness.open;
  Harness.open = async (storage, harnessOptions, context) => {
    const harness = await originalOpen.call(Harness, storage, {
    ...harnessOptions,
    models: () => {
      const models = typeof harnessOptions.models === "function" ? harnessOptions.models() : harnessOptions.models;
      if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
      models.setProvider(fake.provider);
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
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test-crash", tasks: [sleepTask], sections: [{ key: "test-crash-gate", async render() {
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
  ] }));
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], tokensPerSecond: 15, tokenSize: { min: 1, max: 1 } });
  fake.setResponses(Array.from({ length: 100 }, () => ({ messages }) => {
    const latest = messages.filter((message) => message.role === "user").at(-1);
    const text = typeof latest?.content === "string" ? latest.content : "";
    if (text === "hang") return fauxAssistantMessage([fauxToolCall("hang", {}, { id: "hang-call" })], { stopReason: "toolUse" });
    if (text === "first-request") return fauxAssistantMessage("First request streaming text stays visible after interruption and the continuation completes.");
    if (!JSON.stringify(messages).includes("scheduled")) return fauxAssistantMessage([fauxToolCall("sleep_until", { at: Number(process.env.OMARCHY_TEST_SLEEP_AT), text: "scheduled post" }, { id: "sleep-call" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("A long reply that keeps streaming across the restart and eventually completes.");
  }));
  const originalOpen = Harness.open;
  Harness.open = (storage, options, context) => originalOpen.call(Harness, storage, {
    ...options, registry,
    models: () => {
      const models = typeof options.models === "function" ? options.models() : options.models;
      if (!("setProvider" in models) || typeof models.setProvider !== "function") throw new Error("Expected mutable models");
      models.setProvider(fake.provider);
      return models;
    },
  }, context);
  return () => { Harness.open = originalOpen; };
}
