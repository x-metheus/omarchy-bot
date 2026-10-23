import type { NativeMcpRuntimeStatus } from "./native-mcp-config.ts";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

/** Provider ids shared by the plugin API and the Agent-facing tool schema. */
export const PLUGIN_PROVIDER_IDS = [
  "google", "microsoft", "notion", "github", "linear", "asana", "dropbox", "hubspot", "intercom", "miro",
] as const;

export const MANAGE_PLUGINS_ACTIONS = [
  "list", "inspect", "inspect_skill", "search_skills", "install_skill", "enable_skill", "remove_skill",
  "update_skills", "authorize_service", "enable_service", "remove_service", "update_service",
  "label_account", "disconnect_account", "save_mcp", "update_mcp", "enable_mcp", "remove_mcp",
  "check_mcp", "authorize_mcp",
] as const;

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });

// The one MCP endpoint rule, shared by MANAGE_PLUGINS_SCHEMA and SaveMcpBody:
// an absolute http(s) URL with a host and no whitespace. new URL throws on a
// malformed port, so every parse stays inside this check.
const MCP_HTTP_URL_PATTERN = "^[Hh][Tt][Tt][Pp][Ss]?://[^/\\s?#]+(?:[/?#][^\\s]*)?$";
const mcpHttpUrl = new RegExp(MCP_HTTP_URL_PATTERN);
export function isMcpHttpUrl(value: string): boolean {
  if (!mcpHttpUrl.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

const httpUrl = Type.Refine(Type.String({ minLength: 1, pattern: MCP_HTTP_URL_PATTERN }), isMcpHttpUrl, () => "Use an HTTP or HTTPS URL with a valid host");
// An exact public npm package name or bin.

const npmName = Type.String({ minLength: 1, maxLength: 214, pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$" });
const npmBin = Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" });

const SAVE_MCP_SCHEMA = Type.Union([
  Type.Object({
    name: text(120),
    enabled: Type.Optional(Type.Boolean()),
    transport: Type.Union([
      Type.Object({
        type: Type.Literal("stdio"),
        command: text(4096),
        args: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
      }, { additionalProperties: false }),
      Type.Object({
        type: Type.Literal("http"),
        url: httpUrl,
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      }, { additionalProperties: false }),
    ]),
  }, { additionalProperties: false }),
  Type.Object({
    name: text(120),
    enabled: Type.Optional(Type.Boolean()),
    package: Type.Object({
      name: npmName,
      bin: Type.Optional(npmBin),
      args: Type.Optional(Type.Array(Type.String(), { maxItems: 126 })),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
], {
  description: "SaveMcpBody: name, enabled, and either transport {type:stdio,command,args?,env?} / {type:http,url,headers?}, or package {name: exact public npm package,bin?,args?,env?}. Managed npm packages update automatically; arbitrary native commands remain user-owned. Credential fields are write-only.",
});

/** The one parameter schema for `manage_plugins`; the ToolChannel validates every call against it. */
export const MANAGE_PLUGINS_SCHEMA = Type.Object({
  action: Type.Union(MANAGE_PLUGINS_ACTIONS.map((action) => Type.Literal(action))),
  id: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  skillPath: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  providerId: Type.Optional(Type.Union(PLUGIN_PROVIDER_IDS.map((id) => Type.Literal(id)))),
  serviceId: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  connection: Type.Optional(SAVE_MCP_SCHEMA),
  redirectUrl: Type.Optional(Type.String()),
  view: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type ManagePluginsInput = Static<typeof MANAGE_PLUGINS_SCHEMA>;
export interface AgentPluginToolDefinition {
  name: string;
  description: string;
  inputSchema: TSchema;
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
