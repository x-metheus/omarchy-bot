import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { BotViewDto, MessageDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  makeBot,
  messages,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

async function waitForThinking(h: Harness, threadId: string): Promise<MessageDto> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const thinking = (await messages(h, threadId)).find((message) => message.kind === "thinking");
    if (thinking !== undefined) return thinking;
    if (Date.now() > deadline) throw new Error("Thinking did not start");
    await Bun.sleep(25);
  }
}

describe("integration: ordered Thinking blocks", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  test("persists one stable Thinking Block incrementally with its wall-clock boundaries", async () => {
    const botId = await makeBot(h, "Streaming Thinking Bot");
    const sent = await sendToBot(h, botId, "thinking-stream");

    const streaming = await waitForThinking(h, sent.threadId);
    expect(streaming).toMatchObject({
      kind: "thinking",
      author: { kind: "bot" },
      thinking: { state: "streaming" },
    });
    const blockId = streaming.thinking?.blockId;
    expect(blockId).toBeString();

    await waitThreadIdle(h, sent.threadId);
    const completed = (await messages(h, sent.threadId)).find((message) => message.kind === "thinking");
    expect(completed).toMatchObject({
      text: "**Inspect inputs.**",
      thinking: { blockId, state: "completed" },
    });
    const startedAt = Date.parse(completed!.thinking!.startedAt);
    const completedAt = Date.parse(completed!.thinking!.completedAt!);
    expect(completedAt - startedAt).toBeGreaterThanOrEqual(1_300);
  });

  test("keeps multiple Thinking Blocks in exact order around Responses", async () => {
    const botId = await makeBot(h, "Ordered Thinking Bot");
    const sent = await sendToBot(h, botId, "thinking-order");
    await waitThreadIdle(h, sent.threadId);

    const records = (await messages(h, sent.threadId)).filter((message) => message.author.kind === "bot" && message.kind !== "tool");
    expect(records.map((message) => message.kind)).toEqual([
      "response",
      "thinking",
      "thinking",
      "response",
    ]);
    expect(records.map((message) => message.seq)).toEqual([...records.map((message) => message.seq)].sort((a, b) => a - b));
    const thinking = records.filter((message) => message.kind === "thinking");
    expect(thinking.map((message) => message.text)).toEqual([
      "**Inspect** the request.",
      "Provider-authored summary.",
    ]);
    expect(thinking[0]!.thinking!.blockId).not.toBe(thinking[1]!.thinking!.blockId);
  });

  test("keeps the Tool Call between the Thinking Blocks", async () => {
    const botId = await makeBot(h, "Thinking Tool Boundary Bot");
    const sent = await sendToBot(h, botId, "thinking-order");
    await waitThreadIdle(h, sent.threadId);
    const records = (await messages(h, sent.threadId)).filter((message) => message.author.kind === "bot");
    expect(records.map((message) => message.kind)).toEqual(["response", "thinking", "tool", "thinking", "response"]);
  });

  test("removes incomplete Thinking on cancellation, failure, and Agent worker loss", async () => {
    const cancelledBot = await makeBot(h, "Cancelled Thinking Bot");
    const cancelled = await sendToBot(h, cancelledBot, "thinking-hang");
    await waitForThinking(h, cancelled.threadId);
    await h.svc.turns.abortTurn(cancelled.turnId, "test cancellation");
    await waitThreadIdle(h, cancelled.threadId);
    expect((await messages(h, cancelled.threadId)).some((message) => message.kind === "thinking")).toBeFalse();

    const failedBot = await makeBot(h, "Failed Thinking Bot");
    const failed = await sendToBot(h, failedBot, "thinking-fail");
    await waitThreadIdle(h, failed.threadId);
    expect((await messages(h, failed.threadId)).some((message) => message.kind === "thinking")).toBeFalse();

    const lostBot = await makeBot(h, "Lost Worker Thinking Bot");
    const lost = await sendToBot(h, lostBot, "thinking-crash");
    await waitThreadIdle(h, lost.threadId);
    expect((await messages(h, lost.threadId)).some((message) => message.kind === "thinking")).toBeFalse();
  });

  test("startup recovery removes incomplete Thinking from the failed Turn", async () => {
    const botId = await makeBot(h, "Recovered Thinking Bot");
    const sent = await sendToBot(h, botId, "thinking-hang");
    await waitForThinking(h, sent.threadId);

    const home = h.home;
    await h.disconnectForRestart();
    h = await startDaemon(home);

    expect((await messages(h, sent.threadId)).some((message) => message.kind === "thinking")).toBeFalse();
    expect((await api<{ latestTurn?: { status: string; reason?: string } }>(h, "GET", `/api/threads/${sent.threadId}`)).latestTurn).toMatchObject({
      status: "failed",
      reason: "daemon restart",
    });
  });

  test("keeps Thinking available while Pi is offline and projects only emitted records", async () => {
    h.svc.agents.markOffline("pi", "worker unavailable in test");
    expect(h.svc.agents.isReady("pi")).toBeFalse();
    const botId = await makeBot(h, "Thinking Settings Bot");
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).toMatchObject({
      thinkingAvailability: "supported",
    });

    const sent = await sendToBot(h, botId, "say: visible response only");
    await waitThreadIdle(h, sent.threadId);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "thinking")).toBeFalse();
  });

  test("keeps Thinking available and retains history after restart", async () => {
    const botId = await makeBot(h, "Historical Thinking Bot");
    const sent = await sendToBot(h, botId, "thinking-order");
    await waitThreadIdle(h, sent.threadId);
    const retainedIds = (await messages(h, sent.threadId))
      .filter((message) => message.kind === "thinking")
      .map((message) => message.thinking!.blockId);
    expect(retainedIds).toHaveLength(2);

    const home = h.home;
    await h.disconnectForRestart();
    h = await startDaemon(home);
    expect(h.svc.agents.capabilityInventory("pi")).toBeUndefined();

    expect(await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).toMatchObject({
      thinkingAvailability: "supported",
    });
    expect((await messages(h, sent.threadId))
      .filter((message) => message.kind === "thinking")
      .map((message) => message.thinking!.blockId)).toEqual(retainedIds);
  });
});
