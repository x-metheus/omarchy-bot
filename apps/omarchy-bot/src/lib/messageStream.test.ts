import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { MessageDto } from "@omarchy-bot/protocol";
import { createMessageStream, type MessageStream } from "./messageStream.ts";
import type { Invalidate } from "./events.ts";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:00:05.000Z";
const QUERY_KEY = ["messages", "thread-1"] as const;

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

function completedMessage(text: string): MessageDto {
  return responseMessage(text, {
    response: { blockId: "block-response", state: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface StreamHarness {
  queryClient: QueryClient;
  stream: MessageStream;
  invalidations: Array<{ tag: string; threadId?: string }>;
}

function createStreamHarness(listMessages: (threadId: string) => Promise<MessageDto[]>): StreamHarness {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidations: Array<{ tag: string; threadId?: string }> = [];
  const invalidate: Invalidate = (tag, threadId) => {
    invalidations.push(threadId === undefined ? { tag } : { tag, threadId });
  };
  const stream = createMessageStream({ queryClient, invalidate, listMessages });
  return { queryClient, stream, invalidations };
}

function cachedTexts(queryClient: QueryClient): string[] | undefined {
  return queryClient.getQueryData<MessageDto[]>([...QUERY_KEY])?.map((message) => message.text ?? "");
}

describe("createMessageStream transcript refetches", () => {
  test("keeps a streamed patch when an older transcript refetch resolves afterwards", async () => {
    const fetched = deferred<MessageDto[]>();
    const { queryClient, stream } = createStreamHarness(() => fetched.promise);
    queryClient.setQueryData([...QUERY_KEY], [responseMessage("I")]);

    const refetch = queryClient.fetchQuery({
      queryKey: [...QUERY_KEY],
      queryFn: () => stream.fetchMessages("thread-1"),
    });
    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am working"), cursor: 5 });
    fetched.resolve([responseMessage("I")]);

    await refetch;

    expect(cachedTexts(queryClient)).toEqual(["I am working"]);
  });

  test("adds rows an older transcript refetch saw while keeping the streamed patch", async () => {
    const userMessage = MessageDto.parse({
      id: "message-user",
      threadId: "thread-1",
      seq: 1,
      author: { kind: "user" },
      kind: "text",
      text: "hello",
      createdAt: STARTED_AT,
    });
    const fetched = deferred<MessageDto[]>();
    const { queryClient, stream } = createStreamHarness(() => fetched.promise);
    queryClient.setQueryData([...QUERY_KEY], [responseMessage("I")]);

    const refetch = queryClient.fetchQuery({
      queryKey: [...QUERY_KEY],
      queryFn: () => stream.fetchMessages("thread-1"),
    });
    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am working"), cursor: 5 });
    fetched.resolve([userMessage, responseMessage("I")]);

    await refetch;

    expect(queryClient.getQueryData<MessageDto[]>([...QUERY_KEY])?.map((message) => message.id))
      .toEqual(["message-user", "message-response"]);
    expect(cachedTexts(queryClient)).toEqual(["hello", "I am working"]);
  });

  test("applies a transcript refetch that starts after the last streamed patch", async () => {
    const { queryClient, stream } = createStreamHarness(async () => [responseMessage("I am working!")]);

    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am working"), cursor: 5 });
    await queryClient.fetchQuery({
      queryKey: [...QUERY_KEY],
      queryFn: () => stream.fetchMessages("thread-1"),
    });

    expect(cachedTexts(queryClient)).toEqual(["I am working!"]);
  });
});

describe("createMessageStream buffered deltas", () => {
  function thinkingMessage(text: string, overrides: Partial<MessageDto> = {}): MessageDto {
    return MessageDto.parse({
      id: "message-thinking",
      threadId: "thread-1",
      seq: 2,
      author: { kind: "bot" },
      kind: "thinking",
      text,
      thinking: { blockId: "block-thinking", state: "streaming", startedAt: STARTED_AT },
      createdAt: STARTED_AT,
      ...overrides,
    });
  }

  function userMessage(text: string, seq: number): MessageDto {
    return MessageDto.parse({
      id: "message-user",
      threadId: "thread-1",
      seq,
      author: { kind: "user" },
      kind: "text",
      text,
      createdAt: STARTED_AT,
    });
  }

  test("schedules one transcript fetch for an unloaded transcript and keeps the delta it missed", async () => {
    const fetched = deferred<MessageDto[]>();
    const { queryClient, stream, invalidations } = createStreamHarness(() => fetched.promise);
    const setQueryData = spyOn(queryClient, "setQueryData");

    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am"), cursor: 5 });

    expect(invalidations).toEqual([{ tag: "messages", threadId: "thread-1" }]);
    expect(setQueryData).not.toHaveBeenCalled();
    expect(queryClient.getQueryData([...QUERY_KEY])).toBeUndefined();
    setQueryData.mockRestore();

    const fetching = queryClient.fetchQuery({
      queryKey: [...QUERY_KEY],
      queryFn: () => stream.fetchMessages("thread-1"),
    });
    // The snapshot was read before the daemon persisted the delta.
    fetched.resolve([]);
    await fetching;

    expect(cachedTexts(queryClient)).toEqual(["I am"]);
  });

  test("keeps a snapshot row over a delta it predates and adds a row the snapshot lacks", async () => {
    const fetched = deferred<MessageDto[]>();
    const { queryClient, stream } = createStreamHarness(() => fetched.promise);

    // Buffered before the fetch starts: the snapshot already carries this row.
    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I", { seq: 3 }), cursor: 3 });
    const fetching = queryClient.fetchQuery({
      queryKey: [...QUERY_KEY],
      queryFn: () => stream.fetchMessages("thread-1"),
    });
    // Buffered while the fetch runs: the snapshot predates this row.
    stream.applyUpdate("thread-1", { kind: "message", message: thinkingMessage("Th"), cursor: 8 });

    fetched.resolve([userMessage("hello", 1), responseMessage("I am done", { seq: 3 })]);
    await fetching;

    expect(queryClient.getQueryData<MessageDto[]>([...QUERY_KEY])?.map((message) => message.id))
      .toEqual(["message-user", "message-thinking", "message-response"]);
    expect(cachedTexts(queryClient)).toEqual(["hello", "Th", "I am done"]);
  });

  test("leaves the buffered deltas to the newest transcript fetch", async () => {
    const first = deferred<MessageDto[]>();
    const second = deferred<MessageDto[]>();
    const snapshots = [first, second];
    const { stream } = createStreamHarness(() => snapshots.shift()!.promise);

    const superseded = stream.fetchMessages("thread-1");
    const current = stream.fetchMessages("thread-1");
    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am"), cursor: 5 });

    first.resolve([]);
    expect(await superseded).toEqual([]);
    second.resolve([]);

    expect((await current).map((message) => message.text)).toEqual(["I am"]);
  });
});

describe("createMessageStream payload ordering", () => {
  test("ignores a replayed payload older than the applied cursor for the message", () => {
    const { queryClient, stream, invalidations } = createStreamHarness(async () => []);
    queryClient.setQueryData([...QUERY_KEY], [responseMessage("I")]);

    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am working"), cursor: 6 });
    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I"), cursor: 5 });

    expect(cachedTexts(queryClient)).toEqual(["I am working"]);

    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am working!"), cursor: 7 });

    expect(cachedTexts(queryClient)).toEqual(["I am working!"]);
    expect(invalidations).toEqual([]);
  });

  test("ignores a late completed payload that would shorten the applied text", () => {
    const { queryClient, stream } = createStreamHarness(async () => []);
    queryClient.setQueryData([...QUERY_KEY], [completedMessage("I am working")]);

    stream.applyUpdate("thread-1", { kind: "message", message: completedMessage("I am working"), cursor: 6 });
    stream.applyUpdate("thread-1", { kind: "message", message: completedMessage("I"), cursor: 5 });

    expect(cachedTexts(queryClient)).toEqual(["I am working"]);
  });

  test("orders payloads per message id rather than by thread-wide arrival", () => {
    const { queryClient, stream } = createStreamHarness(async () => []);
    queryClient.setQueryData([...QUERY_KEY], []);
    const thinking = MessageDto.parse({
      id: "message-thinking",
      threadId: "thread-1",
      seq: 1,
      author: { kind: "bot" },
      kind: "thinking",
      text: "Th",
      thinking: { blockId: "block-thinking", state: "streaming", startedAt: STARTED_AT },
      createdAt: STARTED_AT,
    });

    stream.applyUpdate("thread-1", { kind: "message", message: responseMessage("I am working"), cursor: 7 });
    stream.applyUpdate("thread-1", { kind: "message", message: thinking, cursor: 3 });

    expect(cachedTexts(queryClient)).toEqual(["Th", "I am working"]);
    expect(queryClient.getQueryData<MessageDto[]>([...QUERY_KEY])?.map((message) => message.id))
      .toEqual(["message-thinking", "message-response"]);
  });
});
