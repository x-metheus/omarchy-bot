import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createToolChannelWorker,
  writeJsonl,
  type AgentPluginSnapshot,
  type AgentPluginToolOutput,
  type AgentPluginTurnContext,
} from "@omarchy-bot/agent-contract";

/**
 * One channel for every plugin tool of the turn's snapshot; the daemon holds the
 * plugin lease and validates each call against that tool's own input schema.
 */
export const pluginChannel = createToolChannelWorker();
pluginChannel.send = (frame) => writeJsonl(frame);

export function createPluginTools(snapshot: AgentPluginSnapshot | undefined, turnContext: () => AgentPluginTurnContext | undefined) {
  return (snapshot?.tools ?? []).map((definition) => defineTool({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: Type.Unsafe<Record<string, unknown>>(definition.inputSchema),
    executionMode: "sequential",
    execute: async (toolCallId, parameters, signal) => {
      const context = turnContext();
      if (!context) throw new Error("Plugin tool has no active Omarchy turn binding");
      signal?.throwIfAborted();
      const output = await pluginChannel.call(
        definition.name,
        parameters,
        { ...context, toolCallId },
        signal ?? new AbortController().signal,
      ) as AgentPluginToolOutput;
      signal?.throwIfAborted();
      if (output.isError) {
        throw new Error(output.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "Remote plugin tool returned an error");
      }
      return { content: output.content, details: output.structuredContent };
    },
  }));
}
