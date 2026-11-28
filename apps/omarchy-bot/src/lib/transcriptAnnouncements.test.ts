import { describe, expect, test } from "bun:test";
import type { ToolCallSummaryDto } from "@omarchy-bot/protocol";
import {
  thinkingBoundaryAnnouncements,
  toolCallBoundaryAnnouncements,
  type ThinkingAnnouncementState,
} from "./transcriptAnnouncements.ts";

function toolSnapshot(
  status: ToolCallSummaryDto["status"],
  target?: string,
): Map<string, ToolCallSummaryDto> {
  const snapshot = new Map<string, ToolCallSummaryDto>();
  snapshot.set("tool-1", {
    id: "tool-1",
    name: "read",
    status,
    ...(target === undefined ? {} : { target }),
  });
  return snapshot;
}

function thinkingSnapshot(state: ThinkingAnnouncementState): Map<string, ThinkingAnnouncementState> {
  const snapshot = new Map<string, ThinkingAnnouncementState>();
  snapshot.set("thinking-1", state);
  return snapshot;
}

describe("transcript boundary announcements", () => {
  test("announces both Tool Call boundaries when the first observed snapshot is terminal", () => {
    expect(toolCallBoundaryAnnouncements(new Map(), toolSnapshot("completed"))).toEqual([
      "read started",
      "read completed",
    ]);
    expect(toolCallBoundaryAnnouncements(new Map(), toolSnapshot("error"))).toEqual([
      "read started",
      "read failed",
    ]);
  });

  test("announces each observed Tool Call transition once without update announcements", () => {
    const running = toolSnapshot("running");
    const updated = toolSnapshot("running", "src/input.ts");
    const completed = toolSnapshot("completed");

    expect(toolCallBoundaryAnnouncements(new Map(), running)).toEqual(["read started"]);
    expect(toolCallBoundaryAnnouncements(running, updated)).toEqual([]);
    expect(toolCallBoundaryAnnouncements(updated, completed)).toEqual(["read completed"]);
    expect(toolCallBoundaryAnnouncements(completed, completed)).toEqual([]);
  });

  test("announces both Thinking boundaries when the first observed snapshot is terminal", () => {
    const completed = thinkingSnapshot("completed");

    expect(thinkingBoundaryAnnouncements(new Map(), completed)).toEqual([
      "Thinking started",
      "Thinking completed",
    ]);
  });

  test("announces each observed Thinking transition once without content announcements", () => {
    const streaming = thinkingSnapshot("streaming");
    const completed = thinkingSnapshot("completed");

    expect(thinkingBoundaryAnnouncements(new Map(), streaming)).toEqual(["Thinking started"]);
    expect(thinkingBoundaryAnnouncements(streaming, streaming)).toEqual([]);
    expect(thinkingBoundaryAnnouncements(streaming, completed)).toEqual(["Thinking completed"]);
    expect(thinkingBoundaryAnnouncements(completed, completed)).toEqual([]);
  });
});
