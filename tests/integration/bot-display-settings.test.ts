import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BotDto, BotViewDto, EventEnvelope } from "../../packages/protocol/src/index.ts";
import {
  api,
  apiStatus,
  makeBot,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

function nextEvent(
  h: Harness,
  predicate: (event: EventEnvelope) => boolean,
): { ready: Promise<void>; event: Promise<EventEnvelope>; close: () => void } {
  const socket = new WebSocket(`${h.baseUrl.replace(/^http/, "ws")}/api/events?access_token=${encodeURIComponent(h.token)}`);
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const event = new Promise<EventEnvelope>((resolve, reject) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello" })));
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as { type?: string; envelope?: EventEnvelope };
      if (frame.type === "hello") {
        resolveReady?.();
        return;
      }
      if (frame.type === "event" && frame.envelope !== undefined && predicate(frame.envelope)) {
        resolve(frame.envelope);
      }
    });
    socket.addEventListener("error", () => {
      const error = new Error("daemon event stream failed");
      rejectReady?.(error);
      reject(error);
    });
  });
  return { ready, event, close: () => socket.close() };
}

describe("Bot Display Settings API", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
  });

  test("defaults both presentation-only preferences off independently for every Bot", async () => {
    const firstId = await makeBot(h, "Quiet Bot");
    const secondId = await makeBot(h, "Another Quiet Bot");

    const first = await api<BotViewDto>(h, "GET", `/api/bots/${firstId}`);
    const second = await api<BotViewDto>(h, "GET", `/api/bots/${secondId}`);

    expect(first).toMatchObject({ showToolCalls: false, showThinking: false, thinkingAvailability: "supported" });
    expect(second).toMatchObject({ showToolCalls: false, showThinking: false, thinkingAvailability: "supported" });
  });

  test("updates one Bot across all its Threads, emits the normal event, and survives restart", async () => {
    const botId = await makeBot(h, "Detailed Bot");
    const otherBotId = await makeBot(h, "Quiet Peer");
    const firstThread = await sendToBot(h, botId, "say: first thread");
    await waitThreadIdle(h, firstThread.threadId);
    const secondThread = await sendToBot(h, botId, "say: second thread");
    await waitThreadIdle(h, secondThread.threadId);
    const retainedBefore = await Promise.all([
      api<unknown[]>(h, "GET", `/api/threads/${firstThread.threadId}/messages`),
      api<unknown[]>(h, "GET", `/api/threads/${secondThread.threadId}/messages`),
    ]);

    const subscription = nextEvent(
      h,
      (candidate) => candidate.aggregateType === "bot" && candidate.aggregateId === botId && candidate.type === "bot.updated",
    );
    await subscription.ready;
    const toolCallsUpdated = await api<BotDto>(h, "PATCH", `/api/bots/${botId}`, {
      showToolCalls: true,
    });
    const event = await subscription.event;
    subscription.close();
    const updated = await api<BotDto>(h, "PATCH", `/api/bots/${botId}`, {
      showThinking: true,
    });

    expect(toolCallsUpdated).toMatchObject({ showToolCalls: true, showThinking: false });
    expect(event.payload).toMatchObject({ showToolCalls: true, showThinking: false });
    expect(updated).toMatchObject({ showToolCalls: true, showThinking: true });
    expect((await api<Array<{ id: string }>>(h, "GET", `/api/bots/${botId}/threads`)).map((thread) => thread.id)).toEqual([
      secondThread.threadId,
      firstThread.threadId,
    ]);
    expect(await Promise.all([
      api<unknown[]>(h, "GET", `/api/threads/${firstThread.threadId}/messages`),
      api<unknown[]>(h, "GET", `/api/threads/${secondThread.threadId}/messages`),
    ])).toEqual(retainedBefore);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${otherBotId}`)).toMatchObject({
      showToolCalls: false,
      showThinking: false,
    });

    const home = h.home;
    await h.disconnectForRestart();
    h = await startDaemon(home);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).toMatchObject({
      showToolCalls: true,
      showThinking: true,
    });
  });

  test("rejects invalid values without changing persisted preferences", async () => {
    const botId = await makeBot(h, "Validated Bot");
    const invalid = await apiStatus(h, "PATCH", `/api/bots/${botId}`, { showToolCalls: "yes" });

    expect(invalid.status).toBe(400);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).toMatchObject({
      showToolCalls: false,
      showThinking: false,
    });
  });
});
