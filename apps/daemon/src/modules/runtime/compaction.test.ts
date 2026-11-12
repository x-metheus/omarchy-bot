import { expect, spyOn, test } from "bun:test";
import { formatAuthorText } from "./compaction.ts";

test("author labels precede multiline visible text", () => {
  expect(formatAuthorText(" Alice ", "first line\nsecond line")).toBe("Alice: first line\nsecond line");
});

test("empty author labels leave visible text unchanged", () => {
  expect(formatAuthorText("  ", "message")).toBe("message");
  expect(formatAuthorText("", "message")).toBe("message");
});

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { CompactionEntry, createRegistry, Harness, MemoryStorage, type ConversationView } from "@earendil-works/pi-durable";
import { compactionExtension, compactionSettings } from "./compaction.ts";
import { DurableTranscript } from "./transcript.ts";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";

async function exerciseCompaction(fail: "none" | "error" | "throw" | "empty") {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  let source = "";
  let system = "";
  let requestOptions: unknown;
  const firstResponse = ({ messages }: { messages: readonly { role: string; content: unknown }[] }, options: unknown) => {
    source = JSON.stringify(messages);
    system = String(messages.find((message) => message.role === "system")?.content);
    requestOptions = options;
    if (fail === "error") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fake failure" });
    if (fail === "empty") return fauxAssistantMessage("");
    const user = messages.find((message) => message.role === "user")!;
    const data = JSON.parse(String(user.content)) as { entries: { author?: string; model?: { content: string }[] }[] };
    const attribution = data.entries.flatMap((entry) => entry.author && entry.model?.[0] ? [`- ${entry.author}: ${entry.model[0].content}`] : []);
    const texts = data.entries.flatMap((entry) => entry.model?.map((message) => message.content) ?? []);
    const decisions = texts.flatMap((text) => text.match(/Decision: ([^.]+)/g)?.map((item) => `- ${item.slice(10)}`) ?? []);
    const openItems = texts.flatMap((text) => text.match(/Open item: ([^.]+)/g)?.map((item) => `- ${item.slice(11)}`) ?? []);
    return fauxAssistantMessage(`## Who said what\n${attribution.join("\n")}\n## Decisions\n${decisions.join("\n")}\n## Open items\n${openItems.join("\n")}`);
  };
  fake.setResponses([
    ...(fail === "throw" ? [] : [firstResponse]),
    fauxAssistantMessage("Built-in fallback summary"),
    fauxAssistantMessage("Turn continues"),
  ]);
  const models = createModels();
  models.setProvider(fake.provider);
  if (fail === "throw") {
    const complete = models.completeSimple.bind(models);
    let first = true;
    spyOn(models, "completeSimple").mockImplementation((...args) => {
      if (first) { first = false; throw new Error("fake thrown call"); }
      return complete(...args);
    });
  }
  const registry = createRegistry();
  registry.install(compactionExtension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry, settings: { compaction: { ...compactionSettings, keepRecentTokens: 1, backgroundTokens: 0, reserveTokens: 1000 }, retry: { enabled: false } } }, ctx);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" }, thinkingLevel: "medium" }, ctx);
    for (const [author, text] of [["Alice", "likes tea. Decision: Serve both."], ["Bob", "likes coffee. Open item: Buy cups."], ["Carol", "kept recent"]] as const) {
      const write = await conversation.submit({ type: "write", entry: { kind: "message", data: { author }, model: [{ role: "user", content: text!, timestamp: Date.now() }] } }, ctx);
      await write.wait(ctx);
    }
    const original = await conversation.entries({ order: "ascending" }, 100, undefined, ctx);
    await conversation.compact(undefined, ctx);
    let entries = original.items;
    for (let i = 0; i < 200 && !entries.some(CompactionEntry.is); i++) {
      await Bun.sleep(10);
      entries = (await conversation.entries({ order: "ascending" }, 100, undefined, ctx)).items;
    }
    const compacted = entries.find(CompactionEntry.is);
    expect(compacted).toBeDefined();
    const submission = await conversation.submit({ type: "input", content: "continue" }, ctx);
    const settled = await submission.wait(ctx);
    return { compacted: compacted!, source, system, requestOptions, entries, original: original.items, settled };
  } finally { await harness.close(ctx); await storage.close(ctx); }
}

test("compaction preserves multi-author attribution and older entries remain stored", async () => {
  const result = await exerciseCompaction("none");
  const summary = JSON.stringify(result.compacted.model);
  expect(summary).toContain("Alice: likes tea");
  expect(summary).toContain("Bob: likes coffee");
  expect(summary).toContain("## Decisions\\n- Serve both\\n## Open items\\n- Buy cups");
  expect(result.system).toContain("Who said what");
  expect(result.system).toContain("Decisions");
  expect(result.system).toContain("Open items");
  expect(result.requestOptions).toMatchObject({ reasoning: "medium", cacheRetention: "none", signal: expect.any(AbortSignal), sessionId: expect.any(String), maxTokens: 800 });
  expect(result.source).toContain('\\"author\\":\\"Alice\\"');
  expect(result.source).toContain('\\"author\\":\\"Bob\\"');
  expect(result.source).not.toContain("kept recent");
  expect(result.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(result.original.map((entry) => entry.id)));
  expect(result.settled.status).toBe("done");
});

