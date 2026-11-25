import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createMcpExtension } from "./extensions/mcp.ts";
import { McpOAuthManager, mcpOAuthSecretName, resolveCallbackBinding, SecretMcpOAuthStateStore, type McpOAuthManagerDeps } from "./mcpOAuth.ts";
import { SecretStore, type SecretBackend } from "./secrets.ts";
import { startOAuthMcpServer } from "./testing/oauthMcpServer.ts";

type Outcome = Parameters<NonNullable<McpOAuthManagerDeps["onComplete"]>>[0];

class MemoryKeychain implements SecretBackend {
  readonly kind = "keychain";
  readonly values = new Map<string, string>();
  readonly writtenAccounts = new Set<string>();
  writes = 0;
  afterSet?: (value: string) => void;

  async get(account: string) { return this.values.get(account); }
  async set(account: string, value: string) {
    this.writtenAccounts.add(account);
    this.values.set(account, value);
    this.writes++;
    this.afterSet?.(value);
  }
  async delete(account: string) { this.values.delete(account); }
}

async function setup(
  options?: Parameters<typeof startOAuthMcpServer>[0],
  { onComplete, ...managerOptions }: Partial<Omit<McpOAuthManagerDeps, "secrets">> & { now?: () => number } = {},
  names: readonly [string, ...string[]] = ["remote"],
) {
  const fixture = await startOAuthMcpServer(options);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-sign-in-"));
  const backend = new MemoryKeychain();
  const secrets = new SecretStore(dataDir, { backend, probe: async () => ({ available: true }) });
  const outcomes: Outcome[] = [];
  const completed = Promise.withResolvers<Outcome>();
  const manager = new McpOAuthManager({ secrets, ...managerOptions, async onComplete(outcome) {
    outcomes.push(outcome);
    completed.resolve(outcome);
    await onComplete?.(outcome);
  } });
  const [name] = names;
  const mcp = createMcpExtension({
    servers: () => ({ revision: "fixture", secrets: [], servers: Object.fromEntries(names.map((service) => [
      service, { disabled: false, transport: { type: "http", url: fixture.url } },
    ])) }),
    authProvider: (service, url) => manager.authProvider(service, url),
  });
  return {
    fixture, backend, secrets, manager, name, mcp, outcomes, completed: completed.promise, dataDir,
    async start(authorizationId = "first", expiresAt?: number) {
      const result = await manager.start({
        name, serverUrl: fixture.url, authorizationId, ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      if (!("authorizationUrl" in result)) throw new Error("Expected a browser sign-in.");
      return result.authorizationUrl;
    },
    call(tool = options?.toolName ?? "read_fixture", service = name) {
      return mcp.tools![0]!.execute({ action: "call", service, tool },
        {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    },
    async close() {
      try {
        await Promise.all([manager.close(), mcp.close()]);
      } finally {
        await fixture.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

function expectSafeEqual(actual: unknown, expected: unknown) {
  expect(Bun.deepEquals(actual, expected)).toBe(true);
}

async function expectRejection(operation: Promise<unknown>, message: string) {
  const rejectedAsExpected = await operation.then(
    () => false,
    (error: unknown) => error instanceof Error && error.message.includes(message),
  );
  expect(rejectedAsExpected).toBe(true);
}

async function expectClosedListener(redirectUrl: string) {
  const code = await fetch(redirectUrl).then(() => undefined, (error: { code?: string }) => error.code);
  expect(code === "ECONNREFUSED").toBe(true);
}

async function fetchOAuthUrl(url: string | URL, options?: RequestInit) {
  return fetch(url, options).catch(() => { throw new Error("OAuth fixture request failed."); });
}

async function callbackLocation(authorizationUrl: string) {
  const response = await fetchOAuthUrl(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const url = response.headers.get("location");
  if (!url) throw new Error("Expected an OAuth redirect.");
  return url;
}

function redirectUri(authorizationUrl: string) {
  const url = new URL(authorizationUrl).searchParams.get("redirect_uri");
  if (!url) throw new Error("Expected an OAuth redirect URI.");
  return url;
}

test("durable MCP reports needs-auth until browser sign-in saves app-scoped tokens", async () => {
  const testMcp = await setup({ toolName: "read_report", toolText: "The report is ready." });
  const { fixture, backend, secrets, name, mcp } = testMcp;
  try {
    expectSafeEqual(await testMcp.call(), { isError: true, output: [{
      type: "text", text: 'MCP service "remote" needs sign-in. Sign in through Services and retry.',
    }] });
    expect(mcp.status()).toEqual([{
      name, status: "needs-auth", toolCount: 0, disabled: false, configurationRevision: "fixture",
    }]);
    expect(await mcp.check(name)).toMatchObject({ status: "needs-auth", toolCount: 0 });

    const authorizationUrl = await testMcp.start();
    const response = await fetchOAuthUrl(authorizationUrl, { redirect: "follow" });
    expect(response.status).toBe(200);
    expectSafeEqual(await testMcp.completed, { name, authorizationId: "first", status: "completed" });
    const secretName = mcpOAuthSecretName(name, fixture.url);
    const saved = await new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url }).load();
    expect(Boolean(saved?.tokens?.access_token && saved.tokens.refresh_token)).toBe(true);
    expect(await secrets.forApp().list()).toEqual([{ name: secretName, description: `MCP OAuth state (${secretName})` }]);
    const namespace = createHash("sha256").update(realpathSync(testMcp.dataDir)).digest("hex");
    const appAccount = createHash("sha256").update(JSON.stringify(["app", secretName])).digest("hex");
    expect([...backend.writtenAccounts]).toEqual([`${namespace}:${appAccount}`]);

    expect(await mcp.check(name)).toMatchObject({ status: "connected", toolCount: 1 });
    expectSafeEqual(await testMcp.call(), { isError: false, output: [{ type: "text", text: "The report is ready." }] });
    expect(fixture.counts).toMatchObject({ authorize: 1, token: 1, toolCalls: 1, refresh: 0, register: 1 });
    expect(fixture.registeredClientNames).toEqual(["Omarchy Bot"]);
    expect(new URL(redirectUri(authorizationUrl)).hostname).toBe("127.0.0.1");
    const refresh = await testMcp.manager.start({ name, serverUrl: fixture.url, authorizationId: "refresh" });
    expect("authorized" in refresh && refresh.authorized).toBe(true);
    expect(fixture.counts.refresh).toBe(1);
    expectSafeEqual(testMcp.outcomes, [
      { name, authorizationId: "first", status: "completed" },
      { name, authorizationId: "refresh", status: "completed" },
    ]);
  } finally {
    await testMcp.close();
  }
});

test("browser denial produces a safe auth_failed outcome and leaves MCP needing sign-in", async () => {
  const testMcp = await setup();
  try {
    expect((await testMcp.call()).isError).toBe(true);
    const authorizationUrl = await testMcp.start();
    testMcp.fixture.deny();
    const response = await fetchOAuthUrl(authorizationUrl);
    expect(response.status).toBe(400);
    expect((await response.text()).includes("Private fixture denial detail")).toBe(false);
    const expected = { name: testMcp.name, authorizationId: "first", status: "failed", reason: "auth_failed" };
    expectSafeEqual(await testMcp.completed, expected);
    expectSafeEqual(testMcp.outcomes, [expected]);
    expect(testMcp.mcp.status()[0]?.status).toBe("needs-auth");
    expect(testMcp.fixture.counts.token).toBe(0);
  } finally {
    await testMcp.close();
  }
});

test("manual OAuth completion rejects a foreign origin and wrong state without consuming the attempt", async () => {
  const testMcp = await setup();
  const { manager, name, mcp, fixture } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    const foreign = new URL(redirectUrl);
    foreign.host = new URL(fixture.origin).host;
    const wrongState = new URL(redirectUrl);
    wrongState.searchParams.set("state", "private-wrong-state");
    for (const invalid of [foreign, wrongState]) {
      await expectRejection(manager.complete({ name, redirectUrl: invalid.href }), "The MCP sign-in redirect is invalid.");
      expectSafeEqual(testMcp.outcomes, []);
      expect(fixture.counts.token).toBe(0);
    }
    await manager.complete({ name, redirectUrl });
    expectSafeEqual(testMcp.outcomes, [{ name, authorizationId: "first", status: "completed" }]);
    expect(await mcp.check(name)).toMatchObject({ status: "connected", toolCount: 1 });
    await expectClosedListener(redirectUrl);
  } finally {
    await testMcp.close();
  }
});

test("starting OAuth again replaces only the attempt for that MCP server", async () => {
  const testMcp = await setup();
  const { manager, name, outcomes } = testMcp;
  const second = await startOAuthMcpServer();
  try {
    const first = await testMcp.start();
    const independent = await manager.start({ name: "second", serverUrl: second.url, authorizationId: "second" });
    if (!("authorizationUrl" in independent)) throw new Error("Expected a browser sign-in.");
    expect((await fetchOAuthUrl(redirectUri(first))).status).toBe(400);

    const replacement = await testMcp.start("replacement");
    const staleRedirect = await callbackLocation(first);
    // A reused port may reach the replacement listener, which must reject the old state.
    const staleRejected = await fetch(staleRedirect).then(
      (response) => response.status === 400,
      (error: unknown) => (error as { code?: string }).code === "ECONNREFUSED",
    );
    expect(staleRejected).toBe(true);
    await expectRejection(manager.complete({ name, redirectUrl: staleRedirect }), "The MCP sign-in redirect is invalid.");
    expect(testMcp.fixture.counts.token).toBe(0);
    expectSafeEqual(outcomes, []);
    await manager.cancel({ name, authorizationId: "first" });
    await manager.complete({ name: "second", redirectUrl: await callbackLocation(independent.authorizationUrl) });
    await manager.complete({ name, redirectUrl: await callbackLocation(replacement) });
    expectSafeEqual(outcomes, [
      { name: "second", authorizationId: "second", status: "completed" },
      { name, authorizationId: "replacement", status: "completed" },
    ]);
  } finally {
    try { await testMcp.close(); }
    finally { await second.close(); }
  }
});

test("a replacement OAuth start with invalid callback settings closes the existing listener", async () => {
  let callbackUrl: string | undefined;
  const testMcp = await setup(undefined, { settings: () => callbackUrl ? { callbackUrl } : {} });
  const { manager, name, fixture, outcomes } = testMcp;
  try {
    const authorizationUrl = await testMcp.start();
    const redirectUrl = await callbackLocation(authorizationUrl);
    expect((await fetchOAuthUrl(redirectUri(authorizationUrl))).status).toBe(400);

    callbackUrl = "http://fixture.invalid/private-callback";
    await expectRejection(testMcp.start("replacement"), "MCP sign-in could not be started.");
    await expectClosedListener(redirectUrl);
    await expectRejection(manager.complete({ name, redirectUrl }), "No pending MCP sign-in.");
    await manager.close();
    expect(fixture.counts.token).toBe(0);
    expectSafeEqual(outcomes, [{ name, authorizationId: "replacement", status: "failed", reason: "auth_failed" }]);
  } finally {
    await testMcp.close();
  }
});

test("a superseded OAuth callback cannot exchange a code after waiting for the refresh lock", async () => {
  const testMcp = await setup();
  const { manager, name, fixture, secrets, outcomes } = testMcp;
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url });
  let lock: Promise<void> | undefined;
  try {
    const first = await testMcp.start();
    const redirectUrl = await callbackLocation(first);
    lock = store.withRefreshLock(async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const completing = manager.complete({ name, redirectUrl });
    const replacement = testMcp.start("replacement");
    release.resolve();
    await completing;
    expect(fixture.counts.token).toBe(0);
    expectSafeEqual(outcomes, []);
    await manager.complete({ name, redirectUrl: await callbackLocation(await replacement) });
    expect(fixture.counts.token).toBe(1);
    expectSafeEqual(outcomes, [{ name, authorizationId: "replacement", status: "completed" }]);
  } finally {
    release.resolve();
    await lock;
    await testMcp.close();
  }
});

test("an OAuth exchange network failure reports connect_failed without exposing the redirect", async () => {
  const testMcp = await setup();
  const { manager, name, fixture, outcomes } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    await fixture.close();
    expect(await manager.complete({ name, redirectUrl })).toEqual({ status: "failed", reason: "connect_failed" });
    expectSafeEqual(outcomes, [{ name, authorizationId: "first", status: "failed", reason: "connect_failed" }]);
    await expectClosedListener(redirectUrl);
  } finally {
    await testMcp.close();
  }
});

test("closing the OAuth manager closes the callback listener without reporting a completion", async () => {
  const testMcp = await setup();
  const { manager, name, fixture } = testMcp;
  try {
    const redirectUrl = redirectUri(await testMcp.start());
    await Promise.all([manager.close(), manager.close()]);
    await expectClosedListener(redirectUrl);
    expectSafeEqual(testMcp.outcomes, []);
    await expectRejection(manager.start({ name, serverUrl: fixture.url, authorizationId: "after-close" }), "The MCP OAuth manager is closed.");
  } finally {
    await testMcp.close();
  }
});

test("cancelling an OAuth attempt closes its callback listener without reporting an outcome", async () => {
  const testMcp = await setup();
  const { manager, name, fixture, outcomes } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    await manager.cancel({ name, authorizationId: "first" });
    await expectClosedListener(redirectUrl);
    await expectRejection(manager.complete({ name, redirectUrl }), "No pending MCP sign-in.");
    expectSafeEqual(outcomes, []);
    expect(fixture.counts.token).toBe(0);
  } finally {
    await testMcp.close();
  }
});

test("an expired OAuth attempt closes its listener and reports expired", async () => {
  let now = Date.now();
  const expiresAt = now + 60_000;
  const testMcp = await setup(undefined, { now: () => now });
  try {
    const redirectUrl = await callbackLocation(await testMcp.start("expiring", expiresAt));
    now = expiresAt;
    expect(await testMcp.manager.complete({ name: testMcp.name, redirectUrl })).toEqual({ status: "failed", reason: "expired" });
    expectSafeEqual(await testMcp.completed, { name: testMcp.name, authorizationId: "expiring", status: "failed", reason: "expired" });
    expect(testMcp.fixture.counts.token).toBe(0);
    await expectClosedListener(redirectUrl);
    await expectRejection(testMcp.manager.complete({ name: testMcp.name, redirectUrl }), "No pending MCP sign-in.");
  } finally {
    await testMcp.close();
  }
});

test.each([1, 3600])("durable MCP refreshes a rotated OAuth token with a %i second lifetime", async (tokenTtlSeconds) => {
  const testMcp = await setup({ tokenTtlSeconds });
  const { fixture, name, secrets, mcp } = testMcp;
  try {
    expect((await fetchOAuthUrl(await testMcp.start())).status).toBe(200);
    expect((await testMcp.completed).status).toBe("completed");
    expect((await testMcp.call()).isError).toBe(false);
    const store = new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url });
    const before = (await store.load())?.tokens?.access_token;
    const { refresh, unauthorized } = fixture.counts;
    fixture.rotateAccessToken();
    const result = await testMcp.call();
    expectSafeEqual(result, { isError: false, output: [{ type: "text", text: "OAuth MCP fixture result" }] });
    expect(fixture.counts.refresh).toBeGreaterThan(refresh);
    // The client proactively refreshes tokens within 30 seconds of expiry.
    if (tokenTtlSeconds > 30) expect(fixture.counts.unauthorized).toBeGreaterThan(unauthorized);
    else expect(fixture.counts.unauthorized).toBe(unauthorized);
    expect(fixture.counts.toolCalls).toBe(2);
    const after = (await store.load())?.tokens?.access_token;
    expect(Boolean(before && after && before !== after)).toBe(true);
    const visible = JSON.stringify({ status: mcp.status(), outcomes: testMcp.outcomes });
    expect(visible.includes(before!) || visible.includes(after!)).toBe(false);
  } finally {
    await testMcp.close();
  }
});

test("MCP connections at the same OAuth URL authorize and use their own tokens", async () => {
  const names = ["account-a", "account-b"] as const;
  const [name, alias] = names;
  const tokens = [crypto.randomUUID(), crypto.randomUUID()];
  let nextToken = 0;
  const testMcp = await setup({ issueAccessToken: () => tokens[nextToken++]! }, {}, names);
  const { manager, fixture, mcp } = testMcp;
  try {
    expect((await fetchOAuthUrl(await testMcp.start())).status).toBe(200);
    expect((await testMcp.completed).status).toBe("completed");
    expect(await mcp.check(name)).toMatchObject({ status: "connected", toolCount: 1 });
    fixture.observedAuthorization.clear();
    expect(await mcp.check(alias)).toMatchObject({ status: "needs-auth", toolCount: 0 });
    expectSafeEqual(fixture.observedAuthorization, new Set([null]));
    expect(manager.authProvider(name, fixture.url)).toBe(manager.authProvider(name, `${fixture.origin}/./mcp`));
    expect(manager.authProvider(name, fixture.url)).not.toBe(manager.authProvider(alias, fixture.url));
    expect(manager.authProvider(name, fixture.url)).not.toBe(manager.authProvider(name, `${fixture.origin}/different`));

    const second = await manager.start({ name: alias, serverUrl: fixture.url, authorizationId: "second" });
    if (!("authorizationUrl" in second)) throw new Error("Expected a separate browser sign-in.");
    const redirectUrl = await callbackLocation(second.authorizationUrl);
    expect(await manager.complete({ name: alias, redirectUrl })).toEqual({ status: "completed" });
    expect(fixture.counts).toMatchObject({ authorize: 2, token: 2, refresh: 0 });
    for (const [index, service] of names.entries()) {
      fixture.observedAuthorization.clear();
      expect((await testMcp.call(undefined, service)).isError).toBe(false);
      expectSafeEqual(fixture.observedAuthorization, new Set([`Bearer ${tokens[index]}`]));
    }
    expect(fixture.counts.toolCalls).toBe(2);
  } finally {
    await testMcp.close();
  }
});

test("a configured Authorization header takes precedence over stored MCP OAuth tokens", async () => {
  const fixedAuthorization = "Bearer fixture-service-account";
  const testMcp = await setup({ fixedAuthorization });
  const { fixture, manager, name, secrets } = testMcp;
  const mcp = createMcpExtension({
    servers: () => ({ revision: "fixture", secrets: [fixedAuthorization], servers: {
      [name]: { disabled: false, transport: { type: "http", url: fixture.url, headers: { aUtHoRiZaTiOn: fixedAuthorization } } },
    } }),
    authProvider: (service, url) => manager.authProvider(service, url),
  });
  try {
    await manager.complete({ name, redirectUrl: await callbackLocation(await testMcp.start()) });
    const stored = await new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url }).load();
    expect(Boolean(stored?.tokens?.access_token)).toBe(true);
    const result = await mcp.tools![0]!.execute({ action: "call", service: name, tool: "read_fixture" },
      {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(false);
    expect(fixture.observedAuthorization.size).toBe(1);
    expect(fixture.observedAuthorization.has(fixedAuthorization)).toBe(true);
    expect(fixture.counts).toMatchObject({ oauthRequests: 0, refresh: 0, unauthorized: 0, toolCalls: 1 });
  } finally {
    await mcp.close();
    await testMcp.close();
  }
});

test("MCP redacts issued OAuth tokens from calls and tool errors after a 401 retry", async () => {
  const testMcp = await setup({ echoAuthorization: true });
  const { fixture, manager, name, secrets } = testMcp;
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url });
  try {
    await manager.complete({ name, redirectUrl: await callbackLocation(await testMcp.start()) });
    const before = (await store.load())?.tokens?.access_token;
    if (!before) throw new Error("Expected a stored fixture token.");
    const first = await testMcp.call();
    expect(JSON.stringify(first).includes(before)).toBe(false);
    expectSafeEqual(first, { isError: false, output: [{ type: "text", text: "Header: Bearer [redacted]" }] });
    const { refresh, unauthorized } = fixture.counts;
    fixture.rotateAccessToken();
    const failure = await testMcp.call("echo_error");
    const after = (await store.load())?.tokens?.access_token;
    if (!after) throw new Error("Expected a refreshed fixture token.");
    const visible = JSON.stringify(failure);
    expect(visible.includes(before) || visible.includes(after)).toBe(false);
    expectSafeEqual(failure, { isError: true, output: [{ type: "text", text: "Error header: Bearer [redacted]" }] });
    expect(fixture.counts.refresh).toBe(refresh + 1);
    expect(fixture.counts.unauthorized).toBe(unauthorized + 1);
  } finally {
    await testMcp.close();
  }
});

