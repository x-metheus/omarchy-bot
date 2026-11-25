import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { OAuthIssuerMismatchError } from "@earendil-works/pi-mcp/oauth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { closeRuntimeAfterMcpOAuthImport, keyringAccessDisabled } from "../../bootstrap/main.ts";
import type { EffectiveMcpServers } from "../plugins/nativeMcp.ts";
import { createMcpExtension } from "./extensions/mcp.ts";
import { McpOAuthManager, mcpOAuthSecretName, SecretMcpOAuthStateStore } from "./mcpOAuth.ts";
import { importMcpOAuthTokens, importMcpOAuthTokensOnce, type PiMcpAdapterTokenReader } from "./mcpOAuthImport.ts";
import { createPiMcpAdapterTokenReader, PiMcpAdapterKeyringUnavailableError, type SecretGet } from "./mcpOAuthKeyringReader.ts";
import { SecretStore, type SecretBackend } from "./secrets.ts";
import { startOAuthMcpServer } from "./testing/oauthMcpServer.ts";

class FakeSecretBackend implements SecretBackend {
  readonly kind = "keychain";
  readonly values = new Map<string, string>();
  readonly writtenAccounts: string[] = [];

  async get(account: string) { return this.values.get(account); }
  async set(account: string, value: string) {
    this.writtenAccounts.push(account);
    this.values.set(account, value);
  }
  async delete(account: string) { this.values.delete(account); }
}

const name = "remote";
const exampleUrl = "https://tools.example.test/mcp";
const exampleIssuer = "https://issuer.example.test";
const sampleTime = 1_699_999_999_000;
const accessToken = "fixture-access-token";
const refreshToken = "fixture-refresh-token";
const clientSecret = "fixture-client-secret";
const serversAt = (url: string) => ({ [name]: { disabled: false, transport: { type: "http" as const, url } } });
const adapterAccount = (server: string) => `sha256-${createHash("sha256").update(server).digest("hex")}`;
const getOptions = (account: string) => ({ service: "pi-mcp-adapter.oauth", name: account });

async function withSecrets(run: (secrets: SecretStore, backend: FakeSecretBackend, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-oauth-import-"));
  const backend = new FakeSecretBackend();
  try {
    await run(new SecretStore(dir, backend), backend, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createMarker() {
  let value: string | undefined;
  return { get: mock(() => value), set: mock((next: string) => { value = next; }) };
}

function importInput(secrets: SecretStore, entry: unknown) {
  const reader = { read: mock(async (_name: string) => entry) };
  return {
    secrets,
    snapshot: (): Pick<EffectiveMcpServers, "servers" | "configurationError"> => ({ servers: serversAt(exampleUrl) }),
    reader,
    preparePlugins: mock(async () => true),
    createReader: mock(() => reader),
    check: mock(async (_name: string) => true),
    reportRejected: mock((_name: string) => {}),
    now: () => sampleTime,
  };
}

test("adapter import maps tokens, client information, expiry in milliseconds, and the shared issuer", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, {
    serverUrl: "https://TOOLS.example.test:443/./mcp",
    tokens: { accessToken, refreshToken, scope: "read", expiresAt: 1_700_000_000, issuer: exampleIssuer },
    clientInfo: { clientId: "fixture-client", clientSecret, issuer: exampleIssuer },
    codeVerifier: "fixture-verifier", oauthState: "fixture-state",
  });
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  const saved = await new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl }).load();
  expect(saved?.tokensExpireAt).toBe(1_700_000_000_000);
  expect(saved?.discovery?.authorizationServerUrl === exampleIssuer).toBe(true);
  expect(Bun.deepEquals(saved?.tokens, {
    access_token: accessToken, token_type: "Bearer", refresh_token: refreshToken, scope: "read",
  })).toBe(true);
  expect(Bun.deepEquals(saved?.clientInformation, { client_id: "fixture-client", client_secret: clientSecret })).toBe(true);
  expect(saved?.codeVerifier === undefined && saved?.oauthState === undefined).toBe(true);
}));

