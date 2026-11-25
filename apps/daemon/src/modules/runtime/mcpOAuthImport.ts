import { isDeepStrictEqual } from "node:util";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import type { EffectiveMcpServers } from "../plugins/nativeMcp.ts";
import { SecretMcpOAuthStateStore } from "./mcpOAuth.ts";
import type { SecretStore } from "./secrets.ts";

/**
 * A reader must resolve service `pi-mcp-adapter.oauth` and account `sha256-<SHA-256 of server name>`,
 * assemble chunks identified by `__piMcpAdapterOAuthChunked`, and return the parsed AuthEntry.
 * Return undefined when no entry exists.
 */
export interface PiMcpAdapterTokenReader {
  readonly available: boolean;
  read(serverName: string): Promise<unknown>;
}

// The real reader is pending Task 22's keychain backend decision. This reader attempts no keychain access.
export const pendingPiMcpAdapterTokenReader: PiMcpAdapterTokenReader = { available: false, read: async () => undefined };

interface ImportInput {
  secrets: SecretStore;
  snapshot: () => Pick<EffectiveMcpServers, "servers" | "configurationError">;
  reader: PiMcpAdapterTokenReader;
  check(name: string): Promise<boolean>;
  reportRejected(name: string): void;
  now?: () => number;
}

interface ImportReport {
  imported: string[];
  needsSignIn: string[];
  skipped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function convertEntry(entry: unknown, serverUrl: string, now: number): McpOAuthState | undefined {
  if (!isRecord(entry) || Object.hasOwn(entry, "__piMcpAdapterOAuthChunked") || !isRecord(entry.tokens)) return;
  if (entry.serverUrl !== undefined && (typeof entry.serverUrl !== "string" || URL.parse(entry.serverUrl)?.href !== serverUrl)) return;

  const { accessToken, refreshToken, scope, expiresAt, issuer: tokenIssuer } = entry.tokens;
  if (typeof accessToken !== "string" || !accessToken.length) return;
  if (refreshToken !== undefined && typeof refreshToken !== "string") return;
  if (scope !== undefined && typeof scope !== "string") return;

  const { clientInfo } = entry;
  if (clientInfo !== undefined && !isRecord(clientInfo)) return;
  const clientIssuer = clientInfo?.issuer;
  if (tokenIssuer !== undefined && clientIssuer !== undefined && tokenIssuer !== clientIssuer) return;
  const issuer = tokenIssuer === undefined ? clientIssuer : tokenIssuer;
  if (issuer !== undefined) {
    if (typeof issuer !== "string") return;
    const protocol = URL.parse(issuer)?.protocol;
    if (protocol !== "http:" && protocol !== "https:") return;
  }

  const state: McpOAuthState = {
    serverUrl,
    tokens: {
      access_token: accessToken,
      token_type: "Bearer",
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      ...(scope === undefined ? {} : { scope }),
    },
    ...(issuer === undefined ? {} : { discovery: { authorizationServerUrl: issuer } }),
  };
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "number") return;
    const expiresAtMs = expiresAt * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return;
    state.tokensExpireAt = expiresAtMs;
  }
  const { clientId, clientSecret, configPreRegistered } = clientInfo ?? {};
  if (configPreRegistered !== true && clientId !== undefined && clientId !== "") {
    if (typeof clientId !== "string" || (clientSecret !== undefined && typeof clientSecret !== "string")) return;
    state.clientInformation = { client_id: clientId, ...(clientSecret === undefined ? {} : { client_secret: clientSecret }) };
  }
  return state;
}

async function runImport({ secrets, snapshot, reader, check, reportRejected, now = Date.now }: ImportInput) {
  const report: ImportReport = { imported: [], needsSignIn: [], skipped: [] };
  const { servers, configurationError } = snapshot();
  if (configurationError !== undefined) return { report, canMarkComplete: false };
  let readSucceeded = false;
  let readFailure: { error: unknown } | undefined;
  const failedReads: string[] = [];
  for (const [name, { disabled, transport }] of Object.entries(servers)) {
    if (disabled || transport?.type !== "http" ||
        Object.keys(transport.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
      report.skipped.push(name);
      continue;
    }
    const serverUrl = new URL(transport.url).href;
    const store = new SecretMcpOAuthStateStore({ secrets, name, server: serverUrl });
    const staged = await store.withRefreshLock(async () => {
      const existing = await store.load();
      // Failed imports can leave client information and discovery available for sign-in.
      if (existing?.tokens || existing?.oauthState || existing?.codeVerifier) return "skipped";
      let entry: unknown;
      try {
        entry = await reader.read(name);
        readSucceeded = true;
      } catch (error) {
        readFailure ??= { error };
        return "readFailed";
      }
      if (entry === undefined) return "skipped";
      const state = convertEntry(entry, serverUrl, now());
      // pi-mcp bypasses stored discovery when the connection supplies an explicit metadata URL.
      if (!state || (state.discovery && transport.oauth?.authServerMetadataUrl !== undefined)) return "needsSignIn";
      await store.save(state);
      return state;
    });
    if (staged === "readFailed") {
      failedReads.push(name);
      report.needsSignIn.push(name);
      continue;
    }
    if (typeof staged === "string") {
      if (staged === "needsSignIn") reportRejected(name);
      report[staged].push(name);
      continue;
    }

    // The check can refresh credentials and needs the store's refresh lock itself.
    let connected = false;
    try {
      connected = await check(name);
    } finally {
      if (!connected) {
        await store.withRefreshLock(async () => {
          const current = await store.load();
          if (!current) return;
          // The check can write discovery. Any other change may belong to a refresh or browser sign-in.
          if (!isDeepStrictEqual({ ...current, discovery: undefined }, { ...staged, discovery: undefined })) return;
          delete current.tokens;
          delete current.tokensExpireAt;
          await store.save(current);
        });
        reportRejected(name);
      }
    }
    report[connected ? "imported" : "needsSignIn"].push(name);
  }
  await Promise.all(failedReads.map((name) => check(name)));
  const canMarkComplete = !readFailure && !Object.values(servers).some((server) => "configurationError" in server);
  return { report, canMarkComplete, allReadsFailed: readSucceeded ? undefined : readFailure };
}

export async function importMcpOAuthTokens(input: ImportInput): Promise<ImportReport> {
  if (input.reader.available === false) throw new Error("The MCP OAuth adapter token reader is unavailable.");
  return (await runImport(input)).report;
}

export async function importMcpOAuthTokensOnce({ marker, ...input }: ImportInput & {
  marker: { get(): string | undefined; set(value: string): void };
}): Promise<"unavailable" | "already-imported" | ImportReport> {
  if (input.reader.available === false) return "unavailable";
  if (marker.get() !== undefined) return "already-imported";
  const { report, allReadsFailed, canMarkComplete } = await runImport(input);
  if (allReadsFailed) throw allReadsFailed.error;
  if (canMarkComplete) marker.set("1");
  return report;
}
