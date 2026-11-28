import type { ToolCallSummaryDto } from "@omarchy-bot/protocol";

export type ThinkingAnnouncementState = "streaming" | "completed";

/** Return only the Tool Call boundaries newly represented by the latest snapshot. */
export function toolCallBoundaryAnnouncements(
  previous: ReadonlyMap<string, ToolCallSummaryDto>,
  current: ReadonlyMap<string, ToolCallSummaryDto>,
): string[] {
  const announcements: string[] = [];
  for (const call of current.values()) {
    const prior = previous.get(call.id);
    if (prior === undefined) {
      announcements.push(`${call.name} started`);
    }
    if ((prior === undefined || prior.status === "running") && call.status !== "running") {
      announcements.push(`${call.name} ${call.status === "error" ? "failed" : "completed"}`);
    }
  }
  return announcements;
}

/** Return only the Thinking boundaries newly represented by the latest snapshot. */
export function thinkingBoundaryAnnouncements(
  previous: ReadonlyMap<string, ThinkingAnnouncementState>,
  current: ReadonlyMap<string, ThinkingAnnouncementState>,
): string[] {
  const announcements: string[] = [];
  for (const [blockId, state] of current) {
    const prior = previous.get(blockId);
    if (prior === undefined) {
      announcements.push("Thinking started");
    }
    if ((prior === undefined || prior === "streaming") && state === "completed") {
      announcements.push("Thinking completed");
    }
  }
  return announcements;
}
