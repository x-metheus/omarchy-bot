import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLUGIN_PROVIDERS } from "../../packages/protocol/src/pluginProviders.ts";
import type { InstalledSkillDto, PluginAccountDto, PluginStateDto, SkillCommandDto } from "../../packages/protocol/src/plugins.ts";
import type { EventEnvelope } from "../../packages/protocol/src/events.ts";
import { handlePluginCloudRequest } from "../../apps/site/server/plugins.ts";
import type { BotRuntime } from "../../apps/daemon/src/modules/runtime/runtime.ts";
import { startOAuthMcpServer } from "../../apps/daemon/src/modules/runtime/testing/oauthMcpServer.ts";
import { api, apiStatus, authedFetch, startDaemon, type Harness } from "./helpers/harness.ts";

const publisher = "https://service-publisher.invalid";
const driveScope = "https://www.googleapis.com/auth/drive.readonly";
const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const originalFetch = globalThis.fetch;
const originalServices = PLUGIN_PROVIDERS.google.services;
const originalIntercom = PLUGIN_PROVIDERS.intercom.services;
let harness: Harness | undefined;
const googleClientId = "fixture-google-client";
const publisherEnv = {
  PLUGIN_CLOUD_URL: process.env.PLUGIN_CLOUD_URL,
  OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
  OAUTH_GOOGLE_CLIENT_ID: process.env.OAUTH_GOOGLE_CLIENT_ID,
  OAUTH_GOOGLE_CLIENT_SECRET: process.env.OAUTH_GOOGLE_CLIENT_SECRET,
};
let googleKey: { publicKey: KeyObject; privateKey: KeyObject } | undefined;

