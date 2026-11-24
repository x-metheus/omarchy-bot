import type { Database } from "bun:sqlite";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AGENT_LOCAL_TOOL, LOCAL_SCHEMA } from "@omarchy-bot/agent-contract";
import { LOCAL_RESULT_TEXT_MAX } from "@omarchy-bot/protocol";
import { resolveActiveTurnIdentity } from "../active-turn.ts";
import type { RuntimeServices } from "../runtime.ts";
import { rejectAmbiguousModelCallId, type DispatchedCallIds } from "./model-call.ts";

const DEFAULT_LOCAL_DEADLINE_MS = 120_000;

type LocalTurn = { readonly inputs: ReadonlySet<number>; readonly deviceId?: string };

export function createLocalExtension(
  db: Database | undefined,
  getSidecars: () => RuntimeServices["sidecars"] | undefined,
  active: ReadonlyMap<string, LocalTurn>,
  dispatched: DispatchedCallIds,
  deadlineMs = DEFAULT_LOCAL_DEADLINE_MS,
) {
  const { name, description, systemPrompt } = AGENT_LOCAL_TOOL;
  const tool = defineTool({
    name,
    description,
    parameters: LOCAL_SCHEMA,
    executionMode: "sequential",
    // A UTF-16 code unit can occupy three UTF-8 bytes or introduce another line.
    outputLimits: { maxBytes: LOCAL_RESULT_TEXT_MAX * 3, maxLines: LOCAL_RESULT_TEXT_MAX + 1 },
    async execute(args, api, context) {
      const deadline = new AbortController();
      const expiresAt = performance.now() + deadlineMs;
      const expire = () => deadline.abort(new DOMException("local timed out", "TimeoutError"));
      const timer = setTimeout(expire, deadlineMs);
      const callContext = withAbortSignal(deadline.signal, context);
      const signal = callContext.abortSignal ?? deadline.signal;
      const checkCancellation = () => {
        // The broker or another synchronous operation can return before the queued timer runs.
        if (performance.now() >= expiresAt) expire();
        signal.throwIfAborted();
      };
      let renameSubmitted = false;
      try {
        checkCancellation();
        const sidecars = getSidecars();
        if (!sidecars) throw new Error("local: Sidecar broker is not bound");
        if (!db) throw new Error("local: Service database is not available");
        await awaitWithContext(rejectAmbiguousModelCallId(api, callContext, name), callContext);
        const { botId, turnId } = await awaitWithContext(resolveActiveTurnIdentity(api, callContext, db, active), callContext);
        const turn = active.get(turnId);
        checkCancellation();
        if (!turn) throw new Error("local: Service Turn is not active");
        const { deviceId } = turn;
        const execution = Promise.resolve().then(() => {
          checkCancellation();
          dispatched.reserve(turnId, api.callId);
          return sidecars.execute(args, { botId, turnId, ...(deviceId === undefined ? {} : { deviceId }) }, signal, {
            checkCancellation,
            onRenameSubmitted: () => { renameSubmitted = true; },
          });
        });
        const result = await awaitWithContext(execution, callContext).catch((error: unknown) => {
          // A submitted rename can still commit after cancellation wins the wait.
          if (renameSubmitted && signal.aborted) return execution;
          throw error;
        });
        if (!renameSubmitted) checkCancellation();
        return { output: [{ type: "text", text: result.text }], details: result };
      } catch (error) {
        if (!renameSubmitted) checkCancellation();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return defineExtension({
    name: "omarchy-local",
    tools: [{ ...tool, label: "Local Sidecar" }],
    sections: [{
      key: name,
      render: ({ agent }) => agent.tools.some((tool) => tool.name === name) ? [
        systemPrompt.summary,
        // The runtime registry offers the tool even when the broker has no online Sidecar.
        "local requires an online Local Sidecar. this-device selects the Sidecar on the device that sent the Turn's user message.",
        ...systemPrompt.guidelines.slice(1),
      ].join("\n") : undefined,
    }],
  });
}
