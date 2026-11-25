import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { AGENT_COMPUTER_TOOL, COMPUTER_TOOL_SCHEMA } from "@omarchy-bot/agent-contract";
import type { ComputerAction } from "@omarchy-bot/domain";
import type { ComputerBroker, ComputerSurfaceOwner } from "../../computer/broker.ts";

// The first action can boot the desktop before the existing 30-second application launch wait.
const COMPUTER_TIMEOUT_MS = 60_000;

export function createComputerExtension({ broker, owner, timeoutMs = COMPUTER_TIMEOUT_MS }: {
  broker: Pick<ComputerBroker, "agentToolAct">;
  owner(api: ToolExecutionApi, context: Context): Promise<(ComputerSurfaceOwner & { turnId: string }) | undefined>;
  timeoutMs?: number;
}) {
  const tool = AGENT_COMPUTER_TOOL;
  return defineExtension({
    name: "omarchy-computer",
    sections: [{
      key: tool.name,
      render: () => [tool.systemPrompt.summary, ...tool.systemPrompt.guidelines.map((line) => `- ${line}`)].join("\n"),
    }],
    tools: [defineTool({
      name: tool.name,
      description: tool.description,
      parameters: COMPUTER_TOOL_SCHEMA,
      executionMode: "sequential",
      // The worker passes the full result, including large window lists.
      outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
      async execute(rawArgs, api, context) {
        const { action, args = {} } = rawArgs as { action: ComputerAction["name"]; args?: ComputerAction["args"] };
        const controller = new AbortController();
        const signal = controller.signal;
        const abort = () => controller.abort(new Error("computer tool call aborted"));
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        if (context.abortSignal?.aborted) abort();
        const timer = setTimeout(() => controller.abort(new Error(`computer tool timed out after ${timeoutMs} ms`)), timeoutMs);
        try {
          signal.throwIfAborted();
          const binding = await owner(api, withAbortSignal(signal, context));
          signal.throwIfAborted();
          if (binding === undefined) throw new Error("computer tool has no active Omarchy turn binding");
          const { turnId, ...activeOwner } = binding;
          const { inlineImage, imageFile: _imageFile, windowList, ...details } = await broker.agentToolAct(
            activeOwner, turnId, api.callId, { name: action, args }, signal,
          );
          const { desktopSession, text, imageRef } = details;
          const summary = [`Bot Desktop Session: ${JSON.stringify(desktopSession)}`];
          if (text !== undefined) summary.push(text);
          if (imageRef !== undefined) summary.push(`Bot Screen snapshot artifact: ${imageRef}`);
          if (windowList !== undefined) summary.push(`Windows: ${JSON.stringify(windowList)}`);
          const output: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
            { type: "text", text: summary.join("\n") },
          ];
          if (inlineImage !== undefined) output.push(inlineImage);
          return { output, details: {
            ...details,
            ...(windowList === undefined ? {} : { windowList: windowList as JsonValue }),
          } };
        } catch (error) {
          signal.throwIfAborted();
          return { isError: true, output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: {} };
        } finally {
          clearTimeout(timer);
          context.abortSignal?.removeEventListener("abort", abort);
        }
      },
    })],
  });
}