for (const failure of ["error", "throw", "empty"] as const) {
  test(`${failure} author-aware summary warns and falls back to the built-in summary`, async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await exerciseCompaction(failure);
      expect(warn).toHaveBeenCalledWith("Unable to create author-aware compaction summary; using the built-in summarizer");
      expect(JSON.stringify(result.compacted.model)).toContain("Built-in fallback summary");
      expect(result.settled.status).toBe("done");
    } finally { warn.mockRestore(); }
  });
}

test("compaction is shown once in the transcript", async () => {
  const { compacted } = await exerciseCompaction("none");
  const messages: unknown[] = [];
  const threads = { listMessages: () => messages, appendMessage: (_threadId: string, message: unknown) => { messages.push(message); } } as unknown as ThreadsService;
  const empty = { entries: [], docs: {} } as unknown as ConversationView;
  const transcript = new DurableTranscript(threads, {} as BotsService, {} as EventLog, "thread", "bot", "turn", empty);
  const view = { ...empty, entries: [compacted] };
  transcript.update(view);
  transcript.update(view);
  expect(messages).toEqual([{ author: { kind: "system" }, kind: "text", text: "Earlier conversation history was compacted.", turnId: "turn", payload: { durableCompactionEntry: compacted.id } }]);
  new DurableTranscript(threads, {} as BotsService, {} as EventLog, "thread", "bot", "next-turn", view);
  expect(messages).toHaveLength(1);
});

test("exact model override applies only to its provider and model", async () => {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }, { id: "other-model" }] });
  fake.setResponses([fauxAssistantMessage("summary")]);
  const models = createModels();
  models.setProvider(fake.provider);
  const registry = createRegistry();
  registry.install(compactionExtension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry, settings: { compaction: { ...compactionSettings, modelOverrides: { "fake/fake-model": { keepRecentTokens: 1 } } } } }, ctx);
  try {
    for (const modelId of ["fake-model", "other-model"]) {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
      await conversation.configure({ model: { provider: "fake", modelId } }, ctx);
      for (const text of ["first", "second", "third"]) {
        const write = await conversation.submit({ type: "write", entry: { kind: "message", model: [{ role: "user", content: text, timestamp: Date.now() }] } }, ctx);
        await write.wait(ctx);
      }
      const taskId = await conversation.compact(undefined, ctx);
      let task = await storage.task(taskId, ctx);
      for (let i = 0; i < 200 && task?.state.status !== "terminal"; i++) {
        await Bun.sleep(10);
        task = await storage.task(taskId, ctx);
      }
      expect(task?.state.status).toBe("terminal");
      const entries = await conversation.entries({}, 100, undefined, ctx);
      expect(entries.items.some(CompactionEntry.is)).toBe(modelId === "fake-model");
    }
  } finally { await harness.close(ctx); await storage.close(ctx); }
});

test("another run's compaction is projected without its assistant output", async () => {
  const { compacted } = await exerciseCompaction("none");
  const messages: unknown[] = [];
  const threads = { listMessages: () => messages, appendMessage: (_threadId: string, message: unknown) => { messages.push(message); } } as unknown as ThreadsService;
  const empty = { entries: [], docs: {} } as unknown as ConversationView;
  const transcript = new DurableTranscript(threads, {} as BotsService, {} as EventLog, "thread", "bot", "turn", empty);
  const foreign = { ...empty, entries: [compacted], docs: { "pi.live": { run: { inputs: [999] }, generation: { message: { role: "assistant", content: [{ type: "text", text: "foreign output" }] } } } } } as unknown as ConversationView;
  transcript.updateCompactions(foreign);
  expect(messages).toEqual([{ author: { kind: "system" }, kind: "text", text: "Earlier conversation history was compacted.", turnId: "turn", payload: { durableCompactionEntry: compacted.id } }]);
});

test("reconcileCompactions notices a compaction older than the watch window once", async () => {
  const fake = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  fake.setResponses([fauxAssistantMessage("summary")]);
  const models = createModels();
  models.setProvider(fake.provider);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { compaction: { ...compactionSettings, keepRecentTokens: 1 } } }, ctx);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" } }, ctx);
    for (const text of ["first", "second", "third"]) {
      const write = await conversation.submit({ type: "write", entry: { kind: "message", model: [{ role: "user", content: text, timestamp: Date.now() }] } }, ctx);
      await write.wait(ctx);
    }
    const task = await conversation.compact(undefined, ctx);
    await harness.waitForTask(task, ctx);
    const compacted = (await conversation.entries({}, 100, undefined, ctx)).items.find(CompactionEntry.is);
    expect(compacted).toBeDefined();
    for (let i = 0; i < 120; i++) {
      const write = await conversation.submit({ type: "write", entry: { kind: "filler", data: { index: i } } }, ctx);
      await write.wait(ctx);
    }
    const watch = await conversation.watch(ctx);
    try {
      expect(watch.value.entries.some(CompactionEntry.is)).toBeFalse();
      const messages: unknown[] = [];
      const threads = Object.assign({} as ThreadsService, { listMessages: () => messages, appendMessage: (_threadId: string, message: unknown) => { messages.push(message); } });
      const transcript = new DurableTranscript(threads, {} as BotsService, {} as EventLog, "thread", "bot", "turn", { ...watch.value, entries: [] });
      await transcript.reconcileCompactions(watch.value, conversation);
      await transcript.reconcileCompactions(watch.value, conversation);
      expect(messages).toEqual([{ author: { kind: "system" }, kind: "text", text: "Earlier conversation history was compacted.", turnId: "turn", payload: { durableCompactionEntry: compacted!.id } }]);
    } finally { await watch.stop(); }
  } finally { await harness.close(ctx); await storage.close(ctx); }
});
