export const BROWSER_ACTION_NAMES = [
  "snapshot", "click", "type", "select", "navigate", "back", "read_text", "tabs", "wait_for", "request_takeover",
] as const;
export type BrowserActionName = (typeof BROWSER_ACTION_NAMES)[number];
export interface BrowserAction {
  name: BrowserActionName;
  args: Record<string, unknown>;
}
export function isBrowserInputAction(name: BrowserActionName): boolean {
  return name === "click" || name === "type" || name === "select" || name === "navigate" || name === "tabs";
}
