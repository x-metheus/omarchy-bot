import { deviceRevoked } from "./pairing.ts";
import { getShell } from "./shell.ts";

export interface AgentBot { id: string; name: string; duties: string | null }
export interface AgentMessage { id: number; role: "user" | "assistant"; text: string }
export interface AgentConversation { bot: AgentBot; messages: AgentMessage[] }
export type WorkStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
export interface AgentWork { messageId: number; status: WorkStatus; reason?: string }
export interface ToolProgress { id: string; name: string; status: "running" | "completed" | "failed" | "cancelled" | "interrupted" }
export type Provider = "openai" | "anthropic";
export interface AgentSettings {
  active: { provider: Provider; model: string; source: "saved" | "environment" } | null;
  storedCredentials: Record<Provider, boolean>;
  writable: boolean;
}

export class DaemonError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const service = getShell().service;
  const token = service.deviceToken();
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${service.baseUrl()}${path}`, { ...options, headers, redirect: "error", cache: "no-store" });
  if (response.ok) return response;
  if (response.status === 401) deviceRevoked();
  const problem: { message?: string } | undefined = await response.json().catch(() => undefined);
  throw new DaemonError(response.status, problem?.message ?? `Agent Daemon request failed (${response.status}).`);
}

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  return (await request(path, options)).json();
}

const botPath = (id: string) => `/bots/${encodeURIComponent(id)}`;

export const agentDaemon = {
  bots: (signal?: AbortSignal) => json<AgentBot[]>("/bots", signal ? { signal } : {}),
  create: (name: string) => json<AgentBot>("/bots", { method: "POST", body: JSON.stringify({ name }) }),
  conversation: (id: string, signal?: AbortSignal) => json<AgentConversation>(botPath(id), signal ? { signal } : {}),
  rename: (id: string, name: string) => json<AgentBot>(botPath(id), { method: "PATCH", body: JSON.stringify({ name }) }),
  async remove(id: string) { await request(botPath(id), { method: "DELETE" }); },
  async send(id: string, text: string) {
    const response = await request(`${botPath(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    // The per-Bot feed already carries these replies and stays open across submissions.
    void response.body?.cancel().catch(() => undefined);
  },
  async retry(id: string, messageId: number) { await request(`${botPath(id)}/work/${messageId}/retry`, { method: "POST" }); },
  settings: () => json<AgentSettings>("/settings"),
  saveSettings: (settings: { provider: Provider; model: string; apiKey?: string }) =>
    json<AgentSettings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
};

export interface ConversationFrame { id: string; event: string; data: unknown }

export async function followConversation(
  botId: string,
  cursor: string,
  signal: AbortSignal,
  connected: () => void,
  received: (frame: ConversationFrame) => void,
): Promise<void> {
  const response = await request(`${botPath(botId)}/events`, {
    headers: { "Last-Event-ID": cursor }, signal,
  });
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    throw new Error("Expected a Conversation event stream.");
  }
  connected();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      // Axum terminates each field and frame with LF, including keepalive comments.
      for (let boundary = pending.indexOf("\n\n"); boundary >= 0; boundary = pending.indexOf("\n\n")) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (frame.startsWith(":")) continue;
        const fields = frame.split("\n");
        const id = fields.find(line => line.startsWith("id: "))?.slice(4);
        const event = fields.find(line => line.startsWith("event: "))?.slice(7);
        const data = fields.filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (!id || !event || !/^\d+$/.test(id) || BigInt(id) <= BigInt(cursor)) continue;
        received({ id, event, data: JSON.parse(data) });
        cursor = id;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
