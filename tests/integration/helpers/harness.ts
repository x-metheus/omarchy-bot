import type { BotComputerAssetSupply } from "../../../apps/daemon/src/modules/computer/botComputerAssets.ts";
/**
 * Daemon harness for integration tests: boots the real daemon in-process with
 * an isolated data dir, random port, and the scripted fake workers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonServices } from "../../../apps/daemon/src/api/http.ts";
import { FakeBotScreenRuntimeAdapter } from "../../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import type { BotScreenRuntimeAdapter } from "../../../apps/daemon/src/modules/computer/botScreenManager.ts";
import type { MessageDto } from "../../../packages/protocol/src/index.ts";

export interface Harness {
  baseUrl: string;
  port: number;
  /** Paired-device token; empty only when the pairing routes are not installed. */
  token: string;
  home: string;
  svc: DaemonServices;
  stop: () => Promise<void>;
  disconnectForRestart: () => Promise<void>;
}

export interface HarnessOptions {
  botDeletionTerminalTimeoutMs?: number;
  botScreenFailure?: string;
  useProductionBotScreen?: boolean;
  /** Production-style user-systemd units. Default false; label those results harness-mode. */
  useHostApplicationUnits?: boolean;
  botScreenAdapter?: BotScreenRuntimeAdapter;
  botComputerAssetSupply?: BotComputerAssetSupply;
  botScreenCapacity?: number;
  waitForAgentReady?: boolean;
  /** Worker tree override; defaults to the shared fake workers. */
  workersDir?: string;
}

/**
 * Issue a pairing code on the loopback Service Host and exchange it for a
 * device token. The Service Host secret is mode 0600 in the state dir.
 * Returns "" when the pairing routes are not installed yet, so the harness
 * still boots against a daemon without the gate.
 */
export async function pairForToken(baseUrl: string, stateDir: string, name = "test"): Promise<string> {
  const secret = readFileSync(path.join(stateDir, "pairing-host-secret"), "utf8").trim();
  const issued = await fetch(`${baseUrl}/api/pairing/codes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ name }),
  });
  if (issued.status === 404) return "";
  if (issued.status !== 200 && issued.status !== 201) {
    throw new Error(`pairing code issue -> ${issued.status}: ${(await issued.text()).slice(0, 300)}`);
  }
  const issuedBody: unknown = await issued.json();
  if (typeof issuedBody !== "object" || issuedBody === null || !("code" in issuedBody) || typeof issuedBody.code !== "string") {
    throw new Error("pairing code issue returned no code");
  }
  const exchanged = await fetch(`${baseUrl}/api/pairing/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: issuedBody.code, name }),
  });
  if (exchanged.status !== 201) {
    throw new Error(`pairing exchange -> ${exchanged.status}: ${(await exchanged.text()).slice(0, 300)}`);
  }
  const exchangedBody: unknown = await exchanged.json();
  if (typeof exchangedBody !== "object" || exchangedBody === null || !("token" in exchangedBody) || typeof exchangedBody.token !== "string") {
    throw new Error("pairing exchange returned no token");
  }
  return exchangedBody.token;
}

/** Authorization header for a harness; empty when no token was issued. */
export function authHeaders(h: Harness): Record<string, string> {
  return h.token ? { authorization: `Bearer ${h.token}` } : {};
}

/** Raw fetch against the daemon that carries the harness device token. */
export function authedFetch(h: Harness, input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (h.token && !headers.has("authorization")) headers.set("authorization", `Bearer ${h.token}`);
  return fetch(input, { ...init, headers });
}