test.each([
  ["expired token", { serverUrl: exampleUrl, tokens: { accessToken, expiresAt: 1_699_999_998 } }],
  ["token expiring at the current time", { serverUrl: exampleUrl, tokens: { accessToken, expiresAt: 1_699_999_999 } }],
  ["missing access token", { serverUrl: exampleUrl, tokens: { refreshToken } }],
  ["empty access token", { serverUrl: exampleUrl, tokens: { accessToken: "" } }],
  ["non-numeric expiry", { serverUrl: exampleUrl, tokens: { accessToken, expiresAt: "1700000000" } }],
  ["infinite expiry", { serverUrl: exampleUrl, tokens: { accessToken, expiresAt: Infinity } }],
  ["overflowing expiry", { serverUrl: exampleUrl, tokens: { accessToken, expiresAt: Number.MAX_VALUE } }],
  ["non-string refresh token", { serverUrl: exampleUrl, tokens: { accessToken, refreshToken: false } }],
  ["non-string scope", { serverUrl: exampleUrl, tokens: { accessToken, scope: [] } }],
  ["malformed client information", { serverUrl: exampleUrl, tokens: { accessToken }, clientInfo: { clientId: 1 } }],
  ["mismatched issuers", { serverUrl: exampleUrl, tokens: { accessToken, issuer: exampleIssuer }, clientInfo: { clientId: "fixture-client", issuer: "https://other.example.test" } }],
  ["relative token issuer", { serverUrl: exampleUrl, tokens: { accessToken, issuer: "/relative" } }],
  ["file token issuer", { serverUrl: exampleUrl, tokens: { accessToken, issuer: "file:///issuer" } }],
  ["non-string client issuer", { serverUrl: exampleUrl, tokens: { accessToken, issuer: exampleIssuer }, clientInfo: { issuer: null } }],
  ["malformed top-level JSON", "unparsed JSON"],
  ["malformed token shape", { serverUrl: exampleUrl, tokens: [] }],
  ["null entry", null],
  ["chunk manifest", { serverUrl: exampleUrl, __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: "0123456789abcdef", tokens: { accessToken } }],
  // The adapter's getAuthForUrl rejects legacy AuthEntry records without a serverUrl.
  ["missing server URL", { tokens: { accessToken } }],
  ["empty server URL", { serverUrl: "", tokens: { accessToken } }],
  ["invalid server URL", { serverUrl: "/mcp", tokens: { accessToken } }],
  ["non-string server URL", { serverUrl: [exampleUrl], tokens: { accessToken } }],
  ["mismatched server URL", { serverUrl: "https://other.example.test/mcp", tokens: { accessToken } }],
])("adapter import requires sign-in for %s with zero writes or checks", (_label, entry) => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, entry);
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
  expect(input.check).not.toHaveBeenCalled();
  expect(input.reportRejected.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("adapter import stages and checks credentials for a canonically matching server URL", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: "https://TOOLS.example.test:443/./mcp", tokens: { accessToken } });
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(input.check.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(1);
}));

test.each([
  ["pre-registered client", { clientId: "fixture-client", configPreRegistered: true, issuer: exampleIssuer }],
  ["client stub without an ID", { issuer: exampleIssuer }],
])("adapter import retains the issuer and omits client information for a %s", (_label, clientInfo) => withSecrets(async (secrets) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken }, clientInfo });
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  const saved = await new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl }).load();
  expect(saved?.discovery?.authorizationServerUrl === exampleIssuer).toBe(true);
  expect(saved?.clientInformation === undefined).toBe(true);
}));

test("adapter import requires sign-in when configured metadata would bypass the issuer binding", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken, issuer: exampleIssuer } });
  const server = serversAt(exampleUrl)[name];
  const snapshot = () => ({ servers: { [name]: {
    ...server, transport: { ...server.transport, oauth: { authServerMetadataUrl: `${exampleIssuer}/metadata` } },
  } } });
  expect(await importMcpOAuthTokens({ ...input, snapshot })).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
  expect(input.check).not.toHaveBeenCalled();
  expect(input.reportRejected.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(0);

  const withoutIssuer = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  expect(await importMcpOAuthTokens({ ...withoutIssuer, snapshot })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
}));