test("MCP redacts retained OAuth tokens after service retirement and clears them on close", async () => {
  const tokens = Array.from({ length: 5 }, () => crypto.randomUUID());
  let issued = 0;
  const service = `fixture-${tokens[4]}`;
  const tool = `read_fixture-${tokens[4]}`;
  const testMcp = await setup({ toolName: tool, echoAuthorization: true, issueAccessToken: () => tokens[issued++]! });
  const { manager, fixture } = testMcp;
  let state: "enabled" | "disabled" | "removed" = "enabled";
  const mcp = createMcpExtension({
    servers: () => ({ revision: state, secrets: [], servers: state === "removed" ? {} : {
      [service]: { disabled: state === "disabled", transport: { type: "http", url: fixture.url } },
    } }),
    authProvider: (name, url) => manager.authProvider(name, url),
  });
  const execute = (action: "call" | "describe", name = service) => mcp.tools![0]!.execute(
    { action, service: name, tool }, {} as ToolExecutionApi, BACKGROUND_CONTEXT,
  );
  try {
    const start = await manager.start({ name: service, serverUrl: fixture.url, authorizationId: "first" });
    if (!("authorizationUrl" in start)) throw new Error("Expected a browser sign-in.");
    await manager.complete({ name: service, redirectUrl: await callbackLocation(start.authorizationUrl) });

    const redactedCall = { isError: false, output: [{ type: "text", text: "Header: Bearer [redacted]" }] };
    expectSafeEqual(await execute("call"), redactedCall);
    for (let index = 1; index < tokens.length; index++) {
      fixture.rotateAccessToken();
      expectSafeEqual(await execute("call"), redactedCall);
    }
    expect(issued).toBe(tokens.length);
    const described = await execute("describe");
    expect(described.isError).toBe(false);
    const metadata = described.output?.[0];
    const identifiers = JSON.parse(metadata?.type === "text" ? metadata.text : "null");
    expect(identifiers?.service === service && identifiers?.tool === tool).toBe(true);

    state = "disabled";
    // Reading status queues retirement. The check for this service runs after retirement.
    const status = mcp.status()[0];
    expect(status?.name === service && status?.status === "disabled").toBe(true);
    await mcp.check(service);
    expectSafeEqual(await execute("call"), { isError: true, output: [{
      type: "text", text: 'MCP service "fixture-[redacted]" is disabled. Enable it in Services before retrying.',
    }] });

    state = "removed";
    expectSafeEqual(await execute("call"), { isError: true, output: [{
      type: "text", text: 'Unknown MCP service "fixture-[redacted]". Use mcp search to find available services.',
    }] });
    expectSafeEqual(await execute("call", `unknown-${tokens.join("-")}`), { isError: true, output: [{
      type: "text", text: `Unknown MCP service "unknown-${tokens[0]}-[redacted]-[redacted]-[redacted]-[redacted]". Use mcp search to find available services.`,
    }] });
    expect(mcp.retainedTokenSetCountForTest()).toBe(1);
    await mcp.close();
    expect(mcp.retainedTokenSetCountForTest()).toBe(0);
  } finally {
    await mcp.close();
    await testMcp.close();
  }
});

