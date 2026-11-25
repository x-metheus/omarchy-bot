import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { BotViewDto, MessageDto, ThreadDto } from "../../packages/protocol/src/index.ts";
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

  test("a completed Thinking and read Turn leaves Bot Activity inactive without unread or preview content", async () => {
    const botId = await makeBot(h, "Thinking and Read Bot");
    const sent = await sendToBot(h, botId, "process-only");
    const active = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    await waitThreadIdle(h, sent.threadId);
    const inactive = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    const thread = await api<ThreadDto>(h, "GET", `/api/threads/${sent.threadId}`);

    expect([active.status, inactive.status, thread.latestTurn?.status]).toEqual(["active", "inactive", "completed"]);
    const { unreadCount, previewText, unreadThreadId } = inactive;
    expect({ unreadCount, previewText, unreadThreadId }).toEqual({ unreadCount: 0, previewText: undefined, unreadThreadId: undefined });

    const transcript = await messages(h, sent.threadId);
    // Native events exist only on the worker path.
    const visible = transcript.filter(({ kind }) => kind !== "event");
    expect(visible.map(({ kind }) => kind)).toEqual(["text", "thinking", "tool"]);
    expect(transcript.map(({ author }) => author.kind)).not.toContain("system");
    expect(visible[2]?.toolCall).toEqual(expect.objectContaining({ name: "read", status: "completed" }));
  });
});
