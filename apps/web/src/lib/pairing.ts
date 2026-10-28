import { getShell, type PairingRequest } from "./shell.ts";

interface ConnectionState {
  paired: boolean;
  pending: boolean;
  serviceUrl: string;
  message?: string;
}

let state: ConnectionState = {
  paired: Boolean(getShell().service.deviceToken()),
  pending: false,
  serviceUrl: getShell().service.baseUrl(),
};
const listeners = new Set<() => void>();
export const connectionState = (): ConnectionState => state;
export function subscribeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(next: ConnectionState): void {
  state = next;
  for (const listener of listeners) listener();
}

export async function pairService({ serviceUrl, code }: PairingRequest): Promise<void> {
  if (state.pending) return;
  publish({ paired: false, pending: true, serviceUrl });
  try {
    let address: URL;
    try { address = new URL(serviceUrl.trim()); } catch { throw new Error("Enter a valid HTTP or HTTPS Service address."); }
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.pathname !== "/" || address.search || address.hash) {
      throw new Error("Enter an HTTP or HTTPS Service address without a path or credentials.");
    }
    const response = await fetch(`${address.origin}/api/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    }).catch(() => { throw new Error("Could not reach the Service. Check the address, connection, and trusted TLS certificate."); });
    if (response.status === 401) throw new Error("This pairing code is invalid or has expired. Ask the Service Host for a new code.");
    const body: { token?: unknown } = await response.json();
    if (!response.ok || typeof body.token !== "string" || body.token.length === 0) throw new Error("The Service could not pair this device. Ask the Service Host for a new code.");
    await getShell().service.store(address.origin, body.token).catch(() => {
      throw new Error("The code was used, but this device could not store its token. Ask the Service Host for a new code.");
    });
    publish({ paired: true, pending: false, serviceUrl: address.origin });
  } catch (error) {
    publish({ paired: false, pending: false, serviceUrl, message: error instanceof Error ? error.message : "Pairing failed." });
  }
}

export function deviceRevoked(): void {
  if (!state.paired) return;
  const serviceUrl = getShell().service.baseUrl();
  publish({ paired: false, pending: true, serviceUrl, message: "This device was revoked. Pair again with a new code from the Service Host." });
  void getShell().service.clear().then(
    () => publish({ ...state, pending: false }),
    () => publish({ ...state, pending: false, message: "This device was revoked, but its stored token could not be cleared. Close the app and clear its connection before pairing again." }),
  );
}