test.each([
  { label: "a short token", token: "q7z9", escaped: "" },
  { label: "a token with a slash", token: "fixture/credential", escaped: "; escaped: Bearer [redacted]" },
])("MCP redacts $label from tool results and errors", async ({ token, escaped }) => {
  const testMcp = await setup({ echoAuthorization: true, issueAccessToken: () => token });
  const { manager, name } = testMcp;
  try {
    await manager.complete({ name, redirectUrl: await callbackLocation(await testMcp.start()) });
    expectSafeEqual(await testMcp.call(), {
      isError: false, output: [{ type: "text", text: `Header: Bearer [redacted]${escaped}` }],
    });
    expectSafeEqual(await testMcp.call("echo_error"), {
      isError: true, output: [{ type: "text", text: `Error header: Bearer [redacted]${escaped}` }],
    });
  } finally {
    await testMcp.close();
  }
});

test("manual OAuth completion joins an in-flight browser exchange and publishes one outcome", async () => {
  const exchangeStarted = Promise.withResolvers<void>();
  const releaseExchange = Promise.withResolvers<void>();
  const testMcp = await setup({ async beforeTokenResponse() {
    exchangeStarted.resolve();
    await releaseExchange.promise;
  } });
  const { manager, name, fixture, outcomes } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    expect((await fetchOAuthUrl(redirectUrl)).status).toBe(200);
    await exchangeStarted.promise;
    const manual = manager.complete({ name, redirectUrl });
    void manual.catch(() => {});
    expectSafeEqual(outcomes, []);
    releaseExchange.resolve();
    expect(await manual).toEqual({ status: "completed" });
    await expectRejection(manager.complete({ name, redirectUrl }), "No pending MCP sign-in.");
    expect(fixture.counts.token).toBe(1);
    expectSafeEqual(outcomes, [{ name, authorizationId: "first", status: "completed" }]);
  } finally {
    releaseExchange.resolve();
    await testMcp.close();
  }
});

