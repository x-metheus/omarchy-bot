import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { McpOAuthProvider, type McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { mcpOAuthSecretName, SecretMcpOAuthStateStore } from "./mcpOAuth.ts";
import { SecretStore, type SecretBackend } from "./secrets.ts";

const bareOrigin = "https://tools.example.test";
const canonicalOrigin = new URL(bareOrigin).href;
const server = "https://tools.example.test/mcp";
const otherServer = "https://tools.example.test/other-mcp";
const state = {
  serverUrl: server,
  clientInformation: { client_id: "test-client", client_secret: "test-client-secret" },
  tokens: {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    token_type: "Bearer",
    expires_in: 3600,
  },
  tokensExpireAt: 1_800_003_600_000,
  codeVerifier: "test-code-verifier",
  oauthState: "test-oauth-state",
  discovery: {
    authorizationServerUrl: "https://auth.example.test",
    resourceMetadataUrl: "https://tools.example.test/.well-known/oauth-protected-resource/mcp",
  },
} satisfies McpOAuthState;

class MemoryKeychain implements SecretBackend {
  readonly kind = "keychain";
  readonly values = new Map<string, string>();
  readonly writtenAccounts: string[] = [];

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    this.writtenAccounts.push(account);
    this.values.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

async function withSecretStore(
  run: (secrets: SecretStore) => Promise<void>,
  servers: readonly string[] = [server],
): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-secrets-"));
  const backend = new MemoryKeychain();
  try {
    await run(new SecretStore(dataDir, backend));
    const namespace = createHash("sha256").update(realpathSync(dataDir)).digest("hex");
    // The keychain account hashes the scope and name, then prefixes the data-directory namespace.
    const appAccounts = servers.map((url) => {
      const account = createHash("sha256").update(JSON.stringify(["app", mcpOAuthSecretName(url)])).digest("hex");
      return `${namespace}:${account}`;
    });
    for (const account of backend.writtenAccounts) expect(appAccounts).toContain(account);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("mcpOAuthSecretName is stable lowercase SHA-256 hex within the secret name limit", () => {
  const name = mcpOAuthSecretName(bareOrigin);
  const digest = createHash("sha256").update(canonicalOrigin).digest("hex");
  expect(mcpOAuthSecretName(canonicalOrigin)).toBe(name);
  expect(name).toMatch(/^mcp-oauth-[a-f0-9]+$/);
  expect(name.length).toBeLessThanOrEqual(64);
  expect(digest.startsWith(name.slice("mcp-oauth-".length))).toBe(true);
  expect(mcpOAuthSecretName(otherServer)).not.toBe(name);
});

test("SecretMcpOAuthStateStore returns undefined for absent state", () => withSecretStore(async (secrets) => {
  expect((await new SecretMcpOAuthStateStore({ secrets, server }).load()) === undefined).toBe(true);
}));

test("SecretMcpOAuthStateStore round-trips full OAuth state as an app secret", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, server });
  const name = mcpOAuthSecretName(server);
  await store.save(state);

  expect((await secrets.getAppSecretForRuntime(name)) === JSON.stringify(state)).toBe(true);
  expect(isDeepStrictEqual(await new SecretMcpOAuthStateStore({ secrets, server }).load(), state)).toBe(true);
  const entries = await secrets.forApp().list();
  expect(isDeepStrictEqual(entries, [{ name, description: `MCP OAuth state (${name})` }])).toBe(true);
}));

