import { randomUUID } from "node:crypto";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export interface ToolChannelContext {
  botId: string;
  turnId: string;
  toolCallId: string;
  workerSessionId: string;
}

export interface ToolChannelTool {
  name: string;
  schema: TSchema;
}

export type ToolChannelFrame =
  | { type: "tool.request"; requestId: string; name: string; params: unknown; context: ToolChannelContext }
  | { type: "tool.cancel"; requestId: string }
  | { type: "tool.result"; requestId: string; ok: true; result: unknown }
  | { type: "tool.result"; requestId: string; ok: false; error: string };

export interface ToolChannelDaemon {
  start(toolCallId: string): void;
  receive(frame: ToolChannelFrame): Promise<ToolChannelFrame | undefined>;
  /** Aborts every running executor; the worker that owns this channel is gone and can no longer cancel. */
  close(): void;
}

export interface ToolChannelWorker {
  send(frame: ToolChannelFrame): void;
  call(name: string, params: unknown, context: ToolChannelContext, signal: AbortSignal): Promise<unknown>;
  receive(frame: ToolChannelFrame | undefined): void;
  /** Rejects every pending call, or only one worker session's when given. */
  close(workerSessionId?: string): void;
}

export function createToolChannelDaemon(options: {
  tools: readonly ToolChannelTool[];
  execute(params: unknown, context: ToolChannelContext, signal: AbortSignal, name: string): Promise<unknown> | unknown;
}): ToolChannelDaemon {
  const started = new Set<string>();
  const dispatched = new Set<string>();
  const seen = new Set<string>();
  const running = new Map<string, AbortController>();
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  return {
    start(toolCallId) {
      started.add(toolCallId);
    },
    async receive(frame) {
      if (frame.type === "tool.cancel") {
        running.get(frame.requestId)?.abort();
        return undefined;
      }
      if (frame.type !== "tool.request") return undefined;
      const fail = (error: string): ToolChannelFrame => ({ type: "tool.result", requestId: frame.requestId, ok: false, error });
      if (seen.has(frame.requestId)) return fail("duplicate tool request");
      seen.add(frame.requestId);
      if (!started.has(frame.context.toolCallId)) return fail("tool call has not started");
      const tool = tools.get(frame.name);
      if (tool === undefined || !Value.Check(tool.schema, frame.params)) return fail(`tool params do not match ${frame.name}`);
      if (dispatched.has(frame.context.toolCallId)) return fail("tool call was already dispatched");
      dispatched.add(frame.context.toolCallId);
      const controller = new AbortController();
      running.set(frame.requestId, controller);
      try {
        const result = await options.execute(frame.params, frame.context, controller.signal, frame.name);
        return { type: "tool.result", requestId: frame.requestId, ok: true, result };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      } finally {
        running.delete(frame.requestId);
      }
    },
    close() {
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}

export function createToolChannelWorker(): ToolChannelWorker {
  const pending = new Map<string, { workerSessionId: string; resolve(value: unknown): void; reject(error: Error): void }>();
  const worker: ToolChannelWorker = {
    send() {},
    call(name, params, context, signal) {
      if (signal.aborted) return Promise.reject(new Error("tool call aborted"));
      const requestId = randomUUID();
      const result = Promise.withResolvers<unknown>();
      pending.set(requestId, { workerSessionId: context.workerSessionId, resolve: result.resolve, reject: result.reject });
      // An aborted call settles here, so its late result is dropped instead of
      // resolving a promise the caller already gave up on.
      signal.addEventListener("abort", () => {
        pending.delete(requestId);
        result.reject(new Error("tool call aborted"));
        worker.send({ type: "tool.cancel", requestId });
      }, { once: true });
      worker.send({ type: "tool.request", requestId, name, params, context });
      return result.promise;
    },
    receive(frame) {
      if (frame === undefined || frame.type !== "tool.result") return;
      const waiting = pending.get(frame.requestId);
      if (waiting === undefined) return;
      pending.delete(frame.requestId);
      if (frame.ok) waiting.resolve(frame.result);
      else waiting.reject(new Error(frame.error));
    },
    close(workerSessionId) {
      for (const [requestId, waiting] of pending) {
        if (workerSessionId !== undefined && waiting.workerSessionId !== workerSessionId) continue;
        pending.delete(requestId);
        waiting.reject(new Error("tool session closed"));
      }
    },
  };
  return worker;
}
