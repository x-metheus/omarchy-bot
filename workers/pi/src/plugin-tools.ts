import { defineTool } from "@earendil-works/pi-coding-agent";
import type {
  AgentPluginSnapshot,
  AgentPluginToolOutput,
  AgentPluginTurnContext,
} from "@omarchy-bot/agent-contract";
import { toolChannel } from "./tool-channel.ts";

/** One channel for every plugin tool of the turn's snapshot; the daemon validates each call. */
export function createPluginTools(snapshot: AgentPluginSnapshot | undefined, turnContext: () => AgentPluginTurnContext | undefined) {
  return (snapshot?.tools ?? []).map((definition) => defineTool({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    executionMode: "sequential",
    execute: async (toolCallId, parameters, signal) => {
      const context = turnContext();
      if (!context) throw new Error("Plugin tool has no active Omarchy turn binding");
      signal?.throwIfAborted();
      const output = await toolChannel.call(
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
