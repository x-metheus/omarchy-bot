import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { McpOAuthProvider, responseFromRedirectUrl, type McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import {
  listenForMcpOAuthCallback,
  MCP_OAUTH_CALLBACK_PATH,
  McpOAuthCallbackCancelledError,
  McpOAuthCallbackError,
  McpOAuthCallbackTimeoutError,
  mcpOAuthSecretName,
  SecretMcpOAuthStateStore,
  type McpOAuthLoopbackCallback,
} from "./mcpOAuth.ts";
import { SecretStore, type SecretBackend } from "./secrets.ts";

const connectionName = "account";
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
      const account = createHash("sha256").update(JSON.stringify(["app", mcpOAuthSecretName(connectionName, url)])).digest("hex");
      return `${namespace}:${account}`;
    });
    for (const account of backend.writtenAccounts) expect(appAccounts).toContain(account);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("mcpOAuthSecretName is stable lowercase SHA-256 hex within the secret name limit", () => {
  const name = mcpOAuthSecretName(connectionName, bareOrigin);
  const digest = createHash("sha256").update(JSON.stringify([connectionName, canonicalOrigin])).digest("hex");
  expect(mcpOAuthSecretName(connectionName, canonicalOrigin)).toBe(name);
  expect(name).toMatch(/^mcp-oauth-[a-f0-9]+$/);
  expect(name.length).toBeLessThanOrEqual(64);
  expect(digest.startsWith(name.slice("mcp-oauth-".length))).toBe(true);
  expect(mcpOAuthSecretName(connectionName, otherServer)).not.toBe(name);
  expect(mcpOAuthSecretName("another-account", canonicalOrigin)).not.toBe(name);
});

test("SecretMcpOAuthStateStore returns undefined for absent state", () => withSecretStore(async (secrets) => {
  expect((await new SecretMcpOAuthStateStore({ secrets, name: connectionName, server }).load()) === undefined).toBe(true);
}));

test("SecretMcpOAuthStateStore round-trips full OAuth state as an app secret", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server });
  const name = mcpOAuthSecretName(connectionName, server);
  await store.save(state);

  expect((await secrets.getAppSecretForRuntime(name)) === JSON.stringify(state)).toBe(true);
  expect(isDeepStrictEqual(await new SecretMcpOAuthStateStore({ secrets, name: connectionName, server }).load(), state)).toBe(true);
  const entries = await secrets.forApp().list();
  expect(isDeepStrictEqual(entries, [{ name, description: `MCP OAuth state (${name})` }])).toBe(true);
}));

test("SecretMcpOAuthStateStore round-trips a bare origin through McpOAuthProvider", () => withSecretStore(async (secrets) => {
  const createProvider = () => new McpOAuthProvider({
    serverUrl: bareOrigin,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: {},
    store: new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: bareOrigin }),
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
  const canonicalStore = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: canonicalOrigin });
  const expectedState = { serverUrl: canonicalOrigin, clientInformation, codeVerifier, tokens };
  expect(isDeepStrictEqual(await canonicalStore.load(), expectedState)).toBe(true);
  expect(await secrets.getAppSecretForRuntime(mcpOAuthSecretName(connectionName, bareOrigin))).toBeDefined();
}, [canonicalOrigin]));

test("SecretMcpOAuthStateStore round-trips partial state and preserves unknown metadata", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server });
  const partialState = { serverUrl: server, clientInformation: state.clientInformation, extra: { enabled: true } };
  await store.save(partialState);

  expect(isDeepStrictEqual(await store.load(), partialState)).toBe(true);
  const name = mcpOAuthSecretName(connectionName, server);
  expect((await secrets.getAppSecretForRuntime(name)) === JSON.stringify(partialState)).toBe(true);
}));

