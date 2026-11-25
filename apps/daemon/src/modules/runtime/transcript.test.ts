import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, defineTool, Harness, LiveDoc, ToolResultEntry, UserEntry, type ConversationView, type EntryDraft, type SubmissionId, type TaskId, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH, TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } from "@omarchy-bot/domain";
import { applyMigration, MIGRATIONS } from "../../persistence/db.ts";
import { AgentsRegistry } from "../agents/registry.ts";
import { BotsService } from "../bots/bots.ts";
import { EventLog } from "../events/eventLog.ts";
import { ThreadsService } from "../threads/threads.ts";
import { openThreadConversation } from "./conversations.ts";
import { openBotRuntime } from "./runtime.ts";
import { DurableTranscript } from "./transcript.ts";

const threadId = "transcript-thread";
const botId = "transcript-bot";
const turnId = "transcript-turn";
const callId = "check-call";
const tool = () => fauxToolCall("check", { privateInput: "never projected" }, { id: callId });

function transcriptStore(db: Database) {
  for (const migration of MIGRATIONS) applyMigration(db, migration);
  const events = new EventLog(db);
  const agents = new AgentsRegistry(db, events, { conformanceDir: "" });
  const threads = new ThreadsService(db, events, agents);
  const bots = new BotsService(db, events, threads);
  threads.insertThreadRow(threadId, botId, "Transcript");
  threads.insertTurnRow({ id: turnId, threadId, botId, nativeSessionId: "" });
  return { threads, bots, events };
}

function transcriptFor(db: Database, initial: ConversationView) {
  const { threads, bots, events } = transcriptStore(db);
  const projector = () => new DurableTranscript(threads, bots, events, threadId, botId, turnId, initial);
  return {
    projector,
    messages: () => threads.listMessages(threadId),
    events: () => events.replay(0, events.oldestCursor()).events,
    finalize: () => threads.finalizeDurableToolCalls(turnId),
    steer: () => threads.appendMessage(threadId, { author: { kind: "user" }, kind: "text", text: "Steer" }),
  };
}

async function committedConversation(assistant: AssistantMessage, execute: (signal: AbortSignal | undefined) => Promise<ToolExecutionResult>, abort = false) {
  const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model", reasoning: true }] });
  provider.setResponses([assistant, fauxAssistantMessage("After result")]);
  const models = createModels();
  models.setProvider(provider.provider);
  const registry = createRegistry();
  const started = Promise.withResolvers<void>();
  registry.install({ name: "transcript-test", tools: [defineTool({
    name: assistant.content.find((part) => part.type === "toolCall")?.name ?? "check", description: "Check a test input", parameters: { type: "object" },
    async execute(_args, _api, toolContext) { started.resolve(); return execute(toolContext.abortSignal); },
  })] });
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    await conversation.configure({ model: { provider: "fake", modelId: "fake-model" } }, context);
    const watch = await conversation.watch(context);
    const initial = watch.value;
    await watch.stop();
    const submission = await conversation.submit({ type: "input", content: "Run a check" }, context);
    if (abort) {
      await started.promise;
      await conversation.abort(context);
    }
    expect((await submission.wait(context)).status).toBe(abort || assistant.stopReason === "error" ? "unanswered" : "done");
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    return { initial, committed: { ...initial, entries: items } };
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
}

async function committedTurn(assistant: AssistantMessage, execute: (signal: AbortSignal | undefined) => Promise<ToolExecutionResult> = async () => ({ output: [fauxText("private output")] }), abort = false) {
  const { initial, committed } = await committedConversation(assistant, execute, abort);
  const items = committed.entries;
  const firstAssistant = items.find(AssistantEntry.is)!;
  const result = items.find(ToolResultEntry.is)!;
  const modelResult = result.model?.find((message) => message.role === "toolResult");
  expect(modelResult).toBeDefined();
  const beforeResult = { ...initial, entries: items.filter((entry) => entry.id < result.id) };
  const throughResult = { ...initial, entries: items.filter((entry) => entry.id <= result.id) };
  const live = { ...initial, docs: JSON.parse(JSON.stringify({ "pi.live": { generation: { attempt: 0, message: firstAssistant.model?.[0] } } })) };
  return { initial, beforeResult, throughResult, committed, live, modelResult: modelResult! };
}

test("DurableTranscript orders committed text, tool calls, later text and thinking", async () => {
  using db = new Database(":memory:");
  const { initial, live, committed } = await committedTurn(fauxAssistantMessage([
    fauxText("Before tool"), tool(), fauxText("After tool"), fauxThinking("Think after tool"),
  ], { stopReason: "toolUse" }));
  const { projector, messages, events } = transcriptFor(db, initial);
  const transcript = projector();
  transcript.update(live);
  expect(messages().map(({ kind, text, response, thinking }) => [kind, text, (response ?? thinking)?.state])).toEqual([
    ["response", "Before tool", "completed"], ["response", "After tool", "completed"], ["thinking", "Think after tool", "streaming"],
  ]);
  expect(events().filter((event) => event.type === "response.updated" || event.type === "thinking.updated").map(({ type, payload }) => {
    const block = payload as ReturnType<typeof messages>[number];
    return [type, block.text, (block.response ?? block.thinking)?.state];
  })).toEqual([
    ["response.updated", "Before tool", "streaming"], ["response.updated", "Before tool", "completed"],
    ["response.updated", "After tool", "streaming"], ["response.updated", "After tool", "completed"],
    ["thinking.updated", "Think after tool", "streaming"],
  ]);
  transcript.update(committed);
  transcript.update(committed);
  expect(messages().map(({ seq, kind, text, toolCall }) => [seq, kind, text ?? toolCall?.id])).toEqual([
    [1, "response", "Before tool"], [2, "tool", callId], [3, "response", "After tool"],
    [4, "thinking", "Think after tool"], [5, "response", "After result"],
  ]);
  expect(events().filter((event) => event.type === "message.appended").map((event) => (event.payload as { kind: string }).kind))
    .toEqual(["response", "response", "thinking", "tool", "response"]);
});

