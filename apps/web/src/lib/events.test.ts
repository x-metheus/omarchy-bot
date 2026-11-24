import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  MessageDto,
  ToolCallSummaryDto,
  type ApprovalDto,
  type ClientToServer,
  type EventEnvelope,
  type ServerToClient,
} from "@omarchy-bot/protocol";
import {
  notifyForAttentionEvent,
  patchCachedMessage,
  patchCachedToolCall,
  route,
  startEventPump,
  type ApplyTranscriptUpdate,
  type Invalidate,
  type QueryTag,
  type TranscriptUpdate,
} from "./events.ts";
import { createMessageStream, type MessageStream } from "./messageStream.ts";
import { createMemoryShell, installShell } from "./shell.ts";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:00:05.000Z";
const MESSAGES_KEY = ["messages", "thread-1"] as const;

function responseMessage(text: string, overrides: Partial<MessageDto> = {}): MessageDto {
  return MessageDto.parse({
    id: "message-response",
    threadId: "thread-1",
    seq: 2,
    author: { kind: "bot" },
    kind: "response",
    text,
    response: { blockId: "block-response", state: "streaming", startedAt: STARTED_AT },
    createdAt: STARTED_AT,
    ...overrides,
  });
}

function thinkingMessage(text: string, overrides: Partial<MessageDto> = {}): MessageDto {
  return MessageDto.parse({
    id: "message-thinking",
    threadId: "thread-1",
    seq: 1,
    author: { kind: "bot" },
    kind: "thinking",
    text,
    thinking: { blockId: "block-thinking", state: "streaming", startedAt: STARTED_AT },
    createdAt: STARTED_AT,
    ...overrides,
  });
}

function toolMessage(toolCall: Partial<ToolCallSummaryDto> = {}): MessageDto {
  return MessageDto.parse({
    id: "message-tool",
    threadId: "thread-1",
    seq: 3,
    author: { kind: "bot" },
    kind: "tool",
    toolCall: { id: "tool-1", name: "read", status: "running", ...toolCall },
    createdAt: STARTED_AT,
  });
}

function toolUpdatePayload(toolCall: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { threadId: "thread-1", messageId: "message-tool", toolCall, ...overrides };
}

let eventSequence = 0;

