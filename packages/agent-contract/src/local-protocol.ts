import { isBotId, isDeviceId } from "@omarchy-bot/domain";

export const LOCAL_ACTIONS = ["run", "search", "read", "write", "transfer"] as const;
export type LocalActionName = (typeof LOCAL_ACTIONS)[number];

/** Daemon-authored binding installed for one active Agent turn when a Sidecar is online. */
export interface AgentLocalTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
}

export interface AgentLocalToolContext extends AgentLocalTurnContext {
  toolCallId: string;
}

export interface AgentLocalToolRequest {
  type: "local.request";
  requestId: string;
  context: AgentLocalToolContext;
  action: LocalActionName;
  target?: "this-device" | string;
  command?: string;
  path?: string;
  destination?: string;
  query?: string;
  contents?: string;
  direction?: "to-workspace" | "from-workspace";
}

const REQUEST_KEYS: Record<string, true> = {
  type: true,
  requestId: true,
  context: true,
  action: true,
  target: true,
  command: true,
  path: true,
  destination: true,
  query: true,
  contents: true,
  direction: true,
};
const CONTEXT_KEYS: Record<string, true> = {
  botId: true,
  turnId: true,
  workerSessionId: true,
  toolCallId: true,
};
const BOUNDED_PROTOCOL_ID_MAX_LENGTH = 256;
const COMMAND_MAX_LENGTH = 8_192;

export function isAgentLocalToolRequest(value: unknown): value is AgentLocalToolRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AgentLocalToolRequest>;
  if (Object.keys(value).some((key) => !(key in REQUEST_KEYS))) return false;
  if (
    request.type !== "local.request"
    || typeof request.requestId !== "string"
    || request.requestId.length === 0
    || request.requestId.length > BOUNDED_PROTOCOL_ID_MAX_LENGTH
    || typeof request.action !== "string"
    || !(LOCAL_ACTIONS as readonly string[]).includes(request.action)
  ) return false;
  if (request.target !== undefined) {
    if (request.target !== "this-device" && (typeof request.target !== "string" || !isDeviceId(request.target))) {
      return false;
    }
  }
  if (request.action === "run") {
    if (typeof request.command !== "string" || request.command.trim().length === 0 || request.command.length > COMMAND_MAX_LENGTH) {
      return false;
    }
  }
  if (request.action === "search") {
    if (typeof request.query !== "string" || request.query.trim().length === 0 || request.query.length > 1_024) {
      return false;
    }
  }
  if (request.action === "read" || request.action === "write") {
    if (typeof request.path !== "string" || request.path.trim().length === 0 || request.path.length > 4_096) {
      return false;
    }
  }
  if (request.action === "transfer") {
    if (
      request.direction !== "to-workspace" && request.direction !== "from-workspace"
      || typeof request.path !== "string" || request.path.trim().length === 0 || request.path.length > 4_096
      || typeof request.destination !== "string" || request.destination.trim().length === 0 || request.destination.length > 4_096
    ) {
      return false;
    }
  }
  const context = request.context;
  return (
    context !== null
    && typeof context === "object"
    && !Array.isArray(context)
    && Object.keys(context).every((key) => key in CONTEXT_KEYS)
    && typeof context.botId === "string"
    && isBotId(context.botId)
    && typeof context.turnId === "string"
    && /^turn_[0-9a-f]{32}$/.test(context.turnId)
    && typeof context.workerSessionId === "string"
    && context.workerSessionId.length > 0
    && context.workerSessionId.length <= BOUNDED_PROTOCOL_ID_MAX_LENGTH
    && typeof context.toolCallId === "string"
    && context.toolCallId.length > 0
    && context.toolCallId.length <= BOUNDED_PROTOCOL_ID_MAX_LENGTH
  );
}

export interface AgentLocalToolCancel {
  type: "local.cancel";
  requestId: string;
}

export interface AgentLocalToolOutput {
  deviceId: string;
  hostname: string;
  text: string;
  exitCode?: number;
}

export type AgentLocalToolResult =
  | { type: "local.result"; requestId: string; ok: true; payload: AgentLocalToolOutput }
  | { type: "local.result"; requestId: string; ok: false; error: string };

const localText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

export const LOCAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { enum: ["run", "search", "read", "write", "transfer"] },
    target: { type: "string", minLength: 1 },
    command: localText(COMMAND_MAX_LENGTH),
    path: localText(4_096),
    destination: localText(4_096),
    query: localText(1_024),
    contents: { type: "string", maxLength: 65_536 },
    direction: { enum: ["to-workspace", "from-workspace"] },
  },
  oneOf: [
    { required: ["action", "command"], properties: { action: { const: "run" } } },
    { required: ["action", "query"], properties: { action: { const: "search" } } },
    { required: ["action", "path"], properties: { action: { const: "read" } } },
    { required: ["action", "path"], properties: { action: { const: "write" } } },
    { required: ["action", "path", "destination", "direction"], properties: { action: { const: "transfer" } } },
  ],
};
