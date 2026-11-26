import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../../apps/daemon/src/bootstrap/config.ts";
import { withBlockingRuntimeTool, withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { openDb, recoverOnStartup } from "../../apps/daemon/src/persistence/db.ts";
import { MessageDto } from "../../packages/protocol/src/index.ts";
import { api, apiStatus, makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle } from "./helpers/harness.ts";

const parityScript = { input: "parity-stream", thinking: "T", response: "R" };
const script = [{ segments: [{ type: "thinking" as const, text: parityScript.thinking }, { type: "text" as const, text: parityScript.response }] }];

test("a durable Turn preserves the ordered transcript and events with a legacy offline status", () => withFakeRuntimeProvider(script, {}, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Parity");
    h.svc.db.query("UPDATE agents SET status = 'offline' WHERE id = 'pi'").run();
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const cursor = h.svc.events.replay(0, h.svc.events.oldestCursor()).events.at(-1)?.cursor ?? 0;
    const { turnId, threadId, messageId } = await sendToBot(h, botId, parityScript.input);
    await waitThreadIdle(h, threadId);
    const row = h.svc.threads.turnRow(turnId);
    expect(row?.status).toBe("completed");
    expect(Number.isFinite(Date.parse(row?.started_at ?? ""))).toBeTrue();
    expect(Number.isFinite(Date.parse(row?.finished_at ?? ""))).toBeTrue();

    const user: MessageDto = {
      id: messageId, threadId, seq: 1, author: { kind: "user" }, kind: "text", text: parityScript.input,
      createdAt: expect.any(String),
    };
    const thinking: MessageDto = {
      id: expect.any(String), threadId, seq: 2, author: { kind: "bot" }, kind: "thinking", text: parityScript.thinking,
      thinking: { blockId: expect.any(String), state: "completed", startedAt: expect.any(String), completedAt: expect.any(String) },
      createdAt: expect.any(String),
    };
    const response: MessageDto = {
      id: expect.any(String), threadId, seq: 3, author: { kind: "bot" }, kind: "response", text: parityScript.response,
      response: { blockId: expect.any(String), state: "completed", startedAt: expect.any(String), completedAt: expect.any(String) },
      createdAt: expect.any(String),
    };
    const transcript = (await messages(h, threadId)).map((message) => MessageDto.parse(message));
    expect(transcript).toEqual([user, thinking, response]);
    const events = h.svc.events.replay(cursor, h.svc.events.oldestCursor()).events
      .filter(({ aggregateId }) => [threadId, turnId, botId].includes(aggregateId));
    expect(events.map(({ aggregateType, type }) => `${aggregateType}:${type}`)).toEqual([
      "thread:thread.created", "thread:message.appended", "turn:turn.created", "bot:bot.activity", "bot:bot.attention",
      "thread:message.appended", "thread:thinking.updated", "thread:thinking.updated",
      "thread:message.appended", "thread:response.updated", "thread:response.updated", "bot:bot.attention", "turn:turn.status", "bot:bot.activity",
    ]);
    const ids = { turnId, threadId, botId };
    function streaming(message: MessageDto, kind: "thinking" | "response", text: string) {
      const { completedAt, ...lifecycle } = message[kind]!;
      return { ...message, text, [kind]: { ...lifecycle, state: "streaming" } };
    }
    for (const { payload } of events.filter(({ type }) => type === "bot.attention")) {
      const at = (payload as { at: unknown }).at;
      expect(typeof at).toBe("string");
      expect(Number.isFinite(Date.parse(at as string))).toBeTrue();
      expect(Date.parse(at as string)).toBeGreaterThanOrEqual(Date.parse(row!.started_at));
      expect(Date.parse(at as string)).toBeLessThanOrEqual(Date.now());
    }
    expect(events.map(({ payload }) => payload)).toEqual([
      ids, user, ids, { status: "active", threadId, turnId }, { threadId, at: expect.any(String) },
      streaming(thinking, "thinking", ""), streaming(thinking, "thinking", parityScript.thinking), thinking,
      streaming(response, "response", ""), streaming(response, "response", parityScript.response), response,
      { threadId, preview: parityScript.response, at: expect.any(String) },
      { ...ids, from: "working", to: "completed" }, { status: "inactive", threadId, turnId },
    ]);
    expect(h.svc.db.query<{ count: number }, []>("SELECT count(*) AS count FROM pi_thread_conversations").get()?.count).toBe(1);
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test("durable steering is accepted during a reply", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "a long streamed reply" }] }, { segments: [{ type: "text", text: "redirected" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Steer durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const sent = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    const steered = await sendToThread(h, sent.threadId, "redirect");
    expect(steered.action).toBe("steered");
    expect(steered.turnId).toBe(sent.turnId);
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)?.steer_count).toBe(1);
    expect(h.svc.db.query<{ kind: string }, [string]>("SELECT kind FROM pi_turn_submissions WHERE turn_id = ? ORDER BY submission_id").all(sent.turnId)).toEqual([{ kind: "input" }, { kind: "steer" }]);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "response" && message.text?.includes("redirected"))).toBeTrue();
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test("durable steering during a tool call lands after the tool result", () => withBlockingRuntimeTool(async (tool) => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Tool steering durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const first = await sendToBot(h, botId, "first");
    await tool.started;
    const steered = await sendToThread(h, first.threadId, "redirect after tool");
    expect(steered.action).toBe("steered");
    tool.release();
    await waitThreadIdle(h, first.threadId);
    const context = tool.seen();
    expect(context).toContain("tool finished");
    expect(context).toContain("redirect after tool");
    expect(context.indexOf("tool finished")).toBeLessThan(context.indexOf("redirect after tool"));
    expect((await messages(h, first.threadId)).some((message) => message.kind === "response" && message.text === "after tool")).toBeTrue();
  } finally { tool.release(); await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("steering targets the running durable turn when a follow-up is queued", () => withBlockingRuntimeTool(async (tool) => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Queued steering durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const first = await sendToBot(h, botId, "first");
    await tool.started;
    const second = await api<{ turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "second", whenBusy: "followUp" });
    const steer = await sendToThread(h, first.threadId, "redirect after tool");
    expect(steer.turnId).toBe(first.turnId);
    expect(steer.turnId).not.toBe(second.turnId);
    tool.release();
    await waitThreadIdle(h, first.threadId);
    expect(tool.seen()).toContain("redirect after tool");
  } finally { tool.release(); await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("a durable follow-up runs as its own turn after the first reply", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "first reply is long" }] }, { segments: [{ type: "text", text: "second reply" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Follow-up durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const first = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    const second = await api<{ action: string; turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "second", whenBusy: "followUp" });
    expect(second.action).toBe("sent");
    expect(second.turnId).not.toBe(first.turnId);
    await waitThreadIdle(h, first.threadId);
    expect(h.svc.threads.turnRow(first.turnId)?.status).toBe("completed");
    expect(h.svc.threads.turnRow(second.turnId)?.status).toBe("completed");
    const replies = (await messages(h, first.threadId)).filter((message) => message.kind === "response");
    expect(replies.map((message) => message.text)).toEqual(["first reply is long", "second reply"]);
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("a queued durable follow-up runs after a model failure", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "before failure" }], failure: "queued failure" }, { segments: [{ type: "text", text: "recovered" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Failure queue durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const first = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    const second = await api<{ action: string; turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "second", whenBusy: "followUp" });
    await waitThreadIdle(h, first.threadId);
    expect(h.svc.threads.turnRow(first.turnId)).toMatchObject({ status: "failed", outcome_reason: "queued failure" });
    expect(h.svc.threads.turnRow(second.turnId)?.status).toBe("completed");
    expect((await messages(h, first.threadId)).some((message) => message.kind === "response" && message.text === "recovered")).toBeTrue();
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("a durable follow-up that loses the idle race starts normally", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "first reply is long" }] }, { segments: [{ type: "text", text: "second reply" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const botId = await makeBot(h, "Follow-up idle race");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const first = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    const runtime = (h.svc.turns as unknown as { runtime: import("../../apps/daemon/src/modules/runtime/runtime.ts").BotRuntime }).runtime;
    const original = runtime.startTurn.bind(runtime);
    let queued!: () => void;
    const started = new Promise<void>((resolve) => { queued = resolve; });
    const spy = spyOn(runtime, "startTurn").mockImplementation(async (input) => {
      if (input.whenBusy) { queued(); await gate; }
      return original(input);
    });
    try {
      const followUp = api<{ action: string; turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "second", whenBusy: "followUp" });
      await started;
      await h.svc.turns.waitForTerminal(first.turnId);
      release();
      const second = await followUp;
      expect(second.action).toBe("sent");
      await h.svc.turns.waitForTerminal(second.turnId);
      expect(h.svc.threads.turnRow(second.turnId)?.status).toBe("completed");
      expect((await messages(h, first.threadId)).some((message) => message.kind === "response" && message.text === "second reply")).toBeTrue();
    } finally { release(); spy.mockRestore(); }
  } finally { release(); await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("failed durable run removes streaming blocks and preserves completed thinking", () => withFakeRuntimeProvider([{ segments: [{ type: "thinking", text: "finished thought" }, { type: "text", text: "partial failure response" }], failure: "stream failed" }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Failed streaming");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const sent = await sendToBot(h, botId, "fail while streaming");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)).toMatchObject({ status: "failed", outcome_reason: "stream failed" });
    expect(h.svc.db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM messages WHERE turn_id = ? AND block_state = 'streaming'").get(sent.turnId)?.count).toBe(0);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "thinking" && message.text === "finished thought" && message.thinking?.state === "completed")).toBeTrue();
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("same-turn steering can recover from a failed durable run", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "before failure" }], failure: "failed primary" }, { segments: [{ type: "text", text: "recovered response" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Steer recovery");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const first = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    expect((await sendToThread(h, first.threadId, "recover")).action).toBe("steered");
    await waitThreadIdle(h, first.threadId);
    expect(h.svc.threads.turnRow(first.turnId)?.status).toBe("completed");
    expect((await messages(h, first.threadId)).some((message) => message.kind === "response" && message.text === "recovered response")).toBeTrue();
    expect(h.svc.db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM messages WHERE turn_id = ? AND block_state = 'streaming'").get(first.turnId)?.count).toBe(0);
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("aborting an active durable turn also cancels its queued follow-up", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "first reply is long" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Abort active with queue");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const first = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    const second = await api<{ turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "second", whenBusy: "followUp" });
    await h.svc.turns.abortTurn(first.turnId, "cancel active");
    await h.svc.turns.waitForTerminal(first.turnId);
    await h.svc.turns.waitForTerminal(second.turnId);
    expect(h.svc.threads.turnRow(first.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "cancel active" });
    expect(h.svc.threads.turnRow(second.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "aborted" });
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("aborting a queued durable follow-up leaves the active reply running", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "first reply is long" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Abort queued durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => { if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed(); });
    const first = await sendToBot(h, botId, "first");
    await streaming;
    unsubscribe();
    const second = await api<{ turnId: string }>(h, "POST", `/api/threads/${first.threadId}/messages`, { text: "second", whenBusy: "followUp" });
    await h.svc.turns.abortTurn(second.turnId, "cancel queued");
    await waitThreadIdle(h, first.threadId);
    expect(h.svc.threads.turnRow(second.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "cancel queued" });
    expect(h.svc.threads.turnRow(first.turnId)?.status).toBe("completed");
    expect((await messages(h, first.threadId)).some((message) => message.kind === "response" && message.text === "first reply is long")).toBeTrue();
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("aborting a durable turn records cancellation and removes the incomplete reply", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "a long streamed reply" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Abort durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => {
      if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed();
    });
    const sent = await sendToBot(h, botId, "abort");
    await streaming;
    unsubscribe();
    await h.svc.turns.abortTurn(sent.turnId, "test abort");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "test abort" });
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "response")).toBeFalse();
    await Bun.sleep(2500);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "response")).toBeFalse();
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("cancelled");
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test("durable turns configure the default tool-round limit", async () => {
  const limits: (number | null | undefined)[] = [];
  await withFakeRuntimeProvider(Array.from({ length: 4 }, () => ({ segments: [{ type: "text" as const, text: "ok" }] })), { onMaxTurns: (limit) => limits.push(limit) }, async () => {
    const h = await startDaemon(undefined, { seedDurableProvider: false });
    try {
      const botId = await makeBot(h, "Limited durable");
      const created = await api<{ id: string; maxTurns: number | null }>(h, "POST", "/api/bots", { name: "Custom limit", maxTurns: 3 });
      expect(created.maxTurns).toBe(3);
      for (const value of [0, -1, 1.5, "2"]) {
        expect((await apiStatus(h, "PATCH", `/api/bots/${created.id}`, { maxTurns: value })).status).toBe(400);
        expect((await apiStatus(h, "POST", "/api/bots", { name: "Invalid limit", maxTurns: value })).status).toBe(400);
      }
      await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
      setSetting(h.svc.db, "default_model", "fake/fake-model");
      const sent = await sendToBot(h, botId, "hello");
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
      expect(limits).toEqual([50]);
      const custom = await sendToBot(h, created.id, "custom");
      await waitThreadIdle(h, custom.threadId);
      expect(limits).toEqual([50, 3]);
      const patched = await api<{ maxTurns: number | null }>(h, "PATCH", `/api/bots/${created.id}`, { maxTurns: 7 });
      expect(patched.maxTurns).toBe(7);
      const event = h.svc.events.replay(0, h.svc.events.oldestCursor()).events.filter((item) => item.type === "bot.updated" && item.aggregateId === created.id).at(-1);
      expect((event?.payload as { maxTurns?: number }).maxTurns).toBe(7);
      const updated = await sendToThread(h, custom.threadId, "updated");
      await waitThreadIdle(h, updated.threadId);
      expect(limits).toEqual([50, 3, 7]);
      expect((await api<{ maxTurns: number | null }>(h, "PATCH", `/api/bots/${created.id}`, { maxTurns: null })).maxTurns).toBeNull();
      const resetEvent = h.svc.events.replay(0, h.svc.events.oldestCursor()).events.filter((item) => item.type === "bot.updated" && item.aggregateId === created.id).at(-1);
      expect((resetEvent?.payload as { maxTurns: number | null }).maxTurns).toBeNull();
      const reset = await sendToThread(h, custom.threadId, "reset");
      await waitThreadIdle(h, reset.threadId);
      expect(limits).toEqual([50, 3, 7, 50]);
    } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
  });
});

test("durable turn reports the model failure reason", () => withFakeRuntimeProvider([{ segments: [], failure: "scripted model failure" }], {}, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Failed durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const sent = await sendToBot(h, botId, "fail");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("failed");
    expect(h.svc.threads.turnRow(sent.turnId)?.outcome_reason).toContain("scripted model failure");
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test("durable turn fails closed when its selected provider has no credentials", async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Missing credential");
    setSetting(h.svc.db, "default_model", "missing/model");
    const sent = await sendToBot(h, botId, parityScript.input);
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)).toMatchObject({ status: "failed", outcome_reason: "Unable to resolve Bot provider/model selection: missing/model" });
    expect((await messages(h, sent.threadId)).map((message) => message.kind)).toEqual(["text"]);
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("durable streams committed partials and resolves the Bot model again on the next turn", () => withFakeRuntimeProvider([{ segments: [{ type: "thinking", text: "think" }, { type: "text", text: "reply" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Live durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const observed: string[] = [];
    const responseUpdates: { text: string; state: string }[] = [];
    const unsubscribe = h.svc.events.subscribe((event) => {
      if (event.type === "thinking.updated" || event.type === "response.updated") {
        const message = event.payload as { text: string; thinking?: { state: string }; response?: { state: string } };
        if ((message.thinking?.state ?? message.response?.state) === "streaming") observed.push(event.type);
        if (event.type === "response.updated" && message.response) responseUpdates.push({ text: message.text, state: message.response.state });
      }
    });
    const sent = await sendToBot(h, botId, "live stream");
    await waitThreadIdle(h, sent.threadId);
    unsubscribe();
    expect(observed).toEqual(expect.arrayContaining(["thinking.updated", "response.updated"]));
    const streaming = responseUpdates.filter((update) => update.state === "streaming");
    let accumulated = "";
    const deltas = streaming.map(({ text }) => {
      expect(text.startsWith(accumulated)).toBeTrue();
      const delta = text.slice(accumulated.length);
      accumulated += delta;
      return delta;
    });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("reply");
    expect(responseUpdates.at(-1)).toEqual({ text: "reply", state: "completed" });
    expect((await messages(h, sent.threadId)).find((message) => message.kind === "response")?.text).toBe("reply");
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
    h.svc.db.query("UPDATE bots SET model = ? WHERE id = ?").run("missing/model", botId);
    const next = await sendToThread(h, sent.threadId, "next turn");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(next.turnId)).toMatchObject({ status: "failed", outcome_reason: "Unable to resolve Bot provider/model selection: missing/model" });
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test.each(["worker", "unexpected"])("historical runtime setting %s leaves Turns on the durable path", async (setting) => {
  const home = mkdtempSync(path.join(tmpdir(), "omarchy-bot-historical-runtime-"));
  try {
    {
      using db = openDb({ dbPath: path.join(home, "db.sqlite"), artifactsDir: path.join(home, "artifacts") } as Config);
      setSetting(db, "runtime", setting);
    }
    const h = await startDaemon(home);
    try {
      const botId = await makeBot(h, "Historical runtime settings");
      const sent = await sendToBot(h, botId, parityScript.input);
      expect(await h.svc.turns.waitForTerminal(sent.turnId)).toMatchObject({ status: "completed" });
      expect((await messages(h, sent.threadId)).map(({ kind }) => kind)).toEqual(["text", "thinking", "response"]);
      expect(h.svc.db.query("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?").get(sent.threadId))
        .toEqual({ conversation_id: expect.any(Number) });
    } finally {
      await h.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a durable turn streams and completes when the Bot storage identity row is unavailable", () => withFakeRuntimeProvider(script, {}, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "No Agent");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    h.svc.db.exec("CREATE TEMP TABLE saved_agents AS SELECT * FROM agents");
    h.svc.db.exec("PRAGMA foreign_keys = OFF");
    h.svc.db.exec("DELETE FROM agents");
    expect(h.svc.db.query("SELECT id FROM agents").all()).toEqual([]);
    const sent = await h.svc.turns.send(botId, null, parityScript.input);
    const turn = await h.svc.turns.waitForTerminal(sent.turnId);
    expect(turn.status).toBe("completed");
    const records = h.svc.threads.listMessages(sent.threadId);
    expect(records.map((message) => message.kind)).toEqual(["text", "thinking", "response"]);
    expect(records[1]?.thinking?.state).toBe("completed");
    expect(records[2]?.response?.state).toBe("completed");
    const streamed = h.svc.events.replay(0, h.svc.events.oldestCursor()).events.filter((event) => event.aggregateId === sent.threadId && (event.type === "thinking.updated" || event.type === "response.updated"));
    expect(streamed.some((event) => event.type === "thinking.updated" && (event.payload as { thinking?: { state: string } }).thinking?.state === "streaming")).toBeTrue();
    expect(streamed.some((event) => event.type === "response.updated" && (event.payload as { response?: { state: string } }).response?.state === "streaming")).toBeTrue();
  } finally {
    h.svc.db.exec("INSERT INTO agents SELECT * FROM saved_agents");
    h.svc.db.exec("PRAGMA foreign_keys = ON");
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test("startup preserves a working Turn with a durable submission association", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "ok" }] }], {}, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Recovery association");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    const sent = await sendToBot(h, botId, "hello");
    await waitThreadIdle(h, sent.threadId);
    h.svc.db.query("UPDATE turns SET status = 'working', finished_at = NULL WHERE id = ?").run(sent.turnId);
    recoverOnStartup(h.svc.db);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
    h.svc.db.query("UPDATE turns SET status = 'completed' WHERE id = ?").run(sent.turnId);
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("shutdown aborts and awaits a running durable turn", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "a long streamed reply" }] }], { tokensPerSecond: 10 }, async () => {
  const h = await startDaemon(undefined, { seedDurableProvider: false });
  try {
    const botId = await makeBot(h, "Shutdown durable");
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    let observed!: () => void;
    const streaming = new Promise<void>((resolve) => { observed = resolve; });
    const unsubscribe = h.svc.events.subscribe((event) => {
      if (event.type === "response.updated" && (event.payload as { text?: string }).text) observed();
    });
    const sent = await sendToBot(h, botId, "shutdown");
    await streaming;
    unsubscribe();
    await h.svc.turns.shutdown();
    expect(h.svc.threads.turnRow(sent.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "aborted" });
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));
