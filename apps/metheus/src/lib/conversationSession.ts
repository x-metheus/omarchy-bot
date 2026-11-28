import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  AttachmentSelectionError,
  maxAttachments,
  type DraftAttachment,
} from "./agentAttachments.ts";
import {
  agentDaemon,
  DaemonError,
  followConversation,
  type AgentConversation,
  type AgentMessage,
  type AgentWork,
  type ConversationFrame,
  type ToolProgress,
} from "./agentDaemon.ts";
import { getShell, type DesktopSelection, type DesktopSelectionKind } from "./shell.ts";

export type ConversationConnection = "connecting" | "connected" | "offline";
export type DesktopContext = DesktopSelection & { kind: DesktopSelectionKind };
export type TraceStatus = "running" | "error" | "pending" | undefined;

export interface ConversationFeed {
  cursor: string;
  conversation?: AgentConversation;
  replies: Map<number, AgentMessage>;
  work: Map<number, AgentWork>;
  tools: Map<string, ToolProgress>;
  delta: string;
  error: string;
  draft: string;
  attachments: DraftAttachment[];
  desktop?: DesktopContext;
  failure: string;
  submitting: boolean;
  version: number;
  listeners: Set<() => void>;
}

export interface ConversationTransport {
  conversation: (botId: string, signal?: AbortSignal) => Promise<AgentConversation>;
  follow: (
    botId: string,
    cursor: string,
    signal: AbortSignal,
    connected: () => void,
    received: (frame: ConversationFrame) => void,
  ) => Promise<void>;
  send: (
    botId: string,
    text: string,
    selected: readonly DraftAttachment[],
    desktopSession?: string,
  ) => Promise<void>;
  retry: (botId: string, messageId: number) => Promise<void>;
  chooseDesktopPath?: (kind: DesktopSelectionKind) => Promise<DesktopSelection | null>;
}

export function createConversationFeed(): ConversationFeed {
  return {
    cursor: "0",
    replies: new Map(),
    work: new Map(),
    tools: new Map(),
    delta: "",
    error: "",
    draft: "",
    attachments: [],
    failure: "",
    submitting: false,
    version: 0,
    listeners: new Set(),
  };
}

export interface FrameEffect {
  needsRefresh: boolean;
  changed: boolean;
}

export function applyConversationFrame(feed: ConversationFeed, frame: ConversationFrame): FrameEffect {
  feed.cursor = frame.id;
  switch (frame.event) {
    case "work": {
      const work = frame.data as AgentWork;
      feed.work.set(work.messageId, work);
      if (work.status === "interrupted") feed.delta = "";
      return { needsRefresh: work.status === "queued", changed: true };
    }
    case "delta":
      if (typeof frame.data === "string") feed.delta += frame.data;
      feed.error = "";
      return { needsRefresh: false, changed: true };
    case "committed": {
      const reply = frame.data as AgentMessage;
      if (!feed.conversation?.messages.some(message => message.id === reply.id)) {
        feed.replies.set(reply.id, reply);
      }
      feed.delta = "";
      feed.error = "";
      return { needsRefresh: true, changed: true };
    }
    case "error":
      feed.delta = "";
      feed.error =
        frame.data &&
        typeof frame.data === "object" &&
        "message" in frame.data &&
        typeof frame.data.message === "string"
          ? frame.data.message
          : "The Agent could not complete the reply.";
      return { needsRefresh: false, changed: true };
    case "tool": {
      const tool = frame.data as ToolProgress;
      feed.tools.set(tool.id, tool);
      return { needsRefresh: false, changed: true };
    }
    default:
      return { needsRefresh: false, changed: false };
  }
}

export function reconcileConversationSnapshot(feed: ConversationFeed, snapshot: AgentConversation): void {
  feed.conversation = snapshot;
  for (const message of snapshot.messages) feed.replies.delete(message.id);
}

export function selectOrderedMessages(feed: ConversationFeed): AgentMessage[] {
  return [...(feed.conversation?.messages ?? []), ...feed.replies.values()].sort((a, b) => a.id - b.id);
}

export function selectVisibleTools(feed: ConversationFeed, maxCompleted = 5): ToolProgress[] {
  const tools = [...feed.tools.values()];
  return tools.filter((tool, index) => tool.status === "running" || index >= tools.length - maxCompleted);
}

export function mapToolStatusToTrace(status: ToolProgress["status"]): TraceStatus {
  switch (status) {
    case "running":
      return "running";
    case "failed":
    case "interrupted":
      return "error";
    case "cancelled":
    case "completed":
      return undefined;
  }
}

export function appendDraftAttachments(
  current: readonly DraftAttachment[],
  incoming: readonly DraftAttachment[],
): { next: DraftAttachment[]; error?: string } {
  if (!incoming.length) return { next: [...current] };
  if (current.length + incoming.length > maxAttachments) {
    return {
      next: [...current],
      error: `A message can include up to ${maxAttachments} attachments.`,
    };
  }
  return { next: [...current, ...incoming] };
}

function createDaemonConversationTransport(): ConversationTransport {
  const desktopTools = getShell().desktopTools;
  return {
    conversation: (botId, signal) => agentDaemon.conversation(botId, signal),
    follow: followConversation,
    send: (botId, text, selected, desktopSession) =>
      agentDaemon.send(botId, text, selected, desktopSession),
    retry: (botId, messageId) => agentDaemon.retry(botId, messageId),
    ...(desktopTools ? { chooseDesktopPath: kind => desktopTools.choose(kind) } : {}),
  };
}

