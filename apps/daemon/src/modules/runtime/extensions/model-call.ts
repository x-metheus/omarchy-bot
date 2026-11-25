import type { Context } from "@earendil-works/chord/context";
import { AssistantEntry, type ToolExecutionApi, type ToolTaskInput } from "@earendil-works/pi-durable";

export class DispatchedCallIds {
  readonly #byTurn = new Map<string, Set<string>>();

  reserve(turnId: string, callId: string): void {
    let callIds = this.#byTurn.get(turnId);
    if (!callIds) {
      callIds = new Set();
      this.#byTurn.set(turnId, callIds);
    }
    if (callIds.has(callId)) throw new Error("tool call was already dispatched");
    callIds.add(callId);
  }

  deleteTurn(turnId: string): void {
    this.#byTurn.delete(turnId);
  }
}

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
