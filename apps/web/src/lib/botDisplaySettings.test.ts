import { describe, expect, test } from "bun:test";
import { rollbackBotDisplaySetting, selectBotDisplayState } from "./botDisplaySettings.ts";

describe("Bot Display Settings presentation state", () => {
  test("keeps process records hidden by default and explains unavailable Thinking", () => {
    const state = selectBotDisplayState({
      showToolCalls: false,
      showThinking: false,
      thinkingAvailability: "unavailable",
    });

    expect(state.thinkingDisabled).toBe(true);
    expect(state.thinkingDescription).toContain("does not provide Thinking");
  });

  test("enables Thinking when the Bot reports support", () => {
    const state = selectBotDisplayState({
      showToolCalls: false,
      showThinking: false,
      thinkingAvailability: "supported",
    });

    expect(state.thinkingDisabled).toBe(false);
    expect(state.thinkingDescription).toContain("from this Bot’s model");
  });

  test("keeps retained Thinking selectable when the Bot no longer provides it", () => {
    const state = selectBotDisplayState({
      showToolCalls: true,
      showThinking: true,
      thinkingAvailability: "history",
    });

    expect(state.thinkingDisabled).toBe(false);
    expect(state.thinkingDescription).toContain("no longer provides Thinking");
    expect(state.thinkingDescription).toContain("retained Thinking remains available");
  });
});

describe("Bot Settings display persistence", () => {
  test("rolls back only the failed setting against the latest Bot snapshot", () => {
    const latest = {
      name: "Renamed in another window",
      instructions: "New instructions from another window",
      pinned: true,
      showToolCalls: true,
      showThinking: true,
      updatedAt: "2026-09-04T10:01:00.000Z",
    };

    expect(rollbackBotDisplaySetting(latest, "showToolCalls", false)).toEqual({
      ...latest,
      showToolCalls: false,
    });
  });
});
