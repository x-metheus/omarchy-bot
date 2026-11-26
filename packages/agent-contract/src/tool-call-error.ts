import { TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH } from "@omarchy-bot/domain";

/** Produce a one-line, bounded summary without common credential forms. */
export function redactToolErrorSummary(value: unknown): string {
  const redacted = String(value ?? "")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\b(?:paired_)?[0-9a-f]{64}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "Tool call failed.").slice(0, TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH);
}
