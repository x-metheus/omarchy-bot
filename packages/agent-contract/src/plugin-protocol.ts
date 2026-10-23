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
export interface AgentPluginToolOutput {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
export interface NativeMcpStatus {
  name: string;
  configurationRevision: string;
  status: "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";
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
