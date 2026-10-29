import { getShell, type PairingRequest } from "./shell.ts";
import { serviceFetch } from "./serviceFetch.ts";

interface ConnectionState {
  paired: boolean;
  pending: boolean;
  serviceUrl: string;
  message?: string;
}

let state: ConnectionState | undefined;
const listeners = new Set<() => void>();
export function connectionState(): ConnectionState {
  if (state) return state;
  const service = getShell().service;
  const startupStatus = service.status();
  const message = startupStatus.error ?? (startupStatus.revoked ? "This app's pairing was revoked. Pair again with a new code from the Service Host." : undefined);
  return state = {
    paired: Boolean(service.deviceToken()),
    pending: false,
    serviceUrl: service.baseUrl(),
    ...(message === undefined ? {} : { message }),
  };
}
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: ConnectionState): void {
  state = next;
  for (const listener of listeners) listener();
}

export async function pairService({ serviceUrl, code }: PairingRequest): Promise<void> {
  if (connectionState().pending) return;
  publish({ paired: false, pending: true, serviceUrl });
  try {
    const startupError = getShell().service.status().error;
    if (startupError) throw new Error(startupError);
    let address: URL;
    try { address = new URL(serviceUrl.trim()); } catch { throw new Error("Enter a valid HTTP or HTTPS Service address."); }
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.pathname !== "/" || address.search || address.hash) {
      throw new Error("Enter an HTTP or HTTPS Service address without a path or credentials.");
    }
    const loopback = address.hostname === "localhost" || address.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(address.hostname);
    if (address.protocol === "http:" && !loopback) throw new Error("Use HTTPS or a loopback HTTP address through an SSH tunnel.");
    const response = await serviceFetch(`${address.origin}/api/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "TlsCertificateError") throw error;
      throw new Error("Could not reach the Service. Check the address and connection.");
    });
    if (response.status === 401) throw new Error("This pairing code is invalid or has expired. Ask the Service Host for a new code.");
    const body: { token?: unknown } = await response.json();
    if (!response.ok || typeof body.token !== "string" || body.token.length === 0) throw new Error("The Service could not pair this device. Ask the Service Host for a new code.");
    await getShell().service.store(address.origin, body.token).catch((error: unknown) => {
      const reason = error instanceof Error ? ` ${error.message}` : typeof error === "string" ? ` ${error}` : "";
      throw new Error(`The code was used, but this device could not store its token.${reason} Ask the Service Host for a new code.`);
    });
    publish({ paired: true, pending: false, serviceUrl: address.origin });
  } catch (error) {
    publish({ paired: false, pending: false, serviceUrl, message: error instanceof Error ? error.message : "Pairing failed." });
  }
}

export function deviceRevoked(): void {
  if (!connectionState().paired) return;
  const serviceUrl = getShell().service.baseUrl();
  publish({ paired: false, pending: true, serviceUrl, message: "This app's pairing was revoked. Pair again with a new code from the Service Host." });
  void getShell().service.clear().then(
    () => publish({ ...connectionState(), pending: false }),
    () => publish({ ...connectionState(), pending: false, message: "This app's pairing was revoked, but its stored token could not be cleared. Close the app and clear its connection before pairing again." }),
  );
}
