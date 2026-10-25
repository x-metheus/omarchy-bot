import type { AgentPluginTurnContext } from "./plugin-protocol.ts";
import {
  TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH,
  isToolCallSummary,
  type SurfaceId,
  type ToolCallSummary,
} from "@omarchy-bot/domain";
import type { Hello, OpenSessionOptionsLike } from "./shared.ts";
import type { AgentBotMessageTurnContext } from "./bot-message-protocol.ts";
import type { AgentLocalTurnContext } from "./local-protocol.ts";

/**
 * Normalized agent events (agents-integration.md §2). Adapters may only emit a
 * unified terminal state after the native protocol's own final event.
 */
/** Ordered Response lifecycle emitted at native text-block boundaries. */
export type AgentResponseEvent =
  | { type: "response.start"; sessionId: string; blockId: string; startedAt: string }
  | { type: "response.delta"; sessionId: string; blockId: string; text: string }
  | { type: "response.end"; sessionId: string; blockId: string; completedAt: string };

/** Ordered Thinking lifecycle emitted only at officially exposed native boundaries. */
export type AgentThinkingEvent =
  | { type: "thinking.start"; sessionId: string; blockId: string; startedAt: string }
  | { type: "thinking.delta"; sessionId: string; blockId: string; text: string }
  | { type: "thinking.end"; sessionId: string; blockId: string; completedAt: string };

type AgentToolCallEventBase = Omit<ToolCallSummary, "status"> & {
  sessionId: string;
};

export type AgentToolCallEvent =
  | (AgentToolCallEventBase & { type: "tool.started" | "tool.updated"; status: "running" })
  | (AgentToolCallEventBase & { type: "tool.completed"; status: "completed" | "error" });

const AGENT_TOOL_CALL_EVENT_KEYS: Record<
  keyof ToolCallSummary | "type" | "sessionId",
  true
> = {
  type: true,
  sessionId: true,
  id: true,
  name: true,
  status: true,
  target: true,
  durationMs: true,
  additions: true,
  deletions: true,
  errorSummary: true,
};

/** Runtime guard at the untrusted worker boundary; extra native detail is rejected. */
export function isAgentToolCallEvent(value: unknown): value is AgentToolCallEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !(key in AGENT_TOOL_CALL_EVENT_KEYS))) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) return false;
  if (
    event.type !== "tool.started" &&
    event.type !== "tool.updated" &&
    event.type !== "tool.completed"
  ) return false;
  if (!isToolCallSummary({
    id: event.id,
    name: event.name,
    status: event.status,
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.additions !== undefined ? { additions: event.additions } : {}),
    ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
    ...(event.errorSummary !== undefined ? { errorSummary: event.errorSummary } : {}),
  })) return false;
  return event.type === "tool.completed"
    ? event.status === "completed" || event.status === "error"
    : event.status === "running";
}

export function toolCallSummaryFromEvent(event: AgentToolCallEvent): ToolCallSummary {
  return {
    id: event.id,
    name: event.name,
    status: event.status,
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.additions !== undefined ? { additions: event.additions } : {}),
    ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
    ...(event.errorSummary !== undefined ? { errorSummary: event.errorSummary } : {}),
  };
}

/** Produce a one-line, bounded summary without common credential forms. */
export function redactToolErrorSummary(value: unknown): string {
  const redacted = String(value ?? "")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\b(?:paired_)?[0-9a-f]{64}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "Tool call failed.").slice(0, TOOL_CALL_ERROR_SUMMARY_MAX_LENGTH);
}

export type AgentEvent =
  | AgentResponseEvent
  | AgentThinkingEvent
  | AgentToolCallEvent
  | { type: "turn.completed"; sessionId: string; usage?: unknown }
  | { type: "turn.cancelled"; sessionId: string }
  | { type: "error"; sessionId?: string; message: string; retryable: boolean }
  | { type: "native"; sessionId?: string; agentId: string; capability: string; payload: unknown; sensitivity: "public" | "diagnostic" | "secret" };

/** Sessions are owned by a Bot+Thread pair; steering is a first-class command. */
export type AgentCommand =
  | { type: "probe"; requestId: string }
  | { type: "resources.list"; requestId: string; cwd: string }
  | { type: "mcp.control"; requestId: string; cwd: string; action: "status" | "connect" | "auth-start" | "auth-complete"; server?: string; redirectUrl?: string }
  | { type: "session.open"; requestId: string; botId: string; threadId: string; options: OpenSessionOptionsLike }
  | { type: "session.resume"; requestId: string; botId: string; threadId: string; nativeSessionId: string; options: OpenSessionOptionsLike }
  | {
      type: "message.send";
      requestId: string;
      sessionId: string;
      turnId: string;
      message: WorkerUserMessage;
      computer: AgentComputerTurnContext;
      botMessage?: AgentBotMessageTurnContext;
      plugins?: AgentPluginTurnContext;
      local?: AgentLocalTurnContext;
    }
  | { type: "message.steer"; requestId: string; sessionId: string; text: string }
  | { type: "turn.abort"; requestId: string; sessionId: string }
  | { type: "session.history"; requestId: string; sessionId: string }
  | { type: "session.close"; requestId: string; sessionId: string };

export interface WorkerUserMessage {
  text: string;
  attachments?: { id: string; name: string; path: string; mediaType: string }[];
}