test("DurableTranscript updates the existing tool row with the committed result duration", async () => {
  using db = new Database(":memory:");
  const { initial, beforeResult, throughResult, modelResult } = await committedTurn(fauxAssistantMessage(tool(), { stopReason: "toolUse" }));
  const { projector, messages, events } = transcriptFor(db, initial);
  projector().update({ ...throughResult, entries: throughResult.entries.filter(ToolResultEntry.is) });
  expect(messages()).toEqual([]);
  expect(events()).toEqual([]);
  const transcript = projector();
  transcript.update(beforeResult);
  const [running] = messages();
  expect(running?.toolCall).toEqual({ id: callId, name: "check", status: "running" });
  expect(events()[0]).toMatchObject({ type: "message.appended", aggregateId: threadId, payload: running! });
  transcript.update(throughResult);
  expect(modelResult.durationMs).toEqual(expect.any(Number));
  const toolCall = { id: callId, name: "check", status: "completed", durationMs: modelResult.durationMs } as const;
  expect(messages()).toEqual([{ ...running!, toolCall }]);
  expect(events()[1]).toMatchObject({ type: "tool.updated", aggregateId: threadId, payload: { threadId, messageId: running!.id, toolCall } });
  expect(events()).toHaveLength(2);
});

test.each([
  ["bash", { command: "echo ok", unrelated: "ignored" }, undefined, "echo ok", "echo ok"],
  ["read", { path: "a".repeat(600) }, undefined, "a".repeat(500), "a".repeat(500)],
  ["glob", { pattern: "reports/[0-9].txt" }, undefined, "reports/[0-9].txt", "reports/[0-9].txt"],
  ["local", { action: "run", command: "pwd" }, { hostname: "laptop" }, "pwd", "laptop pwd"],
] as const)("DurableTranscript keeps the safe target for a %s call", async (name, args, details, started, finished) => {
  using db = new Database(":memory:");
  const assistant = fauxAssistantMessage(fauxToolCall(name, args, { id: callId }), { stopReason: "toolUse" });
  const { initial, beforeResult, throughResult, modelResult } = await committedTurn(assistant, async () => ({ output: [], ...(details ? { details } : {}) }));
  const { projector, messages } = transcriptFor(db, initial);
  const transcript = projector();
  transcript.update(beforeResult);
  expect(messages()[0]?.toolCall).toEqual({ id: callId, name, status: "running", target: started });
  transcript.update(throughResult);
  expect(messages()[0]?.toolCall).toEqual({ id: callId, name, status: "completed", target: finished, durationMs: modelResult.durationMs });
});

test("DurableTranscript omits absent targets and durations", async () => {
  using db = new Database(":memory:");
  const assistant = fauxAssistantMessage(fauxToolCall("bash", { unrelated: "ignored" }, { id: callId }), { stopReason: "toolUse" });
  const { initial, throughResult } = await committedTurn(assistant);
  const withoutDuration = structuredClone(throughResult);
  const result = withoutDuration.entries.find(ToolResultEntry.is)?.model?.find((message) => message.role === "toolResult");
  if (!result) throw new Error("Expected a tool result");
  delete result.durationMs;
  const { projector, messages } = transcriptFor(db, initial);
  projector().update(withoutDuration);
  expect(messages()[0]?.toolCall).toEqual({ id: callId, name: "bash", status: "completed" });
});

test("DurableTranscript projects the worker-safe summary for a committed tool error", async () => {
  using db = new Database(":memory:");
  const failure = "Sidecar result exceeds the limit. Bearer private-credential  ";
  const { initial, throughResult, modelResult } = await committedTurn(fauxAssistantMessage(fauxToolCall("local", {}, { id: callId }), { stopReason: "toolUse" }), async () => ({
    isError: true, output: [fauxText("private tool output")], details: { publicError: failure + "x".repeat(600), secret: "private details" },
  }));
  const { projector, messages, events } = transcriptFor(db, initial);
  projector().update(throughResult);
  const prefix = "Sidecar result exceeds the limit. Bearer [redacted] ";
  const errorSummary = prefix + "x".repeat(TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH - prefix.length);
  const toolCall = { id: callId, name: "local", status: "error", errorSummary, durationMs: modelResult.durationMs } as const;
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.toolCall).toEqual(toolCall);
  expect(events()[1]).toMatchObject({ type: "tool.updated", payload: { threadId, messageId: messages()[0]!.id, toolCall } });
  expect(JSON.stringify([messages(), events()])).not.toContain("private");
});

test.each([
  ["plain private output", "private failure detail", undefined],
  ["inline JSON", 'Request failed: {"payload":"private JSON"}', undefined],
  ["attached JSON", 'Unable to complete the request.\n{"payload":"private JSON"}', undefined],
  ["error diagnostics", "private tool output", [{ severity: "error", message: "private diagnostic" }]],
] as const)("DurableTranscript keeps %s out of the row and tool.updated", async (_label, text, diagnostics) => {
  using db = new Database(":memory:");
  const { initial, throughResult, modelResult } = await committedTurn(fauxAssistantMessage(tool(), { stopReason: "toolUse" }), async () => ({
    isError: true,
    output: [fauxText(text)],
    details: { publicError: "private data in unclassified details" },
    ...(diagnostics ? { diagnostics: [...diagnostics] } : {}),
  }));
  const { projector, messages, events } = transcriptFor(db, initial);
  projector().update(throughResult);
  const toolCall = { id: callId, name: "check", status: "error", errorSummary: "Tool call failed.", durationMs: modelResult.durationMs } as const;
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.toolCall).toEqual(toolCall);
  expect(events()[1]?.type).toBe("tool.updated");
  expect(events()[1]?.payload).toEqual({ threadId, messageId: messages()[0]!.id, toolCall });
  expect(JSON.stringify([messages(), events()])).not.toContain("private");
});

