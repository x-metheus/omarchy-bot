import type { EventEnvelope } from "@omarchy-bot/protocol";
import { api } from "./api.ts";
import { clearDraftsByBot } from "./drafts.ts";

export type QueryTag =
  | "agents"
  | "bots"
  | "threads"
  | "messages"
  | "turns"
  | "computer"
  | "plugins"
  | "plugin-commands";

export type Invalidate = (tag: QueryTag, threadId?: string) => void;

export interface NotificationContext {
  selectedBotId?: string;
  botName?: (botId: string) => string | undefined;
}

interface NotificationDecision {
  botId: string;
}

function notificationDecision(envelope: EventEnvelope): NotificationDecision | undefined {
  if (envelope.type !== "turn.status") return undefined;
  const payload = payloadOf(envelope);
  if (typeof payload.botId !== "string") return undefined;
  if (payload.to === "completed") return { botId: payload.botId };
  return undefined;
}

export function shouldNotifyBot(input: {
  botId: string;
  selectedBotId?: string;
  documentHidden: boolean;
  windowFocused: boolean;
}): boolean {
  return input.documentHidden || !input.windowFocused || input.selectedBotId !== input.botId;
}

/** Call only from an explicit user gesture (for example a Settings button). */
export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export function notifyForAttentionEvent(
  envelope: EventEnvelope,
  context: NotificationContext,
): Notification | undefined {
  const decision = notificationDecision(envelope);
  if (
    decision === undefined
    || typeof Notification === "undefined"
    || Notification.permission !== "granted"
    || !shouldNotifyBot({
      botId: decision.botId,
      ...(context.selectedBotId !== undefined ? { selectedBotId: context.selectedBotId } : {}),
      documentHidden: document.hidden,
      windowFocused: document.hasFocus(),
    })
  ) {
    return undefined;
  }

  const name = context.botName?.(decision.botId) ?? "Bot";
  return new Notification(
    `${name} finished working`,
    {
      body: "Background work is complete.",
      tag: `omarchy-bot:${decision.botId}:completed`,
    },
  );
}

let cursor: number | undefined;
let socket: WebSocket | undefined;
let started = false;
let handlers: {
  invalidate: Invalidate;
  onSnapshotRequired: () => void;
  getNotificationContext?: () => NotificationContext;
} | undefined;

const authorizationListeners = new Set<(envelope: EventEnvelope) => void>();
export function onPluginAuthorization(listener: (envelope: EventEnvelope) => void): () => void {
  authorizationListeners.add(listener);
  return () => { authorizationListeners.delete(listener); };
}

function payloadOf(envelope: EventEnvelope): Record<string, unknown> {
  return (envelope.payload ?? {}) as Record<string, unknown>;
}

function threadIdOf(envelope: EventEnvelope): string | undefined {
  const p = payloadOf(envelope);
  return typeof p.threadId === "string" ? p.threadId : envelope.aggregateType === "thread" ? envelope.aggregateId : undefined;
}

function route(envelope: EventEnvelope, invalidate: Invalidate): void {
  const p = payloadOf(envelope);
  switch (envelope.type) {
    case "plugin.authorization_completed":
    case "plugin.authorization_failed":
      invalidate("plugins");
      invalidate("plugin-commands");
      for (const listener of authorizationListeners) listener(envelope);
      return;
    case "agent.status":
    case "agent.error":
    case "agent.worker_crash":
      invalidate("agents");
      invalidate("bots");
      return;
    case "bot.created":
    case "bot.updated":
    case "bot.activity":
    case "bot.attention":
    case "bot.pinned":
    case "bot.read":
      invalidate("bots");
      return;
    case "bot.deleted":
      if (envelope.aggregateType === "bot") clearDraftsByBot(envelope.aggregateId);
      invalidate("messages");
      invalidate("threads");
      invalidate("bots");
      return;
    case "thread.created":
      invalidate("threads");
      invalidate("bots");
      return;
    case "message.appended": {
      invalidate("messages", threadIdOf(envelope));
      invalidate("threads");
      invalidate("bots");
      return;
    }
    case "response.updated":
    case "response.removed":
    case "thinking.updated":
    case "thinking.removed":
      invalidate("messages", threadIdOf(envelope));
      return;
    case "tool.updated":
      invalidate("messages", threadIdOf(envelope));
      return;
    case "agent.native":
      invalidate("messages", threadIdOf(envelope));
      return;
    case "turn.created":
    case "turn.status":
    case "turn.steered":
      invalidate("turns");
      invalidate("threads");
      invalidate("bots");
      return;
    case "computer.state.changed":
      invalidate("computer");
      invalidate("bots");
      return;
    default:
      return;
  }
}

/**
 * Single shared WS connection with cursor-based replay. On snapshot_required
 * (or repeated reconnects) callers refetch everything; the cursor resets.
 */
export function startEventPump(
  invalidate: Invalidate,
  onSnapshotRequired: () => void,
  getNotificationContext?: () => NotificationContext,
): void {
  handlers = {
    invalidate,
    onSnapshotRequired,
    ...(getNotificationContext !== undefined ? { getNotificationContext } : {}),
  };
  if (started) return;
  started = true;
  let retries = 0;

  const connect = (): void => {
    let notificationsReady = cursor !== undefined;
    socket = api.connectEvents(
      cursor,
      (envelope) => {
        cursor = envelope.cursor;
        const current = handlers;
        if (current === undefined) return;
        route(envelope, current.invalidate);
        if (notificationsReady && current.getNotificationContext !== undefined) {
          notifyForAttentionEvent(envelope, current.getNotificationContext());
        }
      },
      {
        snapshotRequired: () => {
          const current = handlers;
          cursor = undefined;
          notificationsReady = false;
          current?.onSnapshotRequired();
        },
        onOpen: () => {
          retries = 0;
        },
        onCaughtUp: () => {
          notificationsReady = true;
        },
      },
    );
    socket.onclose = () => {
      retries += 1;
      if (retries > 5) {
        const current = handlers;
        cursor = undefined;
        current?.onSnapshotRequired();
      }
      setTimeout(connect, Math.min(1000 * 2 ** retries, 10_000));
    };
  };
  connect();
}