test("a rejecting OAuth completion handler receives one completed outcome", async () => {
  const testMcp = await setup(undefined, { onComplete() { throw new Error("Fixture outcome handler failed."); } });
  const { manager, name, outcomes } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    const completion = await manager.complete({ name, redirectUrl }).then(() => "resolved", () => "rejected");
    expectSafeEqual(outcomes, [{ name, authorizationId: "first", status: "completed" }]);
    expect(completion).toBe("resolved");
    await expectClosedListener(redirectUrl);
  } finally {
    await testMcp.close();
  }
});

test("an OAuth token exchange crossing the deadline reports expired and invalidates its tokens", async () => {
  let now = Date.now();
  const expiresAt = now + 60_000;
  const exchangeStarted = Promise.withResolvers<void>();
  const releaseExchange = Promise.withResolvers<void>();
  const testMcp = await setup({ async beforeTokenResponse() {
    exchangeStarted.resolve();
    await releaseExchange.promise;
  } }, { now: () => now });
  const { manager, fixture, name, secrets, outcomes } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start("expiring", expiresAt));
    now = expiresAt - 1;
    const completing = manager.complete({ name, redirectUrl }).catch(() => {});
    await exchangeStarted.promise;
    now = expiresAt;
    releaseExchange.resolve();
    await completing;
    expectSafeEqual(outcomes, [{ name, authorizationId: "expiring", status: "failed", reason: "expired" }]);
    expect(fixture.counts.token).toBe(1);
    const stored = await new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url }).load();
    expect(Boolean(stored?.tokens || stored?.tokensExpireAt)).toBe(false);
    await expectClosedListener(redirectUrl);
    const retry = await manager.start({ name, serverUrl: fixture.url, authorizationId: "retry" });
    expect("authorizationUrl" in retry).toBe(true);
    expect(fixture.counts.refresh).toBe(0);
  } finally {
    releaseExchange.resolve();
    await testMcp.close();
  }
});

