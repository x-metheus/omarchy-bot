import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLUGIN_PROVIDERS } from "../../packages/protocol/src/pluginProviders.ts";
import type { InstalledSkillDto, PluginAccountDto, PluginStateDto, SkillCommandDto } from "../../packages/protocol/src/plugins.ts";
import type { EventEnvelope } from "../../packages/protocol/src/events.ts";
import { handlePluginCloudRequest } from "../../apps/site/server/plugins.ts";
import { api, apiStatus, authedFetch, startDaemon, type Harness } from "./helpers/harness.ts";

const publisher = "https://service-publisher.invalid";
const driveScope = "https://www.googleapis.com/auth/drive.readonly";
const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const originalFetch = globalThis.fetch;
const originalServices = PLUGIN_PROVIDERS.google.services;
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

async function startServices() {
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
    const shared = await Promise.all([".mcp.json", ".pi/mcp.json", ".codex/config.toml"].map(async (file) => {
      try { return await readFile(path.join(workspace, file), "utf8"); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; }
    }));
    for (const token of tokens.keys()) {
      expect(JSON.stringify(result)).not.toContain(token);
      for (const configuration of shared) expect(configuration).not.toContain(token);
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

test.each(["provider", "standalone"])("native %s consent completes over the event stream without checking by hand", async (kind) => {
  const { h } = await startServices();
  await writeFile(path.join(h.home, "conformance", "pi-fake-pi-1.json"), JSON.stringify({ ok: true, image: "verified", fakeMcpAuthorization: { authorizationUrl: "https://native.example/consent", notify: "completed" } }));
  const connection = kind === "standalone" ? await api<{ id: string }>(h, "POST", "/api/plugins/mcp", { name: "custom-consent", enabled: true, transport: { type: "http", url: "https://native.example/mcp" } }) : undefined;
  const receive = await authorizationEvent(h, "plugin.authorization_completed");
  expect((await apiStatus(h, "POST", connection ? `/api/plugins/mcp/${connection.id}/authorize` : "/api/plugins/authorize", connection ? {} : { providerId: "intercom", serviceId: "intercom" })).status).toBe(200);
  const event = await receive();
  const state = await api<PluginStateDto>(h, "GET", "/api/plugins");
  const account = state.accounts.find(entry => entry.providerId === "intercom");
  expect(event).toMatchObject({ aggregateId: account?.id ?? connection!.id, payload: { mcpId: account?.nativeConnectionId ?? connection!.id, status: "completed", ...(account ? { providerId: "intercom", accountId: account.id } : {}) } });
  expect(account?.status ?? state.mcp.find(entry => entry.id === connection!.id)?.status).toBe("connected");
}, 10_000);

test.each(["provider", "standalone"])("native %s failure and abandoned consent expire with one outcome and allow retry", async (kind) => {
  const { h } = await startServices();
  const control = path.join(h.home, "conformance", "pi-fake-pi-1.json");
  const configure = (authorization: Record<string, unknown>) => writeFile(control, JSON.stringify({ ok: true, image: "verified", fakeMcpAuthorization: authorization }));
  const connection = kind === "standalone" ? await api<{ id: string }>(h, "POST", "/api/plugins/mcp", { name: "custom-consent", enabled: true, transport: { type: "http", url: "https://native.example/mcp" } }) : undefined;
  await configure({ authorizationUrl: "https://native.example/consent", notify: "failed" });
  const failed = await authorizationEvent(h, "plugin.authorization_failed");
  await api(h, "POST", connection ? `/api/plugins/mcp/${connection.id}/authorize` : "/api/plugins/authorize", connection ? {} : { providerId: "intercom", serviceId: "intercom" });
  const account = (await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts.find(entry => entry.providerId === "intercom");
  const id = connection?.id ?? account!.nativeConnectionId!;
  expect(await failed()).toMatchObject({ aggregateId: account?.id ?? id, payload: { mcpId: id, status: "failed", reason: "auth_failed", ...(account ? { providerId: "intercom", accountId: account.id } : {}) } });
  await configure({ authorizationUrl: "https://native.example/consent" });
  const expired = await authorizationEvent(h, "plugin.authorization_failed");
  await api(h, "POST", `/api/plugins/mcp/${id}/authorize`, {});
  setSystemTime(Date.now() + 16 * 60_000);
  try { expect(await expired()).toMatchObject({ payload: { mcpId: id, status: "failed", reason: "expired" } }); }
  finally { setSystemTime(); }
  expect((await apiStatus(h, "POST", `/api/plugins/mcp/${id}/authorize`, { redirectUrl: "https://native.example/callback?code=late" })).status).toBe(400);
  // A late old attempt must not finish a new consent attempt.
  await configure({ authorizationUrl: "https://native.example/retry", staleNotify: true });
  expect((await apiStatus(h, "POST", `/api/plugins/mcp/${id}/authorize`, {})).status).toBe(200);
  const retried = await api<PluginStateDto>(h, "GET", "/api/plugins");
  expect(retried.accounts.find(entry => entry.id === account?.id)?.status ?? retried.mcp.find(entry => entry.id === id)?.status).not.toBe("connected");
  await configure({ authenticated: true });
  const completed = await authorizationEvent(h, "plugin.authorization_completed");
  expect((await apiStatus(h, "POST", `/api/plugins/mcp/${id}/authorize`, { redirectUrl: "https://native.example/callback?code=retry" })).status).toBe(200);
  expect(await completed()).toMatchObject({ payload: { mcpId: id, status: "completed" } });
}, 15_000);

test("real native MCP callbacks report completion and cancellation, and expiry refuses browser and manual callbacks", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-oauth-service-"));
  const workerDir = path.join(home, "workers/pi/src");
  await mkdir(workerDir, { recursive: true });
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(path.join(workerDir, "worker.ts"), `
import os from "node:os";
import { mock, setSystemTime } from "bun:test";
import { writeFileSync } from "node:fs";
const home = process.env.HOME!;
const userInfo = os.userInfo;
const privateUserInfo = () => ({ ...userInfo(), homedir: home });
mock.module("node:os", () => ({ ...os, userInfo: privateUserInfo, default: { ...os, userInfo: privateUserInfo } }));
process.env.PATH = home + "/bin:" + process.env.PATH;
process.env.PI_CODING_AGENT_DIR = home + "/.pi/agent";
process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = home + "/oauth.json";
const stdoutWrite = process.stdout.write.bind(process.stdout);
let holdStatus = false;
const heldStatus = [];
let observedStatus = Promise.withResolvers();
process.stdout.write = (chunk, ...args) => {
  if (holdStatus && String(chunk).includes('"capability":"mcp.authorization"') && String(chunk).includes('"status":"completed"')) { heldStatus.push(chunk); observedStatus.resolve(); return true; }
  return stdoutWrite(chunk, ...args);
};
// Advance only adapter consent timeouts; worker heartbeat and HTTP keep real time.
const originalTimeout = globalThis.setTimeout;
const consentTimers = new Map();
globalThis.setTimeout = (callback, delay, ...args) => {
  const timer = originalTimeout(callback, delay, ...args);
  if (delay === 5 * 60_000) consentTimers.set(timer, () => callback(...args));
  return timer;
};
const clock = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const value = await request.json();
  if (value?.holdStatus) { holdStatus = true; observedStatus = Promise.withResolvers(); }
  else if (value?.releaseStatus) { holdStatus = false; for (const chunk of heldStatus.splice(0)) stdoutWrite(chunk); }
  else if (value?.waitStatus) {
    const deadline = Promise.withResolvers();
    const timeout = originalTimeout(() => deadline.reject(new Error("Native completion status was not emitted")), 5000);
    try { await Promise.race([observedStatus.promise, deadline.promise]); }
    finally { clearTimeout(timeout); }
  }
  else if (value && typeof value === "object") {
    for (const [timer, callback] of consentTimers) { clearTimeout(timer); callback(); }
    consentTimers.clear();
  } else setSystemTime(value);
  return new Response("ok");
} });
writeFileSync(home + "/clock-port", String(clock.port));
// Load the real worker only after installing process-private keychain and clock boundaries.
await import(${JSON.stringify(path.resolve("workers/pi/src/worker.ts"))});
`);
  const originalIntercom = PLUGIN_PROVIDERS.intercom.services;
  let exchanges = 0;
  let unrelatedConnections = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/unrelated") { unrelatedConnections++; return new Response(null, { status: 503 }); }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: url.origin, authorization_endpoint: `${url.origin}/authorize`, token_endpoint: `${url.origin}/token`, registration_endpoint: `${url.origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    if (url.pathname === "/register") return Response.json({ ...await request.json(), client_id: "native-fixture", token_endpoint_auth_method: "none" }, { status: 201 });
    if (url.pathname === "/token") { exchanges++; return Response.json({ access_token: "native-fixture-token", token_type: "Bearer", expires_in: 3600 }); }
    if (request.headers.get("authorization") !== "Bearer native-fixture-token") return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"` } });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const rpc = await request.json() as { id?: number; method: string };
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "consent", version: "1" } } : { tools: [] } });
  } });
  try {
    PLUGIN_PROVIDERS.intercom.services = originalIntercom.map(service => ({ ...service, mcpUrl: `http://127.0.0.1:${provider.port}/mcp` }));
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).origin === "https://native-catalog.invalid") return Response.json([]);
      return originalFetch(input, init);
    }, { preconnect: originalFetch.preconnect });
    const h = harness = await startDaemon(home, { workersDir: path.join(home, "workers"), waitForAgentReady: false });
    await apiStatus(h, "PUT", "/api/plugins/settings", { cloudUrl: "https://native-catalog.invalid" });
    const connection = await api<{ id: string }>(h, "POST", "/api/plugins/mcp", { name: "real-consent", enabled: true, transport: { type: "http", url: `http://127.0.0.1:${provider.port}/mcp` } });
    const plugin = path.join(home, "unrelated-plugin");
    await mkdir(path.join(plugin, "skills/kept"), { recursive: true });
    await writeFile(path.join(plugin, "skills/kept/SKILL.md"), "---\nname: kept\ndescription: Preserve plugin Skill discovery\n---\nKeep this skill.\n");
    await writeFile(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { unrelated: { url: `http://127.0.0.1:${provider.port}/unrelated`, lifecycle: "eager" } } }));
    await mkdir(path.join(home, ".omarchy-bot/workspace/.pi"), { recursive: true });
    await writeFile(path.join(home, ".omarchy-bot/workspace/.pi/mcp.json"), JSON.stringify({ claudePlugins: [{ path: plugin, mcp: true, skills: true }] }));
    for (const kind of ["standalone", "provider"]) {
      const start = async (accountId?: string) => {
        const response = await api<{ authorizationUrl?: string; url?: string }>(h, "POST", kind === "standalone" ? `/api/plugins/mcp/${connection.id}/authorize` : "/api/plugins/authorize", kind === "standalone" ? {} : { providerId: "intercom", serviceId: "intercom", ...(accountId ? { accountId } : {}) });
        const url = new URL(response.authorizationUrl ?? response.url!);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        return callback;
      };
      const failed = await authorizationEvent(h, "plugin.authorization_failed");
      const cancelled = await start();
      cancelled.searchParams.set("error", "access_denied");
      expect(await (await fetch(cancelled)).text()).toContain("access_denied");
      expect(await failed()).toMatchObject({ payload: { status: "failed", reason: "auth_failed" } });
      const account = (await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts.find(entry => entry.providerId === "intercom");
      expect(unrelatedConnections).toBe(0);
      const id = kind === "standalone" ? connection.id : account!.nativeConnectionId!;
      for (const redirectUrl of ["http://localhost/callback?code=bad", "http://localhost/callback?code=bad&state=wrong"]) {
        const beforeManual = (await authorizationHistory(h)).length;
        const manualFailed = await authorizationEvent(h, "plugin.authorization_failed");
        const invalid = await start(account?.id);
        const beforeInvalid = exchanges;
        expect((await api<{ error?: string }>(h, "POST", `/api/plugins/mcp/${id}/authorize`, { redirectUrl })).error).toBe("auth_complete_failed");
        expect(await manualFailed()).toMatchObject({ payload: { status: "failed", reason: "auth_complete_failed" } });
        invalid.searchParams.set("code", "must-not-exchange");
        expect(await fetch(invalid).then(response => response.status !== 200, () => true)).toBe(true);
        expect(exchanges).toBe(beforeInvalid);
        expect((await authorizationHistory(h)).slice(beforeManual).map(event => event.type)).toEqual(["plugin.authorization_failed"]);
      }
      const clock = `http://127.0.0.1:${await readFile(path.join(home, "clock-port"), "utf8")}`;
      const timedOut = await authorizationEvent(h, "plugin.authorization_failed");
      await start(account?.id);
      expect((await fetch(clock, { method: "POST", body: JSON.stringify({ advance: 5 * 60_000 + 1000 }) })).ok).toBe(true);
      try { expect(await timedOut()).toMatchObject({ payload: { status: "failed", reason: "expired" } }); }
      finally { await fetch(clock, { method: "POST", body: "null" }); }
      const expired = await authorizationEvent(h, "plugin.authorization_failed");
      const late = await start(account?.id);
      const future = Date.now() + 16 * 60_000;
      expect((await fetch(clock, { method: "POST", body: JSON.stringify(future) })).ok).toBe(true);
      setSystemTime(future);
      try { expect(await expired()).toMatchObject({ payload: { status: "failed", reason: "expired" } }); }
      finally { setSystemTime(); await fetch(clock, { method: "POST", body: "null" }); }
      const beforeLate = exchanges;
      late.searchParams.set("code", "late-code");
      expect(await fetch(late).then(response => response.status !== 200, () => true)).toBe(true);
      expect(exchanges).toBe(beforeLate);
      expect((await apiStatus(h, "POST", `/api/plugins/mcp/${kind === "standalone" ? connection.id : account!.nativeConnectionId}/authorize`, { redirectUrl: late.href })).status).toBe(400);
      const completed = await authorizationEvent(h, "plugin.authorization_completed");
      const beforeSuccess = (await authorizationHistory(h)).length;
      expect((await fetch(clock, { method: "POST", body: JSON.stringify({ holdStatus: true }) })).ok).toBe(true);
      const success = await start(account?.id);
      expect((await api<{ status: string }>(h, "POST", `/api/plugins/mcp/${id}/check`, {})).status).toBe("needs-auth");
      success.searchParams.set("code", "valid-code");
      expect((await fetch(success)).status).toBe(200);
      expect((await fetch(clock, { method: "POST", body: JSON.stringify({ waitStatus: true }) })).ok).toBe(true);
      expect((await api<{ authenticated?: boolean; error?: string }>(h, "POST", `/api/plugins/mcp/${id}/authorize`, { redirectUrl: success.href })).error).toBeUndefined();
      await fetch(clock, { method: "POST", body: JSON.stringify({ releaseStatus: true }) });
      expect(await completed()).toMatchObject({ payload: { status: "completed", mcpId: kind === "standalone" ? connection.id : account!.nativeConnectionId } });
      expect(exchanges).toBe(beforeLate + 1);
      expect((await authorizationHistory(h)).slice(beforeSuccess).map(event => event.type)).toEqual(["plugin.authorization_completed"]);
    }
  } finally {
    PLUGIN_PROVIDERS.intercom.services = originalIntercom;
    await provider.stop(true);
  }
}, 90_000);

