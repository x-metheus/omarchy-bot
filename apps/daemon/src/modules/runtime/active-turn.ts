import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord/context";
import { LiveDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";

type ActiveTurnToolApi = Pick<ToolExecutionApi, "taskId" | "conversationId" | "getTask" | "commit">;
export type TurnInputs = ReadonlyMap<string, { readonly inputs: ReadonlySet<number> }>;

/** Bind a model tool call only when all inputs of its live run have the same Service Turn owner. */
export async function resolveActiveTurnIdentity(api: ActiveTurnToolApi, context: Context, db: Database, turnInputs: TurnInputs) {
  const task = await api.getTask(api.taskId, context);
  context.abortSignal?.throwIfAborted();
  const turnId = await api.commit(async (tx) => {
    const { run } = await tx.doc(LiveDoc, api.conversationId);
    if (!run || !task || task.conversationId !== api.conversationId || task.owner !== run.taskId) {
      throw new Error("Cannot resolve active Turn: tool task is not owned by the live run");
    }
    if (run.inputs.length === 0) throw new Error("Cannot resolve active Turn: live run has no placed Turn input");
    const owners = new Set<string>();
    for (const id of run.inputs) {
      const submission = await tx.submission(id);
      if (submission?.type !== "input" || submission.status !== "placed" || submission.conversationId !== api.conversationId) {
        throw new Error("Cannot resolve active Turn: live run has no placed Turn input");
      }
      const associated = [...turnInputs].filter(([, turn]) => turn.inputs.has(id));
      if (associated.length > 0) {
        for (const [owner] of associated) owners.add(owner);
      } else {
        // Durable can place the input before the daemon records its association.
        if (!submission.requestId) throw new Error("Cannot resolve active Turn: live run has no unique Service Turn owner");
        owners.add(submission.requestId.replace(/^([^:]+):steer:[^:]+$/, "$1"));
      }
    }
    if (owners.size !== 1) throw new Error("Cannot resolve active Turn: live run has no unique Service Turn owner");
    return [...owners][0]!;
  }, context);
  context.abortSignal?.throwIfAborted();

  const bindings = db.query<{ thread_id: string; bot_id: string }, [number]>(
    "SELECT thread_id, bot_id FROM pi_thread_conversations WHERE conversation_id = ?",
  ).all(api.conversationId);
  const [binding] = bindings;
  if (!binding || bindings.length !== 1) {
    throw new Error("Cannot resolve active Turn: conversation has no unique Thread and Bot binding");
  }
  const turn = db.query<{ thread_id: string; bot_id: string }, [string]>(
    "SELECT thread_id, bot_id FROM turns WHERE id = ? AND status = 'working'",
  ).get(turnId);
  if (!turn) throw new Error("Cannot resolve active Turn: Service Turn is not working");
  if (turn.thread_id !== binding.thread_id || turn.bot_id !== binding.bot_id) {
    throw new Error("Cannot resolve active Turn: Service Turn does not match the conversation's Thread and Bot");
  }
  return { threadId: turn.thread_id, botId: turn.bot_id, turnId };
}