afterEach(async () => {
  try {
    await harness?.stop();
  } finally {
    harness = undefined;
    PLUGIN_PROVIDERS.google.services = originalServices;
    PLUGIN_PROVIDERS.intercom.services = originalIntercom;
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(publisherEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

async function companion(source: string, name: string, increment: number): Promise<void> {
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), `---\nname: ${name}\ndescription: Calculate a fixture amount\n---\nRun the bundled scripts/calculate.js with a JSON argument containing amount.\nExample: bun scripts/calculate.js '{"amount":10}'\nRead the result field from its JSON output.\n`);
  await writeFile(path.join(source, "scripts", "calculate.js"), `const { amount } = JSON.parse(process.argv[2]);\nconsole.log(JSON.stringify({ result: amount + ${increment} }));\n`);
}

async function startServices({ intercomMcpUrl }: { intercomMcpUrl?: string } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarchy-bot-services-"));
  const root = path.join(home, ".omarchy-bot", "workspace", ".service-fixtures");
  const sources = {
    driveRead: path.join(root, "fixture-drive-read"),
    driveWrite: path.join(root, "fixture-drive-write"),
    gmail: path.join(root, "fixture-gmail"),
    independent: path.join(root, "fixture-independent"),
  };
  await companion(sources.driveRead, "fixture-drive-read", 1);
  await companion(sources.driveWrite, "fixture-drive-write", 2);
  await companion(sources.gmail, "fixture-gmail", 3);
  await companion(sources.independent, "fixture-independent", 4);
  PLUGIN_PROVIDERS.google.services = originalServices.map((service) => {
    if (service.id === "google-drive") return { ...service, scopes: [driveScope], mcpUrl: `${publisher}/mcp/drive`, skillSources: [sources.driveRead, sources.driveWrite] };
    if (service.id === "gmail") return { ...service, scopes: [gmailScope], mcpUrl: `${publisher}/mcp/gmail`, skillSources: [sources.gmail] };
    return { ...service, mcpUrl: `${publisher}/mcp/${service.id}` };
  });
  if (intercomMcpUrl !== undefined) {
    PLUGIN_PROVIDERS.intercom.services = originalIntercom.map((service) => ({ ...service, mcpUrl: intercomMcpUrl }));
  }

  process.env.PLUGIN_CLOUD_URL = publisher;
  process.env.OAUTH_STATE_SECRET = "service-publisher-secret-at-least-32b";
  process.env.OAUTH_GOOGLE_CLIENT_ID = googleClientId;
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = "fixture-google-secret";
  googleKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...googleKey.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
  // Provider token endpoint and userinfo only. The publisher itself is the real handler.
  const grants = new Map<string, { actor: string; scopes: string[]; token: string }>();
  const tokens = new Map<string, string>();
  let pending: { localState: string; callbackUrl: string; brokerState: string } | undefined;
  let oauthStartRequests = 0;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === publisher) {
      if (url.pathname === "/api/plugins/oauth/start") oauthStartRequests++;
      const copy = request.clone();
      const response = await handlePluginCloudRequest(request);
      if (url.pathname === "/api/plugins/oauth/start" && response.ok) {
        const sent = await copy.json() as { localState: string; callbackUrl: string };
        const payload = await response.clone().json() as { url: string };
        pending = { ...sent, brokerState: new URL(payload.url).searchParams.get("state") ?? "" };
      }
      return response;
    }
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      const code = new URLSearchParams(await request.text()).get("code") ?? "";
      const grant = grants.get(code);
      const statePayload = pending ? JSON.parse(Buffer.from(pending.brokerState.split(".")[1] ?? "", "base64url").toString()) as { nonce?: string } : {};
      if (!grant || !googleKey) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const claims = { nonce: statePayload.nonce, iss: "https://accounts.google.com", aud: googleClientId, sub: grant.actor, exp: Math.floor(Date.now() / 1000) + 3600 };
      const signingInput = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      const idToken = `${signingInput}.${createSign("RSA-SHA256").update(signingInput).sign(googleKey.privateKey).toString("base64url")}`;
      return Response.json({ access_token: grant.token, scope: ["openid", "email", ...grant.scopes].join(" "), expires_in: 3600, id_token: idToken });
    }
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
      const actor = tokens.get((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      return actor ? Response.json({ sub: actor, email: `${actor}@example.invalid` }) : new Response(null, { status: 401 });
    }
    return originalFetch(request);
  }, { preconnect: originalFetch.preconnect });
  const h = harness = await startDaemon(home);
  expect((await apiStatus(h, "PUT", "/api/plugins/settings", { cloudUrl: publisher })).status).toBe(204);

  async function state(): Promise<PluginStateDto> {
    const result = await api<PluginStateDto>(h, "GET", "/api/plugins");
    const workspace = path.join(home, ".omarchy-bot", "workspace");
    for (const retired of [".pi", ".codex"]) await expect(lstat(path.join(workspace, retired))).rejects.toMatchObject({ code: "ENOENT" });
    const shared = await readFile(path.join(workspace, ".mcp.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    for (const token of tokens.keys()) {
      expect(JSON.stringify(result)).not.toContain(token);
      expect(shared).not.toContain(token);
    }
    return result;
  }

  async function finishAuthorization(actor: string, scopes = [driveScope, gmailScope], accountId?: string) {
    const code = `fixture-code-${crypto.randomUUID()}`;
    const token = `fixture-access-private-${crypto.randomUUID()}`;
    grants.set(code, { actor, scopes, token });
    tokens.set(token, actor);
    // The publisher captures daemon-generated state; no private daemon state is seeded.
    const transaction = pending as { localState: string; callbackUrl: string; brokerState: string } | undefined;
    if (!transaction) throw new Error("Publisher did not receive an OAuth start request");
    const callback = new URL(transaction.callbackUrl);
    callback.searchParams.set("state", transaction.localState);
    callback.searchParams.set("code", code);
    callback.searchParams.set("brokerState", transaction.brokerState);
    // The fixture delivers the public callback through the local listener.
    const response = await fetch(new URL(`${callback.pathname}${callback.search}`, h.baseUrl));
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(page).not.toContain(token);
    const account = (await state()).accounts.find((entry) => entry.identity === `google:${actor}`);
    if (!account) throw new Error("Public callback did not create the fixture account identity");
    expect(account.status).toBe("connected");
    expect(account.label).toBe(`${actor}@example.invalid`);
    if (accountId) expect(account.id).toBe(accountId);
    return { account, callback, response, page, token };
  }

  async function authorize(actor: string, scopes = [driveScope, gmailScope], accountId?: string): Promise<PluginAccountDto> {
    pending = undefined;
    const authorization = await api<{ url: string }>(h, "POST", "/api/plugins/authorize", {
      providerId: "google", ...(accountId ? { accountId } : {}),
    });
    expect(new URL(authorization.url).origin).toBe("https://accounts.google.com");
    return (await finishAuthorization(actor, scopes, accountId)).account;
  }
  return { h, sources, state, authorize, finishAuthorization, pendingAuthorization: () => pending, oauthStarts: () => oauthStartRequests };
}

async function authorizationEvent(h: Harness, type: string) {
  const socket = new WebSocket(`${h.baseUrl.replace(/^http/, "ws")}/api/events?access_token=${encodeURIComponent(h.token)}`);
  const ready = Promise.withResolvers<void>();
  const event = Promise.withResolvers<EventEnvelope>();
  let live = false;
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello" }));
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data)) as { type: string; envelope?: EventEnvelope };
    if (frame.type === "hello") { live = true; ready.resolve(); }
    if (frame.type === "event" && frame.envelope?.type === type && live) event.resolve(frame.envelope);
  };
  await ready.promise;
  return async () => {
    try { return await event.promise; }
    finally { socket.close(); }
  };
}

