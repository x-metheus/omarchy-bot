import { getShell } from "./shell.ts";

let error: string | undefined;

interface ExchangeResponse {
  token?: unknown;
  error?: unknown;
}

/**
 * The development harness accepts one-time `/pair?code=...` URLs. Runs once at
 * startup, before the router mounts: exchange the code for a Device token, then
 * drop it from history so a refresh cannot replay it. A failed exchange lands on
 * the workspace with `pairingError()` rather than retrying.
 */
export async function consumePairingCode(): Promise<void> {
  error = undefined;
  if (typeof window === "undefined" || window.location.pathname !== "/pair") return;
  const code = new URLSearchParams(window.location.search).get("code");
  if (code !== null && code !== "") error = await exchange(code);
  history.replaceState(null, "", "/");
}

export function pairingError(): string | undefined {
  return error;
}

async function exchange(code: string): Promise<string | undefined> {
  const service = getShell().service;
  const baseUrl = service.baseUrl();
  const res = await fetch(`${baseUrl}/api/pairing/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }).catch(() => undefined);
  const body: ExchangeResponse | undefined = await res?.json().catch(() => undefined);
  if (res?.ok === true && typeof body?.token === "string") {
    try {
      await service.store(baseUrl, body.token);
    } catch {
      return "This pairing link was used, but the browser could not store the device token. Ask the Service Host for a new link.";
    }
    return undefined;
  }
  return typeof body?.error === "string" ? body.error : "This pairing link is invalid or has expired.";
}