test("adapter import preserves existing app OAuth state and skips non-HTTP transports", () => withSecrets(async (secrets, backend) => {
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl });
  const appState = { serverUrl: exampleUrl, tokens: { access_token: "fixture-current-app-token", token_type: "Bearer" } };
  await store.save(appState);
  backend.writtenAccounts.length = 0;
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  expect(await importMcpOAuthTokens({
    ...input,
    snapshot: () => ({ servers: { ...serversAt(exampleUrl), local: { disabled: false, transport: { type: "stdio", command: "fixture", args: [] } } } }),
  })).toEqual({ imported: [], needsSignIn: [], skipped: [name, "local"] });
  expect(Bun.deepEquals(await store.load(), appState)).toBe(true);
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test.each([
  ["a disabled HTTP server", { disabled: true, transport: { type: "http" as const, url: exampleUrl } }],
  ["an HTTP server with an explicit Authorization header", { disabled: false, transport: { type: "http" as const, url: exampleUrl, headers: { aUtHoRiZaTiOn: "" } } }],
])("adapter import skips %s before reading or writing", (_label, server) => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const snapshot = () => ({ servers: { [name]: server } });
  expect(await importMcpOAuthTokens({ ...input, snapshot })).toEqual({ imported: [], needsSignIn: [], skipped: [name] });
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("direct adapter import propagates the safe keyring unavailable error", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, undefined);
  const reader = createPiMcpAdapterTokenReader({ get: async () => { throw new Error("Fixture keyring rejected the get."); } });
  const result = await importMcpOAuthTokens({ ...input, reader }).then(() => undefined, (error: unknown) => error);
  expect(result instanceof PiMcpAdapterKeyringUnavailableError).toBe(true);
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("a rejected keyring get stops adapter import without setting the marker or writing OAuth state", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  const get = mock<SecretGet>(async () => { throw new Error("Fixture keyring rejected the get."); });
  const createReader = () => createPiMcpAdapterTokenReader({ get });
  const snapshot = () => ({ servers: { ...serversAt(exampleUrl), later: serversAt(exampleUrl)[name] } });

  expect(await importMcpOAuthTokensOnce({ ...input, marker, createReader, snapshot })).toBe("unavailable");
  expect(get.mock.calls).toEqual([[getOptions(adapterAccount(name))]]);
  expect(input.check).not.toHaveBeenCalled();
  expect(input.reportRejected).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("a hanging keyring get stops adapter import within one second without setting the marker or writing OAuth state", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  const get = mock<SecretGet>(() => new Promise(() => {}));
  const createReader = () => createPiMcpAdapterTokenReader({ get, timeoutMs: 25 });

  const started = performance.now();
  expect(await importMcpOAuthTokensOnce({ ...input, marker, createReader })).toBe("unavailable");
  expect(performance.now() - started).toBeLessThan(1000);
  expect(get.mock.calls).toEqual([[getOptions(adapterAccount(name))]]);
  expect(input.check).not.toHaveBeenCalled();
  expect(input.reportRejected).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}), 1000);

test("adapter import waits for plugin readiness before snapshotting servers or constructing the keyring reader", () => withSecrets(async (secrets) => {
  const ready = Promise.withResolvers<boolean>();
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  const createReader = mock(() => input.reader);
  const snapshot = mock(input.snapshot);
  const importing = importMcpOAuthTokensOnce({ ...input, marker, preparePlugins: () => ready.promise, createReader, snapshot });

  await Promise.resolve();
  const callsBeforeReadiness = [snapshot, createReader, input.reader.read, marker.set].map(({ mock }) => mock.calls.length);
  ready.resolve(true);
  expect(await importing).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(callsBeforeReadiness).toEqual([0, 0, 0, 0]);
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(createReader).toHaveBeenCalledTimes(1);
  expect(input.reader.read).toHaveBeenCalledWith(name);
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("keyring unavailability before plugin readiness leaves the adapter import marker unset", () => withSecrets(async (secrets, backend) => {
  const ready = Promise.withResolvers<boolean>();
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  let available = true;
  const get = mock<SecretGet>(async () => {
    if (!available) throw new Error("Fixture keyring is unavailable.");
    return null;
  });
  const createReader = mock(() => createPiMcpAdapterTokenReader({ get }));
  const importing = importMcpOAuthTokensOnce({ ...input, marker, preparePlugins: () => ready.promise, createReader });

  available = false;
  await Promise.resolve();
  const readsBeforeReadiness = get.mock.calls.length;
  ready.resolve(true);
  expect(await importing).toBe("unavailable");
  expect(readsBeforeReadiness).toBe(0);
  expect(get).toHaveBeenCalledTimes(1);
  expect(marker.set).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("a plugin readiness failure leaves the adapter import marker unset without constructing the reader", () => withSecrets(async (secrets, backend) => {
  const ready = Promise.withResolvers<void>();
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  const createReader = mock(() => input.reader);
  const snapshot = mock(input.snapshot);
  const error = new Error("Fixture plugins are unavailable.");
  const importing = importMcpOAuthTokensOnce({
    ...input, marker, preparePlugins: async () => { await ready.promise; throw error; }, createReader, snapshot,
  });

  ready.resolve();
  await expect(importing).rejects.toBe(error);
  expect(snapshot).not.toHaveBeenCalled();
  expect(createReader).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("adapter import waits for a later successful plugin preparation before reading or marking completion", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  const preparePlugins = mock(async () => true).mockImplementationOnce(async () => false);
  const snapshot = mock(input.snapshot);
  const onceInput = { ...input, marker, preparePlugins, snapshot };

  expect(await importMcpOAuthTokensOnce(onceInput)).toBe("unavailable");
  expect(snapshot).not.toHaveBeenCalled();
  expect(input.createReader).not.toHaveBeenCalled();
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
  expect(marker.set).not.toHaveBeenCalled();
  expect(marker.get()).toBeUndefined();

  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(preparePlugins).toHaveBeenCalledTimes(2);
  expect(input.createReader).toHaveBeenCalledTimes(1);
  expect(input.reader.read.mock.calls).toEqual([[name]]);
  expect(input.check.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(1);
  expect(marker.set.mock.calls).toEqual([["1"]]);
  expect(marker.get()).toBe("1");
}));

test("adapter import marks completion after checking and reads nothing on a second run", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  input.check.mockImplementation(async () => {
    expect(marker.set).not.toHaveBeenCalled();
    return true;
  });
  expect(await importMcpOAuthTokensOnce({ ...input, marker })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(marker.set).toHaveBeenCalledWith("1");
  expect(input.reader.read).toHaveBeenCalledWith(name);
  input.reader.read.mockClear();
  expect(await importMcpOAuthTokensOnce({ ...input, marker })).toBe("already-imported");
  expect(input.preparePlugins).toHaveBeenCalledTimes(1);
  expect(input.createReader).toHaveBeenCalledTimes(1);
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(marker.set).toHaveBeenCalledTimes(1);
}));

test("adapter import keeps successful imports and retries only the server whose read failed", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  input.reader.read.mockImplementationOnce(async () => { throw new Error("Fixture reader failed."); });
  const onceInput = {
    ...input, marker,
    snapshot: () => ({ servers: { first: serversAt(exampleUrl)[name], ...serversAt(exampleUrl) } }),
  };
  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: [name], needsSignIn: ["first"], skipped: [] });
  expect(input.check.mock.calls).toEqual([[name], ["first"]]);
  expect(input.reportRejected).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();

  input.reader.read.mockClear();
  input.check.mockClear();
  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: ["first"], needsSignIn: [], skipped: [name] });
  expect(input.reader.read.mock.calls).toEqual([["first"]]);
  expect(input.check.mock.calls).toEqual([["first"]]);
  expect(input.reportRejected).not.toHaveBeenCalled();
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("adapter import preserves a successful import after a rejected keyring get and retries only the remaining server", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  const retryName = "retry";
  const retryAccount = adapterAccount(retryName);
  const entry = JSON.stringify({ serverUrl: exampleUrl, tokens: { accessToken } });
  let available = false;
  const get = mock<SecretGet>(async ({ name: account }) => {
    if (account === retryAccount && !available) throw new Error("Fixture keyring rejected the get.");
    return entry;
  });
  const createReader = () => createPiMcpAdapterTokenReader({ get });
  const snapshot = () => ({ servers: { ...serversAt(exampleUrl), [retryName]: serversAt(exampleUrl)[name] } });
  const onceInput = { ...input, marker, createReader, snapshot };
  const first = new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl });
  const retry = new SecretMcpOAuthStateStore({ secrets, name: retryName, server: exampleUrl });

  expect(await importMcpOAuthTokensOnce(onceInput)).toBe("unavailable");
  expect(marker.set).not.toHaveBeenCalled();
  expect(get.mock.calls).toEqual([[getOptions(adapterAccount(name))], [getOptions(retryAccount)]]);
  expect(input.check.mock.calls).toEqual([[name]]);
  expect((await first.load())?.tokens?.access_token === accessToken).toBe(true);
  expect((await retry.load()) === undefined).toBe(true);
  expect(backend.writtenAccounts).toHaveLength(1);

  available = true;
  get.mockClear();
  input.check.mockClear();
  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: [retryName], needsSignIn: [], skipped: [name] });
  expect(get.mock.calls).toEqual([[getOptions(retryAccount)]]);
  expect(input.check.mock.calls).toEqual([[retryName]]);
  expect(input.reportRejected).not.toHaveBeenCalled();
  expect((await retry.load())?.tokens?.access_token === accessToken).toBe(true);
  expect(backend.writtenAccounts).toHaveLength(2);
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("an invalid keyring entry requires sign-in for only that server and adapter import completes", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  const get = mock<SecretGet>(async ({ name: account }) => account === adapterAccount("broken")
    ? "invalid JSON"
    : JSON.stringify({ serverUrl: exampleUrl, tokens: { accessToken } }));
  const createReader = () => createPiMcpAdapterTokenReader({ get });
  const snapshot = () => ({ servers: { broken: serversAt(exampleUrl)[name], ...serversAt(exampleUrl) } });

  expect(await importMcpOAuthTokensOnce({ ...input, marker, createReader, snapshot })).toEqual({ imported: [name], needsSignIn: ["broken"], skipped: [] });
  expect(input.reportRejected.mock.calls).toEqual([["broken"]]);
  expect(input.check.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(1);
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("adapter import leaves the marker unset until there is an eligible server", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  const http = serversAt(exampleUrl)[name];
  const ineligible = {
    disabled: { ...http, disabled: true },
    authorized: { ...http, transport: { ...http.transport, headers: { Authorization: "" } } },
    local: { disabled: false, transport: { type: "stdio" as const, command: "fixture", args: [] } },
  };

  expect(await importMcpOAuthTokensOnce({ ...input, marker, snapshot: () => ({ servers: ineligible }) }))
    .toEqual({ imported: [], needsSignIn: [], skipped: ["disabled", "authorized", "local"] });
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
  expect(marker.set).not.toHaveBeenCalled();

  expect(await importMcpOAuthTokensOnce({ ...input, marker, snapshot: () => ({ servers: { ...ineligible, ...serversAt(exampleUrl) } }) }))
    .toEqual({ imported: [name], needsSignIn: [], skipped: ["disabled", "authorized", "local"] });
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("adapter import leaves the marker unset and reads nothing when the snapshot has a configuration error", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  const snapshot = () => ({ ...input.snapshot(), configurationError: "Fixture configuration could not be loaded." });
  expect(await importMcpOAuthTokensOnce({ ...input, marker, snapshot })).toEqual({ imported: [], needsSignIn: [], skipped: [] });
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("adapter import retries a server after its configuration error is fixed", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  const healthy = serversAt(exampleUrl);
  const repairedUrl = "https://repaired.example.test/mcp";
  input.reader.read.mockImplementation(async (service) => ({
    serverUrl: service === "broken" ? repairedUrl : exampleUrl, tokens: { accessToken },
  }));
  let repaired = false;
  const snapshot = (): ReturnType<typeof input.snapshot> => ({ servers: {
    ...healthy,
    broken: repaired ? serversAt(repairedUrl)[name] : { configurationError: "Fixture configuration conflict." },
  } });
  const healthyStore = new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl });
  const repairedStore = new SecretMcpOAuthStateStore({ secrets, name: "broken", server: repairedUrl });
  const onceInput = { ...input, marker, snapshot };

  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: [name], needsSignIn: [], skipped: ["broken"] });
  expect((await healthyStore.load())?.tokens?.access_token === accessToken).toBe(true);
  expect(input.reader.read.mock.calls).toEqual([[name]]);
  expect(await repairedStore.load()).toBeUndefined();
  expect(marker.set).not.toHaveBeenCalled();

  repaired = true;
  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: ["broken"], needsSignIn: [], skipped: [name] });
  expect((await repairedStore.load())?.tokens?.access_token === accessToken).toBe(true);
  expect(input.reader.read.mock.calls).toEqual([[name], ["broken"]]);
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("adapter import rethrows a complete reader failure and leaves the marker unset", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, undefined);
  const marker = createMarker();
  const readerError = new Error("Fixture reader unavailable.");
  input.reader.read.mockImplementation(async () => { throw readerError; });
  const snapshot = () => ({ servers: { ...serversAt(exampleUrl), local: { disabled: false, transport: { type: "socket" as const } } } });
  await expect(importMcpOAuthTokensOnce({ ...input, snapshot, marker })).rejects.toBe(readerError);
  expect(marker.set).not.toHaveBeenCalled();
  expect(input.check.mock.calls).toEqual([[name]]);
  expect(input.reportRejected).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("adapter import checks anonymous MCP connectivity after a reader failure", () => withSecrets(async (secrets, backend) => {
  const fixture = new McpServer({ name: "anonymous-fixture", version: "1" });
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => crypto.randomUUID() });
  fixture.registerTool("read", {}, () => ({ content: [{ type: "text", text: "read" }] }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return request.headers.has("authorization") ? new Response(null, { status: 400 }) : transport.handleRequest(request);
  } });
  const snapshot = () => ({ revision: "anonymous", secrets: [], servers: serversAt(server.url.href) });
  const mcp = createMcpExtension({ servers: snapshot });
  const input = importInput(secrets, undefined);
  input.reader.read.mockImplementation(async () => { throw new Error("Fixture reader unavailable."); });
  input.check.mockImplementation(async (service) => (await mcp.check(service))?.status === "connected");
  input.reportRejected.mockImplementation((service) => { mcp.markNeedsAuth(service); });
  try {
    await fixture.connect(transport);
    expect(await importMcpOAuthTokens({ ...input, snapshot })).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
    expect(input.check.mock.calls).toEqual([[name]]);
    expect(mcp.status()).toMatchObject([{ name, status: "connected", toolCount: 1 }]);
    expect(input.reportRejected).not.toHaveBeenCalled();
    expect(backend.writtenAccounts).toHaveLength(0);
  } finally {
    try { await mcp.close(); }
    finally {
      await server.stop(true);
      await fixture.close();
    }
  }
}));

