import { describe, expect, test } from "bun:test";
import { isAgentToolCallEvent, toolCallSummaryFromEvent } from "./agent-protocol.ts";

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
});
