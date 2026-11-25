import { describe, expect, test } from "bun:test";
import { parseModelIds, providerProtocolLabels, providerSummaryLabel } from "./providerPresentation.ts";

test("labels each supported provider protocol", () => {
  expect(providerProtocolLabels).toEqual({
    "openai-compatible": "OpenAI-compatible",
    "anthropic-messages": "Anthropic Messages",
    "built-in": "Built-in pi-ai",
  });
});

describe("parseModelIds", () => {
  test("splits on commas and newlines, trims IDs, and keeps the first occurrence", () => {
    expect(parseModelIds(" gateway/model-a, model-b\r\n model-c, model-b\nmodel-a ")).toEqual([
      "gateway/model-a", "model-b", "model-c", "model-a",
    ]);
  });

  test("drops empty entries and accepts a blank optional list", () => {
    expect(parseModelIds(", ,\n  model-a,\r\n")).toEqual(["model-a"]);
    expect(parseModelIds(" \n, ")).toEqual([]);
  });
});

describe("providerSummaryLabel", () => {
  test("shows the protocol, model count, and saved key status", () => {
    expect(providerSummaryLabel({ protocol: "openai-compatible", models: [{ id: "example-model" }], hasKey: true }))
      .toBe("OpenAI-compatible · 1 model · Key saved");
  });

  test("shows zero models and a missing key explicitly", () => {
    expect(providerSummaryLabel({ protocol: "anthropic-messages", models: [], hasKey: false }))
      .toBe("Anthropic Messages · 0 models · No key saved");
  });
});
