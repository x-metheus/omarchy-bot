import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_COMPUTER_TOOL,
  COMPUTER_TOOL_SCHEMA,
  type AgentComputerToolContext,
  type AgentComputerToolOutput,
  type AgentComputerTurnContext,
} from "@omarchy-bot/agent-contract";
import type { ComputerAction, ComputerActionName } from "@omarchy-bot/domain";
import { Type } from "typebox";

export interface PiComputerBridge {
  request(
    context: AgentComputerToolContext,
    action: ComputerAction,
    signal: AbortSignal | undefined,
  ): Promise<AgentComputerToolOutput>;
}

export function createComputerTool(
  turnContext: () => AgentComputerTurnContext | undefined,
  bridge: PiComputerBridge,
) {
  return defineTool({
    name: AGENT_COMPUTER_TOOL.name,
    label: "Computer",
    description: AGENT_COMPUTER_TOOL.description,
    promptSnippet: AGENT_COMPUTER_TOOL.systemPrompt.summary,
    promptGuidelines: [...AGENT_COMPUTER_TOOL.systemPrompt.guidelines],
    parameters: Type.Unsafe<{
      action: ComputerActionName;
      args?: Record<string, unknown>;
    }>(COMPUTER_TOOL_SCHEMA),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const active = turnContext();
      if (active === undefined) {
        throw new Error("computer tool has no active Omarchy turn binding");
      }
      signal?.throwIfAborted();
      const output = await bridge.request(
        { ...active, toolCallId },
        { name: params.action, args: params.args ?? {} },
        signal,
      );
      signal?.throwIfAborted();
      const summary: string[] = [
        `Bot Desktop Session: ${JSON.stringify(output.desktopSession)}`,
      ];
      if (output.text !== undefined) summary.push(output.text);
      if (output.imageRef !== undefined) {
        summary.push(`Bot Screen snapshot artifact: ${output.imageRef}`);
      }
      if (output.windowList !== undefined) {
        summary.push(`Windows: ${JSON.stringify(output.windowList)}`);
      }
      const content: Array<
        { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: summary.join("\n") }];
      if (output.imageFile !== undefined) {
        const bytes = await Bun.file(output.imageFile.path).arrayBuffer();
        content.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: output.imageFile.mediaType,
        });
      }
      const { imageFile: _imageFile, ...details } = output;
      return { content, details };
    },
  });
}
