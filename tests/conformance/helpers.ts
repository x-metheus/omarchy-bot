/**
 * Conformance harness: boots the real daemon with the REAL workers (pi +
 * computer) against the user's actual Pi credentials, in an isolated data dir.
 */
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizedEnv } from "../../apps/daemon/src/supervision/workerClient.ts";

export interface ConformanceDaemon {
  baseUrl: string;
  port: number;
  home: string;
  token: string;
  agentEnv: Record<string, string>;
  svc: import("../../apps/daemon/src/api/http.ts").DaemonServices;
  stop: () => Promise<void>;
}

export async function startConformanceDaemon(): Promise<ConformanceDaemon> {
  const home = path.join(os.tmpdir(), `omarchy-bot-conformance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const state = path.join(os.tmpdir(), `omarchy-bot-conformance-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  // NOTE: no conformance record is pre-baked — the suite writes it on success.

  process.env.OMARCHY_BOT_HOME = home;
  process.env.OMARCHY_BOT_STATE = state;
  process.env.OMARCHY_BOT_PORT = "0";
  delete process.env.OMARCHY_BOT_WORKERS_DIR; // real workers
  const agentEnv = sanitizedEnv();

  // Dynamic import: the harness mutates process.env above; importing main.ts fresh keeps that contract explicit.
  const { main } = await import("../../apps/daemon/src/bootstrap/main.ts");
  const { stop, port, svc } = await main();
  const secret = readFileSync(path.join(state, "pairing-host-secret"), "utf8").trim();
  const baseUrl = `http://127.0.0.1:${port}`;
  const issued = await fetch(`${baseUrl}/api/pairing/codes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ name: "conformance" }),
  });
  if (!issued.ok) throw new Error(`conformance pairing code -> ${issued.status}`);
  const issuedBody: unknown = await issued.json();
  const code = typeof issuedBody === "object" && issuedBody !== null && "code" in issuedBody && typeof issuedBody.code === "string"
    ? issuedBody.code
    : undefined;
  const exchanged = await fetch(`${baseUrl}/api/pairing/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const exchangedBody: unknown = await exchanged.json();
  const token = typeof exchangedBody === "object" && exchangedBody !== null && "token" in exchangedBody && typeof exchangedBody.token === "string"
    ? exchangedBody.token
    : undefined;
  const deviceName = typeof exchangedBody === "object" && exchangedBody !== null && "device" in exchangedBody
    && typeof exchangedBody.device === "object" && exchangedBody.device !== null && "name" in exchangedBody.device
    && typeof exchangedBody.device.name === "string"
    ? exchangedBody.device.name
    : undefined;
  if (exchanged.status !== 201 || token === undefined) throw new Error(`conformance pairing exchange -> ${exchanged.status}`);
  if (deviceName !== "conformance") throw new Error("pairing exchange dropped the issued device name");
  return { baseUrl, port, home, token, agentEnv, svc, stop };
}

/** 1×1 red PNG. */
export const RED_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