test.each([
  { label: "an allowlisted code", code: "access_denied" },
  { label: "a provider-specific code", code: "fixture_policy_denial" },
])("a pasted OAuth denial with $label closes the listener and reports auth_failed", async ({ code }) => {
  const testMcp = await setup({ denyAuthorization: true });
  const { manager, name, outcomes, fixture } = testMcp;
  try {
    const redirect = new URL(await callbackLocation(await testMcp.start()));
    redirect.searchParams.set("error", code);
    const redirectUrl = redirect.href;
    const result = await manager.complete({ name, redirectUrl });
    expectSafeEqual(outcomes, [{ name, authorizationId: "first", status: "failed", reason: "auth_failed" }]);
    expect(result).toEqual({ status: "failed", reason: "auth_failed" });
    expect(fixture.counts.token).toBe(0);
    await expectClosedListener(redirectUrl);
    await expectRejection(manager.complete({ name, redirectUrl }), "No pending MCP sign-in.");
  } finally {
    await testMcp.close();
  }
});

test.each([
  { label: "after listener shutdown", activeChecks: 1, invalidate: "available" },
  { label: "without provider invalidation", activeChecks: 0, invalidate: "missing" },
  { label: "when provider invalidation fails", activeChecks: 0, invalidate: "rejecting" },
])("an OAuth deadline after token persistence clears credentials $label", async ({ activeChecks, invalidate }) => {
  const now = Date.now();
  const expiresAt = now + 60_000;
  let tokensWritten = false;
  let checksAfterWrite = 0;
  const testMcp = await setup(undefined, {
    now: () => tokensWritten && ++checksAfterWrite > activeChecks ? expiresAt : now,
  });
  const { manager, fixture, name, backend, secrets, outcomes } = testMcp;
  backend.afterSet = (value) => { tokensWritten ||= Boolean(JSON.parse(value).tokens); };
  const original = Object.getOwnPropertyDescriptor(McpOAuthProvider.prototype, "invalidateCredentials")!;
  if (invalidate !== "available") {
    Object.defineProperty(McpOAuthProvider.prototype, "invalidateCredentials", {
      ...original,
      value: invalidate === "missing" ? undefined : async () => { throw new Error("Fixture invalidation failed."); },
    });
  }
  try {
    const redirectUrl = await callbackLocation(await testMcp.start("expiring", expiresAt));
    expect(await manager.complete({ name, redirectUrl })).toEqual({ status: "failed", reason: "expired" });
    expect(tokensWritten).toBe(true);
    expectSafeEqual(outcomes, [{ name, authorizationId: "expiring", status: "failed", reason: "expired" }]);
    const stored = await new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url }).load();
    expect(Boolean(stored?.tokens || stored?.tokensExpireAt)).toBe(false);
    if (invalidate !== "available") expectSafeEqual(stored, { serverUrl: fixture.url });
    await expectClosedListener(redirectUrl);
    const retry = await manager.start({ name, serverUrl: fixture.url, authorizationId: "retry" });
    expect("authorizationUrl" in retry).toBe(true);
    expect(fixture.counts.refresh).toBe(0);
  } finally {
    Object.defineProperty(McpOAuthProvider.prototype, "invalidateCredentials", original);
    await testMcp.close();
  }
});