function threadEvent(
  type: string,
  payload: unknown,
  overrides: { cursor?: number; aggregateId?: string } = {},
): EventEnvelope {
  eventSequence += 1;
  return {
    schemaVersion: 1,
    eventId: `event-${eventSequence}`,
    cursor: overrides.cursor ?? eventSequence,
    occurredAt: STARTED_AT,
    aggregateType: "thread",
    aggregateId: overrides.aggregateId ?? "thread-1",
    type,
    payload,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface Harness {
  queryClient: QueryClient;
  invalidations: Array<{ tag: QueryTag; threadId?: string }>;
  applied: Array<{ threadId: string; update: TranscriptUpdate }>;
  messagesInvalidations: () => Array<{ tag: QueryTag; threadId?: string }>;
  cached: (threadId: string) => MessageDto[] | undefined;
  stream: MessageStream;
  invalidate: Invalidate;
  applyUpdate: ApplyTranscriptUpdate;
}

function createHarness(
  seed?: { threadId: string; messages: MessageDto[] },
  listMessages: (threadId: string) => Promise<MessageDto[]> = async () => [],
): Harness {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed !== undefined) queryClient.setQueryData(["messages", seed.threadId], seed.messages);
  const invalidations: Array<{ tag: QueryTag; threadId?: string }> = [];
  const invalidate: Invalidate = (tag, threadId) => {
    invalidations.push(threadId === undefined ? { tag } : { tag, threadId });
    void queryClient.invalidateQueries({ queryKey: threadId === undefined ? [tag] : [tag, threadId] });
  };
  const applied: Array<{ threadId: string; update: TranscriptUpdate }> = [];
  const stream = createMessageStream({ queryClient, invalidate, listMessages });
  const applyUpdate: ApplyTranscriptUpdate = (threadId, update) => {
    applied.push({ threadId, update });
    stream.applyUpdate(threadId, update);
  };
  return {
    queryClient,
    invalidations,
    applied,
    messagesInvalidations: () => invalidations.filter((call) => call.tag === "messages"),
    cached: (threadId) => queryClient.getQueryData<MessageDto[]>(["messages", threadId]),
    stream,
    invalidate,
    applyUpdate,
  };
}

const pendingApproval: ApprovalDto = {
  id: "approval-1",
  threadId: "thread-1",
  botId: "bot-1",
  turnId: "turn-1",
  tool: "read",
  path: "/shared/report.txt",
  folder: "/shared",
  status: "pending",
  createdAt: STARTED_AT,
  expiresAt: "2026-01-01T00:10:00.000Z",
  answeredAt: null,
};
const resolvedApproval: ApprovalDto = {
  ...pendingApproval,
  status: "allowed_once",
  answeredAt: COMPLETED_AT,
};

describe("route approval events", () => {
  test("invalidates approvals for the thread in approval.requested", () => {
    const harness = createHarness();

    route(threadEvent("approval.requested", pendingApproval, { aggregateId: "thread-aggregate" }), harness.invalidate);

    expect(harness.invalidations).toEqual([{ tag: "approvals", threadId: "thread-1" }]);
  });

  test("invalidates approvals for the thread in approval.resolved", () => {
    const harness = createHarness();

    route(threadEvent("approval.resolved", resolvedApproval, { aggregateId: "thread-aggregate" }), harness.invalidate);

    expect(harness.invalidations).toEqual([{ tag: "approvals", threadId: "thread-1" }]);
  });
});

describe("approval notifications", () => {
  const calls: Array<{ title: string; options: NotificationOptions }> = [];
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

  class NotificationStub {
    static permission: NotificationPermission = "granted";
    constructor(title: string, options: NotificationOptions) {
      calls.push({ title, options });
    }
  }

  beforeEach(() => {
    calls.length = 0;
    NotificationStub.permission = "granted";
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: NotificationStub });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { hidden: false, hasFocus: () => true },
    });
  });

  afterEach(() => {
    if (originalNotification === undefined) Reflect.deleteProperty(globalThis, "Notification");
    else Object.defineProperty(globalThis, "Notification", originalNotification);
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", originalDocument);
  });

  test("names the Bot, action, and path with a unique tag for each approval.requested", () => {
    const context = {
      selectedBotId: "bot-2",
      botName: (botId: string) => botId === "bot-1" ? "Research Bot" : undefined,
    };
    const approvals: ApprovalDto[] = [
      pendingApproval,
      { ...pendingApproval, id: "approval-2", tool: "write" },
      { ...pendingApproval, id: "approval-3", tool: "edit" },
    ];

    for (const approval of approvals) {
      notifyForAttentionEvent(threadEvent("approval.requested", approval), context);
    }

    expect(calls).toHaveLength(3);
    for (const [index, approval] of approvals.entries()) {
      const { title, options } = calls[index]!;
      const text = `${title} ${options.body ?? ""}`;
      expect(text).toContain("Research Bot");
      expect(text).toContain(approval.tool);
      expect(text).toContain(approval.path);
      expect(options.tag).toBe(`omarchy-bot:bot-1:approval:${approval.id}`);
    }
  });

  test("does not notify for approval.resolved", () => {
    notifyForAttentionEvent(threadEvent("approval.resolved", resolvedApproval), {
      selectedBotId: "bot-2",
      botName: () => "Research Bot",
    });

    expect(calls).toEqual([]);
  });

  test("uses A Bot when the requesting Bot name is unknown", () => {
    notifyForAttentionEvent(threadEvent("approval.requested", pendingApproval), {
      botName: () => undefined,
    });

    expect(calls).toHaveLength(1);
    expect(`${calls[0]!.title} ${calls[0]!.options.body ?? ""}`).toContain("A Bot");
  });

  test.each(["default", "denied"] as const)("suppresses approval.requested with %s Notification permission", (permission) => {
    NotificationStub.permission = permission;

    notifyForAttentionEvent(threadEvent("approval.requested", pendingApproval), { selectedBotId: "bot-2" });

    expect(calls).toHaveLength(0);
  });

  test("suppresses approval.requested for the selected Bot in a focused, visible document", () => {
    notifyForAttentionEvent(threadEvent("approval.requested", pendingApproval), { selectedBotId: pendingApproval.botId });

    expect(calls).toHaveLength(0);
  });

  describe("startEventPump", () => {
    const sockets: FakeWebSocket[] = [];
    const approvalInvalidations: Array<string | undefined> = [];
    let reconnect: (() => void) | undefined;
    let stop: (() => void) | undefined;
    const originalWebSocket = globalThis.WebSocket;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalShell = globalThis.__OMARCHY_BOT_SHELL__;

    class FakeWebSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      readonly sent: ClientToServer[] = [];

      constructor() { sockets.push(this); }
      open(): void { this.onopen?.(); }
      close(): void { this.onclose?.(); }
      send(data: string): void { this.sent.push(JSON.parse(data) as ClientToServer); }
      message(frame: ServerToClient): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
      event(envelope: EventEnvelope): void { this.message({ type: "event", envelope }); }
    }

    beforeEach(() => {
      sockets.length = 0;
      approvalInvalidations.length = 0;
      reconnect = undefined;
      installShell(createMemoryShell({ storage: null, baseUrl: "https://client.example" }));
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { setTimeout: (callback: () => void) => { reconnect = callback; } },
      });
    });

    afterEach(() => {
      stop?.();
      stop = undefined;
      globalThis.WebSocket = originalWebSocket;
      globalThis.__OMARCHY_BOT_SHELL__ = originalShell;
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", originalWindow);
    });

    function start(): FakeWebSocket {
      stop = startEventPump(
        (tag, threadId) => { if (tag === "approvals") approvalInvalidations.push(threadId); },
        () => {},
        async () => true,
        () => ({ selectedBotId: "bot-2" }),
      );
      const socket = sockets[0]!;
      socket.open();
      expect(socket.sent).toEqual([{ type: "hello" }]);
      return socket;
    }

    function liveConnection(): FakeWebSocket {
      const socket = start();
      socket.event(threadEvent("thread.created", {}, { cursor: 1 }));
      socket.message({ type: "hello", cursor: 1 });
      return socket;
    }

    async function resume(previous: FakeWebSocket, lastCursor: number): Promise<FakeWebSocket> {
      previous.close();
      const retry = reconnect!;
      reconnect = undefined;
      retry();
      await Promise.resolve();
      const socket = sockets.at(-1)!;
      expect(socket).not.toBe(previous);
      socket.open();
      expect(socket.sent).toEqual([{ type: "hello", lastCursor }]);
      return socket;
    }

    test("keeps first-connect history quiet and notifies immediately for live approval requests", () => {
      const socket = start();
      socket.event(threadEvent("approval.requested", pendingApproval, { cursor: 1 }));
      expect(approvalInvalidations).toEqual(["thread-1"]);
      socket.message({ type: "hello", cursor: 1 });
      expect(calls).toHaveLength(0);

      socket.event(threadEvent("approval.requested", { ...pendingApproval, id: "approval-live" }, { cursor: 2 }));
      expect(calls.map(({ options }) => options.tag)).toEqual(["omarchy-bot:bot-1:approval:approval-live"]);
    });

    test("notifies only for the completed turn in a mixed reconnect replay", async () => {
      const socket = await resume(liveConnection(), 1);
      socket.event(threadEvent("approval.requested", pendingApproval, { cursor: 2 }));
      socket.event({
        ...threadEvent("turn.status", {
          turnId: "turn-1",
          threadId: "thread-1",
          botId: "bot-1",
          from: "running",
          to: "completed",
        }, { cursor: 3, aggregateId: "turn-1" }),
        aggregateType: "turn",
      });

      expect(calls.map(({ options }) => options.tag)).toEqual(["omarchy-bot:bot-1:completed"]);
      socket.message({ type: "hello", cursor: 1 });
      expect(calls).toHaveLength(1);
    });

    test("keeps reconnect replay quiet when the approval was resolved", async () => {
      const socket = await resume(liveConnection(), 1);
      socket.event(threadEvent("approval.requested", pendingApproval, { cursor: 2 }));
      socket.event(threadEvent("approval.resolved", resolvedApproval, { cursor: 3 }));
      expect(approvalInvalidations).toEqual(["thread-1", "thread-1"]);
      socket.message({ type: "hello", cursor: 1 });

      expect(calls).toHaveLength(0);
    });

    test("keeps reconnect replay quiet for a pending approval and notifies for the next live request", async () => {
      const socket = await resume(liveConnection(), 1);
      socket.event(threadEvent("approval.requested", pendingApproval, { cursor: 2 }));
      expect(approvalInvalidations).toEqual(["thread-1"]);
      expect(calls).toHaveLength(0);

      socket.message({ type: "hello", cursor: 1 });
      expect(calls).toHaveLength(0);

      socket.event(threadEvent("approval.requested", { ...pendingApproval, id: "approval-live" }, { cursor: 3 }));
      expect(calls.map(({ options }) => options.tag)).toEqual(["omarchy-bot:bot-1:approval:approval-live"]);
    });
  });
});

