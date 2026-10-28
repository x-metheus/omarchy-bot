import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BotActivityEventPayload, BotActivityStatusSchema, type BotDto, type BotViewDto, type ThreadDto } from "../../packages/protocol/src/index.ts";
import { api, apiStatus, makeBot, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

describe("Sidebar attention", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
  });

  test("keeps the last useful preview within 120 characters and orders active Bots by activity", async () => {
    const olderBotId = await makeBot(h, "Older activity");
    const newerBotId = await makeBot(h, "Newer activity");
    const longReply = "A".repeat(140);

    const older = await sendToBot(h, olderBotId, "say: older reply");
    await waitThreadIdle(h, older.threadId);
    const newer = await sendToBot(h, newerBotId, `say: ${longReply}`);
    await waitThreadIdle(h, newer.threadId);

    h.svc.db.query("UPDATE bot_state SET last_activity_at = ? WHERE bot_id = ?").run("2026-01-01T00:00:00.000Z", olderBotId);
    h.svc.db.query("UPDATE bot_state SET last_activity_at = ? WHERE bot_id = ?").run("2026-01-02T00:00:00.000Z", newerBotId);

    const active = await api<BotViewDto[]>(h, "GET", "/api/bots");
    expect(active.map((bot) => bot.id)).toEqual([newerBotId, olderBotId]);
    expect(active[0]?.previewText).toBe("A".repeat(120));
    expect(active[0]?.previewText?.length).toBe(120);
  });

  test("keeps the latest Agent output while a user follow-up is in flight", async () => {
    const botId = await makeBot(h, "Output preview");
    h.svc.bots.recordResponse(botId, "thread-preview", "Agent result remains visible");
    h.svc.bots.recordUserMessage(botId, "thread-preview");

    const bot = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    expect(bot.previewText).toBe("Agent result remains visible");
  });

  test("persists pin and unpin without mutating Thread recency", async () => {
    const botId = await makeBot(h, "Pin target");
    const sent = await sendToBot(h, botId, "say: preserve thread recency");
    await waitThreadIdle(h, sent.threadId);
    const before = await api<ThreadDto>(h, "GET", `/api/threads/${sent.threadId}`);

    const pinned = await api<BotDto>(h, "POST", `/api/bots/${botId}/pin`, { pinned: true });
    const afterPin = await api<ThreadDto>(h, "GET", `/api/threads/${sent.threadId}`);
    const unpinned = await api<BotDto>(h, "POST", `/api/bots/${botId}/pin`, { pinned: false });
    const afterUnpin = await api<ThreadDto>(h, "GET", `/api/threads/${sent.threadId}`);

    expect(pinned.pinned).toBe(true);
    expect(unpinned.pinned).toBe(false);
    expect(afterPin.updatedAt).toBe(before.updatedAt);
    expect(afterUnpin.updatedAt).toBe(before.updatedAt);
  });

  test("puts pinned Bots above recent Bots while preserving activity order within each group", async () => {
    const oldestPinnedId = await makeBot(h, "Old pinned");
    const newestUnpinnedId = await makeBot(h, "New unpinned");
    const middlePinnedId = await makeBot(h, "Middle pinned");
    h.svc.bots.recordUserMessage(oldestPinnedId, "thread-old");
    h.svc.bots.recordUserMessage(newestUnpinnedId, "thread-new");
    h.svc.bots.recordUserMessage(middlePinnedId, "thread-middle");
    h.svc.db.query("UPDATE bot_state SET last_activity_at = ? WHERE bot_id = ?").run("2026-01-01T00:00:00.000Z", oldestPinnedId);
    h.svc.db.query("UPDATE bot_state SET last_activity_at = ? WHERE bot_id = ?").run("2026-01-03T00:00:00.000Z", newestUnpinnedId);
    h.svc.db.query("UPDATE bot_state SET last_activity_at = ? WHERE bot_id = ?").run("2026-01-02T00:00:00.000Z", middlePinnedId);
    await api<BotDto>(h, "POST", `/api/bots/${oldestPinnedId}/pin`, { pinned: true });
    await api<BotDto>(h, "POST", `/api/bots/${middlePinnedId}/pin`, { pinned: true });

    const active = await api<BotViewDto[]>(h, "GET", "/api/bots");
    expect(active.map((bot) => bot.id)).toEqual([middlePinnedId, oldestPinnedId, newestUnpinnedId]);
  });

  test("increments unread only for the Bot producing background output and clears only its matching Thread", async () => {
    const firstBotId = await makeBot(h, "First background Bot");
    const secondBotId = await makeBot(h, "Second background Bot");
    const first = await sendToBot(h, firstBotId, "say: first finished");
    const second = await sendToBot(h, secondBotId, "say: second finished");
    await Promise.all([waitThreadIdle(h, first.threadId), waitThreadIdle(h, second.threadId)]);

    const beforeFirst = await api<BotViewDto>(h, "GET", `/api/bots/${firstBotId}`);
    const beforeSecond = await api<BotViewDto>(h, "GET", `/api/bots/${secondBotId}`);
    expect(beforeFirst.unreadCount).toBe(1);
    expect(beforeFirst.unreadThreadId).toBe(first.threadId);
    expect(beforeSecond.unreadCount).toBe(1);
    expect(beforeSecond.unreadThreadId).toBe(second.threadId);

    const wrongThread = await api<BotViewDto>(h, "POST", `/api/bots/${firstBotId}/read`, { threadId: second.threadId });
    expect(wrongThread.unreadCount).toBe(1);

    const read = await api<BotViewDto>(h, "POST", `/api/bots/${firstBotId}/read`, { threadId: first.threadId });
    const untouched = await api<BotViewDto>(h, "GET", `/api/bots/${secondBotId}`);
    expect(read.unreadCount).toBe(0);
    expect(read.unreadThreadId).toBeUndefined();
    expect(untouched.unreadCount).toBe(1);
  });


  test("does not create preview or unread content from Thinking, Tool Calls, or residual Native Events", async () => {
    const botId = await makeBot(h, "Process-only Bot");
    const sent = await sendToBot(h, botId, "process-only");
    await waitThreadIdle(h, sent.threadId);

    const bot = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    expect(bot.previewText).toBeUndefined();
    expect(bot.unreadCount).toBe(0);
    expect(bot.unreadThreadId).toBeUndefined();
  });
});