test("a failed connection check clears the imported credentials and leaves the marker unset", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, {
    serverUrl: exampleUrl,
    tokens: { accessToken, expiresAt: 1_700_000_000 },
    clientInfo: { clientId: "fixture-client" },
  });
  const marker = createMarker();
  const checkError = new Error("Fixture check failed.");
  input.check.mockImplementation(async () => { throw checkError; });
  await expect(importMcpOAuthTokensOnce({ ...input, marker })).rejects.toBe(checkError);
  expect(input.reportRejected.mock.calls).toEqual([[name]]);
  expect(marker.set).not.toHaveBeenCalled();
  const saved = await new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl }).load();
  expect(saved).toEqual({ serverUrl: exampleUrl, clientInformation: { client_id: "fixture-client" } });
}));

async function withOAuthMcp(run: (context: ReturnType<typeof setupOAuthMcp>) => Promise<void>) {
  await withSecrets(async (secrets, backend, dir) => {
    const fixture = await startOAuthMcpServer();
    const context = setupOAuthMcp(fixture, secrets, backend, dir);
    try {
      await run(context);
    } finally {
      try {
        await Promise.all([context.mcp.close(), context.manager.close()]);
      } finally {
        await fixture.close();
      }
    }
  });
}

function setupOAuthMcp(fixture: Awaited<ReturnType<typeof startOAuthMcpServer>>, secrets: SecretStore, backend: FakeSecretBackend, dir: string) {
  const manager = new McpOAuthManager({ secrets });
  const snapshot = (): EffectiveMcpServers => ({
    revision: "fixture", secrets: [], servers: { ...serversAt(fixture.url), absent: serversAt(fixture.url)[name] },
  });
  const mcp = createMcpExtension({
    servers: snapshot,
    authProvider: (service, url) => manager.authProvider(service, url),
  });
  return {
    fixture, mcp, manager, secrets, backend, dir,
    importEntry: (reader: PiMcpAdapterTokenReader) => importMcpOAuthTokens({
      secrets,
      snapshot: () => ({ servers: serversAt(fixture.url) }),
      reader,
      check: async (service) => (await mcp.check(service))?.status === "connected",
      reportRejected: (service: string) => mcp.markNeedsAuth(service),
    }),
    async callTool() {
      const result = await mcp.tools![0]!.execute({ action: "call", service: name, tool: "read_fixture" },
        {} as ToolExecutionApi, BACKGROUND_CONTEXT);
      expect(Bun.deepEquals(result, { isError: false, output: [{ type: "text", text: "OAuth MCP fixture result" }] })).toBe(true);
    },
  };
}