test("SecretMcpOAuthStateStore keeps URL credentials out of metadata", () => {
  const credentialedServer = "https://user:test-password@tools.example.test/test-path-token?token=test-access-token#test-refresh-token";
  return withSecretStore(async (secrets) => {
    const store = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: credentialedServer });
    await store.save({ ...state, serverUrl: credentialedServer });
    const entries = await secrets.forApp().list();
    const name = mcpOAuthSecretName(connectionName, credentialedServer);
    expect(isDeepStrictEqual(entries, [{ name, description: `MCP OAuth state (${name})` }])).toBe(true);
  }, [credentialedServer]);
});

test("SecretMcpOAuthStateStore keeps hostname credentials out of metadata", () => {
  const hostnameToken = "tok-fixture-abc123";
  const credentialedServer = `https://${hostnameToken}.example.test/mcp`;
  return withSecretStore(async (secrets) => {
    const store = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: credentialedServer });
    await store.save({ ...state, serverUrl: credentialedServer });
    const entries = await secrets.forApp().list();
    const name = mcpOAuthSecretName(connectionName, credentialedServer);
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
  const name = mcpOAuthSecretName(connectionName, server);
  await secrets.forApp().save(name, "Invalid OAuth state fixture", value);

  expect((await new SecretMcpOAuthStateStore({ secrets, name: connectionName, server }).load()) === undefined).toBe(true);
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
  const name = mcpOAuthSecretName(connectionName, server);
  const value = `{"serverUrl":${JSON.stringify(server)},${field}}`;
  await secrets.forApp().save(name, "Invalid OAuth field fixture", value);

  expect((await new SecretMcpOAuthStateStore({ secrets, name: connectionName, server }).load()) === undefined).toBe(true);
  expect((await secrets.getAppSecretForRuntime(name)) === value).toBe(true);
}));

test("mcpOAuthSecretName and SecretMcpOAuthStateStore reject an unparseable server URL", () => withSecretStore(async (secrets) => {
  expect(() => mcpOAuthSecretName(connectionName, "")).toThrow(TypeError);
  expect(() => new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: "" })).toThrow(TypeError);
}));

test("SecretMcpOAuthStateStore ignores and can replace state for another server URL", () => withSecretStore(async (secrets) => {
  const store = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server });
  const name = mcpOAuthSecretName(connectionName, server);
  const wrongState = JSON.stringify({ ...state, serverUrl: otherServer });
  await secrets.forApp().save(name, "Mismatched OAuth state fixture", wrongState);

  expect((await store.load()) === undefined).toBe(true);
  expect((await secrets.getAppSecretForRuntime(name)) === wrongState).toBe(true);
  await store.save(state);
  expect(isDeepStrictEqual(await store.load(), state)).toBe(true);
}));

test("SecretMcpOAuthStateStore keeps different servers' state separate", () => withSecretStore(async (secrets) => {
  const first = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server });
  const second = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: otherServer });
  const otherState = { serverUrl: otherServer, codeVerifier: "other-verifier" };

  await first.save(state);
  expect((await second.load()) === undefined).toBe(true);
  await second.save(otherState);
  expect(isDeepStrictEqual(await first.load(), state)).toBe(true);
  expect(isDeepStrictEqual(await second.load(), otherState)).toBe(true);
}, [server, otherServer]));

test("withRefreshLock serializes three tasks across equivalent server URLs", () => withSecretStore(async (secrets) => {
  const first = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: bareOrigin });
  const second = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: canonicalOrigin });
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
  const store = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server });
  const failure = new Error("refresh failed");
  const first = store.withRefreshLock(async () => { throw failure; });
  const second = store.withRefreshLock(async () => "next task");

  await expect(first).rejects.toBe(failure);
  expect(await second).toBe("next task");
}));

