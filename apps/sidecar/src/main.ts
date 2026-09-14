#!/usr/bin/env bun
/**
 * Outbound-only Local Sidecar. TypeScript run by the plugin-runtime Bun.
 * Never listens. Not an Agent worker, plugin daemon, or Bot Screen.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeviceId } from "../../../packages/domain/src/ids.ts";
import type { DeviceClientFrame, DeviceLocalJobFrame, DeviceServerFrame } from "../../../packages/protocol/src/index.ts";
import { executeLocalJob, ruleKey } from "./execute.ts";

interface SidecarPolicy {
  always: string[];
  never: string[];
}

interface AskDecision {
  type: "allow-once" | "deny" | "always" | "never";
  jobId?: string;
}

const HEARTBEAT_MS = 10_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadPolicy(policyPath: string): SidecarPolicy {
  try {
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as { always?: string[]; never?: string[] };
    return { always: parsed.always ?? [], never: parsed.never ?? [] };
  } catch {
    return { always: [], never: [] };
  }
}

function savePolicy(policyPath: string, policy: SidecarPolicy): void {
  writeFileSync(policyPath, JSON.stringify(policy));
}

function emit(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Local Sidecar device channel failed to connect")), { once: true });
  });
}

async function readDecisions(onDecision: (decision: AskDecision) => void): Promise<void> {
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
        const parsed = JSON.parse(line) as AskDecision;
        if (
          parsed.type === "allow-once"
          || parsed.type === "deny"
          || parsed.type === "always"
          || parsed.type === "never"
        ) {
          onDecision(parsed);
        }
      } catch {
        /* ignore malformed stdin */
      }
    }
  }
}

async function main(): Promise<void> {
  const port = Number(requiredEnv("OMARCHY_BOT_DAEMON_PORT"));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("OMARCHY_BOT_DAEMON_PORT must be a positive integer");
  }
  const deviceId = requiredEnv("OMARCHY_BOT_DEVICE_ID");
  if (!isDeviceId(deviceId)) {
    throw new Error("OMARCHY_BOT_DEVICE_ID must be a Local Sidecar device identity");
  }
  const hostname = process.env.OMARCHY_BOT_HOSTNAME?.trim() || os.hostname();
  const root = path.resolve(requiredEnv("OMARCHY_BOT_SIDECAR_ROOT"));
  mkdirSync(root, { recursive: true });
  const policyPath = path.join(root, ".omarchy-bot-local-policy.json");
  const policy = loadPolicy(policyPath);
  const pending = new Map<string, DeviceLocalJobFrame>();
  const handled = new Set<string>();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/devices`);
  await waitOpen(ws);
  const send = (frame: DeviceClientFrame): void => {
    ws.send(JSON.stringify(frame));
  };

  const finish = (job: DeviceLocalJobFrame, result: Awaited<ReturnType<typeof executeLocalJob>>): void => {
    if (handled.has(job.jobId)) return;
    handled.add(job.jobId);
    pending.delete(job.jobId);
    if (result.ok) {
      send({
        type: "local.result",
        jobId: job.jobId,
        ok: true,
        text: result.text,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      });
      return;
    }
    send({ type: "local.result", jobId: job.jobId, ok: false, error: result.error });
  };

  const deny = (job: DeviceLocalJobFrame, error: string): void => {
    if (handled.has(job.jobId)) return;
    handled.add(job.jobId);
    pending.delete(job.jobId);
    send({ type: "local.result", jobId: job.jobId, ok: false, error });
  };

  const ask = (job: DeviceLocalJobFrame): void => {
    pending.set(job.jobId, job);
    emit({
      type: "ask",
      jobId: job.jobId,
      hostname: job.hostname,
      action: job.action,
      ...(job.command !== undefined ? { command: job.command } : {}),
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.destination !== undefined ? { destination: job.destination } : {}),
      ...(job.query !== undefined ? { query: job.query } : {}),
    });
  };

  const onJob = async (job: DeviceLocalJobFrame): Promise<void> => {
    if (job.action === "search" && (job.query === "/" || job.path === "/")) {
      deny(job, "Local Sidecar search cannot scan /");
      return;
    }
    const key = ruleKey(job);
    if (policy.never.includes(key)) {
      deny(job, "Local Sidecar Never allowed this work");
      return;
    }
    if (policy.always.includes(key)) {
      finish(job, await executeLocalJob(job, root));
      return;
    }
    ask(job);
  };

  ws.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as DeviceServerFrame;
      if (frame.type === "registered") {
        emit({ type: "registered", deviceId: frame.deviceId });
        return;
      }
      if (frame.type === "error") {
        emit({ type: "error", error: frame.error });
        return;
      }
      if (frame.type === "local.job") void onJob(frame);
    } catch {
      /* ignore non-JSON */
    }
  });

  send({
    type: "register",
    deviceId,
    hostname,
    capabilities: ["shell", "search", "files", "transfer"],
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) send({ type: "heartbeat" });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const closed = Promise.withResolvers<void>();
  ws.addEventListener("close", () => closed.resolve());

  void readDecisions((decision) => {
    const job = decision.jobId === undefined
      ? [...pending.values()].at(-1)
      : pending.get(decision.jobId);
    if (job === undefined) return;
    const key = ruleKey(job);
    if (decision.type === "always") {
      if (!policy.always.includes(key)) policy.always.push(key);
      savePolicy(policyPath, policy);
      void executeLocalJob(job, root).then((result) => finish(job, result));
      return;
    }
    if (decision.type === "never") {
      if (!policy.never.includes(key)) policy.never.push(key);
      savePolicy(policyPath, policy);
      deny(job, "Local Sidecar Never allowed this work");
      return;
    }
    if (decision.type === "deny") {
      deny(job, "Local Sidecar denied this work");
      return;
    }
    void executeLocalJob(job, root).then((result) => finish(job, result));
  });

  const stop = (): void => {
    clearInterval(heartbeat);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await closed.promise;
  clearInterval(heartbeat);
  process.exit(0);
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