test.each(["authenticated", "pending", "error"])("native authorization without a browser URL preserves %s state and retry", async (outcome) => {
  const { h } = await startServices();
  const control = path.join(h.home, "conformance", "pi-fake-pi-1.json");
  await writeFile(control, JSON.stringify({ ok: true, image: "verified", fakeMcpAuthorization: outcome === "error" ? { error: "Provider consent failed" } : { authenticated: outcome === "authenticated" } }));
  const response = await apiStatus(h, "POST", "/api/plugins/authorize", { providerId: "intercom", serviceId: "intercom" });
  expect(response.status).toBe(outcome === "error" ? 502 : 200);
  if (outcome !== "error") expect(response.body).toEqual({});
  const account = (await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts.find(entry => entry.providerId === "intercom")!;
  expect(account.status).toBe(outcome === "authenticated" ? "connected" : "reauthorize");
  if (outcome === "error") expect(account.error).toContain("Provider consent failed");
  await writeFile(control, JSON.stringify({ ok: true, image: "verified", fakeMcpAuthorization: { authenticated: true } }));
  expect((await apiStatus(h, "POST", "/api/plugins/authorize", { providerId: "intercom", accountId: account.id, serviceId: "intercom" })).status).toBe(200);
  expect((await api<PluginStateDto>(h, "GET", "/api/plugins")).accounts.find(entry => entry.id === account.id)?.status).toBe("connected");
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