async function authorizationHistory(h: Harness): Promise<EventEnvelope[]> {
  const socket = new WebSocket(`${h.baseUrl.replace(/^http/, "ws")}/api/events?access_token=${encodeURIComponent(h.token)}`);
  const events: EventEnvelope[] = [];
  const result = Promise.withResolvers<EventEnvelope[]>();
  socket.onopen = () => socket.send(JSON.stringify({ type: "hello" }));
  socket.onerror = result.reject;
  socket.onmessage = message => {
    const frame = JSON.parse(String(message.data)) as { type: string; envelope?: EventEnvelope };
    if (frame.envelope?.type.startsWith("plugin.authorization_")) events.push(frame.envelope);
    if (frame.type === "hello") { socket.close(); result.resolve(events); }
  };
  return result.promise;
}

async function requestPluginInventory(home: string, checkWhileRunning?: () => Promise<void>): Promise<void> {
  const previousEnvironment = { ...process.env };
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol === "https:" && url.pathname === "/api/plugins/providers") return Response.json([]);
    return originalFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  try {
    const h = await startDaemon(home, { stateDir: path.join(home, "service-state"), seedDurableProvider: false });
    try {
      expect((await apiStatus(h, "GET", "/api/plugins")).status).toBe(200);
      await checkWhileRunning?.();
    } finally {
      await h.stop();
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
  }
}

