import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { OAuthIssuerMismatchError } from "@earendil-works/pi-mcp/oauth";
import type { EffectiveMcpServers } from "../plugins/nativeMcp.ts";
import { createMcpExtension } from "./extensions/mcp.ts";
import { McpOAuthManager, mcpOAuthSecretName, SecretMcpOAuthStateStore } from "./mcpOAuth.ts";
import { importMcpOAuthTokens, importMcpOAuthTokensOnce, pendingPiMcpAdapterTokenReader, type PiMcpAdapterTokenReader } from "./mcpOAuthImport.ts";
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
  return {
    secrets,
    snapshot: (): Pick<EffectiveMcpServers, "servers" | "configurationError"> => ({ servers: serversAt(exampleUrl) }),
    reader: { available: true, read: mock(async (_name: string) => entry) },
    check: mock(async (_name: string) => true),
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
  ["expired token", { tokens: { accessToken, expiresAt: 1_699_999_998 } }],
  ["token expiring at the current time", { tokens: { accessToken, expiresAt: 1_699_999_999 } }],
  ["missing access token", { tokens: { refreshToken } }],
  ["empty access token", { tokens: { accessToken: "" } }],
  ["non-numeric expiry", { tokens: { accessToken, expiresAt: "1700000000" } }],
  ["infinite expiry", { tokens: { accessToken, expiresAt: Infinity } }],
  ["overflowing expiry", { tokens: { accessToken, expiresAt: Number.MAX_VALUE } }],
  ["non-string refresh token", { tokens: { accessToken, refreshToken: false } }],
  ["non-string scope", { tokens: { accessToken, scope: [] } }],
  ["malformed client information", { tokens: { accessToken }, clientInfo: { clientId: 1 } }],
  ["mismatched issuers", { tokens: { accessToken, issuer: exampleIssuer }, clientInfo: { clientId: "fixture-client", issuer: "https://other.example.test" } }],
  ["relative token issuer", { tokens: { accessToken, issuer: "/relative" } }],
  ["file token issuer", { tokens: { accessToken, issuer: "file:///issuer" } }],
  ["non-string client issuer", { tokens: { accessToken, issuer: exampleIssuer }, clientInfo: { issuer: null } }],
  ["malformed top-level JSON", "unparsed JSON"],
  ["malformed token shape", { tokens: [] }],
  ["null entry", null],
  ["chunk manifest", { __piMcpAdapterOAuthChunked: 1, chunkCount: 2, chunkDigest: "0123456789abcdef", tokens: { accessToken } }],
  ["mismatched server URL", { serverUrl: "https://other.example.test/mcp", tokens: { accessToken } }],
])("adapter import requires sign-in for %s with zero writes", (_label, entry) => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, entry);
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
  expect(input.check.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test.each([
  ["pre-registered client", { clientId: "fixture-client", configPreRegistered: true, issuer: exampleIssuer }],
  ["client stub without an ID", { issuer: exampleIssuer }],
])("adapter import retains the issuer and omits client information for a %s", (_label, clientInfo) => withSecrets(async (secrets) => {
  const input = importInput(secrets, { tokens: { accessToken }, clientInfo });
  expect(await importMcpOAuthTokens(input)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  const saved = await new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl }).load();
  expect(saved?.discovery?.authorizationServerUrl === exampleIssuer).toBe(true);
  expect(saved?.clientInformation === undefined).toBe(true);
}));

test("adapter import requires sign-in when configured metadata would bypass the issuer binding", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { tokens: { accessToken, issuer: exampleIssuer } });
  const server = serversAt(exampleUrl)[name];
  const snapshot = () => ({ servers: { [name]: {
    ...server, transport: { ...server.transport, oauth: { authServerMetadataUrl: `${exampleIssuer}/metadata` } },
  } } });
  expect(await importMcpOAuthTokens({ ...input, snapshot })).toEqual({ imported: [], needsSignIn: [name], skipped: [] });
  expect(input.check.mock.calls).toEqual([[name]]);
  expect(backend.writtenAccounts).toHaveLength(0);

  const unbound = importInput(secrets, { tokens: { accessToken } });
  expect(await importMcpOAuthTokens({ ...unbound, snapshot })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
}));

