import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  SEND_BOT_MESSAGE_SCHEMA,
  type AgentBotMessageToolContext,
  type AgentBotMessageToolOutput,
  type AgentBotMessageTurnContext,
} from "@omarchy-bot/agent-contract";

export interface PiBotMessageBridge {
  request(
    context: AgentBotMessageToolContext,
    targetBotId: string,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentBotMessageToolOutput>;
}

export function createBotMessageTool(
  turnContext: () => AgentBotMessageTurnContext | undefined,
  bridge: PiBotMessageBridge,
) {
  return defineTool({
    name: "send_bot_message",
    label: "Send Bot message",
    description:
      "Durably queue a text message for another Omarchy Bot by stable Bot ID. Delivery is asynchronous: after a successful acknowledgement, conclude your response without waiting for the target Bot.",
    promptSnippet: "Send durable asynchronous text mail to another Omarchy Bot.",
    promptGuidelines: [
      "Use send_bot_message only when handing work or information to a distinct Bot ID.",
      "After a successful queued acknowledgement, conclude your response; the target Bot's later output is not returned to this Turn.",
    ],
    parameters: SEND_BOT_MESSAGE_SCHEMA,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const active = turnContext();
      if (active === undefined) {
        throw new Error("send_bot_message tool has no active Omarchy turn binding");
      }
      // The native tool call reaches this adapter unvalidated; extra fields never dispatch.
      if (Object.keys(params).some((key) => key !== "targetBotId" && key !== "text")) {
        throw new Error("Bot mail accepts only targetBotId and text");
      }
      signal?.throwIfAborted();
      const output = await bridge.request(
        { ...active, toolCallId },
        params.targetBotId,
        params.text,
        signal,
      );
      signal?.throwIfAborted();
      return {
        content: [{
          type: "text" as const,
          text: `Bot message ${output.deliveryId} queued. Conclude your response without waiting for the target Bot.`,
        }],
        details: output,
      };
    },
  });
}
