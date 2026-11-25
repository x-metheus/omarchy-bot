import { describe, expect, test } from "bun:test";
import { isAgentCapabilityInventory } from "./agent-capabilities.ts";

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
