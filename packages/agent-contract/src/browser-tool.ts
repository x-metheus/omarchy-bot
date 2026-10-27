import { Type } from "typebox";
import { BROWSER_ACTION_NAMES, type BrowserActionName } from "@omarchy-bot/domain";
import type { AgentComputerToolOutput } from "./agent-protocol.ts";

export { BROWSER_ACTION_NAMES, type BrowserActionName };
export const BROWSER_TOOL_SCHEMA = Type.Object({
  action: Type.Union(BROWSER_ACTION_NAMES.map((action) => Type.Literal(action))),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
export interface AgentBrowserToolOutput {
  desktopSession: AgentComputerToolOutput["desktopSession"];
  text?: string;
  truncated?: boolean;
}
const description = "Operate this Bot Screen's visible pack browser, structure first. Use snapshot before acting; stale Element Refs require a new snapshot. Actions: snapshot {}; click {ref}; type {ref,text}; select {ref,value}; navigate {url}; back {}; read_text {ref?}; tabs {operation:list|open|switch|close,url?,tabId?}; wait_for {text?|ref?|navigation?,timeoutMs?} (exactly one condition, at most 30000ms); request_takeover {reason}. Use computer screenshots and raw input as fallback. For CAPTCHAs, anti-bot challenges, logins and payment call request_takeover with a short reason and wait for the user; never solve or bypass a challenge. Every result belongs only to the bound Screen; never operate another Screen or the Host Session.";
export const AGENT_BROWSER_TOOL = Object.freeze({
  name: "browser" as const,
  description,
  systemPrompt: Object.freeze({
    summary: "Use the visible browser's accessibility tree and snapshot-scoped refs on this Bot Screen.",
    guidelines: Object.freeze([description]),
  }),
});
