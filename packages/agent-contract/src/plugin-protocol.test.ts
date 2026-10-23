import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { MANAGE_PLUGINS_SCHEMA } from "./plugin-protocol.ts";

const connection = (value: unknown) => Value.Check(MANAGE_PLUGINS_SCHEMA, { action: "save_mcp", connection: value });

describe("MANAGE_PLUGINS_SCHEMA connection", () => {
  test("rejects a bare URL and accepts an uppercase scheme", () => {
    expect(connection({ name: "x", transport: { type: "http", url: "https://" } })).toBeFalse();
    expect(connection({ name: "x", transport: { type: "http", url: "HTTPS://example.com/mcp" } })).toBeTrue();
  });

  test("rejects a package name that is not an exact npm name", () => {
    expect(connection({ name: "x", package: { name: "lodash@4" } })).toBeFalse();
    expect(connection({ name: "x", package: { name: "@scope/pkg" } })).toBeTrue();
  });
});
