import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AGENT_LOCAL_TOOL,
  type AgentLocalToolContext,
  type AgentLocalToolOutput,
  type AgentLocalTurnContext,
  type LocalActionName,
} from "@omarchy-bot/agent-contract";
import { isDeviceId } from "@omarchy-bot/domain";
import { Type } from "typebox";

const LOCAL_ACTION = Type.Union([
  Type.Literal("run"),
  Type.Literal("search"),
  Type.Literal("read"),
  Type.Literal("write"),
  Type.Literal("transfer"),
]);

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
) {
  return defineTool({
    name: AGENT_LOCAL_TOOL.name,
    label: "Local Sidecar",
    description: AGENT_LOCAL_TOOL.description,
    promptSnippet: AGENT_LOCAL_TOOL.systemPrompt.summary,
    promptGuidelines: [...AGENT_LOCAL_TOOL.systemPrompt.guidelines],
    parameters: Type.Object({
      action: LOCAL_ACTION,
      target: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      destination: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      contents: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([
        Type.Literal("to-workspace"),
        Type.Literal("from-workspace"),
      ])),
    }),
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      const active = turnContext();
      if (active === undefined) {
        throw new Error("local is unavailable: no online Local Sidecar for this turn");
      }
      signal?.throwIfAborted();
      const target = params.target;
      if (target !== undefined && target !== "this-device" && !isDeviceId(target)) {
        throw new Error("local target must be this-device or an explicit online device identity");
      }
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