test("an OAuth attempt waiting for the refresh lock uses the deadline from start", async () => {
  let now = Date.now();
  const testMcp = await setup(undefined, { now: () => now });
  const { secrets, name, fixture, outcomes, backend } = testMcp;
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url });
  const release = Promise.withResolvers<void>();
  const lock = store.withRefreshLock(() => release.promise);
  try {
    const starting = expectRejection(testMcp.start(), "The MCP sign-in callback timed out.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += 10 * 60_000;
    release.resolve();
    await starting;
    expect(backend.writes).toBe(0);
    expectSafeEqual(outcomes, [{ name: testMcp.name, authorizationId: "first", status: "failed", reason: "expired" }]);
  } finally {
    release.resolve();
    await lock;
    await testMcp.close();
  }
});

test("a pasted OAuth denial with the wrong state leaves the attempt open for a correct paste", async () => {
  const testMcp = await setup();
  const { manager, name, outcomes, fixture } = testMcp;
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    const denial = new URL(redirectUrl);
    denial.searchParams.delete("code");
    denial.searchParams.set("state", "wrong-state");
    denial.searchParams.set("error", "access_denied");
    await expectRejection(manager.complete({ name, redirectUrl: denial.href }), "The MCP sign-in redirect is invalid.");
    expectSafeEqual(outcomes, []);
    expect(fixture.counts.token).toBe(0);
    await manager.complete({ name, redirectUrl });
    expectSafeEqual(outcomes, [{ name, authorizationId: "first", status: "completed" }]);
    expect(fixture.counts.token).toBe(1);
  } finally {
    await testMcp.close();
  }
});

