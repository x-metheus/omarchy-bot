import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { CredentialStore } from "../../apps/daemon/src/modules/runtime/credentials.ts";
import type { BotRuntime } from "../../apps/daemon/src/modules/runtime/runtime.ts";
import { deleteSetting, setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { apiStatus, makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle } from "./helpers/harness.ts";

const parityScript = { input: "parity-stream", thinking: "T", response: "R" };
const script = [{ segments: [{ type: "thinking" as const, text: parityScript.thinking }, { type: "text" as const, text: parityScript.response }] }];

// Generated identifiers and lifecycle timestamps vary between independent runs; cursors identify their event positions.
const normalizedKeys = new Set(["id", "threadId", "turnId", "botId", "messageId", "blockId", "startedAt", "completedAt", "createdAt", "finishedAt", "cursor", "eventId"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    normalizedKeys.has(key) ? `<${key}>` : normalize(item),
  ]));
  return value;
}

test("durable and worker turns produce the same transcript and events; switch off retains worker behavior", () => withFakeRuntimeProvider(script, {}, async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Parity");
    new CredentialStore(h.svc.cfg.stateDir).add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    async function run(runtime: string | null) {
      if (runtime === null) deleteSetting(h.svc.db, "runtime");
      else setSetting(h.svc.db, "runtime", runtime);
      const cursor = h.svc.events.replay(0, h.svc.events.oldestCursor()).events.at(-1)?.cursor ?? 0;
      const sent = await sendToBot(h, botId, parityScript.input);
      await waitThreadIdle(h, sent.threadId);
      const row = h.svc.threads.turnRow(sent.turnId);
      expect(row?.status).toBe("completed");
      expect(Number.isFinite(Date.parse(row?.started_at ?? ""))).toBeTrue();
      expect(Number.isFinite(Date.parse(row?.finished_at ?? ""))).toBeTrue();
      const transcript = await messages(h, sent.threadId);
      const events = h.svc.events.replay(cursor, h.svc.events.oldestCursor()).events
        .filter((event) => event.aggregateId === sent.threadId || event.aggregateId === sent.turnId || event.aggregateId === botId)
        .map(({ aggregateType, type, payload }) => {
          if (aggregateType === "bot" && type === "bot.attention") {
            const attention = payload as { at: unknown };
            expect(typeof attention.at).toBe("string");
            const at = Date.parse(attention.at as string);
            expect(Number.isFinite(at)).toBeTrue();
            expect(at).toBeGreaterThanOrEqual(Date.parse(row!.started_at));
            expect(at).toBeLessThanOrEqual(Date.now());
            // at is the wall-clock time of the run and cannot match across sequential runs.
            return { aggregateType, type, payload: normalize({ ...attention, at: "<at>" }) };
          }
          return { aggregateType, type, payload: normalize(payload) };
        });
      return { transcript: normalize(transcript), events };
    }
    const worker = await run(null);
    expect((worker.transcript as { kind: string; seq: number; thinking?: { state: string }; response?: { state: string } }[]).map((message) => ({ kind: message.kind, seq: message.seq, state: message.thinking?.state ?? message.response?.state }))).toEqual([
      { kind: "text", seq: 1, state: undefined },
      { kind: "thinking", seq: 2, state: "completed" },
      { kind: "response", seq: 3, state: "completed" },
    ]);
    expect(worker.events.map(({ aggregateType, type }) => `${aggregateType}:${type}`)).toEqual([
      "thread:thread.created", "thread:message.appended", "turn:turn.created", "bot:bot.activity", "bot:bot.attention",
      "thread:message.appended", "thread:thinking.updated", "thread:thinking.updated",
      "thread:message.appended", "thread:response.updated", "thread:response.updated", "bot:bot.attention", "turn:turn.status", "bot:bot.activity",
    ]);
    const ready = spyOn(h.svc.agents, "isReady").mockReturnValue(false);
    const inventory = spyOn(h.svc.agents, "capabilityInventory").mockReturnValue(undefined);
    const durable = await run("durable");
    ready.mockRestore();
    inventory.mockRestore();
    expect(h.svc.db.query<{ count: number }, []>("SELECT count(*) AS count FROM pi_thread_conversations").get()?.count).toBe(1);
    expect(durable).toEqual(worker);
    expect(await run(null)).toEqual(worker);
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}));

test("a second durable send returns 409 without persisting anything", async () => {
  const h = await startDaemon();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const runtime = (h.svc.turns as unknown as { runtime: BotRuntime }).runtime;
  const start = spyOn(runtime, "startTurn").mockReturnValue(pending);
  try {
    const botId = await makeBot(h, "Active durable");
    setSetting(h.svc.db, "runtime", "durable");
    const sent = await sendToBot(h, botId, "first");
    const beforeMessages = await messages(h, sent.threadId);
    const beforeTurn = h.svc.threads.turnRow(sent.turnId);
    const beforeTurns = h.svc.db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM turns WHERE thread_id = ?").get(sent.threadId)?.count;
    const beforeEvents = h.svc.events.replay(0, h.svc.events.oldestCursor()).events;
    const cursor = beforeEvents.at(-1)?.cursor ?? 0;
    const result = await apiStatus(h, "POST", `/api/threads/${sent.threadId}/messages`, { text: "second" });
    expect(result.status).toBe(409);
    const afterMessages = await messages(h, sent.threadId);
    const afterEvents = h.svc.events.replay(0, h.svc.events.oldestCursor()).events;
    expect(beforeMessages).toHaveLength(1);
    expect(afterMessages).toHaveLength(1);
    expect(afterMessages).toEqual(beforeMessages);
    expect(beforeTurns).toBe(1);
    expect(h.svc.db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM turns WHERE thread_id = ?").get(sent.threadId)?.count).toBe(1);
    expect(h.svc.threads.turnRow(sent.turnId)).toEqual(beforeTurn);
    expect(afterEvents).toHaveLength(beforeEvents.length);
    expect(afterEvents).toEqual(beforeEvents);
    expect(h.svc.events.replay(cursor, h.svc.events.oldestCursor()).events.filter((event) => event.type === "message.appended")).toHaveLength(0);
  } finally {
    finish();
    await Promise.resolve();
    start.mockRestore();
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("durable turn fails closed when its selected provider has no credentials", async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Missing credential");
    setSetting(h.svc.db, "runtime", "durable");
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
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Live durable");
    new CredentialStore(h.svc.cfg.stateDir).add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");
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

test("unrecognized runtime values use the worker and warn once", async () => {
  const h = await startDaemon();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const botId = await makeBot(h, "Fallback");
    setSetting(h.svc.db, "runtime", "unexpected");
    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = await sendToBot(h, botId, parityScript.input);
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
      expect((await messages(h, sent.threadId)).map((message) => message.kind)).toEqual(["text", "thinking", "response"]);
    }
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("Unrecognized runtime setting; using worker");
  } finally {
    warning.mockRestore();
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
});

test("a durable turn streams and completes with an empty Agent registry", () => withFakeRuntimeProvider(script, {}, async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "No Agent");
    new CredentialStore(h.svc.cfg.stateDir).add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");
    h.svc.db.exec("CREATE TEMP TABLE saved_agents AS SELECT * FROM agents");
    h.svc.db.exec("PRAGMA foreign_keys = OFF");
    h.svc.db.exec("DELETE FROM agents");
    expect(h.svc.agents.list()).toEqual([]);
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