test.each([
  ["bash", { command: `echo '{"password":"private-credential","payload":"private JSON"}'` }],
  ["web_search", { query: 'Search for {"password":"private-marker"}' }],
  ["read", { path: 'files/{"password":"private-marker"}' }],
  ["computer", { action: '{"password":"private-marker"}' }],
  ["glob", { pattern: 'files/{"password":"private-marker"}' }],
  ["bash", { command: `echo '[1,"password","private-marker"]'` }],
  ["web_search", { query: '["a",{"password":"private-marker"}]' }],
  ["read", { path: '"private-marker"' }],
  ["local", { command: '[null,"password","private-marker"]', action: "run" }],
] as const)("DurableTranscript omits a %s target containing a credential JSON blob", async (name, args) => {
  using db = new Database(":memory:");
  const assistant = fauxAssistantMessage(fauxToolCall(name, args, { id: callId }), { stopReason: "toolUse" });
  const { initial, beforeResult, throughResult, modelResult } = await committedTurn(assistant);
  const { projector, messages, events } = transcriptFor(db, initial);
  const transcript = projector();
  transcript.update(beforeResult);
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.toolCall).toEqual({ id: callId, name, status: "running" });
  transcript.update(throughResult);
  const toolCall = { id: callId, name, status: "completed", durationMs: modelResult.durationMs } as const;
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.toolCall).toEqual(toolCall);
  expect(events()[1]?.type).toBe("tool.updated");
  expect(events()[1]?.payload).toEqual({ threadId, messageId: messages()[0]!.id, toolCall });
  expect(JSON.stringify([messages(), events()])).not.toContain("private");
});

test.each([
  ["bash", { command: "curl https://fixture:sample-pass@example.invalid/v1" }, undefined, "curl https://[redacted]@example.invalid/v1", "curl https://[redacted]@example.invalid/v1"],
  ["bash", { command: "curl https://example.invalid/v1" }, undefined, "curl https://example.invalid/v1", "curl https://example.invalid/v1"],
  ["web_search", { query: "Find https://fixture:sample-pass@example.invalid/v1" }, undefined, "Find https://[redacted]@example.invalid/v1", "Find https://[redacted]@example.invalid/v1"],
  ["web_search", { query: "Find https://example.invalid/users/@fixture?email=fixture@example.invalid" }, undefined, "Find https://example.invalid/users/@fixture?email=fixture@example.invalid", "Find https://example.invalid/users/@fixture?email=fixture@example.invalid"],
  ["read", { path: "https://fixture:sample-pass@example.invalid/v1" }, undefined, "https://[redacted]@example.invalid/v1", "https://[redacted]@example.invalid/v1"],
  ["computer", { action: "open https://fixture:sample-pass@example.invalid/v1" }, undefined, "open https://[redacted]@example.invalid/v1", "open https://[redacted]@example.invalid/v1"],
  ["glob", { pattern: "https://fixture:sample-pass@example.invalid/v1/*" }, undefined, "https://[redacted]@example.invalid/v1/*", "https://[redacted]@example.invalid/v1/*"],
  ["local", { action: "run", command: "pwd" }, { hostname: "https://fixture:sample-pass@example.invalid/v1" }, "pwd", "https://[redacted]@example.invalid/v1 pwd"],
] as const)("DurableTranscript keeps URL userinfo out of a %s target (%j)", async (name, args, details, started, finished) => {
  using db = new Database(":memory:");
  const assistant = fauxAssistantMessage(fauxToolCall(name, args, { id: callId }), { stopReason: "toolUse" });
  const { initial, beforeResult, throughResult, modelResult } = await committedTurn(assistant, async () => ({ output: [], ...(details ? { details } : {}) }));
  const { projector, messages, events } = transcriptFor(db, initial);
  const transcript = projector();
  transcript.update(beforeResult);
  expect(messages()).toHaveLength(1);
  const running = messages()[0]!;
  expect(running.toolCall).toEqual({ id: callId, name, status: "running", target: started });
  expect(events()).toHaveLength(1);
  expect(events()[0]?.type).toBe("message.appended");
  expect(events()[0]?.payload).toEqual(running);
  transcript.update(throughResult);
  const toolCall = { id: callId, name, status: "completed", target: finished, durationMs: modelResult.durationMs } as const;
  expect(messages()).toEqual([{ ...running, toolCall }]);
  expect(events()).toHaveLength(2);
  expect(events()[1]?.type).toBe("tool.updated");
  expect(events()[1]?.payload).toEqual({ threadId, messageId: running.id, toolCall });
  expect(JSON.stringify([messages(), events()])).not.toContain("sample-pass");
});

test.each(['{"password":"private-marker"}', '[1,"password","private-marker"]'])("DurableTranscript excludes credential JSON from a Local Sidecar target prefix (%s)", async (hostname) => {
  using db = new Database(":memory:");
  const assistant = fauxAssistantMessage(fauxToolCall("local", { action: "run", command: "pwd" }, { id: callId }), { stopReason: "toolUse" });
  const { initial, throughResult, modelResult } = await committedTurn(assistant, async () => ({
    output: [], details: { hostname },
  }));
  const { projector, messages, events } = transcriptFor(db, initial);
  projector().update(throughResult);
  const toolCall = { id: callId, name: "local", status: "completed", target: "pwd", durationMs: modelResult.durationMs } as const;
  expect(messages()).toHaveLength(1);
  expect(messages()[0]?.toolCall).toEqual(toolCall);
  expect(events()[1]?.type).toBe("tool.updated");
  expect(events()[1]?.payload).toEqual({ threadId, messageId: messages()[0]!.id, toolCall });
  expect(JSON.stringify([messages(), events()])).not.toContain("private");
});

