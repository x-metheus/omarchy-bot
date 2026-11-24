import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startOAuthMcpServer } from "../../apps/daemon/src/modules/runtime/testing/oauthMcpServer.ts";
import type { EventEnvelope, McpConnectionDto, PluginStateDto } from "../../packages/protocol/src/index.ts";
import { PLUGIN_PROVIDERS } from "../../packages/protocol/src/pluginProviders.ts";
import { api, apiStatus, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const publisher = "https://durable-mcp-oauth-publisher.invalid";
const toolText = "OAuth MCP fixture result";

type OAuthFixture = Awaited<ReturnType<typeof startOAuthMcpServer>>;

async function withDurableDaemon(
  run: (h: Harness, connection: McpConnectionDto, fixture: OAuthFixture) => Promise<void>,
  { beforeDiscovery, ...options }: NonNullable<Parameters<typeof startOAuthMcpServer>[0]> & { beforeDiscovery?: () => Promise<void> } = {},
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-mcp-oauth-durable-"));
  const previous = process.env.OMARCHY_TEST_DURABLE;
  process.env.OMARCHY_TEST_DURABLE = "1";
  const fetch = globalThis.fetch;
  const publisherFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${publisher}/api/plugins/providers`) return Response.json([]);
    if (url.hostname !== "127.0.0.1") throw new Error(`Unexpected fixture request to ${url.origin}`);
    if (beforeDiscovery && url.href === fixture?.url && typeof init?.body === "string" &&
      (JSON.parse(init.body) as { method?: string }).method === "tools/list") await beforeDiscovery();
    return fetch(input, init);
  }, { preconnect: fetch.preconnect }));
  let h: Harness | undefined;
  let fixture: OAuthFixture | undefined;
  try {
    fixture = await startOAuthMcpServer({ toolName: "reflect", toolText, ...options });
    // The switch installs the fake model provider and sets runtime=durable in the test database.
    h = await startDaemon(root);
    h.svc.plugins.configure(publisher);
    const connection = await api<McpConnectionDto>(h, "POST", "/api/plugins/mcp", {
      name: "local", enabled: true, transport: { type: "http", url: fixture.url },
    });
    await run(h, connection, fixture);
  } finally {
    try {
      await h?.stop();
    } finally {
      publisherFetch.mockRestore();
      if (previous === undefined) delete process.env.OMARCHY_TEST_DURABLE;
      else process.env.OMARCHY_TEST_DURABLE = previous;
      await Promise.all([
        fixture?.close(),
        rm(root, { recursive: true, force: true }),
        h && rm(h.svc.cfg.stateDir, { recursive: true, force: true }),
      ]);
    }
  }
}

async function withAuthorizationEvent(
  h: Harness, aggregateId: string, type: "completed" | "failed", run: (event: Promise<EventEnvelope>) => Promise<void>,
): Promise<void> {
  const socket = new WebSocket(`${h.baseUrl.replace(/^http/, "ws")}/api/events?access_token=${encodeURIComponent(h.token)}`);
  const ready = Promise.withResolvers<void>();
  const event = Promise.withResolvers<EventEnvelope>();
  void event.promise.catch(() => {});
  const timeout = setTimeout(() => {
    const error = new Error(`Timed out waiting for plugin.authorization_${type}`);
    ready.reject(error);
    event.reject(error);
  }, 10_000);
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello" }));
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data)) as { type: string; envelope?: EventEnvelope };
    if (frame.type === "hello") ready.resolve();
    if (frame.envelope?.aggregateId === aggregateId && frame.envelope.type === `plugin.authorization_${type}`) event.resolve(frame.envelope);
  };
  try {
    await ready.promise;
    await run(event.promise);
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}

const authorizeRoute = (id: string) => `/api/plugins/mcp/${id}/authorize`;

async function startSignIn(h: Harness, id: string): Promise<string> {
  const { authorizationUrl } = await api<{ authorizationUrl?: string }>(h, "POST", authorizeRoute(id), {});
  expect(authorizationUrl).toEqual(expect.any(String));
  return authorizationUrl!;
}

async function connectionState(h: Harness, id: string) {
  return (await api<PluginStateDto>(h, "GET", "/api/plugins")).mcp.find((entry) => entry.id === id);
}

async function expectToolResult(h: Harness) {
  const bot = await makeBot(h, "MCP OAuth durable");
  const { threadId, turnId } = await sendToBot(h, bot, "mcp-durable: call");
  await waitThreadIdle(h, threadId);
  expect(h.svc.threads.turnRow(turnId)?.status).toBe("completed");
  const responseTexts = (await messages(h, threadId)).filter(({ kind }) => kind === "response").map(({ text }) => text);
  expect(Bun.deepEquals(responseTexts, [toolText])).toBe(true);
}

test("durable MCP browser sign-in publishes completion and enables tool calls", async () => {
  await withDurableDaemon(async (h, { id }) => {
    expect(await api(h, "POST", `/api/plugins/mcp/${id}/check`, {})).toMatchObject({ status: "needs-auth" });
    expect(await connectionState(h, id)).toMatchObject({ status: "needs-auth" });
    await withAuthorizationEvent(h, id, "completed", async (event) => {
      const authorizationUrl = await startSignIn(h, id);
      const callback = await fetch(authorizationUrl, { redirect: "follow" });
      expect(callback.status).toBe(200);
      expect(await event).toMatchObject({ payload: { mcpId: id, status: "completed" } });
    });
    expect(await connectionState(h, id)).toMatchObject({ status: "connected", toolCount: 1 });
    await expectToolResult(h);
  });
}, 25_000);

test("durable MCP manual sign-in accepts the browser redirect URL and enables tool calls", async () => {
  await withDurableDaemon(async (h, { id }) => {
    const authorizationUrl = await startSignIn(h, id);
    const consent = await fetch(authorizationUrl, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const redirectUrl = consent.headers.get("location");
    expect(redirectUrl).not.toBeNull();
    expect(await api<{ authenticated?: boolean }>(h, "POST", authorizeRoute(id), { redirectUrl })).toEqual({ authenticated: true });
    expect(await connectionState(h, id)).toMatchObject({ status: "connected", toolCount: 1 });
    const oldest = h.svc.events.oldestCursor();
    const events = h.svc.events.replay(oldest - 1, oldest).events;
    expect(events.filter((event) => event.aggregateId === id && event.type === "plugin.authorization_completed")).toHaveLength(1);
    await expectToolResult(h);
  });
}, 25_000);

test("durable MCP consent denial publishes failure and leaves the connection unsigned in", async () => {
  await withDurableDaemon(async (h, { id }) => {
    await withAuthorizationEvent(h, id, "failed", async (event) => {
      const authorizationUrl = await startSignIn(h, id);
      const callback = await fetch(authorizationUrl, { redirect: "follow" });
      expect(callback.status).toBe(400);
      expect(await event).toMatchObject({ payload: { mcpId: id, status: "failed", reason: "auth_failed" } });
    });
    expect(["needs-auth", "not-connected"]).toContain((await connectionState(h, id))!.status);
  }, { denyAuthorization: true });
}, 25_000);

async function browserRedirect(authorizationUrl: string): Promise<string> {
  const consent = await fetch(authorizationUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const redirectUrl = consent.headers.get("location");
  if (!redirectUrl) throw new Error("Expected an OAuth redirect.");
  return redirectUrl;
}

function authorizationHistory(h: Harness, id: string) {
  const oldest = h.svc.events.oldestCursor();
  return h.svc.events.replay(oldest - 1, oldest).events.filter((event) => event.aggregateId === id &&
    (event.type === "plugin.authorization_completed" || event.type === "plugin.authorization_failed"));
}

test("durable MCP pasted denial returns auth_failed and publishes one failure", async () => {
  await withDurableDaemon(async (h, { id }, fixture) => {
    await withAuthorizationEvent(h, id, "failed", async (event) => {
      const redirectUrl = await browserRedirect(await startSignIn(h, id));
      expect(await api<{ error?: string }>(h, "POST", authorizeRoute(id), { redirectUrl })).toEqual({ error: "auth_failed" });
      expect(await event).toMatchObject({ payload: { mcpId: id, status: "failed", reason: "auth_failed" } });
    });
    expect(authorizationHistory(h, id).map(({ type }) => type)).toEqual(["plugin.authorization_failed"]);
    expect(fixture.counts.token).toBe(0);
  }, { denyAuthorization: true });
}, 25_000);

test("durable MCP invalid manual redirect cancels consent before a later browser callback", async () => {
  await withDurableDaemon(async (h, { id }, fixture) => {
    await withAuthorizationEvent(h, id, "failed", async (event) => {
      const redirectUrl = await browserRedirect(await startSignIn(h, id));
      const invalid = new URL(redirectUrl);
      invalid.searchParams.set("state", "invalid-state");
      expect(await api<{ error?: string }>(h, "POST", authorizeRoute(id), { redirectUrl: invalid.href })).toEqual({ error: "auth_failed" });
      expect(await event).toMatchObject({ payload: { mcpId: id, status: "failed", reason: "auth_failed" } });
      const exchanges = fixture.counts.token;
      expect(await fetch(redirectUrl).then((response) => response.ok, () => false)).toBe(false);
      expect(fixture.counts.token).toBe(exchanges);
    });
    expect(authorizationHistory(h, id).map(({ type }) => type)).toEqual(["plugin.authorization_failed"]);
    expect(await api(h, "POST", `/api/plugins/mcp/${id}/check`, {})).toMatchObject({ status: "needs-auth" });
  });
}, 25_000);

test("durable MCP manual paste during browser exchange publishes one completion", async () => {
  const exchangeStarted = Promise.withResolvers<void>();
  const releaseExchange = Promise.withResolvers<void>();
  await withDurableDaemon(async (h, { id }, fixture) => {
    try {
      const redirectUrl = await browserRedirect(await startSignIn(h, id));
      expect((await fetch(redirectUrl)).status).toBe(200);
      await exchangeStarted.promise;
      const manual = h.svc.plugins.authorizeMcp(id, redirectUrl);
      expect(authorizationHistory(h, id)).toHaveLength(0);
      releaseExchange.resolve();
      expect(await manual).toEqual({ authenticated: true });
      expect(fixture.counts.token).toBe(1);
      expect(authorizationHistory(h, id).map(({ type }) => type)).toEqual(["plugin.authorization_completed"]);
    } finally {
      releaseExchange.resolve();
    }
  }, { async beforeTokenResponse() {
    exchangeStarted.resolve();
    await releaseExchange.promise;
  } });
}, 25_000);

test("durable MCP manual paste joins the Services check after the browser token exchange", async () => {
  const discoveryStarted = Promise.withResolvers<void>();
  const releaseDiscovery = Promise.withResolvers<void>();
  await withDurableDaemon(async (h, { id }, fixture) => {
    try {
      const redirectUrl = await browserRedirect(await startSignIn(h, id));
      expect(await fetch(redirectUrl).then(({ status }) => status, () => 0)).toBe(200);
      await discoveryStarted.promise;
      expect(fixture.counts.token).toBe(1);
      expect(authorizationHistory(h, id)).toHaveLength(0);
      const manual = h.svc.plugins.authorizeMcp(id, redirectUrl);
      const duringDiscovery = await Promise.race([
        manual.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      expect(duringDiscovery).toBe("pending");
      expect(authorizationHistory(h, id)).toHaveLength(0);
      releaseDiscovery.resolve();
      expect(Bun.deepEquals(await manual, { authenticated: true })).toBe(true);
      expect(authorizationHistory(h, id).map(({ type }) => type)).toEqual(["plugin.authorization_completed"]);
      expect(await connectionState(h, id)).toMatchObject({ status: "connected", toolCount: 1 });
    } finally {
      releaseDiscovery.resolve();
    }
  }, { async beforeDiscovery() {
    discoveryStarted.resolve();
    await releaseDiscovery.promise;
  } });
}, 25_000);

test("durable MCP manual paste joins the plugin service's second discovery check", async () => {
  const secondDiscoveryStarted = Promise.withResolvers<void>();
  const releaseDiscovery = Promise.withResolvers<void>();
  let discoveries = 0;
  await withDurableDaemon(async (h, { id }) => {
    try {
      const redirectUrl = await browserRedirect(await startSignIn(h, id));
      expect((await fetch(redirectUrl)).status).toBe(200);
      await secondDiscoveryStarted.promise;
      expect(authorizationHistory(h, id)).toHaveLength(0);
      const manual = h.svc.plugins.authorizeMcp(id, redirectUrl);
      releaseDiscovery.resolve();
      expect(await manual).toEqual({ authenticated: true });
      expect(await connectionState(h, id)).toMatchObject({ status: "connected", toolCount: 1 });
      const replay = await apiStatus(h, "POST", authorizeRoute(id), { redirectUrl });
      expect(replay.status).toBe(400);
      expect(authorizationHistory(h, id).map(({ type }) => type)).toEqual(["plugin.authorization_completed"]);
    } finally {
      releaseDiscovery.resolve();
    }
  }, { async beforeDiscovery() {
    if (++discoveries === 2) {
      secondDiscoveryStarted.resolve();
      await releaseDiscovery.promise;
    }
  } });
}, 25_000);

test("durable MCP provider authorization returns a 502 when the configured callback port is occupied", async () => {
  await withDurableDaemon(async (h, _connection, fixture) => {
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const provider = PLUGIN_PROVIDERS.intercom;
    const { services, nativeOAuth } = provider;
    provider.services = services.map((service) => ({ ...service, mcpUrl: fixture.url }));
    provider.nativeOAuth = { ...nativeOAuth, redirectPort: reservation.port! };
    try {
      const { status, body } = await apiStatus(h, "POST", "/api/plugins/authorize", { providerId: "intercom", serviceId: "intercom" });
      const oldest = h.svc.events.oldestCursor();
      const failures = h.svc.events.replay(oldest - 1, oldest).events.filter(({ type }) => type === "plugin.authorization_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.payload).toMatchObject({ providerId: "intercom", status: "failed", reason: "auth_failed" });
      expect(status).toBe(502);
      expect(Bun.deepEquals(body, { error: "authorization_failed" })).toBe(true);
    } finally {
      provider.services = services;
      if (nativeOAuth === undefined) delete provider.nativeOAuth;
      else provider.nativeOAuth = nativeOAuth;
      await reservation.stop(true);
    }
  });
}, 25_000);

test.each(["browser callback", "manual paste"] as const)("durable MCP forwards connect_failed after a %s", async (completion) => {
  await withDurableDaemon(async (h, _connection, fixture) => {
    const original = PLUGIN_PROVIDERS.intercom.services;
    PLUGIN_PROVIDERS.intercom.services = original.map((service) => ({ ...service, mcpUrl: fixture.url }));
    try {
      const { url } = await api<{ url: string }>(h, "POST", "/api/plugins/authorize", { providerId: "intercom", serviceId: "intercom" });
      const getAccount = async () => (await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts.find(({ providerId }) => providerId === "intercom");
      const account = await getAccount();
      const id = account?.nativeConnectionId;
      if (!id) throw new Error("Expected a provider MCP connection.");
      await withAuthorizationEvent(h, account.id, "failed", async (event) => {
        if (completion === "browser callback") {
          expect((await fetch(url)).status).toBe(200);
        } else {
          const redirectUrl = await browserRedirect(url);
          const result = await api<{ error?: string }>(h, "POST", authorizeRoute(id), { redirectUrl });
          expect(Bun.deepEquals(result, { error: "connect_failed" })).toBe(true);
        }
        expect(await event).toMatchObject({ payload: { mcpId: id, status: "failed", reason: "connect_failed" } });
      });
      expect(authorizationHistory(h, account.id).map(({ type }) => type)).toEqual(["plugin.authorization_failed"]);
      expect(fixture.counts.token).toBe(1);
      expect(await getAccount()).toMatchObject({ status: "reauthorize", error: "connect_failed" });
    } finally {
      PLUGIN_PROVIDERS.intercom.services = original;
    }
  }, { fixedAuthorization: "Bearer unavailable-fixture-credential" });
}, 25_000);
