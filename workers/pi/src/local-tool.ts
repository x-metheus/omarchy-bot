import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_LOCAL_TOOL,
  LOCAL_SCHEMA,
  type AgentLocalToolContext,
  type AgentLocalToolOutput,
  type AgentLocalTurnContext,
  type LocalActionName,
  type LocalDeviceIdentity,
} from "@omarchy-bot/agent-contract";

export interface PiLocalBridge {
  request(
    context: AgentLocalToolContext,
    action: LocalActionName,
    args: {
      target?: "this-device" | string;
      command?: string;
      path?: string;
      destination?: string;
      query?: string;
      contents?: string;
      direction?: "to-workspace" | "from-workspace";
    },
    signal: AbortSignal | undefined,
  ): Promise<AgentLocalToolOutput>;
}

export function createLocalTool(
  turnContext: () => AgentLocalTurnContext | undefined,
  bridge: PiLocalBridge,
  device?: LocalDeviceIdentity,
) {
  return defineTool({
    name: AGENT_LOCAL_TOOL.name,
    label: "Local Sidecar",
    description: device === undefined ? AGENT_LOCAL_TOOL.description : `${AGENT_LOCAL_TOOL.description} This Device runs ${device.os} with ${device.shell}; write commands in that shell's syntax.`,
    promptSnippet: AGENT_LOCAL_TOOL.systemPrompt.summary,
    promptGuidelines: [...AGENT_LOCAL_TOOL.systemPrompt.guidelines],
    parameters: LOCAL_SCHEMA,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const active = turnContext();
      if (active === undefined) {
        throw new Error("local is unavailable: no online Local Sidecar for this turn");
      }
      signal?.throwIfAborted();
      const target = params.target;
      const output = await bridge.request(
        { ...active, toolCallId },
        params.action,
        {
          ...(target !== undefined ? { target } : {}),
          ...(params.command !== undefined ? { command: params.command } : {}),
          ...(params.path !== undefined ? { path: params.path } : {}),
          ...(params.destination !== undefined ? { destination: params.destination } : {}),
          ...(params.query !== undefined ? { query: params.query } : {}),
          ...(params.contents !== undefined ? { contents: params.contents } : {}),
          ...(params.direction !== undefined ? { direction: params.direction } : {}),
        },
        signal,
      );
      signal?.throwIfAborted();
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: output,
      };
    },
  });
}