test("DurableTranscript never starts a tool call carried by a terminal provider error", async () => {
  using db = new Database(":memory:");
  const assistant = fauxAssistantMessage([fauxText("Partial response"), tool()], { stopReason: "error", errorMessage: "test failure" });
  const { initial, committed } = await committedConversation(assistant, async () => { throw new Error("Tool execution must not start"); });
  expect(committed.entries.filter(ToolResultEntry.is)).toEqual([]);
  const { projector, messages, events } = transcriptFor(db, initial);
  projector().update(committed);
  expect(messages().map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "response", text: "Partial response" }]);
  expect(events().filter(({ type }) => type === "tool.updated" || type === "message.appended").map(({ payload }) => (payload as { kind: string }).kind)).toEqual(["response"]);
});

test("DurableTranscript reuses persisted rows and events when a new projector replays committed entries", async () => {
  using db = new Database(":memory:");
  const { initial, beforeResult, committed } = await committedTurn(fauxAssistantMessage([
    fauxText("Before tool"), tool(), fauxThinking("After tool"),
  ], { stopReason: "toolUse" }));
  const { projector, messages, events, steer } = transcriptFor(db, initial);
  const first = projector();
  first.update(beforeResult);
  steer();
  const inFlight = messages();
  const publishedBeforeResult = events();
  // A row written before committed occurrence tracking still has its original public summary.
  db.run("UPDATE messages SET payload = json_remove(payload, '$.durableToolOccurrence') WHERE kind = 'tool'");
  const resumed = projector();
  resumed.update(beforeResult);
  expect(messages()).toEqual(inFlight);
  expect(events()).toEqual(publishedBeforeResult);
  resumed.update(committed);
  const before = messages();
  expect(before.map((message) => message.kind)).toEqual(["response", "tool", "thinking", "text", "response"]);
  const published = events();
  projector().update(committed);
  expect(messages()).toEqual(before);
  expect(events()).toEqual(published);
});

test("DurableTranscript ends aborted and unresolved calls with the worker interruption summary", async () => {
  using db = new Database(":memory:");
  const { initial, beforeResult, throughResult } = await committedTurn(fauxAssistantMessage(tool(), { stopReason: "toolUse" }), async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return {};
  }, true);
  const { projector, messages, events, finalize } = transcriptFor(db, initial);
  const transcript = projector();
  transcript.update(throughResult);
  const interrupted = { id: callId, name: "check", status: "error", errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } as const;
  expect(messages()[0]?.toolCall).toEqual(interrupted);
  expect(events()[1]?.payload).toEqual({ threadId, messageId: messages()[0]!.id, toolCall: interrupted });

  // Rebuild from an interrupted journal that ended before any result was written.
  db.query("DELETE FROM messages").run();
  const unresolved = projector();
  unresolved.update(beforeResult);
  finalize();
  expect(messages()[0]?.toolCall).toEqual(interrupted);
  expect(events().at(-1)?.payload).toEqual({ threadId, messageId: messages()[0]!.id, toolCall: interrupted });
});

