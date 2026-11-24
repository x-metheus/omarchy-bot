import { defineExtension, defineTool, LiveDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { AGENT_BROWSER_TOOL, BROWSER_TOOL_SCHEMA } from "@omarchy-bot/agent-contract";
import type { BrowserAction } from "@omarchy-bot/domain";
import { awaitWithSignal } from "../../computer/awaitWithSignal.ts";
import type { ComputerBroker, ComputerSurfaceOwner } from "../../computer/broker.ts";

// The first call can start the desktop before running the browser action.
const BROWSER_TIMEOUT_MS = 60_000;

export function createBrowserExtension({ broker, owner, timeoutMs = BROWSER_TIMEOUT_MS }: {
  broker: Pick<ComputerBroker, "agentBrowserAct">;
  owner(conversationId: ConversationId, submissionId: SubmissionId): (ComputerSurfaceOwner & { turnId: string }) | undefined;
  timeoutMs?: number;
}) {
  const tool = AGENT_BROWSER_TOOL;
  return defineExtension({
    name: "omarchy-browser",
    sections: [{
      key: tool.name,
      render: () => [tool.systemPrompt.summary, ...tool.systemPrompt.guidelines.map((line) => `- ${line}`)].join("\n"),
    }],
    tools: [defineTool({
      name: tool.name,
      description: tool.description,
      parameters: BROWSER_TOOL_SCHEMA,
      executionMode: "sequential",
      // The browser runtime owns truncation and reports it in the result.
      outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
      async execute(rawArgs, api, context) {
        const { action, args } = rawArgs as { action: BrowserAction["name"]; args?: BrowserAction["args"] };
        const controller = new AbortController();
        const signal = controller.signal;
        const abort = () => controller.abort(new Error("browser tool call aborted"));
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        if (context.abortSignal?.aborted) abort();
        const timer = setTimeout(() => controller.abort(new Error(`browser tool timed out after ${timeoutMs} ms`)), timeoutMs);
        try {
          signal.throwIfAborted();
          const submissionId = await awaitWithSignal(api.commit(async (tx) => {
            const live = await tx.doc(LiveDoc, api.conversationId);
            return live.run?.inputs[0];
          }, context), signal);
          signal.throwIfAborted();
          const binding = submissionId === undefined ? undefined : owner(api.conversationId, submissionId);
          if (binding === undefined) throw new Error("browser tool has no active Omarchy turn binding");
          const { turnId, ...activeOwner } = binding;
          const details = await broker.agentBrowserAct(activeOwner, turnId, api.callId, { name: action, args: args ?? {} }, signal);
          signal.throwIfAborted();
          const summary = [`Bot Desktop Session: ${JSON.stringify(details.desktopSession)}`];
          if (details.text !== undefined) summary.push(details.text);
          if (details.truncated) summary.push("Browser result truncated; some content is omitted.");
          return { output: [{ type: "text", text: summary.join("\n") }], details: { ...details } };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          const failure = signal.aborted ? signal.reason : error;
          return { isError: true, output: [{ type: "text", text: failure instanceof Error ? failure.message : String(failure) }], details: {} };
        } finally {
          clearTimeout(timer);
          context.abortSignal?.removeEventListener("abort", abort);
        }
      },
    })],
  });
}