/** Daemon-authored binding installed for one active Agent turn. */
export interface AgentComputerTurnContext {
  botId: string;
  turnId: string;
  workerSessionId: string;
  surfaceId: SurfaceId;
}

/** The Agent adapter adds its native tool-call identity to the immutable turn binding. */
export interface AgentComputerToolContext extends AgentComputerTurnContext {
  toolCallId: string;
}

export interface AgentComputerToolOutput {
  /** Identity of the desktop that produced this result, not the Agent's Native Session. */
  desktopSession: {
    botId: string;
    surfaceId: SurfaceId;
    runtimeGeneration: number;
  };
  text?: string;
  imageFile?: {
    mediaType: "image/png" | "image/jpeg";
    path: string;
  };
  imageRef?: string;
  windowList?: unknown;
}

export type AgentResult =
  | { requestId: string; ok: true; payload: unknown }
  | { requestId: string; ok: false; error: string };

export type WorkerOutbound =
  | Hello
  | { type: "heartbeat" }
  | { type: "event"; event: AgentEvent }
  | AgentResult;

export const AGENT_CAPABILITY_INVENTORY_VERSION = 4 as const;

export const NATIVE_THREAD_ACTIONS = ["resume", "history", "close", "rename", "delete", "fork", "compact"] as const;
export type NativeThreadAction = (typeof NATIVE_THREAD_ACTIONS)[number];

/** Versioned facts reported by an adapter about behavior its native surface actually supports. */
export interface AgentCapabilityInventory {
  version: typeof AGENT_CAPABILITY_INVENTORY_VERSION;
  steering: boolean;
  abort: boolean;
  /** Whether the adapter exposes the exact bounded send_bot_message tool contract. */
  botMail: boolean;
  /** Managed skill snapshots and turn-bound external tool calls. */
  plugins: boolean;
  nativeThreadActions: NativeThreadAction[];
  thinking: {
    supported: boolean;
    streaming: boolean;
  };
  attachments: {
    text: boolean;
    image: boolean;
    /** Adapter input bound for inlined text. Omitted when only the daemon upload bound applies. */
    maxTextBytes?: number;
  };
  /** Exact capability identifiers permitted on residual `native` events. */
  nativeEventFamilies: string[];
}

const AGENT_CAPABILITY_INVENTORY_KEYS: Record<string, true> = {
  version: true,
  steering: true,
  abort: true,
  botMail: true,
  plugins: true,
  nativeThreadActions: true,
  thinking: true,
  attachments: true,
  nativeEventFamilies: true,
};

const THINKING_CAPABILITY_KEYS: Record<string, true> = { supported: true, streaming: true };
const ATTACHMENT_CAPABILITY_KEYS: Record<string, true> = {
  text: true,
  image: true,
  maxTextBytes: true,
};

export function isAgentCapabilityInventory(value: unknown): value is AgentCapabilityInventory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const inventory = value as Partial<AgentCapabilityInventory>;
  const attachments = inventory.attachments as Partial<AgentCapabilityInventory["attachments"]> | null | undefined;
  const thinking = inventory.thinking as Partial<AgentCapabilityInventory["thinking"]> | null | undefined;
  return Object.keys(value).every((key) => key in AGENT_CAPABILITY_INVENTORY_KEYS) &&
    inventory.version === AGENT_CAPABILITY_INVENTORY_VERSION &&
    typeof inventory.steering === "boolean" &&
    typeof inventory.abort === "boolean" &&
    typeof inventory.botMail === "boolean" &&
    typeof inventory.plugins === "boolean" &&
    Array.isArray(inventory.nativeThreadActions) &&
    inventory.nativeThreadActions.every((action) => NATIVE_THREAD_ACTIONS.includes(action)) &&
    new Set(inventory.nativeThreadActions).size === inventory.nativeThreadActions.length &&
    thinking !== null &&
    thinking !== undefined &&
    Object.keys(thinking).every((key) => key in THINKING_CAPABILITY_KEYS) &&
    typeof thinking.supported === "boolean" &&
    typeof thinking.streaming === "boolean" &&
    (!thinking.streaming || thinking.supported) &&
    attachments !== null &&
    attachments !== undefined &&
    Object.keys(attachments).every((key) => key in ATTACHMENT_CAPABILITY_KEYS) &&
    typeof attachments.text === "boolean" &&
    typeof attachments.image === "boolean" &&
    (attachments.maxTextBytes === undefined ||
      (Number.isSafeInteger(attachments.maxTextBytes) && attachments.maxTextBytes > 0)) &&
    Array.isArray(inventory.nativeEventFamilies) &&
    inventory.nativeEventFamilies.every((family) => typeof family === "string" && family.length > 0) &&
    new Set(inventory.nativeEventFamilies).size === inventory.nativeEventFamilies.length;
}

export interface ProbePayload {
  agentId: string;
  installed: boolean;
  agentVersion: string;
  sdkOk: boolean;
  reason?: string;
  capabilities: AgentCapabilityInventory;
}

export interface SessionOpenedPayload {
  sessionId: string;
  nativeSessionId: string;
}

export interface HistoryPayload {
  messages: NormalizedMessage[];
}

export interface NormalizedMessage {
  role: "user" | "assistant" | "toolResult";
  text?: string;
  parts?: unknown[];
  createdAt?: string;
}
