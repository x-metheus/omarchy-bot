import { describe, expect, test } from "bun:test";
import { SaveMcpBody } from "./plugins.ts";

const body = (url: string) => ({ name: "x", transport: { type: "http", url } });

describe("SaveMcpBody URL", () => {
  test("rejects the same URLs MANAGE_PLUGINS_SCHEMA rejects, as a schema error", () => {
    for (const url of ["https://example.com/a b", "https://example.com:bad/mcp", "ftp://example.com/mcp", "https://"]) {
      const result = SaveMcpBody.safeParse(body(url));
      expect(result.success).toBeFalse();
    }
  });

  test("accepts an http(s) URL with a port and a path", () => {
    expect(SaveMcpBody.safeParse(body("https://example.com:8443/mcp?q=1")).success).toBeTrue();
    expect(SaveMcpBody.safeParse(body("http://localhost:3000")).success).toBeTrue();
  });
});
