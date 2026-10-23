#!/usr/bin/env bun
/**
 * Outbound-only Local Sidecar. TypeScript run by the plugin-runtime Bun.
 * Never listens. Not an Agent worker, plugin daemon, or Bot Screen.
 */
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeviceId } from "@omarchy-bot/domain";
import { DeviceServerFrameSchema, type DeviceClientFrame } from "@omarchy-bot/protocol";
import { createLocalJobHandler, type LocalAsk, type LocalAskDecision } from "./handler.ts";

const HEARTBEAT_MS = 10_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function emit(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("Local Sidecar device channel failed to connect")), { once: true });
  return promise;
}

async function readDecisions(onDecision: (decision: { type: LocalAskDecision; jobId?: string }) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { type?: LocalAskDecision; jobId?: string };
        if (parsed.type === "allow-once" || parsed.type === "deny" || parsed.type === "always" || parsed.type === "never") {
          onDecision({ type: parsed.type, ...(parsed.jobId !== undefined ? { jobId: parsed.jobId } : {}) });
        }
      } catch {
        /* ignore malformed stdin */
      }
    }
  }
}

async function main(): Promise<void> {
  const port = Number(requiredEnv("OMARCHY_BOT_DAEMON_PORT"));
  if (!Number.isInteger(port) || port <= 0) throw new Error("OMARCHY_BOT_DAEMON_PORT must be a positive integer");
  const deviceId = requiredEnv("OMARCHY_BOT_DEVICE_ID");
  if (!isDeviceId(deviceId)) throw new Error("OMARCHY_BOT_DEVICE_ID must be a Local Sidecar device identity");
  const hostname = process.env.OMARCHY_BOT_HOSTNAME?.trim() || os.hostname();
  const root = path.resolve(requiredEnv("OMARCHY_BOT_SIDECAR_ROOT"));
  mkdirSync(root, { recursive: true });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices`);
  await waitOpen(ws);
  const send = (frame: DeviceClientFrame): void => ws.send(JSON.stringify(frame));
  const asks = new Map<string, { resolve(decision: LocalAskDecision): void }>();
  const handler = createLocalJobHandler({
    root,
    send,
    approver: {
      ask(ask: LocalAsk) {
        const decision = Promise.withResolvers<LocalAskDecision>();
        asks.set(ask.jobId, decision);
        emit({
          type: "ask",
          jobId: ask.jobId,
          hostname: ask.hostname,
          action: ask.action,
          ...(ask.command !== undefined ? { command: ask.command } : {}),
          ...(ask.path !== undefined ? { path: ask.path } : {}),
          ...(ask.destination !== undefined ? { destination: ask.destination } : {}),
          ...(ask.query !== undefined ? { query: ask.query } : {}),
        });
        void ask.dismissed.then(() => {
          asks.delete(ask.jobId);
          emit({ type: "ask.dismiss", jobId: ask.jobId });
        });
        return decision.promise;
      },
    },
  });

  ws.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as unknown;
      const parsed = DeviceServerFrameSchema.safeParse(frame);
      if (!parsed.success) return;
      if (parsed.data.type === "registered") emit({ type: "registered", deviceId: parsed.data.deviceId });
      else if (parsed.data.type === "error") emit({ type: "error", error: parsed.data.error });
      else handler.receive(parsed.data);
    } catch {
      /* ignore non-JSON */
    }
  });

  send({ type: "register", deviceId, hostname, capabilities: ["shell", "search", "files", "transfer"] });
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) send({ type: "heartbeat" });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  ws.addEventListener("close", () => resolveClosed());
  let teardown: Promise<void> | undefined;
  const beginTeardown = (): Promise<void> => {
    // handler.close() aborts and dismisses synchronously; the teardown itself is awaited later.
    const pending = teardown ?? handler.close();
    teardown = pending;
    // The rejection is rethrown by the await below; this keeps it from being unhandled in between.
    void pending.catch(() => undefined);
    return pending;
  };
  void readDecisions((decision) => {
    const id = decision.jobId ?? [...asks.keys()].at(-1);
    const ask = id === undefined ? undefined : asks.get(id);
    if (ask === undefined || id === undefined) return;
    asks.delete(id);
    ask.resolve(decision.type);
  });

  const stop = (): void => {
    clearInterval(heartbeat);
    void beginTeardown();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await closed;
  clearInterval(heartbeat);
  await beginTeardown();
  process.exit(0);
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
