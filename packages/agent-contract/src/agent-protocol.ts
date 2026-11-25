import { isToolCallSummary, type SurfaceId, type ToolCallSummary } from "@omarchy-bot/domain";
import type { AgentCapabilityInventory } from "./agent-capabilities.ts";
import type { AgentPluginTurnContext, NativeMcpControlInput } from "./plugin-protocol.ts";
import type { Hello, OpenSessionOptionsLike } from "./shared.ts";
import type { AgentBotMessageTurnContext } from "./bot-message-protocol.ts";
import type { AgentLocalTurnContext } from "./local-protocol.ts";
import type { UserTurnMessage } from "./turn-message.ts";

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
  | ({ type: "mcp.control"; requestId: string; cwd: string } & NativeMcpControlInput)
  | { type: "session.open"; requestId: string; botId: string; threadId: string; options: OpenSessionOptionsLike }
  | { type: "session.resume"; requestId: string; botId: string; threadId: string; nativeSessionId: string; options: OpenSessionOptionsLike }
  | {
      type: "message.send";
      requestId: string;
      sessionId: string;
      turnId: string;
      message: UserTurnMessage;
      computer: AgentComputerTurnContext;
      botMessage?: AgentBotMessageTurnContext;
      plugins?: AgentPluginTurnContext;
      local?: AgentLocalTurnContext;
    }
  | { type: "message.steer"; requestId: string; sessionId: string; text: string }
  | { type: "turn.abort"; requestId: string; sessionId: string }
  | { type: "session.history"; requestId: string; sessionId: string }
  | { type: "session.close"; requestId: string; sessionId: string };

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

export type AgentResult =
  | { requestId: string; ok: true; payload: unknown }
  | { requestId: string; ok: false; error: string };

export type WorkerOutbound =
  | Hello
  | { type: "heartbeat" }
  | { type: "event"; event: AgentEvent }
  | AgentResult;

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