async function issueAdapterEntry(url: string, dir: string) {
  const sourceSecrets = new SecretStore(path.join(dir, "adapter-fixture"), new FakeSecretBackend());
  const manager = new McpOAuthManager({ secrets: sourceSecrets });
  try {
    const start = await manager.start({ name, serverUrl: url, authorizationId: "fixture-seed" });
    if (!("authorizationUrl" in start)) throw new Error("Expected the fixture to require authorization.");
    const response = await fetch(start.authorizationUrl, { redirect: "manual" }).catch(() => {
      throw new Error("Fixture authorization request failed.");
    });
    const redirectUrl = response.headers.get("location");
    if (!redirectUrl) throw new Error("Expected the fixture authorization redirect.");
    expect((await manager.complete({ name, redirectUrl })).status).toBe("completed");
    const state = await new SecretMcpOAuthStateStore({ name, secrets: sourceSecrets, server: url }).load();
    if (!state?.tokens?.refresh_token || !state.clientInformation || state.tokensExpireAt === undefined) {
      throw new Error("Expected the fixture to issue tokens and client information.");
    }
    return {
      serverUrl: url,
      tokens: {
        accessToken: state.tokens.access_token, refreshToken: state.tokens.refresh_token,
        expiresAt: state.tokensExpireAt / 1000, issuer: state.discovery?.authorizationServerUrl, scope: "read",
      },
      clientInfo: { clientId: state.clientInformation.client_id },
    };
  } finally {
    await manager.close();
  }
}

