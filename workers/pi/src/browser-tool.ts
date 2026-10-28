import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_BROWSER_TOOL,
  BROWSER_TOOL_SCHEMA,
  type AgentBrowserToolOutput,
  type AgentComputerToolContext,
  type AgentComputerTurnContext,
} from "@omarchy-bot/agent-contract";
import type { BrowserAction } from "@omarchy-bot/domain";

export interface PiBrowserBridge {
  request(
    context: AgentComputerToolContext,
    action: BrowserAction,
    signal: AbortSignal | undefined,
  ): Promise<AgentBrowserToolOutput>;
}

export function createBrowserTool(
  turnContext: () => AgentComputerTurnContext | undefined,
  bridge: PiBrowserBridge,
) {
  return defineTool({
    name: AGENT_BROWSER_TOOL.name,
    label: "Browser",
    description: AGENT_BROWSER_TOOL.description,
    promptSnippet: AGENT_BROWSER_TOOL.systemPrompt.summary,
    promptGuidelines: [...AGENT_BROWSER_TOOL.systemPrompt.guidelines],
    parameters: BROWSER_TOOL_SCHEMA,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const active = turnContext();
      if (active === undefined) {
        throw new Error("browser tool has no active Omarchy turn binding");
      }
      signal?.throwIfAborted();
      const output = await bridge.request(
        { ...active, toolCallId },
        { name: params.action, args: params.args ?? {} },
        signal,
      );
      signal?.throwIfAborted();
      const summary = [`Bot Desktop Session: ${JSON.stringify(output.desktopSession)}`];
      if (output.text !== undefined) summary.push(output.text);
      if (output.truncated) summary.push("Browser result truncated; some content is omitted.");
      return {
        content: [{ type: "text" as const, text: summary.join("\n") }],
        details: output,
      };
    },
  });
}