describe("route streaming payloads", () => {
  test("applies every consecutive response.updated payload without invalidating messages", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [responseMessage("I")] });
    const deltas = ["I", "I am", "I am working"];

    for (const text of deltas) {
      route(threadEvent("response.updated", responseMessage(text)), harness.invalidate, harness.applyUpdate);
      expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual([text]);
    }

    expect(harness.applied).toHaveLength(deltas.length);
    expect(harness.invalidations).toEqual([]);
    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am working"]);
  });

  test("applies every consecutive thinking.updated payload without invalidating messages", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [thinkingMessage("T")] });
    const deltas = ["T", "Th", "Thinking"];

    for (const text of deltas) {
      route(threadEvent("thinking.updated", thinkingMessage(text)), harness.invalidate, harness.applyUpdate);
    }

    expect(harness.applied).toHaveLength(deltas.length);
    expect(harness.invalidations).toEqual([]);
    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["Thinking"]);
  });

  test("applies every consecutive tool.updated payload without invalidating messages", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [toolMessage()] });
    const summaries: ToolCallSummaryDto[] = [
      { id: "tool-1", name: "read", status: "running" },
      { id: "tool-1", name: "read", status: "running", target: "src/index.ts" },
      { id: "tool-1", name: "read", status: "completed", durationMs: 12 },
    ];

    for (const summary of summaries) {
      route(threadEvent("tool.updated", toolUpdatePayload(summary)), harness.invalidate, harness.applyUpdate);
      expect(harness.cached("thread-1")?.map((message) => message.toolCall)).toEqual([summary]);
    }

    expect(harness.applied).toHaveLength(summaries.length);
    expect(harness.invalidations).toEqual([]);
    expect(harness.cached("thread-1")).toEqual([
      expect.objectContaining({ id: "message-tool", toolCall: summaries.at(-1) }),
    ]);
  });

  test("falls back to invalidation for malformed response.updated payloads", () => {
    const cached = [responseMessage("I")];
    const malformed = [
      {},
      { threadId: "thread-1", id: "message-response", text: "I am" },
      { ...responseMessage("I am"), text: 42 },
    ];

    for (const payload of malformed) {
      const harness = createHarness({ threadId: "thread-1", messages: [...cached] });

      route(threadEvent("response.updated", payload), harness.invalidate, harness.applyUpdate);

      expect(harness.applied).toEqual([]);
      expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
      expect(harness.cached("thread-1")).toEqual(cached);
    }
  });

  test("falls back to invalidation for malformed thinking.updated payloads", () => {
    const cached = [thinkingMessage("T")];
    const malformed = [
      {},
      { threadId: "thread-1", id: "message-thinking", text: "Th" },
      { ...thinkingMessage("Th"), thinking: { blockId: "block-thinking", state: "finished" } },
    ];

    for (const payload of malformed) {
      const harness = createHarness({ threadId: "thread-1", messages: [...cached] });

      route(threadEvent("thinking.updated", payload), harness.invalidate, harness.applyUpdate);

      expect(harness.applied).toEqual([]);
      expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
      expect(harness.cached("thread-1")).toEqual(cached);
    }
  });

  test("falls back to invalidation for malformed tool.updated payloads", () => {
    const cached = [toolMessage()];
    const malformed = [
      {},
      toolUpdatePayload(undefined),
      toolUpdatePayload({ id: "tool-1", name: "read" }),
      toolUpdatePayload({ id: "tool-1", name: "read", status: "finished" }),
      toolUpdatePayload({ id: "", name: "read", status: "running" }),
      toolUpdatePayload({ id: "tool-1", name: "read", status: "running" }, { threadId: 7 }),
      toolUpdatePayload({ id: "tool-1", name: "read", status: "running" }, { messageId: undefined }),
    ];

    for (const payload of malformed) {
      const harness = createHarness({ threadId: "thread-1", messages: [...cached] });

      route(threadEvent("tool.updated", payload), harness.invalidate, harness.applyUpdate);

      expect(harness.applied).toEqual([]);
      expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
      expect(harness.cached("thread-1")).toEqual(cached);
    }
  });

  test("refetches when the tool.updated row is not cached", () => {
    const cached = [responseMessage("I am working")];
    const harness = createHarness({ threadId: "thread-1", messages: [...cached] });

    route(
      threadEvent("tool.updated", toolUpdatePayload({ id: "tool-1", name: "read", status: "running" })),
      harness.invalidate,
      harness.applyUpdate,
    );

    expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
    expect(harness.cached("thread-1")).toEqual(cached);
  });

  test("keeps removed, native, and appended events on invalidation", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [responseMessage("I am")] });
    const envelopes = [
      threadEvent("response.removed", { threadId: "thread-1", turnId: "turn-1", count: 1 }),
      threadEvent("thinking.removed", { threadId: "thread-1", turnId: "turn-1", count: 1 }),
      threadEvent("agent.native", {
        threadId: "thread-1",
        botId: "bot-1",
        capability: "agent-native",
        sensitivity: "public",
        payload: { type: "diagnostic" },
      }),
    ];

    for (const envelope of envelopes) {
      route(envelope, harness.invalidate, harness.applyUpdate);
    }

    expect(harness.applied).toEqual([]);
    expect(harness.messagesInvalidations()).toEqual(
      envelopes.map(() => ({ tag: "messages", threadId: "thread-1" })),
    );
    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am"]);
  });

  test("keeps message.appended on invalidation", () => {
    const harness = createHarness();

    route(threadEvent("message.appended", responseMessage("")), harness.invalidate, harness.applyUpdate);

    expect(harness.applied).toEqual([]);
    expect(harness.invalidations).toEqual([
      { tag: "messages", threadId: "thread-1" },
      { tag: "threads" },
      { tag: "bots" },
    ]);
  });

  test("keys the cache patch on the payload threadId rather than the aggregate", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [responseMessage("I")] });

    route(
      threadEvent("response.updated", responseMessage("I am", { threadId: "thread-1" }), { aggregateId: "thread-aggregate" }),
      harness.invalidate,
      harness.applyUpdate,
    );

    expect(harness.applied.map((call) => call.threadId)).toEqual(["thread-1"]);
    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am"]);
    expect(harness.cached("thread-aggregate")).toBeUndefined();
  });

  test("invalidates once instead of seeding a transcript that is not cached", () => {
    const harness = createHarness();
    const setQueryData = spyOn(harness.queryClient, "setQueryData");

    route(threadEvent("response.updated", responseMessage("I am")), harness.invalidate, harness.applyUpdate);

    expect(setQueryData).not.toHaveBeenCalled();
    expect(harness.applied).toHaveLength(1);
    expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
    expect(harness.cached("thread-1")).toBeUndefined();
    setQueryData.mockRestore();
  });

  test("patches an empty cached transcript instead of invalidating", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [] });

    route(threadEvent("response.updated", responseMessage("I am")), harness.invalidate, harness.applyUpdate);

    expect(harness.messagesInvalidations()).toEqual([]);
    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am"]);
  });

  test("invalidates once without writing when the cached transcript is not an array", () => {
    const harness = createHarness();
    const unexpected = { messages: [] as string[] };
    harness.queryClient.setQueryData([...MESSAGES_KEY], unexpected);
    const setQueryData = spyOn(harness.queryClient, "setQueryData");

    route(threadEvent("response.updated", responseMessage("I am")), harness.invalidate, harness.applyUpdate);

    expect(setQueryData).not.toHaveBeenCalled();
    expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
    expect(harness.queryClient.getQueryData<typeof unexpected>([...MESSAGES_KEY])).toEqual(unexpected);
    setQueryData.mockRestore();
  });

  test("merges streamed deltas that the running transcript fetch predates", async () => {
    const pending = deferred<MessageDto[]>();
    const harness = createHarness(undefined, () => pending.promise);
    const fetching = harness.queryClient.fetchQuery({
      queryKey: [...MESSAGES_KEY],
      queryFn: () => harness.stream.fetchMessages("thread-1"),
    });

    // Opening a thread appends its response row while the initial fetch is running.
    route(threadEvent("message.appended", responseMessage("")), harness.invalidate, harness.applyUpdate);
    route(threadEvent("response.updated", responseMessage("I"), { cursor: 11 }), harness.invalidate, harness.applyUpdate);
    route(threadEvent("response.updated", responseMessage("I am"), { cursor: 12 }), harness.invalidate, harness.applyUpdate);

    // Only the structural append refetches; the deltas ride on the running fetch.
    expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);

    // The fetch snapshot has no rows, so it predates both deltas.
    pending.resolve([]);
    await fetching;

    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am"]);
    expect(harness.cached("thread-1")?.map((message) => message.id)).toEqual(["message-response"]);
  });

  test("passes the envelope cursor so a replayed payload cannot replace newer text", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [responseMessage("I")] });

    route(threadEvent("response.updated", responseMessage("I am working"), { cursor: 6 }), harness.invalidate, harness.applyUpdate);
    route(threadEvent("response.updated", responseMessage("I"), { cursor: 5 }), harness.invalidate, harness.applyUpdate);

    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am working"]);

    route(threadEvent("response.updated", responseMessage("I am working!"), { cursor: 7 }), harness.invalidate, harness.applyUpdate);

    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I am working!"]);
    expect(harness.messagesInvalidations()).toEqual([]);
  });

  test("falls back to invalidation when no applyUpdate handler is supplied", () => {
    const harness = createHarness({ threadId: "thread-1", messages: [responseMessage("I")] });

    route(threadEvent("response.updated", responseMessage("I am")), harness.invalidate);

    expect(harness.messagesInvalidations()).toEqual([{ tag: "messages", threadId: "thread-1" }]);
    expect(harness.cached("thread-1")?.map((message) => message.text)).toEqual(["I"]);
  });
});