async function withRecoveryJournal(entries: EntryDraft[], run: (services: ReturnType<typeof transcriptStore>, recover: () => Promise<void>) => Promise<void>, failedPredecessor = false): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "durable-transcript-recovery-"));
  const paths = { dbPath: join(root, "state.sqlite"), stateDir: root, homeDir: root, dataDir: root, sharedWorkspaceDir: root, downloadsDir: root };
  try {
    using db = new Database(paths.dbPath);
    const services = transcriptStore(db);
    const storage = await openNodeSqliteStorage(paths.dbPath, { prefix: "pi_" });
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    const steers: SubmissionId[] = [];
    try {
      const conversation = await openThreadConversation(db, harness, threadId, botId, context);
      await conversation.commit(async (tx) => {
        const user = await tx.appendEntry(conversation.id, { kind: UserEntry.kind, model: [{ role: "user", content: "Start", timestamp: Date.now() }] });
        const submission = await tx.createSubmission({ type: "input", status: "placed", entry: user.id, requestId: turnId, conversationId: conversation.id });
        const inputs: SubmissionId[] = [];
        if (failedPredecessor) {
          tx.settleSubmission(submission.id, { status: "unanswered", reason: "model_error" });
          (await tx.doc(LiveDoc, conversation.id)).runFailure = {
            taskId: 1 as TaskId, inputs: [submission.id], first: user.id, reason: "model_error",
          };
        } else {
          inputs.push(submission.id);
        }
        let answer = user.id;
        for (const entry of entries) {
          const stored = await tx.appendEntry(conversation.id, entry);
          if (AssistantEntry.is(stored)) answer = stored.id;
          if (UserEntry.is(stored)) {
            const steer = await tx.createSubmission({ type: "input", status: "placed", entry: stored.id, requestId: `${turnId}:steer:${stored.id}`, conversationId: conversation.id });
            steers.push(steer.id);
            inputs.push(steer.id);
          }
        }
        for (const id of inputs) tx.settleSubmission(id, { status: "done", answer });
      }, context);
      for (const id of steers) db.run("INSERT INTO pi_turn_submissions (turn_id, submission_id, kind, created_at) VALUES (?, ?, 'steer', '')", [turnId, id]);
    } finally {
      await harness.close(context);
      await storage.close(context);
    }
    await run(services, async () => {
      const runtime = await openBotRuntime(paths, db);
      try {
        const outcomes: unknown[] = [];
        const recovery = runtime.recoverTurns({ db, ...services, registered() {}, settled(_id, outcome) { outcomes.push(outcome); } });
        await recovery.settled;
        expect(outcomes).toEqual([{ status: "completed" }]);
      } finally {
        await runtime.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function legacyResponse(threads: ThreadsService, index: number, text: string, state: "streaming" | "completed", startedAt = new Date().toISOString(), generation = 0) {
  return threads.appendMessage(threadId, {
    author: { kind: "bot" }, kind: "response", text, turnId,
    response: { blockId: `${turnId}-${generation}-text-${index}`, state, startedAt, ...(state === "completed" ? { completedAt: startedAt } : {}) },
  });
}

test("recoverTurns inserts a missed tool before legacy responses and republishes its corrected position", async () => {
  const { committed } = await committedTurn(fauxAssistantMessage([fauxText("A"), tool(), fauxText("B")], { stopReason: "toolUse" }));
  await withRecoveryJournal(committed.entries.filter((entry) => AssistantEntry.is(entry) || ToolResultEntry.is(entry)), async ({ threads, events }, recover) => {
    const a = legacyResponse(threads, 0, "A", "completed");
    const b = legacyResponse(threads, 1, "B", "completed");
    const steer = threads.appendMessage(threadId, { author: { kind: "user" }, kind: "text", text: "Steer" });
    await recover();
    const rows = threads.listMessages(threadId);
    expect(rows.map(({ kind, text, toolCall }) => [kind, text ?? toolCall?.id])).toEqual([
      ["response", "A"], ["tool", callId], ["response", "B"], ["text", "Steer"], ["response", "After result"],
    ]);
    expect(rows[0]).toEqual(a);
    expect(rows[2]).toEqual({ ...b, seq: 3 });
    expect(rows[3]).toEqual({ ...steer, seq: 4 });
    const published = events.replay(0, events.oldestCursor()).events;
    expect(published.find((event) => event.type === "message.appended" && (event.payload as { kind: string }).kind === "tool")?.payload)
      .toEqual({ ...rows[1]!, toolCall: { id: callId, name: "check", status: "running" } });
    await recover();
    expect(threads.listMessages(threadId)).toEqual(rows);
    expect(events.replay(0, events.oldestCursor()).events).toEqual(published);
  });
});

test("recoverTurns replays a settled failed reply before its already answered steer", async () => {
  const timestamp = Date.now() - 1_000;
  await withRecoveryJournal([
    { kind: AssistantEntry.kind, model: [fauxAssistantMessage("Predecessor partial.", { stopReason: "error", timestamp })] },
    { kind: UserEntry.kind, model: [{ role: "user", content: "Steer", timestamp }] },
    { kind: AssistantEntry.kind, model: [fauxAssistantMessage("Steer reply.", { timestamp })] },
  ], async ({ threads }, recover) => {
    const partial = legacyResponse(threads, 0, "Predecessor partial.", "streaming");
    await recover();
    const responses = threads.listMessages(threadId);
    expect(responses).toMatchObject([
      { id: partial.id, text: "Predecessor partial.", response: { blockId: `${turnId}-0-text-0`, state: "completed" } },
      { text: "Steer reply.", response: { blockId: `${turnId}-1-text-0`, state: "completed" } },
    ]);
    await recover();
    expect(threads.listMessages(threadId)).toEqual(responses);
  }, true);
});

test("recoverTurns replaces stale live content with the journal and removes orphaned blocks", async () => {
  const partialTime = Date.now() - 10_000;
  const startedAt = new Date(partialTime + 100).toISOString();
  await withRecoveryJournal([
    { kind: AssistantEntry.kind, model: [fauxAssistantMessage([fauxText("abc"), fauxThinking("Durable reasoning")], { stopReason: "aborted", timestamp: partialTime })] },
    { kind: AssistantEntry.kind, model: [fauxAssistantMessage("Retry", { timestamp: partialTime + 1000 })] },
  ], async ({ threads, events }, recover) => {
    const prior = legacyResponse(threads, 0, "abcdef", "streaming", startedAt);
    const reasoning = threads.appendMessage(threadId, {
      author: { kind: "bot" }, kind: "thinking", text: "Stale reasoning", turnId,
      thinking: { blockId: `${turnId}-0-thinking-1`, state: "completed", startedAt, completedAt: startedAt },
    });
    const orphan = legacyResponse(threads, 2, "lost live block", "streaming", startedAt);
    await recover();
    const rows = threads.listMessages(threadId);
    expect(rows.map(({ text, response, thinking }) => [text, (response ?? thinking)?.state])).toEqual([
      ["abc", "completed"], ["Durable reasoning", "completed"], ["Retry", "completed"],
    ]);
    expect(rows[0]).toMatchObject({ id: prior.id, createdAt: prior.createdAt, response: { blockId: prior.response!.blockId } });
    expect(rows[1]).toEqual({ ...reasoning, text: "Durable reasoning" });
    expect(threads.getMessage(orphan.id)).toBeUndefined();
    const published = events.replay(0, events.oldestCursor()).events;
    expect(published.some((event) => event.type === "response.removed")).toBeTrue();
    await recover();
    expect(threads.listMessages(threadId)).toEqual(rows);
    expect(events.replay(0, events.oldestCursor()).events).toEqual(published);
  });

  await withRecoveryJournal([
    { kind: AssistantEntry.kind, model: [fauxAssistantMessage("Retry", { timestamp: partialTime + 1000 })] },
  ], async ({ threads }, recover) => {
    const lost = legacyResponse(threads, 0, "Entire partial lost", "streaming", startedAt);
    await recover();
    const [retry] = threads.listMessages(threadId);
    expect(retry?.text).toBe("Retry");
    expect(threads.getMessage(lost.id)).toBeUndefined();
  });
});

test("DurableTranscript rolls back terminal tool writes when the event insert fails", async () => {
  using db = new Database(":memory:");
  const { initial, beforeResult, throughResult } = await committedTurn(fauxAssistantMessage(tool(), { stopReason: "toolUse" }));
  const { projector, messages, events, finalize } = transcriptFor(db, initial);
  const rejectUpdate = () => db.exec("CREATE TEMP TRIGGER refuse_tool_event BEFORE INSERT ON events WHEN new.type = 'tool.updated' BEGIN SELECT RAISE(ABORT, 'tool event unavailable'); END");
  const restore = () => db.exec("DROP TRIGGER refuse_tool_event");
  const transcript = projector();
  transcript.update(beforeResult);
  const [running] = messages();
  const initialEvents = events();
  rejectUpdate();
  expect(() => transcript.update(throughResult)).toThrow("tool event unavailable");
  expect(messages()).toEqual([running!]);
  expect(events()).toEqual(initialEvents);
  expect(finalize).toThrow("tool event unavailable");
  expect(messages()).toEqual([running!]);
  expect(events()).toEqual(initialEvents);
  restore();
  projector().update(throughResult);
  expect(messages()[0]?.toolCall?.status).toBe("completed");
  expect(events().at(-1)).toMatchObject({ type: "tool.updated", payload: { messageId: running!.id, toolCall: messages()[0]!.toolCall } });

  db.exec("DELETE FROM messages");
  projector().update(beforeResult);
  rejectUpdate();
  expect(finalize).toThrow("tool event unavailable");
  restore();
  finalize();
  expect(messages()[0]?.toolCall).toMatchObject({ status: "error", errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY });
  expect(events().at(-1)).toMatchObject({ type: "tool.updated", payload: { messageId: messages()[0]!.id, toolCall: messages()[0]!.toolCall } });
});

test("recoverTurns restores a trailing tool before the steer that followed its assistant entry", async () => {
  const { committed } = await committedTurn(fauxAssistantMessage([fauxText("A"), tool()], { stopReason: "toolUse" }));
  const entries: EntryDraft[] = committed.entries.filter((entry) => AssistantEntry.is(entry) || ToolResultEntry.is(entry));
  entries.splice(1, 0, { kind: UserEntry.kind, model: [{ role: "user", content: "Steer", timestamp: Date.now() }] });
  await withRecoveryJournal(entries, async ({ threads, events }, recover) => {
    const a = legacyResponse(threads, 0, "A", "completed");
    const steer = threads.appendMessage(threadId, { author: { kind: "user" }, kind: "text", text: "Steer", turnId });
    const b = legacyResponse(threads, 0, "After result", "completed", undefined, 1);
    await recover();
    const rows = threads.listMessages(threadId);
    expect(rows.map(({ kind, text, toolCall }) => [kind, text ?? toolCall?.id])).toEqual([
      ["response", "A"], ["tool", callId], ["text", "Steer"], ["response", "After result"],
    ]);
    expect(rows[0]).toEqual(a);
    expect(rows[2]).toEqual({ ...steer, seq: 3 });
    expect(rows[3]).toEqual({ ...b, seq: 4 });
    const published = events.replay(0, events.oldestCursor());
    await recover();
    expect(threads.listMessages(threadId)).toEqual(rows);
    expect(events.replay(0, events.oldestCursor())).toEqual(published);
  });
});

test("DurableTranscript projects text and thinking from an aborted partial without publishing its unstarted tool", async () => {
  const { committed } = await committedTurn(fauxAssistantMessage([fauxText("A"), tool(), fauxThinking("C")], { stopReason: "toolUse" }));
  const entries: EntryDraft[] = [
    { kind: AssistantEntry.kind, model: [fauxAssistantMessage([fauxText("A"), tool(), fauxThinking("C")], { stopReason: "aborted" })] },
    ...committed.entries.filter(AssistantEntry.is).slice(1),
  ];
  await withRecoveryJournal(entries, async ({ threads, events }, recover) => {
    await recover();
    expect(threads.listMessages(threadId).map(({ kind, text }) => [kind, text])).toEqual([
      ["response", "A"], ["thinking", "C"], ["response", "After result"],
    ]);
    expect(events.replay(0, events.oldestCursor()).events.some((event) => event.type === "tool.updated")).toBeFalse();
  });
});

test("DurableTranscript never anchors a later turn to a duplicate tool ID from an earlier turn", async () => {
  using db = new Database(":memory:");
  const { initial, committed } = await committedTurn(fauxAssistantMessage([fauxText("New response"), tool()], { stopReason: "toolUse" }));
  const { threads, bots, events } = transcriptStore(db);
  const oldTurn = "older-turn";
  threads.insertTurnRow({ id: oldTurn, threadId, botId, nativeSessionId: "" });
  const old = threads.appendMessage(threadId, { author: { kind: "bot" }, kind: "tool", turnId: oldTurn, toolCall: { id: callId, name: "check", status: "running" } });
  const user = threads.appendMessage(threadId, { author: { kind: "user" }, kind: "text", text: "New turn" });
  new DurableTranscript(threads, bots, events, threadId, botId, turnId, initial).update(committed);
  const rows = threads.listMessages(threadId);
  expect(rows.slice(0, 2)).toEqual([old, user]);
  expect(rows.slice(2).map(({ text }) => text)).toEqual(["New response", "After result"]);
});

test("DurableTranscript reopens a recovered final live block and accepts its next delta", async () => {
  using db = new Database(":memory:");
  const { threads, bots, events } = transcriptStore(db);
  const startedAt = new Date().toISOString();
  const existing = legacyResponse(threads, 0, "abcdef", "completed", startedAt);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const persistedView = async (text: string) => {
      await conversation.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, conversation.id);
        live.generation = { attempt: 1, message: JSON.parse(JSON.stringify(fauxAssistantMessage(text, { timestamp: Date.parse(startedAt) }))) };
      }, context);
      const watch = await conversation.watch(context);
      await watch.stop();
      return watch.value;
    };
    const initial = await persistedView("abc");
    const transcript = new DurableTranscript(threads, bots, events, threadId, botId, turnId, initial);
    transcript.resume(initial);
    const reopened = threads.getMessage(existing.id)!;
    expect(reopened).toMatchObject({ id: existing.id, createdAt: existing.createdAt, text: "abc", response: { state: "streaming" } });
    expect(reopened.response?.completedAt).toBeUndefined();
    expect(events.replay(0, events.oldestCursor()).events.slice(-2).map(({ type, payload }) => [type, payload])).toEqual([
      ["message.appended", reopened], ["response.updated", reopened],
    ]);
    transcript.update(await persistedView("abcd"));
    expect(threads.getMessage(existing.id)?.text).toBe("abcd");
    expect(events.replay(0, events.oldestCursor()).events.at(-1)).toMatchObject({ type: "response.updated", payload: { id: existing.id, text: "abcd" } });
  } finally {
    await harness.close(context);
    await storage.close(context);
  }
});