test.each(["plain", "chunked"] as const)("adapter import uses only keyring gets for a %s entry and enables the MCP tool", (format) => withOAuthMcp(async (ctx) => {
  const entry = await issueAdapterEntry(ctx.fixture.url, ctx.dir);
  if (format === "chunked") entry.tokens.scope = "read ".repeat(250).trim();
  const payload = JSON.stringify(entry);
  const account = adapterAccount(name);
  const values = new Map([[account, payload]]);
  if (format === "chunked") {
    expect(payload.length).toBeGreaterThan(1000);
    expect(payload.length).toBeLessThanOrEqual(2000);
    const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    values.set(account, JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: digest }));
    values.set(`${account}.chunk.${digest}.0`, payload.slice(0, 1000));
    values.set(`${account}.chunk.${digest}.1`, payload.slice(1000));
  } else {
    expect(payload.length).toBeLessThanOrEqual(1000);
  }
  const get = mock<SecretGet>(async ({ name }) => values.get(name) ?? null);
  const accessed: string[] = [];
  const reader = new Proxy(createPiMcpAdapterTokenReader({ get }), {
    get(target, property) {
      if (property !== "read") throw new Error("Unexpected adapter reader property.");
      accessed.push(property);
      return target[property];
    },
    set() { throw new Error("Unexpected write to the adapter reader."); },
    deleteProperty() { throw new Error("Unexpected deletion from the adapter reader."); },
    defineProperty() { throw new Error("Unexpected property definition on the adapter reader."); },
    setPrototypeOf() { throw new Error("Unexpected prototype change on the adapter reader."); },
  });
  expect(await ctx.importEntry(reader)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(accessed).toEqual(["read"]);
  expect(get.mock.calls).toEqual([...values.keys()].map((name) => [getOptions(name)]));
  expect(ctx.mcp.status()).toContainEqual(expect.objectContaining({ name, status: "connected", toolCount: 1 }));
  await ctx.callTool();
  expect(ctx.fixture.counts).toMatchObject({ authorize: 1, token: 1, toolCalls: 1, refresh: 0 });
  const secretName = mcpOAuthSecretName(name, ctx.fixture.url);
  const saved = await new SecretMcpOAuthStateStore({ secrets: ctx.secrets, name, server: ctx.fixture.url }).load();
  expect(Bun.deepEquals(saved?.tokens, {
    access_token: entry.tokens.accessToken, refresh_token: entry.tokens.refreshToken, scope: entry.tokens.scope, token_type: "Bearer",
  })).toBe(true);
  expect(saved?.tokensExpireAt).toBe(entry.tokens.expiresAt * 1000);
  expect(saved?.clientInformation?.client_id === entry.clientInfo.clientId).toBe(true);
  expect(await ctx.secrets.forApp().list()).toEqual([{ name: secretName, description: `MCP OAuth state (${secretName})` }]);
  expect(await ctx.secrets.forBot("fixture-bot").list()).toEqual([]);
  const namespace = createHash("sha256").update(await realpath(ctx.dir)).digest("hex");
  const appAccount = createHash("sha256").update(JSON.stringify(["app", secretName])).digest("hex");
  expect(ctx.backend.writtenAccounts).toEqual([`${namespace}:${appAccount}`]);
}));

