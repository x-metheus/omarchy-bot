import type { Database } from "bun:sqlite";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type JsonObject } from "@earendil-works/pi-durable";
import { PLUGIN_MANAGEMENT_TOOL, PLUGIN_TOOL_OUTPUT_MAX_BYTES } from "../../plugins/plugins.ts";
import { resolveActiveTurnIdentity, type TurnInputs } from "../active-turn.ts";
import type { RuntimeServices } from "../runtime.ts";
import { rejectAmbiguousModelCallId, type DispatchedCallIds } from "./model-call.ts";

const DEFAULT_PLUGIN_DEADLINE_MS = 120_000;

export function createPluginsExtension(
  db: Database | undefined,
  getPlugins: () => RuntimeServices["plugins"] | undefined,
  turnInputs: TurnInputs,
  dispatched: DispatchedCallIds,
  deadlineMs = DEFAULT_PLUGIN_DEADLINE_MS,
) {
  const { name, description, inputSchema } = PLUGIN_MANAGEMENT_TOOL;
  return defineExtension({
    name: "omarchy-plugins",
    tools: [defineTool({
      name,
      description,
      parameters: inputSchema,
      executionMode: "sequential",
      replay: "unsafe",
      // The service already spills results above this byte limit, including multiline output.
      outputLimits: { maxBytes: PLUGIN_TOOL_OUTPUT_MAX_BYTES, maxLines: PLUGIN_TOOL_OUTPUT_MAX_BYTES + 1 },
      async execute(args, api, context) {
        const deadline = new AbortController();
        const expiresAt = performance.now() + deadlineMs;
        const expire = () => deadline.abort(new DOMException(`${name} timed out`, "TimeoutError"));
        const timer = setTimeout(expire, deadlineMs);
        const callContext = withAbortSignal(deadline.signal, context);
        const signal = callContext.abortSignal ?? deadline.signal;
        const checkCancellation = () => {
          if (performance.now() >= expiresAt) expire();
          signal.throwIfAborted();
        };
        try {
          checkCancellation();
          const plugins = getPlugins();
          if (!plugins) throw new Error(`${name}: Plugins service is not bound`);
          if (!db) throw new Error(`${name}: Service database is not available`);
          await awaitWithContext(rejectAmbiguousModelCallId(api, callContext, name), callContext);
          // Management acts on the shared workspace after verifying the caller's Turn.
          const { turnId } = await awaitWithContext(resolveActiveTurnIdentity(api, callContext, db, turnInputs), callContext);
          checkCancellation();
          const execution = Promise.resolve().then(() => {
            checkCancellation();
            dispatched.reserve(turnId, api.callId);
            return plugins.callManage(name, args, signal);
          });
          const result = await awaitWithContext(execution, callContext);
          checkCancellation();
          if (result.isError) {
            throw new Error(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "Remote plugin tool returned an error");
          }
          return {
            output: result.content,
            ...(result.structuredContent === undefined ? {} : { details: result.structuredContent as JsonObject }),
          };
        } finally {
          clearTimeout(timer);
        }
      },
    })],
  });
}
