import { existsSync } from "node:fs";
import { BlockList, isIP } from "node:net";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  const family = isIP(host);
  return family !== 0 && loopback.check(host, family === 6 ? "ipv6" : "ipv4");
}

export function listenerConfig(env: NodeJS.ProcessEnv) {
  const host = env.OMARCHY_BOT_HOST ?? "127.0.0.1";
  const tlsCert = env.OMARCHY_BOT_TLS_CERT || undefined;
  const tlsKey = env.OMARCHY_BOT_TLS_KEY || undefined;
  const trustedProxy = env.OMARCHY_BOT_TRUSTED_PROXY || undefined;
  if (trustedProxy && !isIP(trustedProxy)) throw new Error("OMARCHY_BOT_TRUSTED_PROXY (trusted proxy) must be one IP address (canonical IPv4 or IPv6)");
  if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error("OMARCHY_BOT_TLS_CERT and OMARCHY_BOT_TLS_KEY must be set together");
  for (const file of [tlsCert, tlsKey]) {
    if (file && !existsSync(file)) throw new Error(`TLS file does not exist: ${file}`);
  }
  if (!isLoopbackHost(host) && !(tlsCert && tlsKey) && !trustedProxy) {
    throw new Error(`Bind address ${host} requires a certificate (OMARCHY_BOT_TLS_CERT and OMARCHY_BOT_TLS_KEY) or a declared trusted proxy (OMARCHY_BOT_TRUSTED_PROXY)`);
  }
  return { host, tlsCert, tlsKey, trustedProxy };
}
