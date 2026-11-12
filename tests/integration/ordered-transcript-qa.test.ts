import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { BotViewDto, MessageDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  makeBot,
  messages,
  sendToBot,
  sendToThread,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

async function waitForRunningTool(h: Harness, threadId: string, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const transcript = await messages(h, threadId);
    if (transcript.some((message) =>
      message.kind === "tool"
      && message.toolCall?.name === name
      && message.toolCall.status === "running"
    )) return;
    if (Date.now() > deadline) throw new Error(`${name} Tool Call did not start`);
    await Bun.sleep(25);
  }
}

function orderedProjection(message: MessageDto): unknown {
  switch (message.kind) {
    case "text":
      return { kind: message.kind, author: message.author.kind, turnId: (message.payload as { turnId?: string } | undefined)?.turnId };
    case "response":
      return { kind: message.kind, state: message.response?.state };
    case "thinking":
      return { kind: message.kind, state: message.thinking?.state };
    case "tool":
      return { kind: message.kind, name: message.toolCall?.name, status: message.toolCall?.status };
    case "event":
      return { kind: message.kind, capability: (message.payload as { capability?: string } | undefined)?.capability };
  }
}

describe("integration: ordered rich transcript QA", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  test("orders responses and Thinking around an accepted steer", async () => {
    const botId = await makeBot(h, "Ordered Steering Bot");
    const sent = await sendToBot(h, botId, "ordered-transcript");
    const deadline = Date.now() + 10_000;
    while (!(await messages(h, sent.threadId)).some((message) => message.text === "**Inspect** every ordered boundary.")) {
      if (Date.now() > deadline) throw new Error("ordered Thinking did not arrive");
      await Bun.sleep(25);
    }
    await Bun.sleep(1200);
    const steered = await sendToThread(h, sent.threadId, "Keep the real boundary");
    expect(steered.action).toBe("steered");
    expect(steered.turnId).toBe(sent.turnId);
    await waitThreadIdle(h, sent.threadId);
    const transcript = (await messages(h, sent.threadId)).filter((message) => message.kind === "text" || message.kind === "response" || message.kind === "thinking");
    expect(transcript.slice(0, 7).map(orderedProjection)).toEqual([
      { kind: "text", author: "user", turnId: undefined },
      { kind: "response", state: "completed" },
      { kind: "thinking", state: "completed" },
      { kind: "text", author: "user", turnId: sent.turnId },
      { kind: "response", state: "completed" },
      { kind: "response", state: "completed" },
      { kind: "thinking", state: "completed" },
    ]);
    expect(transcript[1]?.text).toContain("## Release notes");
    expect(transcript.slice(2, 7).map((message) => message.text)).toEqual([
      "**Inspect** every ordered boundary.", "Keep the real boundary",
      "Steering received: Keep the real boundary", "Adjacent response remains in the same visual reply.",
      "Check the final interleaving.",
    ]);
  }, 20_000);

  test("preserves mixed Agent blocks and Steering in exact occurrence order across restart", async () => {
    const botId = await makeBot(h, "Ordered Transcript Bot");
    const sent = await sendToBot(h, botId, "ordered-transcript");
    await waitForRunningTool(h, sent.threadId, "read");

    const steered = await sendToThread(h, sent.threadId, "Keep the real boundary");
    expect(steered.action).toBe("steered");
    expect(steered.turnId).toBe(sent.turnId);
    await waitThreadIdle(h, sent.threadId);

    const beforeRestart = await messages(h, sent.threadId);
    const retainedBlockIds = beforeRestart.flatMap((message) => {
      const blockId = message.response?.blockId ?? message.thinking?.blockId;
      return blockId === undefined ? [] : [blockId];
    });
    expect(beforeRestart.map((message) => message.seq)).toEqual(
      Array.from({ length: beforeRestart.length }, (_, index) => index + 1),
    );
    expect(beforeRestart.map(orderedProjection)).toEqual([
      { kind: "text", author: "user", turnId: undefined },
      { kind: "response", state: "completed" },
      { kind: "thinking", state: "completed" },
      { kind: "tool", name: "read", status: "completed" },
      { kind: "text", author: "user", turnId: sent.turnId },
      { kind: "response", state: "completed" },
      { kind: "response", state: "completed" },
      { kind: "thinking", state: "completed" },
      { kind: "tool", name: "write", status: "completed" },
      { kind: "response", state: "completed" },
      { kind: "event", capability: "fake.progress" },
      { kind: "response", state: "completed" },
    ]);
    expect(beforeRestart[0]?.text).toBe("ordered-transcript");
    expect(beforeRestart[1]?.text).toContain("## Release notes");
    expect(beforeRestart[2]?.text).toBe("**Inspect** every ordered boundary.");
    expect(beforeRestart[4]?.text).toBe("Keep the real boundary");
    expect(beforeRestart[5]?.text).toBe("Steering received: Keep the real boundary");
    expect(beforeRestart[6]?.text).toBe("Adjacent response remains in the same visual reply.");
    expect(beforeRestart[7]?.text).toBe("Check the final interleaving.");
    expect(beforeRestart[9]?.text).toBe("Final response after the second tool.");
    expect(beforeRestart[11]?.text).toBe("Response after an unrendered Native Event boundary.");
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).toMatchObject({
      previewText: "Response after an unrendered Native Event boundary.",
      unreadCount: 5,
      unreadThreadId: sent.threadId,
    });

    const home = h.home;
    await h.disconnectForRestart();
    h = await startDaemon(home);

    expect(await messages(h, sent.threadId)).toEqual(beforeRestart);

    const laterTurn = await sendToThread(h, sent.threadId, "thinking-order");
    await waitThreadIdle(h, sent.threadId);
    const afterRestart = await messages(h, sent.threadId);
    const laterBlocks = afterRestart.slice(beforeRestart.length)
      .filter((message) => message.kind === "response" || message.kind === "thinking");
    expect(laterBlocks.map((message) => ({ kind: message.kind, text: message.text }))).toEqual([
      { kind: "response", text: "Before Thinking." },
      { kind: "thinking", text: "**Inspect** the request." },
      { kind: "thinking", text: "Provider-authored summary." },
      { kind: "response", text: "After Thinking." },
    ]);
    const laterBlockIds = laterBlocks.flatMap((message) => {
      const blockId = message.response?.blockId ?? message.thinking?.blockId;
      return blockId === undefined ? [] : [blockId];
    });
    expect(laterBlockIds).toHaveLength(4);
    expect(laterBlockIds.every((blockId) => blockId.includes(laterTurn.turnId))).toBeTrue();
    expect(new Set([...retainedBlockIds, ...laterBlockIds]).size).toBe(
      retainedBlockIds.length + laterBlockIds.length,
    );
  });

  test("keeps a completed process-only Turn quiet while Bot Activity remains state-driven", async () => {
    const botId = await makeBot(h, "Quiet Process Bot");
    const sent = await sendToBot(h, botId, "process-only");
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    await waitThreadIdle(h, sent.threadId);

    const transcript = await messages(h, sent.threadId);
    expect(transcript.map((message) => message.kind)).toEqual(["text", "thinking", "tool", "event"]);
    expect(transcript.some((message) => message.kind === "response")).toBeFalse();
    expect(transcript.some((message) => message.author.kind === "system")).toBeFalse();

    const sidebar = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    expect(sidebar).toMatchObject({ status: "inactive", unreadCount: 0 });
    expect(sidebar.previewText).toBeUndefined();
    expect(sidebar.unreadThreadId).toBeUndefined();

    const completion = h.svc.events
      .replay(0, h.svc.events.oldestCursor())
      .events.find((event) =>
        event.type === "turn.status"
        && event.aggregateId === sent.turnId
        && (event.payload as { to?: string }).to === "completed"
      );
    expect(completion).toBeDefined();
  });
});