test("closing the OAuth manager resolves during an active completion handler and blocks later token writes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<boolean>();
  let shutdownResolved = false;
  const testMcp = await setup({ tokenTtlSeconds: 1 }, { async onComplete() {
    entered.resolve();
    await release.promise;
    // C2 may close the manager from this handler, so shutdown must drain credential work independently.
    if (!shutdownResolved) return;
    await testMcp.manager.close();
    finished.resolve((await provider.token()) === undefined);
  } });
  const { manager, name, fixture, backend } = testMcp;
  const provider = manager.authProvider(name, fixture.url);
  try {
    const redirectUrl = await callbackLocation(await testMcp.start());
    const completing = manager.complete({ name, redirectUrl });
    await entered.promise;
    const closed = await Promise.race([
      manager.close().then(() => { shutdownResolved = true; return true; }),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(closed).toBe(true);
    const writes = backend.writes;
    release.resolve();
    expect(await finished.promise).toBe(true);
    await completing;
    expect(backend.writes).toBe(writes);
    expect(fixture.counts.refresh).toBe(0);
  } finally {
    release.resolve();
    await testMcp.close();
  }
});

test("closing the OAuth manager waits for a cached provider's refresh", async () => {
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const testMcp = await setup({ tokenTtlSeconds: 1, async beforeTokenResponse(grant) {
    if (grant !== "refresh_token") return;
    refreshing.resolve();
    await release.promise;
  } });
  const { manager, fixture, name, secrets } = testMcp;
  const store = new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url });
  try {
    await manager.complete({ name, redirectUrl: await callbackLocation(await testMcp.start()) });
    const before = (await store.load())?.tokens?.access_token;
    const token = manager.authProvider(name, fixture.url).token();
    await refreshing.promise;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    const after = (await store.load())?.tokens?.access_token;
    expect(Boolean(before && after && before !== after)).toBe(true);
    expect(Boolean(after && await token === after)).toBe(true);
  } finally {
    release.resolve();
    await testMcp.close();
  }
});

test("closing an idle OAuth manager resolves immediately and is repeatable", async () => {
  const testMcp = await setup();
  try {
    const closing = testMcp.manager.close();
    expect(testMcp.manager.close()).toBe(closing);
    const finished = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    expect(finished).toBe(true);
    await testMcp.manager.close();
  } finally {
    await testMcp.close();
  }
});

test("MCP OAuth listens on the configured callback port", async () => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const callbackPort = reservation.port!;
  const testMcp = await setup(undefined, { settings: () => ({ callbackPort }) });
  try {
    await reservation.stop(true);
    const redirect = new URL(redirectUri(await testMcp.start()));
    expect(redirect.port === String(callbackPort)).toBe(true);
    expect((await fetchOAuthUrl(redirect)).status).toBe(400);
  } finally {
    await reservation.stop(true);
    await testMcp.close();
  }
});

