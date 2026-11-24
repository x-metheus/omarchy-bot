import type { Database } from "bun:sqlite";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { AssistantEntry, defineExtension, defineTool, type ToolTaskInput } from "@earendil-works/pi-durable";
import { SEND_BOT_MESSAGE_SCHEMA } from "@omarchy-bot/agent-contract";
import { resolveActiveTurnIdentity, type TurnInputs } from "../active-turn.ts";
import type { RuntimeServices } from "../runtime.ts";

const DEFAULT_MAIL_DEADLINE_MS = 120_000;
const SEND_BOT_MESSAGE = "send_bot_message";

export function createMailExtension(db: Database | undefined, getMailbox: () => RuntimeServices["mailbox"] | undefined, turnInputs: TurnInputs, deadlineMs = DEFAULT_MAIL_DEADLINE_MS) {
  const tool = defineTool({
    name: SEND_BOT_MESSAGE,
    description:
      "Durably queue a text message for another Omarchy Bot by stable Bot ID. Delivery is asynchronous: after a successful acknowledgement, conclude your response without waiting for the target Bot.",
    parameters: SEND_BOT_MESSAGE_SCHEMA,
    executionMode: "sequential",
    // MailboxService deduplicates by the source Turn and durable tool task, including after a restart.
    replay: "safe",
    async execute(args, api, context) {
      const deadline = new AbortController();
      const expiresAt = performance.now() + deadlineMs;
      const expire = () => deadline.abort(new DOMException(`${SEND_BOT_MESSAGE} timed out`, "TimeoutError"));
      const timer = setTimeout(expire, deadlineMs);
      const callContext = withAbortSignal(deadline.signal, context);
      const checkCancellation = () => {
        // A synchronous database operation can return before the queued timer runs.
        if (performance.now() >= expiresAt) expire();
        callContext.abortSignal?.throwIfAborted();
      };
      try {
        checkCancellation();
        const mailbox = getMailbox();
        if (!mailbox) throw new Error(`${SEND_BOT_MESSAGE}: mailbox service is not bound`);
        if (!db) throw new Error(`${SEND_BOT_MESSAGE}: Service database is not available`);
        await awaitWithContext(api.commit(async (tx) => {
          const input = (await tx.task(api.taskId))?.input as ToolTaskInput | undefined;
          if (input?.kind !== "model") return;
          const assistant = (await tx.entry(AssistantEntry, input.assistant))?.model?.[0];
          // pi-durable resolves duplicate IDs to the first call's arguments, even for distinct tasks.
          if (assistant?.role === "assistant" && assistant.content.filter((part) => part.type === "toolCall" && part.id === input.callId).length > 1) {
            throw new Error(`${SEND_BOT_MESSAGE}: duplicate tool call ID ${JSON.stringify(input.callId)} in the assistant response`);
          }
        }, callContext), callContext);
        const { botId, turnId } = await awaitWithContext(resolveActiveTurnIdentity(api, callContext, db, turnInputs), callContext);
        checkCancellation();
        const output = mailbox.enqueue({ botId, turnId, toolCallId: `pi-task:${api.taskId}` }, args.targetBotId, args.text);
        return {
          output: [{ type: "text", text: `Bot message ${output.deliveryId} queued. Conclude your response without waiting for the target Bot.` }],
          details: { ...output },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return defineExtension({
    name: "omarchy-mail",
    tools: [{ ...tool, label: "Send Bot message" }],
    sections: [{
      key: SEND_BOT_MESSAGE,
      render: ({ agent }) => agent.tools.some(({ name }) => name === SEND_BOT_MESSAGE) ? [
        "Send durable asynchronous text mail to another Omarchy Bot.",
        "Use send_bot_message only when handing work or information to a distinct Bot ID.",
        "After a successful queued acknowledgement, conclude your response; the target Bot's later output is not returned to this Turn.",
      ].join("\n") : undefined,
    }],
  });
}