test("EventLog publishes tool events only after the outer transaction commits", () => {
  using db = new Database(":memory:");
  const { threads, events } = transcriptStore(db);
  const running = () => threads.appendMessage(threadId, { author: { kind: "bot" }, kind: "tool", turnId, toolCall: { id: callId, name: "check", status: "running" } });
  const toolRow = running();
  const received: { type: string; inTransaction: boolean }[] = [];
  events.subscribe(({ type }) => received.push({ type, inTransaction: db.inTransaction }));
  const update = () => threads.projectToolResult(toolRow.id, { id: callId, name: "check", status: "completed" });
  expect(() => events.transaction(() => {
    update();
    expect(received).toEqual([]);
    throw new Error("outer rollback");
  })).toThrow("outer rollback");
  expect(received).toEqual([]);
  expect(threads.getMessage(toolRow.id)?.toolCall?.status).toBe("running");
  events.transaction(() => {
    update();
    expect(received).toEqual([]);
  });
  expect(received).toEqual([{ type: "tool.updated", inTransaction: false }]);
  events.transaction(() => {
    expect(() => events.transaction(() => {
      events.append("thread", threadId, "test.rolled_back_savepoint", {});
      throw new Error("savepoint rollback");
    })).toThrow("savepoint rollback");
    events.append("thread", threadId, "test.committed_savepoint", {});
    expect(received).toHaveLength(1);
  });
  expect(received).toEqual([
    { type: "tool.updated", inTransaction: false }, { type: "test.committed_savepoint", inTransaction: false },
  ]);
  events.append("thread", threadId, "test.direct", {});
  expect(received.at(-1)).toEqual({ type: "test.direct", inTransaction: false });
});