export async function startDaemon(existingHome?: string, options: HarnessOptions = {}): Promise<Harness> {
  const home = existingHome ?? path.join(os.tmpdir(), `omarchy-bot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const state = path.join(os.tmpdir(), `omarchy-bot-test-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  // Fake conformance record so the fake pi worker probes to `ready`.
  const conf = path.join(home, "conformance");
  mkdirSync(conf, { recursive: true });
  writeFileSync(
    path.join(conf, "pi-fake-pi-1.json"),
    JSON.stringify({ ok: true, image: "verified" }),
  );

  process.env.HOME = home;
  process.env.OMARCHY_BOT_HOME = home;
  process.env.OMARCHY_BOT_STATE = state;
  process.env.OMARCHY_BOT_PORT = "0";
  process.env.OMARCHY_BOT_WORKERS_DIR = options.workersDir ?? path.resolve(import.meta.dir, "../fake-workers");
  process.env.OMARCHY_BOT_DELETION_TERMINAL_TIMEOUT_MS = String(
    options.botDeletionTerminalTimeoutMs ?? 30_000,
  );

  // Dynamic import keeps the harness the single boot seam for fresh and legacy homes.
  const { main } = await import("../../../apps/daemon/src/bootstrap/main.ts");
  const daemon = options.useProductionBotScreen
    ? await main({
        useHostApplicationUnits: options.useHostApplicationUnits === true,
        botScreenRuntimeDir: path.join(home, "r"),
        ...(options.botComputerAssetSupply === undefined ? {} : { botComputerAssetSupply: options.botComputerAssetSupply }),
        ...(options.botScreenCapacity === undefined ? {} : { botScreenCapacity: options.botScreenCapacity }),
      })
    : await main({
        useHostApplicationUnits: options.useHostApplicationUnits === true,
        botScreenRuntimeDir: path.join(home, "r"),
        botScreenAdapter: options.botScreenAdapter ?? new FakeBotScreenRuntimeAdapter(options.botScreenFailure),
        botScreenCapacity: options.botScreenCapacity ?? 8,
      });
  const { stop, disconnectForRestart, port, svc } = daemon;
  const base: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    token: "",
    home,
    svc,
    stop,
    disconnectForRestart,
  };
  base.token = await pairForToken(base.baseUrl, state);
  if (options.waitForAgentReady !== false) {
    // Wait until the fake pi agent finishes its probe and reports ready.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const agents = (await fetch(`${base.baseUrl}/api/agents`, { headers: authHeaders(base) }).then((r) => r.json())) as { id: string; status: string }[];
      const pi = agents.find((a) => a.id === "pi");
      if (pi?.status === "ready") break;
      if (Date.now() > deadline) throw new Error(`pi agent never became ready (status: ${pi?.status ?? "none"})`);
      await Bun.sleep(150);
    }
  }
  return base;
}

export async function api<T>(h: Harness, method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${h.baseUrl}${p}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID(), ...authHeaders(h) },
  });
  if (!res.ok && res.status !== 409 && res.status !== 503) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${method} ${p} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function messages(h: Harness, threadId: string): Promise<MessageDto[]> {
  return api<MessageDto[]>(h, "GET", `/api/threads/${threadId}/messages`);
}

export async function apiStatus(h: Harness, method: string, p: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${h.baseUrl}${p}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID(), ...authHeaders(h) },
  });
  const text = await res.text();
  let bodyJson: unknown = text;
  try {
    bodyJson = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: bodyJson };
}

/** Create a Bot on the ready pi agent and return its id. */
export async function makeBot(h: Harness, name = "Test Bot", instructions = ""): Promise<string> {
  const bot = await api<{ id: string }>(h, "POST", "/api/bots", { name, instructions, agentId: "pi" });
  return bot.id;
}

/** First send against a Bot: atomically creates the thread. */
export async function sendToBot(
  h: Harness,
  botId: string,
  text: string,
  deviceId?: string,
): Promise<{ threadId: string; messageId: string; turnId: string; action: string }> {
  return api(h, "POST", `/api/bots/${botId}/messages`, { text, ...(deviceId !== undefined ? { deviceId } : {}) });
}

/** Send into an existing thread (send when idle, steer when a turn is active). */
export async function sendToThread(h: Harness, threadId: string, text: string, deviceId?: string): Promise<{ threadId: string; messageId: string; turnId: string; action: string }> {
  return api(h, "POST", `/api/threads/${threadId}/messages`, { text, ...(deviceId !== undefined ? { deviceId } : {}) });

}

/** Poll a thread until it has no active turn. */
export async function waitThreadIdle(h: Harness, threadId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const thread = await api<{ activeTurn?: unknown }>(h, "GET", `/api/threads/${threadId}`);
    if (thread.activeTurn === undefined) return;
    if (Date.now() > deadline) throw new Error(`thread ${threadId} still has an active turn after ${timeoutMs}ms`);
    await Bun.sleep(100);
  }
}
