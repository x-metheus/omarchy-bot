import { describe, expect, test } from "bun:test";
import { buildBotModelOptions, toBotModelOverride } from "./botModelOptions.ts";

describe("buildBotModelOptions", () => {
  test("keeps Service default when no provider has models", () => {
    expect(buildBotModelOptions([{ id: "empty", name: "Empty", models: [] }], null)).toEqual([
      { id: "", label: "Service default" },
    ]);
    expect(buildBotModelOptions([], "")).toEqual([{ id: "", label: "Service default" }]);
  });

  test("uses qualified IDs and stable labels and keeps the first occurrence of each model", () => {
    expect(buildBotModelOptions([
      { id: "empty", name: "Empty", models: [] },
      { id: "first", name: "First", models: [
        { id: "family/model", name: "Model" },
        { id: "family/model", name: "Duplicate" },
        { id: "basic" },
      ] },
      { id: "second", name: "Second", models: [{ id: "family/model", name: "Model" }] },
    ], "first/family/model")).toEqual([
      { id: "", label: "Service default" },
      { id: "first/family/model", label: "First — Model (family/model)" },
      { id: "first/basic", label: "First — basic" },
      { id: "second/family/model", label: "Second — Model (family/model)" },
    ]);
  });

  test("distinguishes providers that share a display name", () => {
    expect(buildBotModelOptions([
      { id: "gateway-a", name: "Gateway", models: [{ id: "basic" }] },
      { id: "gateway-b", name: "Gateway", models: [{ id: "basic" }] },
    ], null)).toEqual([
      { id: "", label: "Service default" },
      { id: "gateway-a/basic", label: "Gateway (gateway-a) — basic" },
      { id: "gateway-b/basic", label: "Gateway (gateway-b) — basic" },
    ]);
  });

  test("retains a stored model missing from the provider list alongside Service default", () => {
    expect(buildBotModelOptions([], "removed/model")).toEqual([
      { id: "", label: "Service default" },
      { id: "removed/model", label: "removed/model" },
    ]);
  });
});

describe("toBotModelOverride", () => {
  test("maps the empty Service default value to null", () => {
    expect(toBotModelOverride("")).toBeNull();
  });

  test("preserves the complete qualified model ID", () => {
    expect(toBotModelOverride("gateway/family/model")).toBe("gateway/family/model");
  });
});