test("DurableTranscript rolls back completed block corrections when their event insert fails", async () => {
  using db = new Database(":memory:");
  const { threads, bots, events } = transcriptStore(db);
  const { initial, beforeResult } = await committedTurn(fauxAssistantMessage([fauxText("Correct"), tool()], { stopReason: "toolUse" }));
  const stale = legacyResponse(threads, 0, "Stale", "completed");
  const project = () => new DurableTranscript(threads, bots, events, threadId, botId, turnId, initial).update(beforeResult);
  const initialEvents = events.replay(0, events.oldestCursor());
  db.exec("CREATE TEMP TRIGGER refuse_correction BEFORE INSERT ON events WHEN new.type = 'response.updated' BEGIN SELECT RAISE(ABORT, 'correction event unavailable'); END");
  expect(project).toThrow("correction event unavailable");
  expect(threads.getMessage(stale.id)).toEqual(stale);
  expect(events.replay(0, events.oldestCursor())).toEqual(initialEvents);
  db.exec("DROP TRIGGER refuse_correction");
  const corrections: boolean[] = [];
  events.subscribe((event) => { if (event.type === "response.updated") corrections.push(db.inTransaction); });
  project();
  expect(threads.getMessage(stale.id)).toEqual({ ...stale, text: "Correct" });
  expect(events.replay(0, events.oldestCursor()).events.find(({ type }) => type === "response.updated")?.payload).toEqual({ ...stale, text: "Correct" });
  expect(corrections).toEqual([false]);
});

test("ThreadsService publishes interruption under the finalized tool row's thread", () => {
  using db = new Database(":memory:");
  const { threads, events } = transcriptStore(db);
  const toolRow = threads.appendMessage(threadId, { author: { kind: "bot" }, kind: "tool", turnId, toolCall: { id: callId, name: "check", status: "running" } });
  threads.finalizeDurableToolCalls(turnId);
  expect(events.replay(0, events.oldestCursor()).events.at(-1)).toMatchObject({
    type: "tool.updated", aggregateId: toolRow.threadId,
    payload: { threadId: toolRow.threadId, messageId: toolRow.id, toolCall: { status: "error" } },
  });
});

test("EventLog drains reentrant appends after the committed batch for every listener", () => {
  using db = new Database(":memory:");
  const { events } = transcriptStore(db);
  const append = () => events.append("thread", threadId, "test.event", {});
  const cursors: number[] = [];
  events.subscribe(({ cursor }) => { if (cursor === 1) append(); });
  events.subscribe(({ cursor }) => { cursors.push(cursor); });
  events.transaction(() => { append(); append(); });
  expect(cursors).toEqual([1, 2, 3]);
});

test("EventLog reports subscriber failures and still delivers to later listeners and events", async () => {
  using db = new Database(":memory:");
  const { events } = transcriptStore(db);
  const report = spyOn(console, "error").mockImplementation(() => {});
  try {
    const failure = new Error("listener threw");
    const rejected = new Error("listener rejected");
    const cursors: number[] = [];
    events.subscribe(({ cursor }) => { if (cursor === 1) throw failure; });
    events.subscribe(async ({ cursor }) => { if (cursor === 1) throw rejected; });
    events.subscribe(({ cursor }) => { cursors.push(cursor); });
    expect(() => events.transaction(() => {
      events.append("thread", threadId, "test.event", {});
      events.append("thread", threadId, "test.event", {});
    })).not.toThrow();
    expect(cursors).toEqual([1, 2]);
    await Promise.resolve();
    expect(report.mock.calls.map((call) => call.at(-1))).toEqual([failure, rejected]);
  } finally {
    report.mockRestore();
  }
});