export function useConversationSession(
  botId: string,
  feed: ConversationFeed,
  {
    onMissing,
    transport,
    reconnectDelayMs = 1000,
  }: {
    onMissing: (botId: string) => void;
    transport?: ConversationTransport;
    reconnectDelayMs?: number;
  },
) {
  const [connection, setConnection] = useState<ConversationConnection>("connecting");
  const [defaultTransport] = useState(() => transport ?? createDaemonConversationTransport());
  const activeTransport = transport ?? defaultTransport;
  const hasDesktopTools = Boolean(activeTransport.chooseDesktopPath);

  const subscribe = useCallback((listener: () => void) => {
    feed.listeners.add(listener);
    return () => { feed.listeners.delete(listener); };
  }, [feed]);
  useSyncExternalStore(subscribe, () => feed.version);

  const notify = useCallback(() => {
    feed.version += 1;
    for (const listener of feed.listeners) listener();
  }, [feed]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let refreshing = false;
    let refreshAgain = false;

    async function refresh() {
      refreshAgain = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (refreshAgain && !signal.aborted) {
          refreshAgain = false;
          const result = await activeTransport.conversation(botId, signal);
          if (signal.aborted) break;
          reconcileConversationSnapshot(feed, result);
          notify();
        }
      } catch (error) {
        if (!signal.aborted && error instanceof DaemonError && error.status === 404) {
          onMissing(botId);
        }
      } finally {
        refreshing = false;
      }
    }

    async function connect() {
      while (!signal.aborted) {
        try {
          await activeTransport.follow(
            botId,
            feed.cursor,
            signal,
            () => {
              if (signal.aborted) return;
              setConnection("connected");
              void refresh();
            },
            frame => {
              if (signal.aborted) return;
              const effect = applyConversationFrame(feed, frame);
              if (effect.needsRefresh) void refresh();
              if (effect.changed) notify();
            },
          );
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof DaemonError && error.status === 401) return;
          if (error instanceof DaemonError && error.status === 404) {
            onMissing(botId);
            return;
          }
        }
        if (signal.aborted) return;
        setConnection("offline");
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, reconnectDelayMs);
        const cancel = () => { clearTimeout(timer); resolve(); };
        signal.addEventListener("abort", cancel, { once: true });
        await promise;
        signal.removeEventListener("abort", cancel);
      }
    }

    void refresh();
    void connect();
    return () => controller.abort();
  }, [activeTransport, botId, feed, notify, onMissing, reconnectDelayMs]);

  const composerDisabled = connection !== "connected" || feed.submitting;

  const setDraft = useCallback((value: string) => {
    feed.draft = value;
    notify();
  }, [feed, notify]);

  const attach = useCallback((items: DraftAttachment[]) => {
    if (composerDisabled || !items.length) return;
    const result = appendDraftAttachments(feed.attachments, items);
    feed.attachments = result.next;
    feed.failure = result.error ?? "";
    notify();
  }, [composerDisabled, feed, notify]);

  const removeAttachment = useCallback((index: number) => {
    feed.attachments = feed.attachments.filter((_, position) => position !== index);
    feed.failure = "";
    notify();
  }, [feed, notify]);

  const chooseDesktopPath = useCallback(async (kind: DesktopSelectionKind) => {
    feed.failure = "";
    notify();
    try {
      const selected = await activeTransport.chooseDesktopPath?.(kind);
      if (selected && !feed.submitting) {
        feed.desktop = { ...selected, kind };
        notify();
      }
    } catch (error) {
      feed.failure = typeof error === "string" ? error : "Could not connect the desktop tools.";
      notify();
    }
  }, [activeTransport, feed, notify]);

  const clearDesktopPath = useCallback(() => {
    delete feed.desktop;
    notify();
  }, [feed, notify]);

  const send = useCallback(async (text = feed.draft) => {
    if (!text.trim() || feed.submitting || connection !== "connected") return;
    const selectedAttachments = [...feed.attachments];
    const selectedDesktop = feed.desktop;
    feed.submitting = true;
    feed.draft = "";
    feed.failure = "";
    notify();
    try {
      await activeTransport.send(botId, text, selectedAttachments, selectedDesktop?.session);
      delete feed.desktop;
      feed.attachments = [];
    } catch (error) {
      if (error instanceof DaemonError || error instanceof AttachmentSelectionError) {
        if (!feed.draft) feed.draft = text;
        feed.failure = error.message;
      } else {
        feed.attachments = [];
        feed.failure = "Could not confirm submission. Check the Conversation before sending it again.";
      }
    } finally {
      feed.submitting = false;
      notify();
    }
  }, [activeTransport, botId, connection, feed, notify]);

  const retry = useCallback(async (messageId: number) => {
    feed.failure = "";
    notify();
    try {
      await activeTransport.retry(botId, messageId);
    } catch (error) {
      feed.failure =
        error instanceof DaemonError ? error.message : "Could not confirm retry. Check the work status.";
      notify();
    }
  }, [activeTransport, botId, feed, notify]);

  return {
    bot: feed.conversation?.bot,
    messages: selectOrderedMessages(feed),
    work: feed.work,
    delta: feed.delta,
    visibleTools: selectVisibleTools(feed),
    connection,
    submitting: feed.submitting,
    hasHistory: feed.conversation !== undefined,
    composerDisabled,
    hasDesktopTools,
    draft: feed.draft,
    attachments: feed.attachments,
    desktop: feed.desktop,
    error: feed.failure || feed.error,
    setDraft,
    attach,
    removeAttachment,
    chooseDesktopPath,
    clearDesktopPath,
    send,
    retry,
  };
}