test("SecretMcpOAuthStateStore round-trips a bare origin through McpOAuthProvider", () => withSecretStore(async (secrets) => {
  const createProvider = () => new McpOAuthProvider({
    serverUrl: bareOrigin,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: {},
    store: new SecretMcpOAuthStateStore({ secrets, server: bareOrigin }),
    onRedirect: () => {},
  });
  const clientInformation = { client_id: "test-client", client_secret: "test-client-secret" };
  const codeVerifier = "test-code-verifier";
  const tokens = { access_token: "test-access-token", token_type: "Bearer" };
  const writer = createProvider();
  await writer.saveClientInformation(clientInformation);
  await writer.saveCodeVerifier(codeVerifier);
  await writer.saveTokens(tokens);

  const reader = createProvider();
  expect(isDeepStrictEqual(await reader.clientInformation(), clientInformation)).toBe(true);
  expect(isDeepStrictEqual(await reader.tokens(), tokens)).toBe(true);
  expect((await reader.codeVerifier()) === codeVerifier).toBe(true);
  const canonicalStore = new SecretMcpOAuthStateStore({ secrets, server: canonicalOrigin });
  const expectedState = { serverUrl: canonicalOrigin, clientInformation, codeVerifier, tokens };
  expect(isDeepStrictEqual(await canonicalStore.load(), expectedState)).toBe(true);
  expect(await secrets.getAppSecretForRuntime(mcpOAuthSecretName(bareOrigin))).toBeDefined();
}, [canonicalOrigin]));

test("SecretMcpOAuthStateStore round-trips partial state and preserves unknown metadata", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, server });
  const partialState = { serverUrl: server, clientInformation: state.clientInformation, extra: { enabled: true } };
  await store.save(partialState);

  expect(isDeepStrictEqual(await store.load(), partialState)).toBe(true);
  const name = mcpOAuthSecretName(server);
  expect((await secrets.getAppSecretForRuntime(name)) === JSON.stringify(partialState)).toBe(true);
}));

test("SecretMcpOAuthStateStore keeps URL credentials out of metadata", () => {
  const credentialedServer = "https://user:test-password@tools.example.test/test-path-token?token=test-access-token#test-refresh-token";
  return withSecretStore(async (secrets) => {
    const store = new SecretMcpOAuthStateStore({ secrets, server: credentialedServer });
    await store.save({ ...state, serverUrl: credentialedServer });
    const entries = await secrets.forApp().list();
    const name = mcpOAuthSecretName(credentialedServer);
    expect(isDeepStrictEqual(entries, [{ name, description: `MCP OAuth state (${name})` }])).toBe(true);
  }, [credentialedServer]);
});

test("SecretMcpOAuthStateStore keeps hostname credentials out of metadata", () => {
  const hostnameToken = "tok-fixture-abc123";
  const credentialedServer = `https://${hostnameToken}.example.test/mcp`;
  return withSecretStore(async (secrets) => {
    const store = new SecretMcpOAuthStateStore({ secrets, server: credentialedServer });
    await store.save({ ...state, serverUrl: credentialedServer });
    const entries = await secrets.forApp().list();
    const name = mcpOAuthSecretName(credentialedServer);
    expect(entries.some(({ description }) => description.includes(hostnameToken))).toBe(false);
    expect(isDeepStrictEqual(entries, [{ name, description: `MCP OAuth state (${name})` }])).toBe(true);
  }, [credentialedServer]);
});

test.each([
  ["malformed JSON", "{broken"],
  ["a JSON array", "[]"],
  ["JSON null", "null"],
  ["a JSON string", JSON.stringify(server)],
  ["a missing server URL", "{}"],
  ["a non-string server URL", '{"serverUrl":42}'],
])("SecretMcpOAuthStateStore ignores %s without deleting it", (_label, value) => withSecretStore(async (secrets) => {
  const name = mcpOAuthSecretName(server);
  await secrets.forApp().save(name, "Invalid OAuth state fixture", value);

  expect((await new SecretMcpOAuthStateStore({ secrets, server }).load()) === undefined).toBe(true);
  expect((await secrets.getAppSecretForRuntime(name)) === value).toBe(true);
}));