test("MCP OAuth uses and advertises an explicit callback URL port ahead of callbackPort", async () => {
  const callbackUrl = "http://127.0.0.1:80/callback";
  const binding = { port: 80, path: "/callback", redirectHostname: "127.0.0.1", fixedRedirectUrl: callbackUrl };
  expect(resolveCallbackBinding({ callbackUrl, callbackPort: 4000 })).toEqual(binding);
  expect(resolveCallbackBinding({ callbackUrl })).toEqual(binding);
  const noAuthorityPort = resolveCallbackBinding({ callbackUrl: "http://127.0.0.1/callback:80", callbackPort: 4000 });
  expect(noAuthorityPort).toEqual({ port: 4000, path: "/callback:80", redirectHostname: "127.0.0.1" });
  expect(noAuthorityPort).not.toHaveProperty("fixedRedirectUrl");

  const explicitCallbackUrl = "http://localhost:4000/callback";
  const settings = { callbackUrl: explicitCallbackUrl, callbackPort: 8000 };
  expect(resolveCallbackBinding(settings)).toEqual({
    port: 4000, path: "/callback", redirectHostname: "localhost", fixedRedirectUrl: explicitCallbackUrl,
  });
  const testMcp = await setup(undefined, { settings: () => settings });
  const serve = Bun.serve;
  // Use an available port so the test can verify the advertised URI independently of the listener port.
  const callbackServe = spyOn(Bun, "serve").mockImplementationOnce(({ unix: _unix, ...options }) => serve({ ...options, port: 0 }));
  try {
    expect(redirectUri(await testMcp.start())).toEqual(explicitCallbackUrl);
    expect(callbackServe).toHaveBeenCalledWith(expect.objectContaining({ port: 4000 }));
  } finally {
    callbackServe.mockRestore();
    await testMcp.close();
  }
});

test("MCP OAuth advertises the registered localhost callback URL", async () => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = reservation.port!;
  const testMcp = await setup(undefined, { settings: () => ({ callbackUrl: `http://localhost:${port}/oauth/finish`, callbackPort: 0 }) });
  try {
    await reservation.stop(true);
    const url = await testMcp.start();
    const redirect = new URL(redirectUri(url));
    expect(redirect.port === String(port)).toBe(true);
    // The authorization server must receive the exact registered redirect URI.
    expect(redirect.href).toBe(`http://localhost:${port}/oauth/finish`);
    expect((await fetchOAuthUrl(new URL("/callback", redirect))).status).toBe(404);
    expect((await fetchOAuthUrl(url)).status).toBe(200);
    expect((await testMcp.completed).status).toBe("completed");
  } finally {
    await reservation.stop(true);
    await testMcp.close();
  }
});

test.each([
  { label: "a tab", callbackUrl: "http://localhost/oauth/\tfinish" },
  { label: "a backslash", callbackUrl: "http://localhost/oauth\\finish" },
])("MCP OAuth rejects $label in a callback URL before parsing", ({ callbackUrl }) => {
  expect(() => resolveCallbackBinding({ callbackUrl })).toThrow("Invalid MCP OAuth callback URL.");
});

test("MCP OAuth rejects a configured non-loopback callback URL", () => {
  expect(() => resolveCallbackBinding({ callbackUrl: "http://fixture.invalid/private-callback" })).toThrow("Invalid MCP OAuth callback URL.");
});

test("invalid MCP OAuth callback configuration reports one auth_failed outcome without opening a listener", async () => {
  const testMcp = await setup(undefined, { settings: () => ({ callbackUrl: "http://fixture.invalid/private-callback" }) });
  const { manager, name, fixture, outcomes } = testMcp;
  const authorizationId = "invalid-callback";
  const serve = spyOn(Bun, "serve");
  try {
    const error: unknown = await manager.start({ name, serverUrl: fixture.url, authorizationId }).catch((error: unknown) => error);
    expectSafeEqual(outcomes, [{ name, authorizationId, status: "failed", reason: "auth_failed" }]);
    expectSafeEqual(error instanceof Error && error.message, "MCP sign-in could not be started.");
    expect(serve).toHaveBeenCalledTimes(0);
    await expectRejection(manager.complete({ name, redirectUrl: fixture.origin }), "No pending MCP sign-in.");
    await manager.cancel({ name, authorizationId });
    await manager.close();
    expect(outcomes).toHaveLength(1);
  } finally {
    serve.mockRestore();
    await testMcp.close();
  }
});

test.each(["consumed", "replaced"] as const)("MCP OAuth clears a %s challenge only if it is still current", async (challenge) => {
  const testMcp = await setup({ challengeScope: "initial-scope" });
  const { manager, fixture, name, secrets } = testMcp;
  try {
    expect((await testMcp.call()).isError).toBe(true);
    const authorizationUrl = await testMcp.start();
    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("initial-scope");
    if (challenge === "replaced") {
      fixture.setChallengeScope("newer-scope");
      expect((await testMcp.call()).isError).toBe(true);
    }
    await manager.complete({ name, redirectUrl: await callbackLocation(authorizationUrl) });
    const store = new SecretMcpOAuthStateStore({ secrets, name, server: fixture.url });
    const saved = await store.load();
    if (!saved?.tokens) throw new Error("Expected stored OAuth tokens.");
    delete saved.tokens;
    delete saved.tokensExpireAt;
    await store.save(saved);
    const retry = await testMcp.start("retry");
    expect(new URL(retry).searchParams.get("scope")).toBe(challenge === "replaced" ? "newer-scope" : null);
  } finally {
    await testMcp.close();
  }
});
