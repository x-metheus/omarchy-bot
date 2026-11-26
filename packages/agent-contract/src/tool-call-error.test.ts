import { expect, test } from "bun:test";
import { TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH } from "@omarchy-bot/domain";
import { redactToolErrorSummary } from "./tool-call-error.ts";

test("redacts common credentials and bounds one-line errors", () => {
  const summary = redactToolErrorSummary(
    `failed\npassword=hunter2 Bearer abc123 ${"x".repeat(1_000)}`,
  );
  expect(summary).not.toContain("hunter2");
  expect(summary).not.toContain("abc123");
  expect(summary).not.toContain("\n");
  expect(summary.length).toBeLessThanOrEqual(TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH);
});
