import type { QueryClient } from "@tanstack/react-query";
import type { MessageDto } from "@omarchy-bot/protocol";
import {
  patchCachedMessage,
  patchCachedToolCall,
  type ApplyTranscriptUpdate,
  type Invalidate,
  type TranscriptUpdate,
} from "./events.ts";

export interface MessageStreamOptions {
  queryClient: QueryClient;
  invalidate: Invalidate;
  listMessages: (threadId: string) => Promise<MessageDto[]>;
}

export interface MessageStream {
  /** Event-pump seam: patches a loaded transcript instead of refetching it. */
  applyUpdate: ApplyTranscriptUpdate;
  /** Loads one transcript, merging the streamed payloads its snapshot predates. */
  fetchMessages: (threadId: string) => Promise<MessageDto[]>;
}

function messagesKey(threadId: string): [string, string] {
  return ["messages", threadId];
}

function messageIdOf(update: TranscriptUpdate): string {
  return update.kind === "message" ? update.message.id : update.messageId;
}

/**
 * Merges the rows a refetch saw but the patched cache does not, so an appended
 * message still appears. Cached rows win: they are newer than the snapshot.
 */
export function mergeFetchedMessages(cached: MessageDto[], fetched: MessageDto[]): MessageDto[] {
  const known = new Set(cached.map((message) => message.id));
  const missing = fetched.filter((message) => !known.has(message.id));
  if (missing.length === 0) return cached;
  const next = [...cached];
  for (const message of missing) {
    const insertAt = next.findIndex((candidate) => candidate.seq > message.seq);
    next.splice(insertAt === -1 ? next.length : insertAt, 0, message);
  }
  return next;
}

/**
 * One transcript payload that arrived while the transcript was not cached, kept
 * until a transcript fetch can merge it. `order` places it against fetch starts.
 */
interface BufferedUpdate {
  order: number;
  update: TranscriptUpdate;
}

/**
 * Keeps the `["messages", threadId]` cache in stream order. `MessageDto` carries
 * no revision, so ordering comes from the WS envelope cursor (a monotonic server
 * event-log sequence), and a per-thread revision records streamed patches that a
 * refetch started earlier must not overwrite.
 */
