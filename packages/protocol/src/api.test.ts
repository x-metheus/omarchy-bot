import { describe, expect, test } from "bun:test";
import { DeleteBotResultDto, MessageDto, SendMessageBody, ToolCallSummaryDto } from "./api.ts";

test("Bot deletion results accept the secrets phase and default older counts to zero", () => {
  const result = {
    status: "failed", botId: "bot-1", botName: "Bot 1",
    removed: { threads: 0, messages: 0, turns: 0, attachments: 0, avatar: false, privateFolder: false, computerArtifacts: 0, surface: false },
    failures: [],
  };
  expect(DeleteBotResultDto.parse(result).removed.secrets).toBe(0);
  expect(DeleteBotResultDto.parse({
    ...result,
    removed: { ...result.removed, secrets: 1 },
    failures: [{ stage: "secrets", resource: result.botId, message: "Unable to delete secret" }],
  }).removed.secrets).toBe(1);
});

test("send message preserves and validates the requested busy mode", () => {
  expect(SendMessageBody.parse({ text: "hello", whenBusy: "steer" }).whenBusy).toBe("steer");
  expect(SendMessageBody.parse({ text: "hello", whenBusy: "followUp" }).whenBusy).toBe("followUp");
  expect(SendMessageBody.safeParse({ text: "hello", whenBusy: "other" }).success).toBeFalse();
});

const base = {
  id: "message-response",
  threadId: "thread-1",
  seq: 2,
  author: { kind: "bot" as const },
  kind: "response" as const,
  text: "Hello",
  createdAt: "2026-09-04T00:00:00.000Z",
};

describe("Response message contract", () => {
  test("accepts streaming and completed Response lifecycle metadata", () => {
    expect(MessageDto.parse({
      ...base,
      response: {
        blockId: "response-1",
        state: "streaming",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
    }).response?.blockId).toBe("response-1");

    expect(MessageDto.parse({
      ...base,
      response: {
        blockId: "response-1",
        state: "completed",
        startedAt: "2026-09-04T00:00:00.000Z",
        completedAt: "2026-09-04T00:00:01.000Z",
      },
    }).response?.state).toBe("completed");
  });

  test("rejects invalid Response authors and lifecycle transitions", () => {
    expect(MessageDto.safeParse({
      ...base,
      author: { kind: "user" },
      response: {
        blockId: "response-1",
        state: "streaming",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
    }).success).toBeFalse();

    expect(MessageDto.safeParse({
      ...base,
      response: {
        blockId: "response-1",
        state: "completed",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
    }).success).toBeFalse();
  });
});

describe("ordered transcript author contract", () => {
  test("keeps user and system text while rejecting Bot text records", () => {
    const textBase = {
      id: "message-text",
      threadId: "thread-1",
      seq: 1,
      kind: "text",
      text: "Visible text",
      createdAt: base.createdAt,
    };
    expect(MessageDto.safeParse({ ...textBase, author: { kind: "user" } }).success).toBeTrue();
    expect(MessageDto.safeParse({ ...textBase, author: { kind: "system" } }).success).toBeTrue();
    expect(MessageDto.safeParse({ ...textBase, author: { kind: "bot" } }).success).toBeFalse();
  });

  test("keeps Native Events payload-only and Bot-authored", () => {
    const nativeEvent = {
      id: "message-event",
      threadId: "thread-1",
      seq: 4,
      author: { kind: "bot" },
      kind: "event",
      payload: { capability: "pi.progress", sensitivity: "secret", redacted: true },
      createdAt: base.createdAt,
    };
    expect(MessageDto.safeParse(nativeEvent).success).toBeTrue();
    expect(MessageDto.safeParse({ ...nativeEvent, text: "diagnostic output" }).success).toBeFalse();
    expect(MessageDto.safeParse({ ...nativeEvent, author: { kind: "system" } }).success).toBeFalse();
  });
});

describe("Thinking message contract", () => {
  const thinkingBase = {
    ...base,
    id: "message-thinking",
    kind: "thinking" as const,
    text: "Provider-authored reasoning summary.",
  };

  test("accepts streaming and completed lifecycle metadata", () => {
    expect(MessageDto.parse({
      ...thinkingBase,
      thinking: {
        blockId: "thinking-1",
        state: "streaming",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
    }).thinking?.blockId).toBe("thinking-1");
    expect(MessageDto.parse({
      ...thinkingBase,
      thinking: {
        blockId: "thinking-1",
        state: "completed",
        startedAt: "2026-09-04T00:00:00.000Z",
        completedAt: "2026-09-04T00:00:01.250Z",
      },
    }).thinking?.state).toBe("completed");
  });

  test("rejects invalid authors and lifecycle metadata on another content kind", () => {
    expect(MessageDto.safeParse({
      ...thinkingBase,
      author: { kind: "user" },
      thinking: {
        blockId: "thinking-1",
        state: "streaming",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
    }).success).toBeFalse();
    expect(MessageDto.safeParse({
      ...base,
      response: {
        blockId: "response-1",
        state: "streaming",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
      thinking: {
        blockId: "thinking-1",
        state: "streaming",
        startedAt: "2026-09-04T00:00:00.000Z",
      },
    }).success).toBeFalse();
  });
});

describe("Tool Call message contract", () => {
  const toolCall = {
    id: "tool-1",
    name: "edit",
    status: "error" as const,
    target: "src/file.ts",
    durationMs: 42,
    additions: 3,
    deletions: 1,
    errorSummary: "Interrupted before completion.",
  };

  test("accepts the complete safe summary and omits unavailable optional fields", () => {
    expect(ToolCallSummaryDto.parse(toolCall)).toEqual(toolCall);
    expect(ToolCallSummaryDto.parse({
      id: "tool-2",
      name: "read",
      status: "running",
    })).toEqual({
      id: "tool-2",
      name: "read",
      status: "running",
    });
  });

  test("rejects opaque detail, invalid errors, and Tool payloads", () => {
    expect(ToolCallSummaryDto.safeParse({
      ...toolCall,
      input: { token: "secret" },
    }).success).toBeFalse();
    expect(ToolCallSummaryDto.safeParse({
      ...toolCall,
      status: "completed",
    }).success).toBeFalse();
    expect(MessageDto.safeParse({
      id: "message-tool",
      threadId: "thread-1",
      seq: 3,
      author: { kind: "bot" },
      kind: "tool",
      toolCall,
      payload: { output: "must not cross" },
      createdAt: base.createdAt,
    }).success).toBeFalse();
  });
});
