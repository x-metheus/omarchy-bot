import { PEER_MAIL_TEXT_MAX_LENGTH } from "@omarchy-bot/domain";

/** Daemon-authored binding installed for one active Agent turn. */
export interface AgentBotMessageTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
}

/** An Agent adapter adds its native Tool Call identity to the immutable binding. */
export interface AgentBotMessageToolContext extends AgentBotMessageTurnContext {
  toolCallId: string;
}

export interface AgentBotMessageToolRequest {
  type: "bot-message.request";
  requestId: string;
  context: AgentBotMessageToolContext;
  targetBotId: string;
  text: string;
}

const BOT_MESSAGE_REQUEST_KEYS: Record<string, true> = {
  type: true,
  requestId: true,
  context: true,
  targetBotId: true,
  text: true,
};
const BOT_MESSAGE_CONTEXT_KEYS: Record<string, true> = {
  botId: true,
  turnId: true,
  workerSessionId: true,
  toolCallId: true,
};
const BOUNDED_PROTOCOL_ID_MAX_LENGTH = 256;

/** Strict guard for the untrusted adapter boundary: v1 is exact 1:1 text only. */
export function isAgentBotMessageToolRequest(value: unknown): value is AgentBotMessageToolRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AgentBotMessageToolRequest>;
  if (Object.keys(value).some((key) => !(key in BOT_MESSAGE_REQUEST_KEYS))) return false;
  if (
    request.type !== "bot-message.request"
    || typeof request.requestId !== "string"
    || request.requestId.length === 0
    || request.requestId.length > BOUNDED_PROTOCOL_ID_MAX_LENGTH
    || typeof request.targetBotId !== "string"
    || !/^bot_[0-9a-f]{32}$/.test(request.targetBotId)
    || typeof request.text !== "string"
    || request.text.trim().length === 0
    || request.text.length > PEER_MAIL_TEXT_MAX_LENGTH
  ) return false;

  const context = request.context;
  return (
    context !== null
    && typeof context === "object"
    && !Array.isArray(context)
    && Object.keys(context).every((key) => key in BOT_MESSAGE_CONTEXT_KEYS)
    && typeof context.botId === "string"
    && /^bot_[0-9a-f]{32}$/.test(context.botId)
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

export interface AgentBotMessageToolCancel {
  type: "bot-message.cancel";
  requestId: string;
}

export interface AgentBotMessageToolOutput {
  deliveryId: string;
  queued: true;
}

export type AgentBotMessageToolResult =
  | { type: "bot-message.result"; requestId: string; ok: true; payload: AgentBotMessageToolOutput }
  | { type: "bot-message.result"; requestId: string; ok: false; error: string };

export const SEND_BOT_MESSAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["targetBotId", "text"],
  properties: {
    targetBotId: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1, maxLength: PEER_MAIL_TEXT_MAX_LENGTH },
  },
};