describe("patchCachedMessage", () => {
  test("replaces the cached record by id without touching the other rows", () => {
    const userMessage = MessageDto.parse({
      id: "message-user",
      threadId: "thread-1",
      seq: 1,
      author: { kind: "user" },
      kind: "text",
      text: "hello",
      createdAt: STARTED_AT,
    });
    const cached = [userMessage, responseMessage("I")];

    const patched = patchCachedMessage(cached, responseMessage("I am"));

    expect(patched?.map((message) => message.id)).toEqual(["message-user", "message-response"]);
    expect(patched?.map((message) => message.seq)).toEqual([1, 2]);
    expect(patched?.at(-1)?.text).toBe("I am");
  });

  test("does not regress a completed block to streaming", () => {
    const completed = responseMessage("I am done", {
      response: {
        blockId: "block-response",
        state: "completed",
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
      },
    });

    const patched = patchCachedMessage([completed], responseMessage("I am"));

    expect(patched).toBeUndefined();
  });

  test("inserts an unseen record in seq order", () => {
    const first = responseMessage("one", { id: "message-1", seq: 1 });
    const third = responseMessage("three", { id: "message-3", seq: 3 });
    const second = responseMessage("two", { id: "message-2", seq: 2 });

    const patched = patchCachedMessage([first, third], second);

    expect(patched?.map((message) => message.id)).toEqual(["message-1", "message-2", "message-3"]);
  });

  test("returns undefined when the transcript is not cached", () => {
    expect(patchCachedMessage(undefined, responseMessage("I am"))).toBeUndefined();
  });
});

describe("patchCachedToolCall", () => {
  test("replaces the matching tool row and keeps the other rows", () => {
    const toolCall = ToolCallSummaryDto.parse({ id: "tool-1", name: "read", status: "completed", durationMs: 12 });
    const cached = [responseMessage("I am working"), toolMessage()];

    const patched = patchCachedToolCall(cached, "message-tool", toolCall);

    expect(patched?.map((message) => message.id)).toEqual(["message-response", "message-tool"]);
    expect(patched?.at(-1)?.toolCall).toEqual(toolCall);
    expect(patched?.at(0)?.text).toBe("I am working");
  });

  test("returns undefined when the row is not cached", () => {
    const toolCall = ToolCallSummaryDto.parse({ id: "tool-1", name: "read", status: "running" });

    expect(patchCachedToolCall([responseMessage("I")], "message-tool", toolCall)).toBeUndefined();
    expect(patchCachedToolCall(undefined, "message-tool", toolCall)).toBeUndefined();
  });

  test("returns undefined when the cached row is not a Tool Call", () => {
    const toolCall = ToolCallSummaryDto.parse({ id: "tool-1", name: "read", status: "running" });

    expect(patchCachedToolCall([responseMessage("I")], "message-response", toolCall)).toBeUndefined();
  });
});
