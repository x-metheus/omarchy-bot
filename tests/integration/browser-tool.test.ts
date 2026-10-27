import { expect, test } from "bun:test";
import { AGENT_BROWSER_TOOL, BROWSER_TOOL_SCHEMA } from "../../packages/agent-contract/src/browser-tool.ts";

test("browser tool advertises structure, fresh refs and mandatory human handoff", () => {
  expect(AGENT_BROWSER_TOOL.name).toBe("browser");
  expect(BROWSER_TOOL_SCHEMA.properties.action.anyOf.map((item) => item.const)).toEqual([
    "snapshot", "click", "type", "select", "navigate", "back", "read_text", "tabs", "wait_for", "request_takeover",
  ]);
  for (const term of ["snapshot", "stale", "computer", "CAPTCHAs", "logins", "payment", "never solve or bypass"]) {
    expect(AGENT_BROWSER_TOOL.description).toContain(term);
  }
});