test.each([
  ["clientInformation as a string", '"clientInformation":"broken"'],
  ["clientInformation as null", '"clientInformation":null'],
  ["discovery as an array", '"discovery":[]'],
  ["tokens as a string", '"tokens":"broken"'],
  ["tokens without an access_token", '"tokens":{}'],
  ["tokens with an empty access_token", '"tokens":{"access_token":""}'],
  ["tokens with a non-string refresh_token", '"tokens":{"access_token":"fixture","refresh_token":false}'],
  ["tokens with a non-string scope", '"tokens":{"access_token":"fixture","scope":[]}'],
  ["tokens with a non-string token_type", '"tokens":{"access_token":"fixture","token_type":null}'],
  ["codeVerifier as a number", '"codeVerifier":42'],
  ["oauthState as an empty string", '"oauthState":""'],
  ["tokensExpireAt as a string", '"tokensExpireAt":"42"'],
  ["tokensExpireAt as a non-finite number", '"tokensExpireAt":1e999'],
])("SecretMcpOAuthStateStore ignores %s without changing the raw value", (_label, field) => withSecretStore(async (secrets) => {
  const name = mcpOAuthSecretName(server);
  const value = `{"serverUrl":${JSON.stringify(server)},${field}}`;
  await secrets.forApp().save(name, "Invalid OAuth field fixture", value);

  expect((await new SecretMcpOAuthStateStore({ secrets, server }).load()) === undefined).toBe(true);
  expect((await secrets.getAppSecretForRuntime(name)) === value).toBe(true);
}));

test("mcpOAuthSecretName and SecretMcpOAuthStateStore reject an unparseable server URL", () => withSecretStore(async (secrets) => {
  expect(() => mcpOAuthSecretName("")).toThrow(TypeError);
  expect(() => new SecretMcpOAuthStateStore({ secrets, server: "" })).toThrow(TypeError);
}));

test("SecretMcpOAuthStateStore ignores and can replace state for another server URL", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, server });
  const name = mcpOAuthSecretName(server);
  const wrongState = JSON.stringify({ ...state, serverUrl: otherServer });
  await secrets.forApp().save(name, "Mismatched OAuth state fixture", wrongState);

  expect((await store.load()) === undefined).toBe(true);
  expect((await secrets.getAppSecretForRuntime(name)) === wrongState).toBe(true);
  await store.save(state);
  expect(isDeepStrictEqual(await store.load(), state)).toBe(true);
}));

test("SecretMcpOAuthStateStore keeps different servers' state separate", () => withSecretStore(async (secrets) => {
  const first = new SecretMcpOAuthStateStore({ secrets, server });
  const second = new SecretMcpOAuthStateStore({ secrets, server: otherServer });
  const otherState = { serverUrl: otherServer, codeVerifier: "other-verifier" };

  await first.save(state);
  expect((await second.load()) === undefined).toBe(true);
  await second.save(otherState);
  expect(isDeepStrictEqual(await first.load(), state)).toBe(true);
  expect(isDeepStrictEqual(await second.load(), otherState)).toBe(true);
}, [server, otherServer]));

test("withRefreshLock serializes three tasks across equivalent server URLs", () => withSecretStore(async (secrets) => {
  const first = new SecretMcpOAuthStateStore({ secrets, server: bareOrigin });
  const second = new SecretMcpOAuthStateStore({ secrets, server: canonicalOrigin });
  const events: string[] = [];
  const run = async (task: number) => {
    events.push(`start ${task}`);
    await Promise.resolve();
    events.push(`end ${task}`);
    return task;
  };
  const results = await Promise.all([
    first.withRefreshLock(() => run(1)),
    second.withRefreshLock(() => run(2)),
    first.withRefreshLock(() => run(3)),
  ]);

  expect(results).toEqual([1, 2, 3]);
  expect(events).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
}));

test("withRefreshLock releases the queue after a task rejects", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, server });
  const failure = new Error("refresh failed");
  const first = store.withRefreshLock(async () => { throw failure; });
  const second = store.withRefreshLock(async () => "next task");

  await expect(first).rejects.toBe(failure);
  expect(await second).toBe("next task");
}));

test("withRefreshLock lets another server finish while the first server is locked", () => withSecretStore(async (secrets) => {
  const first = new SecretMcpOAuthStateStore({ secrets, server });
  const second = new SecretMcpOAuthStateStore({ secrets, server: otherServer });
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const firstTask = first.withRefreshLock(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  try {
    await firstStarted.promise;
    expect(await second.withRefreshLock(async () => "independent task")).toBe("independent task");
  } finally {
    releaseFirst.resolve();
    await firstTask;
  }
}));
