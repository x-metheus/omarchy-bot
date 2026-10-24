import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { createManagePluginsSchema } from "./plugin-protocol.ts";

const schema = createManagePluginsSchema(["save_mcp"], []);
const connection = (value: unknown) => Value.Check(schema, { action: "save_mcp", connection: value });

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

describe("MANAGE_PLUGINS_SCHEMA MCP URL", () => {
  test("rejects a space, a bad port and a non-HTTP scheme", () => {
    for (const url of ["https://example.com/a b", "https://example.com:bad/mcp", "ftp://example.com/mcp", "https://"]) {
      expect(connection({ name: "x", transport: { type: "http", url } })).toBeFalse();
    }
  });

  test("accepts an http(s) URL with a port and a path", () => {
    expect(connection({ name: "x", transport: { type: "http", url: "https://example.com:8443/mcp?q=1" } })).toBeTrue();
    expect(connection({ name: "x", transport: { type: "http", url: "http://localhost:3000" } })).toBeTrue();
  });
});
