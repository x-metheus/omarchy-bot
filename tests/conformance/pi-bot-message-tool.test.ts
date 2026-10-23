import { describe, expect, test } from "bun:test";
import type { AgentBotMessageToolContext } from "../../packages/agent-contract/src/index.ts";
import { PEER_MAIL_TEXT_MAX_LENGTH } from "../../packages/domain/src/index.ts";
import { createBotMessageTool } from "../../workers/pi/src/bot-message-tool.ts";

const binding = {
  botId: "bot_0123456789abcdef0123456789abcdef",
  turnId: "turn_0123456789abcdef0123456789abcdef",
  workerSessionId: "worker-session-1",
};

describe("Pi SDK Omarchy Bot-message tool", () => {
  test("exposes only target identity and bounded text while binding the native Tool Call to the active Turn", async () => {
    const calls: Array<{
      context: AgentBotMessageToolContext;
      targetBotId: string;
      text: string;
    }> = [];
    const tool = createBotMessageTool(
      () => binding,
      {
        request: async (context, targetBotId, text) => {
          calls.push({ context, targetBotId, text });
          return { deliveryId: "delivery_0123456789abcdef0123456789abcdef", queued: true };
        },
      },
    );

    const result = await tool.execute(
      "sdk-mail-call-7",
      {
        targetBotId: "bot_fedcba9876543210fedcba9876543210",
        text: "Review the release checklist.",
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(tool.name).toBe("send_bot_message");
    expect(tool.executionMode).toBe("sequential");
    expect(Object.keys(tool.parameters.properties)).toEqual(["targetBotId", "text"]);
    expect(tool.parameters.properties.text.maxLength).toBe(PEER_MAIL_TEXT_MAX_LENGTH);
    expect(calls).toEqual([{
      context: { ...binding, toolCallId: "sdk-mail-call-7" },
      targetBotId: "bot_fedcba9876543210fedcba9876543210",
      text: "Review the release checklist.",
    }]);
    expect(result).toEqual({
      content: [{
        type: "text",
        text: "Bot message delivery_0123456789abcdef0123456789abcdef queued. Conclude your response without waiting for the target Bot.",
      }],
      details: { deliveryId: "delivery_0123456789abcdef0123456789abcdef", queued: true },
    });
  });

  test("fails before bridge dispatch without an active binding or after cancellation", async () => {
    let active = false;
    let dispatches = 0;
    const tool = createBotMessageTool(
      () => active ? binding : undefined,
      {
        request: async () => {
          dispatches += 1;
          return { deliveryId: "delivery_0123456789abcdef0123456789abcdef", queued: true };
        },
      },
    );

    await expect(tool.execute(
      "unbound-mail",
      { targetBotId: "bot_fedcba9876543210fedcba9876543210", text: "Review this." },
      undefined,
      undefined,
      undefined as never,
    )).rejects.toThrow("no active Omarchy turn binding");

    active = true;
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute(
      "cancelled-mail",
      { targetBotId: "bot_fedcba9876543210fedcba9876543210", text: "Review this." },
      controller.signal,
      undefined,
      undefined as never,
    )).rejects.toThrow();
    expect(dispatches).toBe(0);
  });
});