test("adapter import preserves existing app OAuth state and skips non-HTTP transports", () => withSecrets(async (secrets, backend) => {
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: exampleUrl });
  const appState = { serverUrl: exampleUrl, tokens: { access_token: "fixture-current-app-token", token_type: "Bearer" } };
  await store.save(appState);
  backend.writtenAccounts.length = 0;
  const input = importInput(secrets, { tokens: { accessToken } });
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
  const input = importInput(secrets, { tokens: { accessToken } });
  const snapshot = () => ({ servers: { [name]: server } });
  expect(await importMcpOAuthTokens({ ...input, snapshot })).toEqual({ imported: [], needsSignIn: [], skipped: [name] });
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("adapter importer directly refuses an unavailable reader with a safe error", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { tokens: { accessToken } });
  const reader = { ...input.reader, available: false };
  await expect(importMcpOAuthTokens({ ...input, reader })).rejects.toThrow("The MCP OAuth adapter token reader is unavailable.");
  expect(reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("adapter import stays pending while the reader is unavailable", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, { tokens: { accessToken } });
  const marker = createMarker();
  const reader = { ...pendingPiMcpAdapterTokenReader, read: mock(pendingPiMcpAdapterTokenReader.read) };
  expect(await importMcpOAuthTokensOnce({ ...input, marker, reader })).toBe("unavailable");
  expect(reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(marker.get).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();
}));

test("adapter import marks completion after checking and reads nothing on a second run", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, { tokens: { accessToken } });
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
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(marker.set).toHaveBeenCalledTimes(1);
}));

test("adapter import keeps successful imports and retries only the server whose read failed", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, { tokens: { accessToken } });
  const marker = createMarker();
  input.reader.read.mockImplementationOnce(async () => { throw new Error("Fixture reader failed."); });
  const onceInput = {
    ...input, marker,
    snapshot: () => ({ servers: { first: serversAt(exampleUrl)[name], ...serversAt(exampleUrl) } }),
  };
  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: [name], needsSignIn: ["first"], skipped: [] });
  expect(input.check.mock.calls).toEqual([[name], ["first"]]);
  expect(marker.set).not.toHaveBeenCalled();

  input.reader.read.mockClear();
  input.check.mockClear();
  expect(await importMcpOAuthTokensOnce(onceInput)).toEqual({ imported: ["first"], needsSignIn: [], skipped: [name] });
  expect(input.reader.read.mock.calls).toEqual([["first"]]);
  expect(input.check.mock.calls).toEqual([["first"]]);
  expect(marker.set).toHaveBeenCalledWith("1");
}));

test("adapter import leaves the marker unset and reads nothing when the snapshot has a configuration error", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { tokens: { accessToken } });
  const marker = createMarker();
  const snapshot = () => ({ ...input.snapshot(), configurationError: "Fixture configuration could not be loaded." });
  expect(await importMcpOAuthTokensOnce({ ...input, marker, snapshot })).toEqual({ imported: [], needsSignIn: [], skipped: [] });
  expect(input.reader.read).not.toHaveBeenCalled();
  expect(input.check).not.toHaveBeenCalled();
  expect(marker.set).not.toHaveBeenCalled();
  expect(backend.writtenAccounts).toHaveLength(0);
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
  expect(backend.writtenAccounts).toHaveLength(0);
}));

test("a failed connection check clears the imported credentials and leaves the marker unset", () => withSecrets(async (secrets) => {
  const input = importInput(secrets, {
    tokens: { accessToken, expiresAt: 1_700_000_000 },
    clientInfo: { clientId: "fixture-client" },
  });
  const marker = createMarker();
  const checkError = new Error("Fixture check failed.");
  input.check.mockImplementation(async () => { throw checkError; });
  await expect(importMcpOAuthTokensOnce({ ...input, marker })).rejects.toBe(checkError);
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
      tokens: {
        accessToken: state.tokens.access_token, refreshToken: state.tokens.refresh_token,
        expiresAt: state.tokensExpireAt / 1000, issuer: state.discovery?.authorizationServerUrl,
      },
      clientInfo: { clientId: state.clientInformation.client_id },
    };
  } finally {
    await manager.close();
  }
}

