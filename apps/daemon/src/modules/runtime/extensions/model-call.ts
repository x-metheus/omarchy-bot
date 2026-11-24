import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, type ToolExecutionApi, type ToolTaskInput } from "@earendil-works/pi-durable";

export async function rejectAmbiguousModelCallId(api: Pick<ToolExecutionApi, "commit" | "taskId">, context: Context, toolName: string): Promise<void> {
  await api.commit(async (tx) => {
    const input = (await tx.task(api.taskId))?.input as ToolTaskInput | undefined;
    if (input?.kind !== "model") return;
    const assistant = (await tx.entry(AssistantEntry, input.assistant))?.model?.[0];
    // pi-durable resolves duplicate IDs to the first call's arguments, even for distinct tasks.
    if (assistant?.role === "assistant" && assistant.content.filter((part) => part.type === "toolCall" && part.id === input.callId).length > 1) {
      throw new Error(`${toolName}: duplicate tool call ID ${JSON.stringify(input.callId)} in the assistant response`);
    }
  }, context);
}
