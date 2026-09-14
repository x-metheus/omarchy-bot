/** Loopback aliases that identify this machine under the current unauthenticated listener policy. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface LocalSidecarStartDecision {
  clientKind: "web" | "omarchy-bot";
  daemonHost: string;
  daemonPort: number;
  thisDaemonHost: string;
  thisDaemonPort: number;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Whether Omarchy Bot should start a Local Sidecar for this daemon connection.
 * Skip when the Bot Client is talking to this machine’s plugin daemon.
 * A browser tab is never a Sidecar host. The rule is not “this OS is Omarchy.”
 */
export function shouldStartLocalSidecar(input: LocalSidecarStartDecision): boolean {
  if (input.clientKind === "web") return false;
  const sameLoopbackInstance =
    isLoopback(input.daemonHost)
    && isLoopback(input.thisDaemonHost)
    && input.daemonPort === input.thisDaemonPort;
  return !sameLoopbackInstance;
}