test("adapter import uses the read-only reader and the manager's app OAuth account", () => withOAuthMcp(async (ctx) => {
  const entry = await issueAdapterEntry(ctx.fixture.url, ctx.dir);
  const accessed: string[] = [];
  const read = mock(async (_name: string) => entry);
  const reader = new Proxy({ available: true, read }, {
    get(target, property) {
      if (property !== "available" && property !== "read") throw new Error("Unexpected adapter reader property.");
      accessed.push(property);
      return target[property];
    },
    set() { throw new Error("Unexpected write to the adapter reader."); },
    deleteProperty() { throw new Error("Unexpected deletion from the adapter reader."); },
    defineProperty() { throw new Error("Unexpected property definition on the adapter reader."); },
    setPrototypeOf() { throw new Error("Unexpected prototype change on the adapter reader."); },
  });
  expect(await ctx.importEntry(reader)).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  expect(accessed).toEqual(["available", "read"]);
  expect(read.mock.calls).toEqual([[name]]);
  await ctx.callTool();
  expect(ctx.fixture.counts).toMatchObject({ authorize: 1, token: 1, toolCalls: 1, refresh: 0 });
  const secretName = mcpOAuthSecretName(name, ctx.fixture.url);
  const saved = await new SecretMcpOAuthStateStore({ secrets: ctx.secrets, name, server: ctx.fixture.url }).load();
  expect(saved?.tokens?.access_token === entry.tokens.accessToken).toBe(true);
  expect(await ctx.secrets.forApp().list()).toEqual([{ name: secretName, description: `MCP OAuth state (${secretName})` }]);
  expect(await ctx.secrets.forBot("fixture-bot").list()).toEqual([]);
  const namespace = createHash("sha256").update(await realpath(ctx.dir)).digest("hex");
  const appAccount = createHash("sha256").update(JSON.stringify(["app", secretName])).digest("hex");
  expect(ctx.backend.writtenAccounts).toEqual([`${namespace}:${appAccount}`]);
}));

test("adapter import clears a rejected token, keeps discovery, and retries a later import", () => withOAuthMcp(async (ctx) => {
  const store = new SecretMcpOAuthStateStore({ secrets: ctx.secrets, name, server: ctx.fixture.url });
  const tokensPresentDuringCheck: boolean[] = [];
  let discovered: Awaited<ReturnType<SecretMcpOAuthStateStore["load"]>>;
  const read = mock(async (_name: string) => ({ tokens: { accessToken, refreshToken } }));
  const input = {
    secrets: ctx.secrets,
    snapshot: () => ({ servers: serversAt(ctx.fixture.url) }),
    reader: { available: true, read },
    async check(service: string) {
      tokensPresentDuringCheck.push((await store.load())?.tokens !== undefined);
      const status = (await ctx.mcp.check(service))?.status;
      if (tokensPresentDuringCheck.length === 1) {
        discovered = await store.load();
        expect(discovered?.tokens?.access_token === accessToken).toBe(true);
        expect(discovered?.discovery?.authorizationServerUrl).toBe(ctx.fixture.origin);
      }
      return status === "connected";
    },
  };
  const needsSignIn = { imported: [], needsSignIn: [name], skipped: [] };
  expect(await importMcpOAuthTokens(input)).toEqual(needsSignIn);
  expect(tokensPresentDuringCheck).toEqual([true, false]);
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
  const snapshot = () => ({ servers: { ...serversAt(ctx.fixture.url), absent: serversAt(ctx.fixture.url)[name] } });
  const report = await importMcpOAuthTokens({
    secrets: ctx.secrets, snapshot, check, now: () => sampleTime,
    reader: { available: true, read: async (service) => service === name ? { tokens: { accessToken, expiresAt: 1 } } : undefined },
  });
  expect(report).toEqual({ imported: [], needsSignIn: [name], skipped: ["absent"] });
  expect(check.mock.calls).toEqual([[name]]);
  expect(ctx.mcp.status().map(({ name, status }) => [name, status])).toEqual([[name, "needs-auth"], ["absent", "not-connected"]]);
  expect(ctx.backend.writtenAccounts).toHaveLength(0);
}));

test("failed import cleanup preserves a change to only the staged token expiry", () => withSecrets(async (secrets, backend) => {
  const input = importInput(secrets, { tokens: { accessToken, refreshToken, expiresAt: 1_700_000_000 } });
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
  const input = importInput(secrets, { tokens: { accessToken }, clientInfo: { clientId: "fixture-client" } });
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
  expect(await ctx.importEntry({ available: true, read: async () => entry })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
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
  expect(await ctx.importEntry({ available: true, read: async () => entry })).toEqual({ imported: [name], needsSignIn: [], skipped: [] });
  const { unauthorized, refresh } = ctx.fixture.counts;
  ctx.fixture.rotateAccessToken();
  await ctx.callTool();
  expect(ctx.fixture.counts).toMatchObject({ unauthorized: unauthorized + 1, refresh: refresh + 1, register: 1, toolCalls: 1 });
  const saved = await new SecretMcpOAuthStateStore({ secrets: ctx.secrets, name, server: ctx.fixture.url }).load();
  expect(!!saved?.tokens?.access_token && saved.tokens.access_token !== entry.tokens.accessToken).toBe(true);
}));