describe("binary Bot Activity", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
  });

  test("publishes only active and inactive through every Turn transition", async () => {
    const botId = await makeBot(h, "Lifecycle Bot");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");
    expect(BotActivityStatusSchema.safeParse("active").success).toBeTrue();
    expect(BotActivityStatusSchema.safeParse("inactive").success).toBeTrue();
    for (const removed of ["idle", "working", "waiting", "needs_you", "error", "unavailable"]) {
      expect(BotActivityStatusSchema.safeParse(removed).success).toBeFalse();
    }

    const cancelled = await sendToBot(h, botId, "hang");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");

    await h.svc.turns.abortTurn(cancelled.turnId, "integration cancellation");
    await h.svc.turns.waitForTerminal(cancelled.turnId);
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");

    const completed = await sendToThread(h, cancelled.threadId, "say: completed");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    await waitThreadIdle(h, completed.threadId);
    const completedThread = await api<ThreadDto>(h, "GET", `/api/threads/${completed.threadId}`);
    expect(completedThread.latestTurn?.status).toBe("completed");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");

    const failed = await sendToThread(h, cancelled.threadId, "fail");
    await waitThreadIdle(h, failed.threadId);
    const failedThread = await api<ThreadDto>(h, "GET", `/api/threads/${failed.threadId}`);
    expect(failedThread.latestTurn).toMatchObject({ status: "failed", reason: "fake failure" });
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");

    const messages = await api<Array<{ author: { kind: string }; text?: string }>>(
      h,
      "GET",
      `/api/threads/${failed.threadId}/messages`,
    );
    expect(messages.some((message) => message.author.kind === "system" && message.text?.includes("fake failure"))).toBeFalse();

    const activityEvents = h.svc.events
      .replay(0, h.svc.events.oldestCursor())
      .events
      .filter((event) => event.aggregateId === botId && event.type === "bot.activity");
    expect(activityEvents.length).toBeGreaterThan(0);
    expect(activityEvents.every((event) => BotActivityEventPayload.safeParse(event.payload).success)).toBeTrue();
    const failedActivity = activityEvents.map(event => BotActivityEventPayload.parse(event.payload))
      .filter(event => event.turnId === failed.turnId).map(event => event.status);
    expect(failedActivity).toEqual(["active", "inactive"]);
  });

  test("stays active until concurrent Threads have all become terminal", async () => {
    const botId = await makeBot(h, "Concurrent Bot");
    const first = await sendToBot(h, botId, "hang");
    const secondThread = h.svc.threads.createThread(botId, { title: "Parallel work" });
    const second = await sendToThread(h, secondThread.id, "hang");

    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    await h.svc.turns.abortTurn(first.turnId, "first done");
    await h.svc.turns.waitForTerminal(first.turnId);
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");

    await h.svc.turns.abortTurn(second.turnId, "second done");
    await h.svc.turns.waitForTerminal(second.turnId);
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");
  });

  test("keeps Agent Readiness separate while rejecting creation and sends on a non-ready Agent", async () => {
    const botId = await makeBot(h, "Readiness Bot");
    h.svc.agents.markOffline("pi", "credentials expired");

    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");
    expect((await apiStatus(h, "POST", "/api/bots", {
      name: "Rejected Bot",
      agentId: "pi",
    })).status).toBe(400);
    expect((await apiStatus(h, "POST", `/api/bots/${botId}/messages`, { text: "must not start" })).status).toBe(409);

    await h.svc.agents.recheck("pi");
    const active = await sendToBot(h, botId, "hang");
    h.svc.agents.markOffline("pi", "runtime disconnected");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");

    await h.svc.agents.recheck("pi");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    await h.svc.turns.abortTurn(active.turnId, "cleanup");
    await h.svc.turns.waitForTerminal(active.turnId);
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("inactive");
  });
});