test("adapter import clears a rejected token, keeps discovery, and retries a later import", () => withOAuthMcp(async (ctx) => {
  const store = new SecretMcpOAuthStateStore({ secrets: ctx.secrets, name, server: ctx.fixture.url });
  const tokensPresentDuringValidationAndReport: Promise<boolean>[] = [];
  let discovered: Awaited<ReturnType<SecretMcpOAuthStateStore["load"]>>;
  const read = mock(async (_name: string) => ({ serverUrl: ctx.fixture.url, tokens: { accessToken, refreshToken } }));
  const input = {
    secrets: ctx.secrets,
    snapshot: () => ({ servers: serversAt(ctx.fixture.url) }),
    reader: { read },
    async check(service: string) {
      tokensPresentDuringValidationAndReport.push(store.load().then((state) => state?.tokens !== undefined));
      const status = (await ctx.mcp.check(service))?.status;
      if (tokensPresentDuringValidationAndReport.length === 1) {
        discovered = await store.load();
        expect(discovered?.tokens?.access_token === accessToken).toBe(true);
        expect(discovered?.discovery?.authorizationServerUrl).toBe(ctx.fixture.origin);
      }
      return status === "connected";
    },
    reportRejected(service: string) {
      tokensPresentDuringValidationAndReport.push(store.load().then((state) => state?.tokens !== undefined));
      ctx.mcp.markNeedsAuth(service);
    },
  };
  const needsSignIn = { imported: [], needsSignIn: [name], skipped: [] };
  expect(await importMcpOAuthTokens(input)).toEqual(needsSignIn);
  expect(await Promise.all(tokensPresentDuringValidationAndReport)).toEqual([true, false]);
  expect(ctx.fixture.observedAuthorization.has(`Bearer ${accessToken}`)).toBe(true);
  expect(ctx.mcp.status()[0]?.status).toBe("needs-auth");
  const saved = await store.load();
  expect(saved?.tokens === undefined).toBe(true);
  expect(saved?.discovery).toEqual(discovered?.discovery);

  expect(await importMcpOAuthTokens(input)).toEqual(needsSignIn);
  expect(read.mock.calls).toEqual([[name], [name]]);
  const start = await ctx.manager.start({ name, serverUrl: ctx.fixture.url, authorizationId: "fresh-sign-in" });
  expect("authorizationUrl" in start).toBe(true);
}));

test("adapter import reports an expired entry as needs-auth and leaves a missing entry unchecked", () => withOAuthMcp(async (ctx) => {
  const check = mock(async (service: string) => (await ctx.mcp.check(service))?.status === "connected");
  const reportRejected = mock((service: string) => ctx.mcp.markNeedsAuth(service));
  const snapshot = () => ({ servers: { ...serversAt(ctx.fixture.url), absent: serversAt(ctx.fixture.url)[name] } });
  const report = await importMcpOAuthTokens({
    secrets: ctx.secrets, snapshot, check, reportRejected, now: () => sampleTime,
    reader: { read: async (service) => service === name ? { serverUrl: ctx.fixture.url, tokens: { accessToken, expiresAt: 1 } } : undefined },
  });
  expect(report).toEqual({ imported: [], needsSignIn: [name], skipped: ["absent"] });
  expect(check).not.toHaveBeenCalled();
  expect(reportRejected.mock.calls).toEqual([[name]]);
  expect(ctx.mcp.status().map(({ name, status }) => [name, status])).toEqual([[name, "needs-auth"], ["absent", "not-connected"]]);
  expect(ctx.backend.writtenAccounts).toHaveLength(0);
}));

test("failed import cleanup preserves a change to only the staged token expiry", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken, refreshToken, expiresAt: 1_700_000_000 } });
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl });
  const updatedExpiry = 1_700_000_001_000;
  let expectedState: Awaited<ReturnType<SecretMcpOAuthStateStore["load"]>>;
  let writesAfterExpiryChange = 0;
  input.check.mockImplementation(async () => false).mockImplementationOnce(async () => {
    await store.withRefreshLock(async () => {
      const staged = await store.load();
      if (!staged) throw new Error("Expected staged credentials during the check.");
      expectedState = { ...staged, tokensExpireAt: updatedExpiry };
      await store.save(expectedState);
      writesAfterExpiryChange = backend.writtenAccounts.length;
    });
    return false;
  });
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
  expect(Bun.deepEquals(await store.load(), expectedState)).toBe(true);
  expect(backend.writtenAccounts).toHaveLength(writesAfterExpiryChange);
}));

test("failed import cleanup preserves browser OAuth state written alongside discovery", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken }, clientInfo: { clientId: "fixture-client" } });
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl });
  let expectedState: Awaited<ReturnType<SecretMcpOAuthStateStore["load"]>>;
  let writesAfterSignIn = 0;
  input.check.mockImplementation(async () => false).mockImplementationOnce(async () => {
    await store.withRefreshLock(async () => {
      const staged = await store.load();
      if (!staged) throw new Error("Expected staged credentials during the check.");
      expectedState = { ...staged, discovery: { authorizationServerUrl: exampleIssuer }, oauthState: "fixture-state" };
      await store.save(expectedState);
      writesAfterSignIn = backend.writtenAccounts.length;
    });
    return false;
  });
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
  expect(Bun.deepEquals(await store.load(), expectedState)).toBe(true);
  expect(backend.writtenAccounts).toHaveLength(writesAfterSignIn);
}));

