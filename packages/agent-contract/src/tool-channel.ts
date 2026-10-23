import { randomUUID } from "node:crypto";

export interface ToolChannelContext {
  botId: string;
  turnId: string;
  toolCallId: string;
  workerSessionId: string;
}

export interface ToolChannelTool {
  name: string;
  schema: Record<string, unknown>;
  repeatable?: boolean;
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

// shortcut: JSON Schema keywords these tools don't emit fail closed, switch to a full validator when a tool schema needs one.
const SCHEMA_KEYS: Record<string, true> = {
  type: true, properties: true, required: true, additionalProperties: true, items: true,
  minLength: true, maxLength: true, pattern: true, minimum: true, maximum: true,
  exclusiveMinimum: true, exclusiveMaximum: true, minItems: true, maxItems: true,
  uniqueItems: true, multipleOf: true, enum: true, const: true, anyOf: true, allOf: true, oneOf: true, not: true,
  description: true, title: true, default: true, examples: true, $schema: true, $id: true, $comment: true, deprecated: true,
};

export function schemaMatches(schema: Record<string, unknown>, value: unknown): boolean {
  if (Object.keys(schema).some((key) => !Object.hasOwn(SCHEMA_KEYS, key))) return false;
  if (schema.anyOf !== undefined && !branches(schema.anyOf).some((branch) => schemaMatches(branch, value))) return false;
  if (schema.allOf !== undefined && !branches(schema.allOf).every((branch) => schemaMatches(branch, value))) return false;
  if (schema.oneOf !== undefined && branches(schema.oneOf).filter((branch) => schemaMatches(branch, value)).length !== 1) return false;
  if (schema.not !== undefined && schemaMatches(asSchema(schema.not), value)) return false;
  if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.some((entry) => Object.is(entry, value)))) return false;
  if (schema.const !== undefined && !Object.is(schema.const, value)) return false;
  if (schema.type !== undefined && !typeMatches(schema.type, value)) return false;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    if (typeof schema.multipleOf === "number" && schema.multipleOf !== 0 && !Number.isInteger(value / schema.multipleOf)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) return false;
    if (schema.items !== undefined && !value.every((entry) => schemaMatches(asSchema(schema.items), entry))) return false;
  }
  if (isObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, property] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && !schemaMatches(asSchema(property), value[key])) return false;
    }
    const extra = Object.keys(value).filter((key) => !Object.hasOwn(properties, key));
    if (schema.additionalProperties === false && extra.length > 0) return false;
    if (isObject(schema.additionalProperties) && extra.some((key) => !schemaMatches(schema.additionalProperties as Record<string, unknown>, value[key]))) return false;
  }
  return true;
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
      if (tool === undefined || !schemaMatches(tool.schema, frame.params)) return fail(`tool params do not match ${frame.name}`);
      if (!tool.repeatable && dispatched.has(frame.context.toolCallId)) return fail("tool call was already dispatched");
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

function branches(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function asSchema(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => {
    if (entry === "object") return isObject(value);
    if (entry === "array") return Array.isArray(value);
    if (entry === "string") return typeof value === "string";
    if (entry === "number") return typeof value === "number" && Number.isFinite(value);
    if (entry === "integer") return typeof value === "number" && Number.isInteger(value);
    if (entry === "boolean") return typeof value === "boolean";
    if (entry === "null") return value === null;
    return false;
  });
}