test("startup and the Services inventory leave the user's Pi home untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarchy-bot-pi-home-"));
  const piDir = path.join(home, ".pi");
  const agentDir = path.join(piDir, "agent");
  const skillsDir = path.join(agentDir, "skills");
  const skillDir = path.join(skillsDir, "user-pi-skill");
  const directories = [piDir, agentDir, skillsDir, skillDir];
  const sentinels = [
    [path.join(agentDir, "auth.json"), '{"openai":{"type":"api_key","key":"fixture-pi-user-key"}}\n', 0o600],
    [path.join(agentDir, "settings.json"), '{"theme":"dark"}\n', 0o640],
    [path.join(skillDir, "SKILL.md"), "---\nname: user-pi-skill\ndescription: User Pi Skill sentinel\n---\n", 0o644],
  ] as const;
  const entries = [...directories, ...sentinels.map(([file]) => file)];
  const readMetadata = () => Promise.all(entries.map(async (entry) => {
    const { mode, atimeNs, mtimeNs } = await lstat(entry, { bigint: true });
    return { entry, mode, atimeNs, mtimeNs };
  }));
  const readContents = async () => ({
    entries: await Promise.all(directories.map(async (directory) => (await readdir(directory)).sort())),
    bytes: await Promise.all(sentinels.map(([file]) => readFile(file))),
  });
  try {
    await mkdir(skillDir, { recursive: true });
    for (const [file, contents, mode] of sentinels) {
      await writeFile(file, contents);
      await chmod(file, mode);
    }
    const contentsBefore = await readContents();
    // Age access times after reading the baseline so a Service read is visible under relatime.
    for (const entry of entries) await utimes(entry, 946684800, 946771200);
    const metadataBefore = await readMetadata();

    await requestPluginInventory(home);

    // Check timestamps before the assertion reads can update access times.
    expect(await readMetadata()).toEqual(metadataBefore);
    expect(await readContents()).toEqual(contentsBefore);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("startup and the Services inventory do not create a Pi directory in a clean HOME", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarchy-bot-no-pi-home-"));
  const expectNoPiDirectory = async () => {
    await expect(lstat(path.join(home, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  };
  try {
    await requestPluginInventory(home, expectNoPiDirectory);
    await expectNoPiDirectory();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a Paired Device authorizes from a remote client origin with a Service callback and app return link", async () => {
  const { h, finishAuthorization, pendingAuthorization } = await startServices();
  expect(h.token).not.toBe("");
  const authorization = await authedFetch(h, `${h.baseUrl}/api/plugins/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://remote.example" },
    body: JSON.stringify({ providerId: "google" }),
  });
  const authorizationBody = await authorization.json() as { url: string };
  expect(authorization.status, JSON.stringify(authorizationBody)).toBe(200);
  expect(new URL(authorizationBody.url).origin).toBe("https://accounts.google.com");
  const transaction = pendingAuthorization();
  if (!transaction) throw new Error("Publisher did not receive an OAuth start request");
  expect(transaction.callbackUrl).toBe(`${h.baseUrl}/api/plugins/oauth/callback`);

  const firstApp = await authorizationEvent(h, "plugin.authorization_completed");
  const secondApp = await authorizationEvent(h, "plugin.authorization_completed");
  const { response, page, token } = await finishAuthorization("fixture-actor-remote");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const returnLink = page.match(/<a href="([^"]+)">Return to Omarchy Bot<\/a>/)?.[1];
  expect(returnLink).toBeDefined();
  expect(returnLink).toBe("omarchy-bot://");
  expect(page).not.toContain(token);
  expect(page).not.toContain(h.token);
  const account = (await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts[0]!;
  for (const receive of [firstApp, secondApp]) {
    const event = await receive();
    expect(event).toMatchObject({ aggregateType: "plugin", aggregateId: account.id, payload: { providerId: "google", accountId: account.id, status: "completed" } });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain(h.token);
  }
}, 40_000);

test.each(["https://evil.example/", "https://remote.example/next"])("OAuth rejects the removed returnUrl field %s before contacting the publisher", async (returnUrl) => {
  const { h, oauthStarts } = await startServices();
  const response = await authedFetch(h, `${h.baseUrl}/api/plugins/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://remote.example" },
    body: JSON.stringify({ providerId: "google", returnUrl }),
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("returnUrl");
  expect(oauthStarts()).toBe(0);
}, 40_000);

test.each(["cancelled", "invalid-code", "wrong-transaction"])("OAuth %s publishes a scoped failure and permits retry", async (failure) => {
  const { h, pendingAuthorization, oauthStarts } = await startServices();
  await api(h, "POST", "/api/plugins/authorize", { providerId: "google" });
  const transaction = pendingAuthorization()!;
  const receive = await authorizationEvent(h, "plugin.authorization_failed");
  const callback = new URL(transaction.callbackUrl);
  callback.searchParams.set("state", transaction.localState);
  callback.searchParams.set("brokerState", failure === "wrong-transaction" ? "wrong" : transaction.brokerState);
  callback.searchParams.set(failure === "cancelled" ? "error" : "code", failure === "cancelled" ? "access_denied" : "invalid-code");
  const response = await fetch(callback);
  expect(response.ok).toBe(false);
  expect(await response.text()).toContain('<a href="omarchy-bot://">Return to Omarchy Bot</a>');
  expect(await receive()).toMatchObject({ aggregateType: "plugin", aggregateId: "google", payload: { providerId: "google", status: "failed", reason: expect.any(String) } });
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts).toEqual([]);
  expect((await apiStatus(h, "POST", "/api/plugins/authorize", { providerId: "google" })).status).toBe(200);
  expect(oauthStarts()).toBe(2);
}, 40_000);

test("an abandoned publisher reconnect expires without a callback and refuses late completion", async () => {
  const { h, authorize, pendingAuthorization } = await startServices();
  const account = await authorize("fixture-expired");
  await api(h, "POST", "/api/plugins/authorize", { providerId: "google", accountId: account.id });
  const transaction = pendingAuthorization()!;
  const receive = await authorizationEvent(h, "plugin.authorization_failed");
  const callback = new URL(transaction.callbackUrl);
  callback.searchParams.set("state", transaction.localState);
  let response: Response;
  setSystemTime(Date.now() + 16 * 60_000);
  try {
    expect(await receive()).toMatchObject({ aggregateType: "plugin", aggregateId: account.id, payload: { providerId: "google", accountId: account.id, status: "failed", reason: "expired" } });
    response = await fetch(callback);
  } finally { setSystemTime(); }
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("expired");
  expect((await fetch(callback)).status).toBe(400);
  expect((await apiStatus(h, "POST", "/api/plugins/authorize", { providerId: "google", accountId: account.id })).status).toBe(200);
}, 10_000);

const mcpAuthorizePath = (id: string) => `/api/plugins/mcp/${id}/authorize`;
const intercomAuthorization = { providerId: "intercom", serviceId: "intercom" };

function botRuntime(h: Harness): BotRuntime {
  return (h.svc.turns as unknown as { runtime: BotRuntime }).runtime;
}

async function addConsentConnection(h: Harness, url: string) {
  return api<{ id: string }>(h, "POST", "/api/plugins/mcp", { name: "custom-consent", enabled: true, transport: { type: "http", url } });
}

async function startConsent(h: Harness, connection?: { id: string }, accountId?: string): Promise<string> {
  const authorization = await apiStatus(h, "POST", connection ? mcpAuthorizePath(connection.id) : "/api/plugins/authorize",
    connection ? {} : { ...intercomAuthorization, ...(accountId ? { accountId } : {}) });
  expect(authorization.status).toBe(200);
  const { authorizationUrl, url } = authorization.body as { authorizationUrl?: string; url?: string };
  const browserUrl = connection ? authorizationUrl : url;
  expect(browserUrl).toEqual(expect.any(String));
  return browserUrl!;
}

async function consentRedirect(browserUrl: string): Promise<URL> {
  const consent = await fetch(browserUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  return new URL(consent.headers.get("location")!);
}

async function intercomAccount(h: Harness) {
  return (await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts.find(entry => entry.providerId === "intercom");
}

test.each(["provider", "standalone"])("native %s consent completes over the event stream without checking by hand", async (kind) => {
  const fixture = await startOAuthMcpServer();
  try {
    const { h } = await startServices({ intercomMcpUrl: fixture.url });
    const connection = kind === "standalone" ? await addConsentConnection(h, fixture.url) : undefined;
    const receive = await authorizationEvent(h, "plugin.authorization_completed");
    const browserUrl = await startConsent(h, connection);
    expect((await fetch(browserUrl, { redirect: "follow" })).status).toBe(200);
    const event = await receive();
    const state = await api<PluginStateDto>(h, "GET", "/api/plugins");
    const account = state.accounts.find(entry => entry.providerId === "intercom");
    expect(event).toMatchObject({ aggregateId: account?.id ?? connection!.id, payload: { mcpId: account?.nativeConnectionId ?? connection!.id, status: "completed", ...(account ? { providerId: "intercom", accountId: account.id } : {}) } });
    expect(account?.status ?? state.mcp.find(entry => entry.id === connection!.id)?.status).toBe("connected");
  } finally {
    await fixture.close();
  }
}, 10_000);

test.each(["provider", "standalone"])("native %s failure and abandoned consent each publish one outcome and allow retry", async (kind) => {
  const fixture = await startOAuthMcpServer();
  try {
    const { h } = await startServices({ intercomMcpUrl: fixture.url });
    const connection = kind === "standalone" ? await addConsentConnection(h, fixture.url) : undefined;
    const failed = await authorizationEvent(h, "plugin.authorization_failed");
    const denied = await consentRedirect(await startConsent(h, connection));
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    expect((await fetch(denied)).status).toBe(400);
    const account = await intercomAccount(h);
    const id = connection?.id ?? account!.nativeConnectionId!;
    expect(await failed()).toMatchObject({ aggregateId: account?.id ?? id, payload: { mcpId: id, status: "failed", reason: "auth_failed", ...(account ? { providerId: "intercom", accountId: account.id } : {}) } });

    const control = spyOn(botRuntime(h), "mcpControl");
    try {
      const expired = await authorizationEvent(h, "plugin.authorization_failed");
      const late = await consentRedirect(await startConsent(h, { id }));
      const expiredAttempt = control.mock.calls.findLast(([input]) => input.action === "auth-start")![0];
      expect(expiredAttempt).toMatchObject({ server: expect.any(String), authorizationId: expect.any(String) });
      setSystemTime(Date.now() + 16 * 60_000);
      try { expect(await expired()).toMatchObject({ payload: { mcpId: id, status: "failed", reason: "expired" } }); }
      finally { setSystemTime(); }
      expect((await apiStatus(h, "POST", mcpAuthorizePath(id), { redirectUrl: late.href })).status).toBe(400);

      const retry = await consentRedirect(await startConsent(h, { id }));
      const retryAttempt = control.mock.calls.findLast(([input]) => input.action === "auth-start")![0];
      expect(retryAttempt).toMatchObject({ server: expiredAttempt.server, authorizationId: expect.any(String) });
      expect(retryAttempt.authorizationId).not.toBe(expiredAttempt.authorizationId);
      expect(await fetch(late).then(response => response.ok, () => false)).toBe(false);
      expect(fixture.counts.token).toBe(0);

      const beforeStale = await authorizationHistory(h);
      const callsBeforeStale = control.mock.calls.length;
      h.svc.plugins.handleNativeAuthorization({ server: expiredAttempt.server, authorizationId: expiredAttempt.authorizationId, status: "completed" });
      expect(control).toHaveBeenCalledTimes(callsBeforeStale);
      expect(await authorizationHistory(h)).toEqual(beforeStale);
      const retried = await api<PluginStateDto>(h, "GET", "/api/plugins");
      if (account) expect(retried.accounts.find(entry => entry.id === account.id)?.status).toBe("reauthorize");
      else expect(retried.mcp.find(entry => entry.id === id)?.status).toBe("not-connected");

      const completed = await authorizationEvent(h, "plugin.authorization_completed");
      expect(await apiStatus(h, "POST", mcpAuthorizePath(id), { redirectUrl: retry.href })).toEqual({ status: 200, body: { authenticated: true } });
      expect(await completed()).toMatchObject({ payload: { mcpId: id, status: "completed" } });
      expect(fixture.counts.token).toBe(1);
      expect((await authorizationHistory(h)).map(event => event.type)).toEqual([
        "plugin.authorization_failed", "plugin.authorization_failed", "plugin.authorization_completed",
      ]);
    } finally { control.mockRestore(); }
  } finally {
    await fixture.close();
  }
}, 15_000);

test("native MCP callbacks report completion and cancellation, and expiry refuses browser and manual callbacks", async () => {
  const tokenExchange = () => ({ started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() });
  let exchange: ReturnType<typeof tokenExchange> | undefined;
  const fixture = await startOAuthMcpServer({ async beforeTokenResponse() {
    exchange?.started.resolve();
    await exchange?.release.promise;
  } });
  let unrelatedConnections = 0;
  const unrelated = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    unrelatedConnections++;
    return new Response(null, { status: 503 });
  } });
  try {
    const { h } = await startServices({ intercomMcpUrl: fixture.url });
    const standalone = await addConsentConnection(h, fixture.url);
    await api(h, "POST", "/api/plugins/mcp", { name: "unrelated", enabled: true, transport: { type: "http", url: unrelated.url.href } });
    const keptSkill = path.join(h.svc.cfg.sharedWorkspaceDir, ".agents/skills/kept");
    await companion(keptSkill, "kept", 1);
    const beforeConsent = await api<PluginStateDto>(h, "GET", "/api/plugins");
    const skill = beforeConsent.skills.find(({ name }) => name === "kept");
    expect(skill).toMatchObject({ name: "kept", enabled: true });
    for (const kind of ["standalone", "provider"]) {
      const connection = kind === "standalone" ? standalone : undefined;
      const failed = await authorizationEvent(h, "plugin.authorization_failed");
      const cancelled = await consentRedirect(await startConsent(h, connection));
      cancelled.searchParams.delete("code");
      cancelled.searchParams.set("error", "access_denied");
      const cancelledResponse = await fetch(cancelled);
      expect(cancelledResponse.status).toBe(400);
      expect(await cancelledResponse.text()).toContain("Sign-in did not complete.");
      expect(await failed()).toMatchObject({ payload: { status: "failed", reason: "auth_failed" } });
      const account = await intercomAccount(h);
      expect(unrelatedConnections).toBe(0);
      const id = connection?.id ?? account!.nativeConnectionId!;
      for (const redirectUrl of ["http://localhost/callback?code=bad", "http://localhost/callback?code=bad&state=wrong"]) {
        const beforeManual = (await authorizationHistory(h)).length;
        const manualFailed = await authorizationEvent(h, "plugin.authorization_failed");
        const invalid = await consentRedirect(await startConsent(h, connection, account?.id));
        const beforeInvalid = fixture.counts.token;
        expect((await api<{ error?: string }>(h, "POST", mcpAuthorizePath(id), { redirectUrl })).error).toBe("auth_failed");
        expect(await manualFailed()).toMatchObject({ payload: { status: "failed", reason: "auth_failed" } });
        expect(await fetch(invalid).then(response => response.ok, () => false)).toBe(false);
        expect(fixture.counts.token).toBe(beforeInvalid);
        expect((await authorizationHistory(h)).slice(beforeManual).map(event => event.type)).toEqual(["plugin.authorization_failed"]);
      }

      const timedOut = await authorizationEvent(h, "plugin.authorization_failed");
      const runtime = botRuntime(h);
      const control = runtime.mcpControl.bind(runtime);
      const consentClock = spyOn(runtime, "mcpControl").mockImplementation((input) =>
        control(input.action === "auth-start" ? { ...input, expiresAt: Date.now() + 1_000 } : input));
      try {
        await startConsent(h, connection, account?.id);
        expect(await timedOut()).toMatchObject({ payload: { status: "failed", reason: "expired" } });
      } finally { consentClock.mockRestore(); }

      const expired = await authorizationEvent(h, "plugin.authorization_failed");
      const late = await consentRedirect(await startConsent(h, connection, account?.id));
      setSystemTime(Date.now() + 16 * 60_000);
      try { expect(await expired()).toMatchObject({ payload: { status: "failed", reason: "expired" } }); }
      finally { setSystemTime(); }
      const beforeLate = fixture.counts.token;
      expect(await fetch(late).then(response => response.ok, () => false)).toBe(false);
      expect(fixture.counts.token).toBe(beforeLate);
      expect((await apiStatus(h, "POST", mcpAuthorizePath(id), { redirectUrl: late.href })).status).toBe(400);

      const completed = await authorizationEvent(h, "plugin.authorization_completed");
      const beforeSuccess = (await authorizationHistory(h)).length;
      exchange = tokenExchange();
      const success = await consentRedirect(await startConsent(h, connection, account?.id));
      expect((await api<{ status: string }>(h, "POST", `/api/plugins/mcp/${id}/check`, {})).status).toBe("needs-auth");
      expect((await fetch(success)).status).toBe(200);
      await exchange.started.promise;
      const enteredManualCompletion = Promise.withResolvers<void>();
      const manualControl = spyOn(runtime, "mcpControl").mockImplementation((input) => {
        const result = control(input);
        if (input.action === "auth-complete") enteredManualCompletion.resolve();
        return result;
      });
      try {
        const manual = apiStatus(h, "POST", mcpAuthorizePath(id), { redirectUrl: success.href });
        await enteredManualCompletion.promise;
        exchange.release.resolve();
        expect(await manual).toEqual({ status: 200, body: { authenticated: true } });
      } finally {
        manualControl.mockRestore();
      }
      expect(await completed()).toMatchObject({ payload: { status: "completed", mcpId: id } });
      expect(fixture.counts.token).toBe(beforeLate + 1);
      expect((await authorizationHistory(h)).slice(beforeSuccess).map(event => event.type)).toEqual(["plugin.authorization_completed"]);
    }
    expect(unrelatedConnections).toBe(0);
    const afterConsent = await api<PluginStateDto>(h, "GET", "/api/plugins");
    expect(afterConsent.skills.find(({ name }) => name === "kept")).toEqual(skill);
  } finally {
    exchange?.release.resolve();
    await Promise.all([fixture.close(), unrelated.stop(true)]);
  }
}, 40_000);

test.each(["authenticated", "pending", "error"])("native authorization without a browser URL preserves %s state and retry", async (outcome) => {
  const fixture = await startOAuthMcpServer();
  try {
    const { h } = await startServices({ intercomMcpUrl: fixture.url });
    if (outcome === "authenticated") {
      const completed = await authorizationEvent(h, "plugin.authorization_completed");
      expect((await fetch(await startConsent(h))).status).toBe(200);
      await completed();
    }
    const existingAccount = await intercomAccount(h);
    const runtime = botRuntime(h);
    const control = runtime.mcpControl.bind(runtime);
    // Exercise the plugin service's handling of browserless responses at the runtime control boundary.
    let delegatedAuthStart: ReturnType<BotRuntime["mcpControl"]> | undefined;
    const browserless = spyOn(runtime, "mcpControl").mockImplementation((input) => {
      if (input.action !== "auth-start") return control(input);
      if (outcome === "authenticated") {
        delegatedAuthStart = control(input);
        return delegatedAuthStart;
      }
      return Promise.resolve({ servers: runtime.mcpStatus(), result: outcome === "error" ? { error: "Provider consent failed" } : { authenticated: false } });
    });
    try {
      const response = await apiStatus(h, "POST", "/api/plugins/authorize", { ...intercomAuthorization, ...(existingAccount ? { accountId: existingAccount.id } : {}) });
      expect(response.status).toBe(outcome === "error" ? 502 : 200);
      if (outcome !== "error") expect(response.body).toEqual({});
      if (outcome === "authenticated") expect(await delegatedAuthStart).toMatchObject({ result: { authenticated: true } });
    } finally { browserless.mockRestore(); }
    const account = (await intercomAccount(h))!;
    expect(account.status).toBe(outcome === "authenticated" ? "connected" : "reauthorize");
    if (outcome === "error") expect(account.error).toContain("Provider consent failed");
    const retry = await apiStatus(h, "POST", "/api/plugins/authorize", { ...intercomAuthorization, accountId: account.id });
    expect(retry.status).toBe(200);
    if (outcome !== "authenticated") {
      const completed = await authorizationEvent(h, "plugin.authorization_completed");
      expect((await fetch((retry.body as { url: string }).url)).status).toBe(200);
      await completed();
    }
    const retried = await api<PluginStateDto>(h, "GET", "/api/plugins");
    expect(retried.accounts.find(entry => entry.id === account.id)?.status).toBe("connected");
  } finally {
    await fixture.close();
  }
}, 40_000);

async function usable(h: Harness, state: PluginStateDto, name: string, result: number): Promise<InstalledSkillDto> {
  const skill = state.skills.find((entry) => entry.name === name);
  if (!skill?.path) throw new Error(`Missing installed helper ${name}`);
  expect(skill.enabled).toBe(true);
  expect((await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands")).some((entry) => entry.command === `/skill:${name}`)).toBe(true);
  const child = Bun.spawn([process.execPath, path.join(path.dirname(skill.path), "scripts", "calculate.js"), JSON.stringify({ amount: 10 })], {
    cwd: path.dirname(skill.path), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ result });
  return skill;
}

async function absent(h: Harness, state: PluginStateDto, skills: InstalledSkillDto[]): Promise<void> {
  const commands = await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands");
  for (const skill of skills) {
    expect(state.skills.some((entry) => entry.id === skill.id)).toBe(false);
    expect(commands.some((entry) => entry.command === `/skill:${skill.name}`)).toBe(false);
    await expect(lstat(skill.path!)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function serviceRoute(account: PluginAccountDto, serviceId: string): string {
  return `/api/plugins/accounts/${encodeURIComponent(account.id)}/services/${serviceId}`;
}

test("removing Services respects shared account ownership and Disconnect preserves independent Skills", async () => {
  const fixture = await startServices();
  const { h, sources, state, authorize } = fixture;
  const first = await authorize("fixture-actor-first");
  const second = await authorize("fixture-actor-second");
  await api<InstalledSkillDto>(h, "POST", "/api/plugins/skills", { source: sources.independent });
  const initial = await state();
  const drive = [await usable(h, initial, "fixture-drive-read", 11), await usable(h, initial, "fixture-drive-write", 12)];
  const gmail = await usable(h, initial, "fixture-gmail", 13);

  expect((await apiStatus(h, "DELETE", serviceRoute(first, "google-drive"))).status).toBe(204);
  let current = await state();
  expect(current.accounts.find((entry) => entry.id === first.id)?.enabledServices).toEqual(["gmail"]);
  expect(current.accounts.find((entry) => entry.id === second.id)?.enabledServices).toContain("google-drive");
  await usable(h, current, "fixture-drive-read", 11);
  await usable(h, current, "fixture-drive-write", 12);

  expect((await apiStatus(h, "DELETE", serviceRoute(second, "google-drive"))).status).toBe(204);
  current = await state();
  await absent(h, current, drive);
  for (const account of [first, second]) {
    expect(current.accounts.find((entry) => entry.id === account.id)).toMatchObject({ identity: account.identity, status: "connected", enabledServices: ["gmail"] });
  }
  await usable(h, current, "fixture-gmail", 13);
  await usable(h, current, "fixture-independent", 14);

  expect((await apiStatus(h, "DELETE", `/api/plugins/accounts/${first.id}`)).status).toBe(204);
  current = await state();
  expect(current.accounts.map((entry) => entry.identity)).toEqual([second.identity]);
  await usable(h, current, "fixture-gmail", 13);
  expect((await apiStatus(h, "DELETE", `/api/plugins/accounts/${second.id}`)).status).toBe(204);
  current = await state();
  expect(current.accounts).toEqual([]);
  await absent(h, current, [gmail]);
  await usable(h, current, "fixture-independent", 14);
}, 40_000);

test("Service updates stage every companion before replacing any usable installed version", async () => {
  const { h, sources, state, authorize } = await startServices();
  const account = await authorize("fixture-actor-update");
  await usable(h, await state(), "fixture-drive-read", 11);
  await usable(h, await state(), "fixture-drive-write", 12);
  await companion(sources.driveRead, "fixture-drive-read", 101);
  await companion(sources.driveWrite, "fixture-drive-write", 202);
  await writeFile(path.join(sources.driveWrite, "SKILL.md"), "---\nname: [unterminated\n");
  const route = `${serviceRoute(account, "google-drive")}/update`;
  expect((await apiStatus(h, "POST", route, {})).status).toBe(502);
  let current = await state();
  await usable(h, current, "fixture-drive-read", 11);
  await usable(h, current, "fixture-drive-write", 12);
  await usable(h, current, "fixture-gmail", 13);
  expect(current.accounts.find((entry) => entry.id === account.id)?.identity).toBe(account.identity);

  await companion(sources.driveWrite, "fixture-drive-write", 202);
  expect((await apiStatus(h, "POST", route, {})).status).toBe(204);
  current = await state();
  await usable(h, current, "fixture-drive-read", 111);
  await usable(h, current, "fixture-drive-write", 212);
  await usable(h, current, "fixture-gmail", 13);
}, 40_000);

test("reduced-scope reauthorization keeps identity and authorized Services but withdraws dropped-scope components", async () => {
  const { h, state, authorize } = await startServices();
  const account = await authorize("fixture-actor-reduced");
  const before = await state();
  await usable(h, before, "fixture-drive-read", 11);
  await usable(h, before, "fixture-drive-write", 12);
  await usable(h, before, "fixture-gmail", 13);
  await authorize("fixture-actor-reduced", [gmailScope], account.id);
  const current = await state();
  expect(current.accounts).toHaveLength(1);
  const retained = current.accounts[0]!;
  expect(retained).toMatchObject({ id: account.id, identity: account.identity, status: "connected", enabledServices: ["gmail"] });
  const driveComponent = retained.components?.find((entry) => entry.serviceId === "google-drive");
  if (driveComponent) expect(["disabled", "not-connected"]).toContain(driveComponent.status);
  const previousMcpId = before.accounts[0]?.components?.find((entry) => entry.serviceId === "google-drive")?.mcpId;
  if (!previousMcpId) throw new Error("Authorized Drive did not expose its component");
  const driveMcp = current.mcp.find((entry) => entry.id === previousMcpId);
  if (driveMcp) expect(driveMcp.enabled).toBe(false);
  const commands = await api<SkillCommandDto[]>(h, "GET", "/api/plugins/commands");
  for (const name of ["fixture-drive-read", "fixture-drive-write"]) {
    expect(current.skills.find((entry) => entry.name === name)?.enabled ?? false).toBe(false);
    expect(commands.some((entry) => entry.command === `/skill:${name}`)).toBe(false);
  }
  expect((await apiStatus(h, "PATCH", `/api/plugins/accounts/${account.id}/services`, { serviceId: "google-drive", enabled: true })).status).toBe(409);
  await usable(h, await state(), "fixture-gmail", 13);
}, 40_000);