test("EventLog replay followed by subscription delivers each handshake cursor once", () => {
  using db = new Database(":memory:");
  const { events } = transcriptStore(db);
  const cursors: number[] = [];
  // Run the same synchronous replay-then-subscribe handshake even while a committed batch drains.
  events.subscribe(({ cursor }) => {
    if (cursor !== 1) return;
    cursors.push(...events.replay(0, events.oldestCursor()).events.map((event) => event.cursor));
    events.subscribe((event) => { cursors.push(event.cursor); });
  });
  const append = () => events.append("thread", threadId, "test.event", {});
  events.transaction(() => { append(); append(); });
  append();
  expect(cursors).toEqual([1, 2, 3]);
});

test("DurableTranscript retries authoritative prefix and completion updates after an event insert fails", async () => {
  using db = new Database(":memory:");
  const { threads, bots, events } = transcriptStore(db);
  const { initial, beforeResult } = await committedTurn(fauxAssistantMessage([fauxText("abcd"), tool()], { stopReason: "toolUse" }));
  const startedAt = new Date().toISOString();
  const row = legacyResponse(threads, 0, "abc", "streaming", startedAt);
  const live: ConversationView = { ...initial, docs: JSON.parse(JSON.stringify({
    "pi.live": { generation: { attempt: 1, message: fauxAssistantMessage("abcd", { timestamp: Date.parse(startedAt) }) } },
  })) };
  const transcript = new DurableTranscript(threads, bots, events, threadId, botId, turnId, initial);
  const replay = () => events.replay(0, events.oldestCursor());
  const before = replay();

  db.exec("CREATE TEMP TRIGGER refuse_prefix BEFORE INSERT ON events WHEN new.type = 'response.updated' BEGIN SELECT RAISE(ABORT, 'prefix event unavailable'); END");
  expect(() => transcript.resume(live)).toThrow("prefix event unavailable");
  expect(threads.getMessage(row.id)).toEqual(row);
  expect(replay()).toEqual(before);
  db.exec("DROP TRIGGER refuse_prefix");
  transcript.resume(live);
  const extended = { ...row, text: "abcd" };
  expect(threads.getMessage(row.id)).toEqual(extended);
  expect(replay().events.at(-1)).toMatchObject({ type: "response.updated", payload: extended });

  db.exec("CREATE TEMP TRIGGER refuse_completion BEFORE INSERT ON events WHEN new.type = 'response.updated' AND json_extract(new.payload, '$.response.state') = 'completed' BEGIN SELECT RAISE(ABORT, 'completion event unavailable'); END");
  const afterExtension = replay();
  expect(() => transcript.update(beforeResult)).toThrow("completion event unavailable");
  expect(threads.getMessage(row.id)).toEqual(extended);
  expect(replay()).toEqual(afterExtension);
  db.exec("DROP TRIGGER refuse_completion");
  transcript.update(beforeResult);
  expect(threads.getMessage(row.id)).toMatchObject({ ...extended, response: { ...extended.response!, state: "completed" } });
  expect(replay().events.find(({ type, payload }) => type === "response.updated" && (payload as { response?: { state: string } }).response?.state === "completed")?.payload)
    .toEqual(threads.getMessage(row.id));
});

test("DurableTranscript retries a live response delta without duplicating its suffix", async () => {
  using db = new Database(":memory:");
  const { initial, live } = await committedTurn(fauxAssistantMessage([fauxText("abcd"), tool()], { stopReason: "toolUse" }));
  const { projector, messages, events } = transcriptFor(db, initial);
  const transcript = projector();
  const prefix = structuredClone(live);
  (prefix.docs["pi.live"] as { generation: { message: AssistantMessage } }).generation.message.content[0] = fauxText("abc");
  transcript.update(prefix);
  const [row] = messages();
  expect(row?.text).toBe("abc");
  const before = events();

  db.exec("CREATE TEMP TRIGGER refuse_live_delta BEFORE INSERT ON events WHEN new.type = 'response.updated' BEGIN SELECT RAISE(ABORT, 'live delta event unavailable'); END");
  expect(() => transcript.update(live)).toThrow("live delta event unavailable");
  expect(messages()).toEqual([row!]);
  expect(events()).toEqual(before);
  db.exec("DROP TRIGGER refuse_live_delta");

  transcript.update(live);
  const extended = { ...row!, text: "abcd" };
  expect(messages()).toEqual([extended]);
  expect(events().slice(before.length)).toMatchObject([{ type: "response.updated", payload: extended }]);
});

test("DurableTranscript retries its first block append after the append event insert fails", async () => {
  using db = new Database(":memory:");
  const { initial, live } = await committedTurn(fauxAssistantMessage([fauxText("First response"), tool()], { stopReason: "toolUse" }));
  const { projector, messages, events } = transcriptFor(db, initial);
  const transcript = projector();
  const before = events();

  db.exec("CREATE TEMP TRIGGER refuse_first_append BEFORE INSERT ON events WHEN new.type = 'message.appended' BEGIN SELECT RAISE(ABORT, 'append event unavailable'); END");
  expect(() => transcript.update(live)).toThrow("append event unavailable");
  expect(messages()).toEqual([]);
  expect(events()).toEqual(before);
  db.exec("DROP TRIGGER refuse_first_append");

  transcript.update(live);
  expect(messages()).toHaveLength(1);
  const [row] = messages();
  expect(row).toMatchObject({ kind: "response", text: "First response", response: { state: "streaming" } });
  expect(events().slice(before.length)).toMatchObject([
    { type: "message.appended", payload: { ...row!, text: "" } },
    { type: "response.updated", payload: row! },
  ]);
});