export function createMessageStream({ queryClient, invalidate, listMessages }: MessageStreamOptions): MessageStream {
  /** Per-thread transcript revision, bumped by every applied streamed patch. */
  const revisions = new Map<string, number>();
  /** Newest applied envelope cursor per transcript record. */
  const appliedCursors = new Map<string, number>();
  /**
   * Payloads that arrived while the transcript was not cached, by thread and then
   * message id. Nothing else holds them: the fetch that loads the transcript
   * claims them and merges them into its snapshot. The queue is bounded by one
   * fetch lifetime, because a fetch claims every entry for its thread and clears
   * the thread's queue.
   */
  const bufferedUpdates = new Map<string, Map<string, BufferedUpdate>>();
  /** Newest transcript fetch started per thread; only it may claim the queue. */
  const fetchStarts = new Map<string, number>();
  /** Arrival order shared by buffered payloads and fetch starts. */
  let streamOrder = 0;

  const revisionOf = (threadId: string): number => revisions.get(threadId) ?? 0;

  // `invalidateQueries` cancels the refetch that is already in flight, so one
  // invalidation per unloaded transcript is enough: that refetch catches up.
  const refetchIfIdle = (threadId: string): void => {
    if (queryClient.isFetching({ queryKey: messagesKey(threadId) }) === 0) {
      invalidate("messages", threadId);
    }
  };

  // Keeps the highest cursor per message: a replayed envelope must not undo a
  // newer buffered payload for the same record.
  const bufferUpdate = (threadId: string, update: TranscriptUpdate): void => {
    const messageId = messageIdOf(update);
    const threadBuffer = bufferedUpdates.get(threadId) ?? new Map<string, BufferedUpdate>();
    const buffered = threadBuffer.get(messageId);
    if (buffered !== undefined && buffered.update.cursor >= update.cursor) return;
    threadBuffer.delete(messageId);
    streamOrder += 1;
    threadBuffer.set(messageId, { order: streamOrder, update });
    bufferedUpdates.set(threadId, threadBuffer);
  };

  const claimBufferedUpdates = (threadId: string): BufferedUpdate[] => {
    const threadBuffer = bufferedUpdates.get(threadId);
    if (threadBuffer === undefined) return [];
    bufferedUpdates.delete(threadId);
    return [...threadBuffer.values()];
  };

  /**
   * Replays claimed payloads onto a fetched snapshot: replace by id, insert unseen
   * rows in seq order. A payload buffered before the fetch started is already in
   * the snapshot (the daemon persists a message before emitting its event), so it
   * only survives when the snapshot lacks its row.
   */
  const mergeBufferedUpdates = (
    fetched: MessageDto[],
    buffered: BufferedUpdate[],
    fetchStartedAt: number,
  ): MessageDto[] => {
    const snapshotIds = new Set(fetched.map((message) => message.id));
    let merged = fetched;
    for (const entry of buffered) {
      const messageId = messageIdOf(entry.update);
      if (entry.order < fetchStartedAt && snapshotIds.has(messageId)) continue;
      // Only the newest payload for a record is worth applying.
      if (appliedCursors.get(messageId) !== entry.update.cursor) continue;
      const patched = entry.update.kind === "message"
        ? patchCachedMessage(merged, entry.update.message)
        : patchCachedToolCall(merged, entry.update.messageId, entry.update.toolCall);
      if (patched !== undefined) merged = patched;
    }
    return merged;
  };

  const applyUpdate: ApplyTranscriptUpdate = (threadId, update) => {
    const messageId = messageIdOf(update);
    const appliedCursor = appliedCursors.get(messageId);
    // A cursor reset replays the log, so an older payload for the same record can
    // arrive after a newer one and must not replace its text.
    if (appliedCursor !== undefined && update.cursor <= appliedCursor) return;
    appliedCursors.set(messageId, update.cursor);

    const cached: unknown = queryClient.getQueryData(messagesKey(threadId));
    if (!Array.isArray(cached)) {
      // A transcript that is not loaded yet cannot be patched and must not be
      // seeded: hold the payload for the fetch that loads it. A fetch already
      // running may predate this payload, so it is buffered even then instead of
      // being dropped.
      bufferUpdate(threadId, update);
      refetchIfIdle(threadId);
      return;
    }
    const patched = update.kind === "message"
      ? patchCachedMessage(cached as MessageDto[], update.message)
      : patchCachedToolCall(cached as MessageDto[], update.messageId, update.toolCall);
    if (patched === undefined) {
      // A Tool Call summary cannot create its transcript row; refetch it.
      if (update.kind === "toolCall") refetchIfIdle(threadId);
      return;
    }
    queryClient.setQueryData(messagesKey(threadId), patched);
    revisions.set(threadId, revisionOf(threadId) + 1);
  };

  const fetchMessages = async (threadId: string): Promise<MessageDto[]> => {
    const revisionAtStart = revisionOf(threadId);
    streamOrder += 1;
    const fetchStartedAt = streamOrder;
    fetchStarts.set(threadId, fetchStartedAt);

    const fetched = await listMessages(threadId);
    // A newer fetch for this thread owns the buffered payloads, and the client
    // keeps its result; leaving the queue to it avoids applying them twice.
    if (fetchStarts.get(threadId) !== fetchStartedAt) return fetched;

    const cached: unknown = queryClient.getQueryData(messagesKey(threadId));
    // This snapshot started before a streamed patch and is older than it; keep the
    // patched cache, but still add rows the snapshot saw for the first time.
    const snapshot = revisionOf(threadId) === revisionAtStart || !Array.isArray(cached)
      ? fetched
      : mergeFetchedMessages(cached as MessageDto[], fetched);
    const merged = mergeBufferedUpdates(snapshot, claimBufferedUpdates(threadId), fetchStartedAt);
    if (merged !== fetched) queryClient.setQueryData(messagesKey(threadId), merged);
    return merged;
  };

  return { applyUpdate, fetchMessages };
}
