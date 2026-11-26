import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { durableSuiteToolResults } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import type { MessageDto, ThreadDto, ToolCallSummaryDto } from "../../packages/protocol/src/index.ts";
import { TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } from "../../packages/domain/src/index.ts";
import {
  api,
  makeBot,
  messages,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

// Worker events cross a real subprocess; poll the public API rather than guessing a fixed completion delay.
async function waitForTool(
  h: Harness,
  threadId: string,
  status?: ToolCallSummaryDto["status"],
): Promise<MessageDto> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const tool = (await messages(h, threadId)).find((message) =>
      message.kind === "tool" && (status === undefined || message.toolCall?.status === status)
    );
    if (tool !== undefined) return tool;
    if (Date.now() > deadline) throw new Error(`Tool Call did not reach ${status ?? "any status"}`);
    await Bun.sleep(25);
  }
}

function expectInterrupted(tool: MessageDto): void {
  expect(tool.toolCall).toMatchObject({
    name: "bash",
    status: "error",
    target: "safe interrupted operation",
    errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY,
  });
  expect(tool.payload).toBeUndefined();
}

describe("integration: native Tool Call summaries", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  test("publishes only safe bash summary fields on completion and interruption", async () => {
    const botId = await makeBot(h, "Bash Summary Bot");
    const completed = await sendToBot(h, botId, "tool please");
    await waitThreadIdle(h, completed.threadId);

    const tool = await waitForTool(h, completed.threadId, "completed");
    const durationMs = tool.toolCall?.durationMs;
    expect(tool).toEqual({
      id: expect.any(String),
      threadId: completed.threadId,
      seq: expect.any(Number),
      author: { kind: "bot" },
      kind: "tool",
      createdAt: expect.any(String),
      toolCall: {
        id: expect.any(String),
        name: "bash",
        status: "completed",
        target: "echo fake",
        ...(durationMs === undefined ? {} : { durationMs }),
      },
    });
    if (durationMs !== undefined) {
      expect(Number.isSafeInteger(durationMs) && durationMs >= 0).toBeTrue();
    }
    const journalBinding = h.svc.db.query("SELECT 1 FROM pi_thread_conversations WHERE thread_id = ?").get(completed.threadId);
    if (journalBinding !== null) {
      const result = (await durableSuiteToolResults(h.svc.db, completed.threadId))
        .filter((entry) => entry.role === "toolResult")
        .find(({ toolCallId }) => toolCallId === tool.toolCall?.id);
      expect(result).toBeDefined();
      expect(durationMs).toBe(result!.durationMs);
    }

    const failed = await sendToBot(h, botId, "tool-fail");
    await waitThreadIdle(h, failed.threadId);
    const thread = await api<ThreadDto>(h, "GET", `/api/threads/${failed.threadId}`);
    expect(thread.latestTurn).toEqual(expect.objectContaining({ id: failed.turnId, status: "failed" }));
    const interrupted = await waitForTool(h, failed.threadId, "error");
    expect(interrupted.toolCall).toEqual({
      id: expect.any(String),
      name: "bash",
      status: "error",
      target: "safe interrupted operation",
      errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY,
    });
  });

  test("finalizes a started call when its Turn fails", async () => {
    const botId = await makeBot(h, "Failed Tool Bot");
    const sent = await sendToBot(h, botId, "tool-fail");
    await waitThreadIdle(h, sent.threadId);
    expectInterrupted(await waitForTool(h, sent.threadId, "error"));
  });

  test("finalizes a started call when its Turn is cancelled", async () => {
    const botId = await makeBot(h, "Cancelled Tool Bot");
    const sent = await sendToBot(h, botId, "tool-hang");
    await waitForTool(h, sent.threadId, "running");
    await h.svc.turns.abortTurn(sent.turnId, "test cancellation");
    await waitThreadIdle(h, sent.threadId);
    expectInterrupted(await waitForTool(h, sent.threadId, "error"));
  });

  test("startup recovery finalizes a call belonging to the failed Turn", async () => {
    const botId = await makeBot(h, "Recovered Tool Bot");
    const sent = await sendToBot(h, botId, "tool-hang");
    await waitForTool(h, sent.threadId, "running");

    const home = h.home;
    await h.disconnectForRestart();
    h = await startDaemon(home);

    expectInterrupted(await waitForTool(h, sent.threadId, "error"));
  });
});
