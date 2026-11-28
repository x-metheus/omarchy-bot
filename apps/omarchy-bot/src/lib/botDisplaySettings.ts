import type { BotViewDto, ThinkingAvailabilityDto } from "@omarchy-bot/protocol";

export interface BotDisplayState {
  showToolCalls: boolean;
  showThinking: boolean;
  thinkingAvailability: ThinkingAvailabilityDto;
  thinkingDisabled: boolean;
  thinkingDescription: string;
}

export type BotDisplaySetting = "showToolCalls" | "showThinking";

/** Preserve a newer Bot snapshot while restoring only the display write that failed. */
export function rollbackBotDisplaySetting<T extends Record<BotDisplaySetting, boolean>>(
  latest: T,
  setting: BotDisplaySetting,
  previousValue: boolean,
): T {
  return { ...latest, [setting]: previousValue };
}

/** Presentation state is Bot-scoped, so the same result applies to every current or historical Thread. */
export function selectBotDisplayState(
  bot: Pick<BotViewDto, "showToolCalls" | "showThinking" | "thinkingAvailability">,
): BotDisplayState {
  const { thinkingAvailability } = bot;
  const thinkingDescription = thinkingAvailability === "supported"
    ? "Show Thinking from this Bot’s model in every conversation."
    : thinkingAvailability === "history"
      ? "This Bot no longer provides Thinking. Previously retained Thinking remains available."
      : "This Bot does not provide Thinking and there is no retained Thinking history.";

  return {
    showToolCalls: bot.showToolCalls,
    showThinking: bot.showThinking,
    thinkingAvailability,
    thinkingDisabled: thinkingAvailability === "unavailable",
    thinkingDescription,
  };
}
