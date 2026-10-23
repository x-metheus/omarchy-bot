import { describe, expect, test } from "bun:test";
import { TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH } from "@omarchy-bot/domain";
import {
  isAgentCapabilityInventory,
  isAgentToolCallEvent,
  redactToolErrorSummary,
  toolCallSummaryFromEvent,
} from "./agent-protocol.ts";

describe("Agent capability inventory", () => {
  const inventory = {
    version: 4,
    steering: true,
    abort: true,
    botMail: true,
    plugins: true,
    nativeThreadActions: ["resume", "history", "close"],
    thinking: { supported: true, streaming: true },
    attachments: { text: true, image: false },
    nativeEventFamilies: ["pi.progress"],
  };

  test("rejects incompatible or incomplete capability inventories", () => {
    expect(isAgentCapabilityInventory(inventory)).toBeTrue();
    expect(isAgentCapabilityInventory({ ...inventory, version: 3 })).toBeFalse();
    const { thinking: _thinking, ...withoutThinking } = inventory;
    expect(isAgentCapabilityInventory(withoutThinking)).toBeFalse();
    const { botMail: _botMail, ...withoutBotMail } = inventory;
    expect(isAgentCapabilityInventory(withoutBotMail)).toBeFalse();
    const { plugins: _plugins, ...withoutPlugins } = inventory;
    expect(isAgentCapabilityInventory(withoutPlugins)).toBeFalse();
    expect(isAgentCapabilityInventory({
      ...inventory,
      thinking: { supported: false, streaming: true },
    })).toBeFalse();
    expect(isAgentCapabilityInventory({
      ...inventory,
      experimental: true,
    })).toBeFalse();
    expect(isAgentCapabilityInventory({
      ...inventory,
      thinking: { ...inventory.thinking, source: "inferred" },
    })).toBeFalse();
  });
});

describe("Agent Tool Call events", () => {
  test("accepts only lifecycle-valid safe summary fields", () => {
    const event = {
      type: "tool.completed" as const,
      sessionId: "session-1",
      id: "tool-1",
      name: "edit",
      status: "completed" as const,
      target: "src/file.ts",
      durationMs: 15,
      additions: 2,
      deletions: 1,
    };
    expect(isAgentToolCallEvent(event)).toBeTrue();
    expect(toolCallSummaryFromEvent(event)).toEqual({
      id: "tool-1",
      name: "edit",
      status: "completed",
      target: "src/file.ts",
      durationMs: 15,
      additions: 2,
      deletions: 1,
    });
    expect(isAgentToolCallEvent({
      ...event,
      input: { token: "must-not-cross" },
    })).toBeFalse();
    expect(isAgentToolCallEvent({
      ...event,
      type: "tool.started",
      status: "completed",
    })).toBeFalse();
  });

  test("redacts common credentials and bounds one-line errors", () => {
    const summary = redactToolErrorSummary(
      `failed\npassword=hunter2 Bearer abc123 ${"x".repeat(1_000)}`,
    );
    expect(summary).not.toContain("hunter2");
    expect(summary).not.toContain("abc123");
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH);
  });
});