test("withRefreshLock lets another server finish while the first server is locked", () => withSecretStore(async (secrets) => {
  const first = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server });
  const second = new SecretMcpOAuthStateStore({ secrets, name: connectionName, server: otherServer });
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

async function withLoopbackCallback(
  run: (callback: McpOAuthLoopbackCallback) => Promise<void>,
  options?: Parameters<typeof listenForMcpOAuthCallback>[0],
): Promise<void> {
  const callback = await listenForMcpOAuthCallback(options);
  try {
    await run(callback);
  } finally {
    await callback.close();
  }
}

test("listenForMcpOAuthCallback advertises its ephemeral IPv4 loopback address", () => withLoopbackCallback(async (callback) => {
  expect(callback.hostname).toBe("127.0.0.1");
  expect(callback.port).toBeGreaterThan(0);
  expect(MCP_OAUTH_CALLBACK_PATH).toBe("/callback");
  expect(callback.redirectUrl).toBe(`http://127.0.0.1:${callback.port}/callback`);
  expect((await fetch(callback.redirectUrl)).status).toBe(400);
}));

test("listenForMcpOAuthCallback binds exclusively to 127.0.0.1", () => withLoopbackCallback(async (callback) => {
  const query = "?code=x&state=y";
  expect((await fetch(callback.redirectUrl + query)).status).toBe(400);

  const control = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    development: false,
    fetch: () => new Response("wildcard listener"),
  });
  try {
    const response = await fetch(`http://127.0.0.2:${control.port}/`, { signal: AbortSignal.timeout(500) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("wildcard listener");
    await expect(fetch(`http://127.0.0.2:${callback.port}/callback${query}`, {
      signal: AbortSignal.timeout(500),
    })).rejects.toHaveProperty("code", "ECONNREFUSED");
  } finally {
    await control.stop(true);
  }

  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  await Promise.all(addresses.map(async (address) => {
    const url = `http://${address}:${callback.port}/callback${query}`;
    const error = await fetch(url, { signal: AbortSignal.timeout(500) }).catch((error: unknown) => error);
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    expect(code === "ECONNREFUSED" || (error instanceof Error && error.name === "TimeoutError"), address).toBe(true);
  }));
}));

test("waitForCallback accepts the first matching code and serves a private result page", () => withLoopbackCallback(async (callback) => {
  const url = `${callback.redirectUrl}?code=code-1&state=state-1&iss=https%3A%2F%2Fissuer.example`;
  const [result, response] = await Promise.all([callback.waitForCallback("state-1"), fetch(url)]);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
  const page = await response.text();
  expect(page).not.toContain("code-1");
  expect(page).not.toContain("state-1");
  expect(result).toStrictEqual({ code: "code-1", state: "state-1", iss: "https://issuer.example" });
  expect((await fetch(url)).status).toBe(410);
  expect((await fetch(url, { method: "POST" })).status).toBe(410);
}));

test("waitForCallback stays pending for missing state or a mismatch, including case", () => withLoopbackCallback(async (callback) => {
  const result = callback.waitForCallback("state-1").then((response) => ({ response }), (error: unknown) => ({ error }));
  for (const query of ["?code=private-code", "?code=private-code&state=wrong", "?code=private-code&state=State-1"]) {
    const response = await fetch(callback.redirectUrl + query);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-code");
  }
  expect(await Promise.race([result, Bun.sleep(50).then(() => "pending")])).toBe("pending");
  const response = await fetch(`${callback.redirectUrl}?code=code-1&state=state-1`);
  expect(response.status).toBe(200);
  expect(await result).toStrictEqual({ response: { code: "code-1", state: "state-1" } });
}));

test("waitForCallback returns a private error page for a malformed request URL", () => withLoopbackCallback(async (callback) => {
  const url = `${callback.redirectUrl}?code=private-code&state=state-1`;
  const result = callback.waitForCallback("state-1").then((response) => ({ response }), (error: unknown) => ({ error }));
  const malformed = await fetch(url, { headers: { host: "invalid%" } });
  expect(malformed.status).toBe(400);
  const page = await malformed.text();
  expect(page).not.toContain("private-code");
  expect(page).not.toContain("state-1");
  expect((await fetch(url)).status).toBe(200);
  expect(await result).toStrictEqual({ response: { code: "private-code", state: "state-1" } });
}));

test("waitForCallback reports an authorization server error without its description", () => withLoopbackCallback(async (callback) => {
  const description = "synthetic secret description";
  const query = new URLSearchParams({ error: "access_denied", error_description: description, state: "state-1" });
  const [error, response] = await Promise.all([
    callback.waitForCallback("state-1").catch((error: unknown) => error),
    fetch(`${callback.redirectUrl}?${query}`),
  ]);
  expect(response.status).toBe(400);
  const page = await response.text();
  expect(page).toContain("Sign-in did not complete");
  expect(page).not.toContain(description);
  expect(page).not.toContain("access_denied");
  expect(error).toBeInstanceOf(McpOAuthCallbackError);
  expect(error).toHaveProperty("code", "access_denied");
  expect(String(error)).not.toContain(description);
  expect(String(error)).not.toContain("access_denied");
  expect((await fetch(`${callback.redirectUrl}?code=code-1&state=state-1`)).status).toBe(410);
}));

test("McpOAuthCallbackError preserves account_selection_required", () => {
  expect(new McpOAuthCallbackError("account_selection_required").code).toBe("account_selection_required");
});

test.each([
  ["control characters and free-form text", `\u0001\t\r${"synthetic error text".repeat(10)}`],
  ["an empty value", ""],
  ["a padded code", " access_denied "],
])("waitForCallback uses a generic OAuth error for %s", (_label, errorValue) => withLoopbackCallback(async (callback) => {
  const query = new URLSearchParams({ error: errorValue, state: "state-1" });
  const [error, response] = await Promise.all([
    callback.waitForCallback("state-1").catch((error: unknown) => error),
    fetch(`${callback.redirectUrl}?${query}`),
  ]);
  expect(response.status).toBe(400);
  expect(error).toBeInstanceOf(McpOAuthCallbackError);
  expect(error).toHaveProperty("code", "oauth_error");
  expect(error).toHaveProperty("message", "The authorization server rejected MCP sign-in.");
  const page = await response.text();
  expect(page).toContain("Sign-in did not complete.");
  expect(page).not.toContain("synthetic error text");
  expect(page).not.toContain("access_denied");
  expect(page).not.toMatch(/\p{Cc}/u);
}));

test("waitForCallback rejects a matching callback with no authorization code", () => withLoopbackCallback(async (callback) => {
  const [error, response] = await Promise.all([
    callback.waitForCallback("state-1").catch((error: unknown) => error),
    fetch(`${callback.redirectUrl}?state=state-1`),
  ]);
  expect(response.status).toBe(400);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("state-1");
  expect((await fetch(`${callback.redirectUrl}?code=code-1&state=state-1`)).status).toBe(410);
}));

test("waitForCallback times out and closes the listener", () => withLoopbackCallback(async (callback) => {
  await expect(callback.waitForCallback("state-1")).rejects.toBeInstanceOf(McpOAuthCallbackTimeoutError);
  await expect(fetch(callback.redirectUrl)).rejects.toThrow();
}, { timeoutMs: 50 }));

test.each([{ alreadyAborted: false }, { alreadyAborted: true }])("waitForCallback closes on abort (%j)", ({ alreadyAborted }) => withLoopbackCallback(async (callback) => {
  const controller = new AbortController();
  const reason = new Error("private abort reason");
  if (alreadyAborted) controller.abort(reason);
  const failure = callback.waitForCallback("state-1", controller.signal).catch((error: unknown) => error);
  if (!alreadyAborted) controller.abort(reason);
  const error = await failure;
  expect(error).toBeInstanceOf(McpOAuthCallbackCancelledError);
  expect(String(error)).not.toContain(reason.message);
  await expect(fetch(callback.redirectUrl)).rejects.toThrow();
}));

test("McpOAuthLoopbackCallback close is idempotent and cancels a pending waiter", () => withLoopbackCallback(async (callback) => {
  const failure = callback.waitForCallback("state-1").catch((error: unknown) => error);
  await expect(Promise.all([callback.close(), callback.close()])).resolves.toEqual([undefined, undefined]);
  expect(await failure).toBeInstanceOf(McpOAuthCallbackCancelledError);
  await expect(fetch(callback.redirectUrl)).rejects.toThrow();
}));

test("waitForCallback rejects a second waiter without replacing the first", () => withLoopbackCallback(async (callback) => {
  const result = callback.waitForCallback("state-1").then((response) => ({ response }), (error: unknown) => ({ error }));
  await expect(callback.waitForCallback("state-2")).rejects.toThrow();
  expect((await fetch(`${callback.redirectUrl}?code=code-1&state=state-1`)).status).toBe(200);
  expect(await result).toStrictEqual({ response: { code: "code-1", state: "state-1" } });
  await expect(callback.waitForCallback("state-1")).rejects.toThrow();
}));

test("listenForMcpOAuthCallback routes only GET requests on its configured path", () => withLoopbackCallback(async (callback) => {
  const query = "?code=code-1&state=state-1";
  const result = callback.waitForCallback("state-1").then((response) => ({ response }), (error: unknown) => ({ error }));
  expect(callback.redirectUrl).toBe(`http://127.0.0.1:${callback.port}/oauth/return`);
  expect((await fetch(new URL(`/callback${query}`, callback.redirectUrl))).status).toBe(404);
  const post = await fetch(callback.redirectUrl + query, { method: "POST" });
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET");
  expect((await fetch(callback.redirectUrl + query)).status).toBe(200);
  expect(await result).toStrictEqual({ response: { code: "code-1", state: "state-1" } });
}, { path: "/oauth/return" }));

test.each([
  ["/oauth/staging/../return%20here", "/oauth/return%20here"],
  ["/call%20back", "/call%20back"],
])("listenForMcpOAuthCallback advertises and routes the normalized path for %s", (path, pathname) => withLoopbackCallback(async (callback) => {
  expect(new URL(callback.redirectUrl).pathname).toBe(pathname);
  const [result, response] = await Promise.all([
    callback.waitForCallback("state-1"),
    fetch(`http://127.0.0.1:${callback.port}${pathname}?code=code-1&state=state-1`),
  ]);
  expect(response.status).toBe(200);
  expect(result).toStrictEqual({ code: "code-1", state: "state-1" });
}, { path }));

test.each([
  { path: "callback" }, { path: "/callback?query" }, { path: "/callback#fragment" },
  { path: "/call\tback" }, { path: "/callback " }, { path: "/oauth/staging/../return here" },
  { path: "/call\\back" }, { path: "/call\x7fback" },
  { path: "/" }, { path: "/oauth/.." },
  { port: 70_000 }, { port: -1 }, { port: 1.5 },
])("listenForMcpOAuthCallback rejects invalid options %j", async (options) => {
  const listener = listenForMcpOAuthCallback(options);
  try {
    await expect(listener).rejects.toBeInstanceOf(TypeError);
  } finally {
    const callback = await listener.catch(() => undefined);
    await callback?.close();
  }
});

test("pi-mcp responseFromRedirectUrl accepts the listener URL and checks origin and state", () => withLoopbackCallback(async (callback) => {
  const authorization = { redirectUrl: callback.redirectUrl, state: "state-1" };
  const redirect = new URL(callback.redirectUrl);
  redirect.searchParams.set("code", "code-1");
  redirect.searchParams.set("state", authorization.state);
  const [result, response] = await Promise.all([callback.waitForCallback(authorization.state), fetch(redirect)]);
  expect(response.status).toBe(200);
  expect(responseFromRedirectUrl(redirect.href, authorization)).toStrictEqual(result);
  expect(() => responseFromRedirectUrl("https://evil.example/callback?code=code-1&state=state-1", authorization)).toThrow();
  redirect.searchParams.set("state", "wrong-state");
  expect(() => responseFromRedirectUrl(redirect.href, authorization)).toThrow();
}));
