// This test helper lives here to satisfy the pi-durable module boundary rule.
// No production module imports this test-only helper.
import { Harness, createRegistry, defineTool } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createFakeProvider, type FakeReply } from "../../../../../packages/testkit/src/fake-provider.ts";

export function installDurableSuiteProvider(): () => void {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }], tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
  fake.setResponses(Array.from({ length: 100 }, () => ({ messages }) => {
    const latest = messages.filter((message) => message.role === "user").at(-1);
    const text = typeof latest?.content === "string" ? latest.content : "";
    if (text === "steer-echo") return fauxAssistantMessage([fauxToolCall("steer_boundary", {}, { id: "steer-boundary" })], { stopReason: "toolUse" });
    if (text === "hang") return fauxAssistantMessage("hanging indefinitely while a turn is running");
    return fauxAssistantMessage(text.startsWith("say:") ? text.slice(4).trim() : text.startsWith("redirect") ? `steered: ${text}` : "ok");
  }));
  const registry = createRegistry();
  registry.install({ name: "test-steering", tools: [defineTool({
    name: "steer_boundary", description: "Test steering boundary", parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { await Bun.sleep(1000); return { output: [{ type: "text", text: "boundary completed" }] }; },
  })] });
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
  return () => { Harness.open = originalOpen; };
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
