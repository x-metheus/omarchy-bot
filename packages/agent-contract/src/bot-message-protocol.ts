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

export interface AgentBotMessageToolOutput {
  deliveryId: string;
  queued: true;
}

/** v1 is exact 1:1 text only; the ToolChannel validates it before the mailbox sees a request. */
export const SEND_BOT_MESSAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["targetBotId", "text"],
  properties: {
    targetBotId: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1, maxLength: PEER_MAIL_TEXT_MAX_LENGTH },
  },
};
