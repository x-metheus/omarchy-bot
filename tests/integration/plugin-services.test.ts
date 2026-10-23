import { afterEach, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLUGIN_PROVIDERS } from "../../packages/protocol/src/pluginProviders.ts";
import type { InstalledSkillDto, PluginAccountDto, PluginStateDto, SkillCommandDto } from "../../packages/protocol/src/plugins.ts";
import { handlePluginCloudRequest } from "../../apps/site/server/plugins.ts";
import { api, apiStatus, startDaemon, type Harness } from "./helpers/harness.ts";

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
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === publisher) {
      const copy = request.clone();
      const response = await handlePluginCloudRequest(request);
      if (url.pathname === "/api/plugins/oauth/start") {
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

  async function authorize(actor: string, scopes = [driveScope, gmailScope], accountId?: string): Promise<PluginAccountDto> {
    const code = `fixture-code-${crypto.randomUUID()}`;
    const token = `fixture-access-private-${crypto.randomUUID()}`;
    grants.set(code, { actor, scopes, token });
    tokens.set(token, actor);
    pending = undefined;
    const authorization = await api<{ url: string }>(h, "POST", "/api/plugins/authorize", {
      providerId: "google", returnUrl: h.baseUrl, ...(accountId ? { accountId } : {}),
    });
    expect(new URL(authorization.url).origin).toBe("https://accounts.google.com");
    // The publisher captures daemon-generated state; no private daemon state is seeded.
    const transaction = pending as { localState: string; callbackUrl: string; brokerState: string } | undefined;
    if (!transaction) throw new Error("Publisher did not receive an OAuth start request");
    const callback = new URL(transaction.callbackUrl);
    callback.searchParams.set("state", transaction.localState);
    callback.searchParams.set("code", code);
    callback.searchParams.set("brokerState", transaction.brokerState);
    const response = await fetch(callback);
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(page).not.toContain(token);
    const account = (await state()).accounts.find((entry) => entry.identity === `google:${actor}`);
    if (!account) throw new Error("Public callback did not create the fixture account identity");
    expect(account.status).toBe("connected");
    expect(account.label).toBe(`${actor}@example.invalid`);
    if (accountId) expect(account.id).toBe(accountId);
    return account;
  }
  return { h, sources, state, authorize };
}

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
