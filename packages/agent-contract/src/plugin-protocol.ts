import type { NativeMcpRuntimeStatus } from "./native-mcp-config.ts";
export interface AgentPluginToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Immutable configuration selected before a turn opens its native session. No credentials. */
export interface AgentPluginSnapshot {
  revision: number;
  tools: AgentPluginToolDefinition[];
  diagnostics: string[];
}

export interface AgentPluginTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
}
export interface AgentPluginToolRequest {
  type: "plugin.request";
  requestId: string;
  context: AgentPluginTurnContext & { toolCallId: string };
  name: string;
  arguments: Record<string, unknown>;
}
export interface AgentPluginToolOutput {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
export type AgentPluginToolResult =
  | { type: "plugin.result"; requestId: string; ok: true; payload: AgentPluginToolOutput }
  | { type: "plugin.result"; requestId: string; ok: false; error: string };
export interface NativeMcpStatus {
  name: string;
  configurationRevision: string;
  status: NativeMcpRuntimeStatus;
  toolCount: number;
  disabled: boolean;
}
export interface NativeMcpControlResult {
  servers: NativeMcpStatus[];
  result?: Record<string, unknown>;
}
export interface NativePluginResources {
  skills: { name: string; description: string; path: string }[];
  mcp?: NativeMcpStatus[];
}

const REQUEST_KEYS: Record<string, true> = { type: true, requestId: true, context: true, name: true, arguments: true };
const CONTEXT_KEYS: Record<string, true> = { botId: true, turnId: true, workerSessionId: true, toolCallId: true };

export function isAgentPluginToolRequest(value: unknown): value is AgentPluginToolRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AgentPluginToolRequest>;
  if (Object.keys(value).some((key) => !Object.hasOwn(REQUEST_KEYS, key))) return false;
  if (request.type !== "plugin.request" || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 256) return false;
  if (typeof request.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.name)) return false;
  if (request.arguments === null || typeof request.arguments !== "object" || Array.isArray(request.arguments)) return false;
  const context = request.context;
  return context !== null && typeof context === "object" && !Array.isArray(context)
    && Object.keys(context).every((key) => Object.hasOwn(CONTEXT_KEYS, key))
    && typeof context.botId === "string" && /^bot_[0-9a-f]{32}$/.test(context.botId)
    && typeof context.turnId === "string" && /^turn_[0-9a-f]{32}$/.test(context.turnId)
    && typeof context.workerSessionId === "string" && context.workerSessionId.length > 0 && context.workerSessionId.length <= 256
    && typeof context.toolCallId === "string" && context.toolCallId.length > 0 && context.toolCallId.length <= 256;
}