test("pi-mcp rejects a later authorization-server issuer change before refreshing an imported token", () => withOAuthMcp(async (ctx) => {
  const entry = await issueAdapterEntry(ctx.fixture.url, ctx.dir);
  expect(await ctx.importEntry({ read: async () => entry })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  const replacementIssuer = `${ctx.fixture.origin}/replacement`;
  const tokenEndpoint = `${replacementIssuer}/token`;
  let refreshRequests = 0;
  const provider = ctx.manager.authProvider(name, ctx.fixture.url);
  const refresh = provider.onUnauthorized!({
    response: new Response(null, {
      status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${ctx.fixture.origin}/.well-known/oauth-protected-resource"` },
    }),
    serverUrl: new URL(ctx.fixture.url),
    token: entry.tokens.accessToken,
    async fetch(input) {
      switch (new URL(input).pathname) {
        case "/.well-known/oauth-protected-resource":
          return Response.json({ resource: ctx.fixture.url, authorization_servers: [replacementIssuer] });
        case "/.well-known/oauth-authorization-server":
        case "/.well-known/oauth-authorization-server/replacement":
          return Response.json({
            issuer: replacementIssuer, authorization_endpoint: `${replacementIssuer}/authorize`,
            token_endpoint: tokenEndpoint, response_types_supported: ["code"],
          });
        case "/replacement/token":
          refreshRequests++;
          return Response.json({ access_token: "fixture-replacement-token", token_type: "Bearer" });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  expect(await refresh.then(() => false, (error: unknown) => error instanceof OAuthIssuerMismatchError)).toBe(true);
  expect(refreshRequests).toBe(0);
}));

test("the durable tool refreshes an imported token with the imported client ID", () => withOAuthMcp(async (ctx) => {
  const entry = await issueAdapterEntry(ctx.fixture.url, ctx.dir);
  expect(await ctx.importEntry({ read: async () => entry })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  const { unauthorized, refresh } = ctx.fixture.counts;
  ctx.fixture.rotateAccessToken();
  await ctx.callTool();
  expect(ctx.fixture.counts).toMatchObject({ unauthorized: unauthorized + 1, refresh: refresh + 1, register: 1, toolCalls: 1 });
  const saved = await new SecretMcpOAuthStateStore({ secrets: ctx.secrets, name, server: ctx.fixture.url }).load();
  expect(!!saved?.tokens?.access_token && saved.tokens.access_token !== entry.tokens.accessToken).toBe(true);
}));

test("daemon shutdown lets the OAuth import finish its connection check before closing the runtime", () => withSecrets(async (secrets) => {
  const readiness = Promise.withResolvers<boolean>();
  const finishCheck = Promise.withResolvers<void>();
  const checkStarted = Promise.withResolvers<void>();
  const input = importInput(secrets, { serverUrl: exampleUrl, tokens: { accessToken } });
  const marker = createMarker();
  const close = mock(async () => {});
  input.check.mockImplementation(async () => {
    checkStarted.resolve();
    await finishCheck.promise;
    return close.mock.calls.length === 0;
  });
  const importing = importMcpOAuthTokensOnce({ ...input, marker, preparePlugins: () => readiness.promise });
  const closing = closeRuntimeAfterMcpOAuthImport(importing, close);

  readiness.resolve(true);
  await checkStarted.promise;
  const callsDuringCheck = close.mock.calls.length;
  finishCheck.resolve();
  await closing;
  expect(callsDuringCheck).toBe(0);
  expect(await importing).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(marker.set).toHaveBeenCalledWith("1");
  expect(close).toHaveBeenCalledTimes(1);
}));

test.each([
  ["undefined", undefined, false],
  ['""', "", false],
  ['"0"', "0", false],
  ['"true"', "true", false],
  ['" OR "', " OR ", false],
  ['" 1 "', " 1 ", false],
  ['"yes"', "yes", false],
  ['"1"', "1", true],
])("daemon test keyring guard uses an exact match for %s", (_label, value, expected) => {
  expect(keyringAccessDisabled({ OMARCHY_TEST_DISABLE_KEYRING: value })).toBe(expected);
});

test("daemon product source references Bun.secrets exactly once through a get call in guarded bootstrap", async () => {
  const sourceDir = new URL("../../", import.meta.url);
  const sourceFiles = new Bun.Glob("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}");
  const references: { file: string; text: string }[] = [];
  for await (const file of sourceFiles.scan({ cwd: fileURLToPath(sourceDir), dot: true })) {
    if (/\.(test|spec)\.[^.]+$/.test(file)) continue;
    const source = await Bun.file(new URL(file, sourceDir)).text();
    for (const match of source.matchAll(/\bBun\s*(?:\.\s*secrets\b|\[\s*["']secrets["']\s*\])(?:\s*\.\s*get\s*\()?/g)) {
      references.push({ file, text: match[0] });
    }
  }
  expect(references).toEqual([{ file: "bootstrap/main.ts", text: "Bun.secrets.get(" }]);

  const bootstrapSource = await Bun.file(new URL("bootstrap/main.ts", sourceDir)).text();
  const guardedReader = /if \(!keyringAccessDisabled\(process\.env\) && typeof runtime\.mcpControl === "function"\) \{\s*const markerKey = [^\n]+\s*mcpOAuthImport = importMcpOAuthTokensOnce\(\{[^}]+createReader: \(\) => createPiMcpAdapterTokenReader\(\{ get: \(options\) => Bun\.secrets\.get\(/;
  expect(guardedReader.test(bootstrapSource)).toBe(true);
});

test("the integration harness sets OMARCHY_TEST_DISABLE_KEYRING before starting the daemon", async () => {
  const source = await Bun.file(new URL("../../../../../tests/integration/helpers/harness.ts", import.meta.url)).text();
  expect(/function startDaemon\([\s\S]*?^  process\.env\.OMARCHY_TEST_DISABLE_KEYRING = "1";$[\s\S]*?await main\(/m.test(source)).toBe(true);
});
