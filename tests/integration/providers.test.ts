import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { ApiClient } from "../../packages/api-client/src/index.ts";
import type { CreateProviderBody, ProviderDto } from "../../packages/protocol/src/index.ts";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { DEFAULT_MODEL_SETTING } from "../../apps/daemon/src/modules/runtime/models.ts";
import { SecretStore } from "../../apps/daemon/src/modules/runtime/secrets.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { apiStatus, authedFetch, makeBot, messages, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

const providersPath = "/api/providers";
const fixtureKey = "provider-http-test-key";
const replacementKey = "provider-http-replacement-key";
const username = "provider-http-userinfo";
const password = "provider-http-password";
const credentialUrl = `https://${username}:${password}@example.invalid/v1`;
const custom = {
  protocol: "openai-compatible",
  name: "  Example --- Gateway!! ",
  baseUrl: "https://example.invalid/v1",
  key: fixtureKey,
  models: ["example-model"],
} satisfies CreateProviderBody;

function expectSecretFree(text: string) {
  for (const secret of [fixtureKey, replacementKey, username, password, '"key"', '"apiKey"']) {
    expect(text.includes(secret)).toBeFalse();
  }
}

async function providerRequest<T>(h: Harness, method: string, path: string, status: number, body?: unknown): Promise<T> {
  const response = await authedFetch(h, `${h.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expectSecretFree(text);
  expect(response.status).toBe(status);
  const parsed = JSON.parse(text) as T;
  expectSecretFree(JSON.stringify(parsed));
  return parsed;
}

function withDaemon(run: (h: Harness, client: ApiClient) => Promise<void>, options?: Parameters<typeof startDaemon>[1]) {
  return async () => {
    const h = await startDaemon(undefined, options);
    try {
      await run(h, new ApiClient({ baseUrl: h.baseUrl, deviceToken: h.token }));
    } finally {
      await h.stop();
      await rm(h.home, { recursive: true, force: true });
      await rm(h.svc.cfg.stateDir, { recursive: true, force: true });
    }
  };
}

test("provider routes require a paired device token", withDaemon(async (h) => {
  const routes = [
    ["GET", providersPath],
    ["GET", `${providersPath}/builtin`],
    ["POST", providersPath],
    ["PUT", `${providersPath}/example`],
    ["DELETE", `${providersPath}/example`],
  ] as const;
  for (const [method, path] of routes) {
    expect((await fetch(`${h.baseUrl}${path}`, { method })).status).toBe(401);
  }
}));

test("custom provider CRUD preserves an omitted key and hides credentials in raw JSON", withDaemon(async (h, client) => {
  const created = await providerRequest<ProviderDto>(h, "POST", providersPath, 201, custom);
  expect(created).toEqual({ id: "example-gateway", name: "Example --- Gateway!!", protocol: custom.protocol, baseUrl: custom.baseUrl, hasKey: true, models: [{ id: "example-model" }] });
  const path = `${providersPath}/${created.id}`;
  expect(await providerRequest<ProviderDto[]>(h, "GET", providersPath, 200)).toContainEqual(created);

  const updates = { name: "Renamed Gateway", baseUrl: "http://localhost:4321/v2", models: ["org/new-model"] };
  const updated = await providerRequest<ProviderDto>(h, "PUT", path, 200, updates);
  expect(updated).toEqual({ ...created, ...updates, models: [{ id: "org/new-model" }] });
  expect(h.svc.credentials.getForRuntime(created.id)?.apiKey === fixtureKey).toBeTrue();
  expect(await providerRequest<ProviderDto[]>(h, "GET", providersPath, 200)).toContainEqual(updated);

  const cleared = await client.updateProvider(created.id, { key: replacementKey, models: [] });
  expectSecretFree(JSON.stringify(cleared));
  expect(cleared).toEqual({ ...updated, models: [] });
  expect(h.svc.credentials.getForRuntime(created.id)?.apiKey === replacementKey).toBeTrue();

  expect(await client.deleteProvider(created.id)).toBeUndefined();
  expect((await client.providers()).some(({ id }) => id === created.id)).toBeFalse();
  expect((await apiStatus(h, "DELETE", path)).status).toBe(404);
}));

test("provider create and update store and return each model ID once", withDaemon(async (h) => {
  const created = await providerRequest<ProviderDto>(h, "POST", providersPath, 201, { ...custom, models: [" example-model ", "example-model"] });
  const firstModels = [{ id: "example-model" }];
  expect(created.models).toEqual(firstModels);
  expect(h.svc.credentials.getForRuntime(created.id)?.models).toEqual(firstModels);

  const updated = await providerRequest<ProviderDto>(h, "PUT", `${providersPath}/${created.id}`, 200, { models: ["next-model", "second-model", "next-model"] });
  const updatedModels = [{ id: "next-model" }, { id: "second-model" }];
  expect(updated.models).toEqual(updatedModels);
  expect(h.svc.credentials.getForRuntime(created.id)?.models).toEqual(updatedModels);
}));

test("custom provider IDs suffix collisions and reserve built-in IDs even for concurrent creates", withDaemon(async (_h, client) => {
  const body = { ...custom, protocol: "anthropic-messages", name: "OpenAI" } as const;
  const providers = await Promise.all([client.createProvider(body), client.createProvider(body)]);
  expect(providers.map(({ id }) => id).sort()).toEqual(["openai-2", "openai-3"]);
  expect(providers.map(({ protocol }) => protocol)).toEqual(["anthropic-messages", "anthropic-messages"]);
}));

test("built-in provider list is sorted and saved providers project catalog and extra models", withDaemon(async (h, client) => {
  const catalog = await client.builtinProviders();
  const names = catalog.map(({ name }) => name);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  const openai = catalog.find(({ id }) => id === "openai")!;
  expect(openai).toEqual({ id: "openai", name: "OpenAI" });

  const created = await providerRequest<ProviderDto>(h, "POST", providersPath, 201, { protocol: "built-in", id: openai.id, key: fixtureKey });
  expect(created).toMatchObject({ ...openai, protocol: "built-in", hasKey: true });
  expect(created.baseUrl).toBeUndefined();
  expect(created.models).toContainEqual(expect.objectContaining({ id: "gpt-4o", name: expect.any(String), contextWindow: expect.any(Number), maxTokens: expect.any(Number), reasoning: expect.any(Boolean), input: expect.any(Array) }));
  expect(created.models.every((model) => Object.keys(model).every((key) => ["id", "name", "contextWindow", "maxTokens", "reasoning", "input"].includes(key)))).toBeTrue();

  expect((await apiStatus(h, "POST", providersPath, { protocol: "built-in", id: openai.id, key: replacementKey })).status).toBe(409);
  expect(h.svc.credentials.getForRuntime(openai.id)?.apiKey === fixtureKey).toBeTrue();
  const path = `${providersPath}/${openai.id}`;
  for (const body of [{ name: "Different name" }, { baseUrl: custom.baseUrl }, { protocol: "openai-compatible" }]) {
    expect((await apiStatus(h, "PUT", path, body)).status).toBe(400);
  }
  const updated = await providerRequest<ProviderDto>(h, "PUT", path, 200, { models: ["gpt-4o", "extra-model"] });
  expect(updated).toEqual({ ...created, models: [...created.models, { id: "extra-model" }] });
  expect(await providerRequest<ProviderDto[]>(h, "GET", providersPath, 200)).toContainEqual(updated);
}));

test("provider listing keeps the first legacy model for each ID and prefers the built-in catalog", withDaemon(async (h) => {
  const firstExtra = { id: "extra-model", name: "First extra" };
  await h.svc.credentials.add({ id: "openai", name: "OpenAI", protocol: "built-in", apiKey: fixtureKey, models: [
    { id: "gpt-4o", name: "Legacy override" },
    firstExtra,
    { id: firstExtra.id, name: "Second extra" },
  ] });
  expect(h.svc.credentials.list()[0]?.models).toEqual([{ id: "gpt-4o", name: "Legacy override" }, firstExtra]);
  const [listed] = await providerRequest<ProviderDto[]>(h, "GET", providersPath, 200);
  expect(listed?.models.filter(({ id }) => id === firstExtra.id)).toEqual([firstExtra]);
  const stock = listed?.models.filter(({ id }) => id === "gpt-4o");
  expect(stock).toHaveLength(1);
  expect(stock?.[0]?.name).not.toBe("Legacy override");
}));

test("OAuth-only built-ins are rejected and omitted from the API-key catalog but reserve their slugs", withDaemon(async (h, client) => {
  const id = "openai-codex";
  const rejected = await providerRequest<{ error: string }>(h, "POST", providersPath, 400, { protocol: "built-in", id, key: fixtureKey });
  expect(rejected.error).toMatch(/API key/i);
  expect(h.svc.credentials.has(id)).toBeFalse();
  expect(await new SecretStore(h.svc.cfg.dataDir).forApp().list()).toEqual([]);
  expect((await client.builtinProviders()).map((provider) => provider.id)).not.toContain(id);
  expect((await client.createProvider({ ...custom, name: "OpenAI Codex" })).id).toBe(`${id}-2`);
}));

test("an existing OAuth-only built-in has no models in the API-key projection", withDaemon(async (_h, client) => {
  expect(await client.providers()).toContainEqual({ id: "openai-codex", name: "OpenAI Codex", protocol: "built-in", hasKey: true, models: [] });
}, { legacyModelCredentials: [{ id: "openai-codex", name: "OpenAI Codex", protocol: "built-in", apiKey: fixtureKey, models: [{ id: "extra-model" }] }] }));

test("built-in catalog projection omits model metadata containing a stored key", withDaemon(async (h) => {
  const key = "gpt-4o-mini";
  const created = await providerRequest<ProviderDto>(h, "POST", providersPath, 201, { protocol: "built-in", id: "openai", key });
  const listed = await providerRequest<ProviderDto[]>(h, "GET", providersPath, 200);
  expect(JSON.stringify([created, listed]).includes(key)).toBeFalse();
  expect(created.models.some(({ id }) => id === "gpt-4o")).toBeTrue();
}));

test("invalid provider requests return 400 without echoing request values, and unknown IDs return 404", withDaemon(async (h, client) => {
  const invalid = [
    [{ ...custom, key: undefined }, /key/i],
    [{ ...custom, key: "  " }, /key/i],
    [{ ...custom, baseUrl: "not-a-url" }, /base URL/i],
    [{ ...custom, baseUrl: "ftp://example.invalid" }, /base URL/i],
    [{ ...custom, baseUrl: credentialUrl }, /base URL/i],
    [{ ...custom, protocol: "unknown" }, /protocol/i],
    [{ protocol: "built-in", id: "not-in-catalog", key: fixtureKey }, /built-in/i],
  ] as const;
  for (const [body, message] of invalid) {
    expect((await providerRequest<{ error: string }>(h, "POST", providersPath, 400, body)).error).toMatch(message);
  }
  const created = await client.createProvider(custom);
  const path = `${providersPath}/${created.id}`;
  for (const body of [{ protocol: "anthropic-messages" }, { id: "different" }, { baseUrl: credentialUrl }, { models: [42] }]) {
    await providerRequest(h, "PUT", path, 400, body);
  }
  expect(await client.providers()).toContainEqual(created);
  expect((await apiStatus(h, "PUT", `${providersPath}/unknown`, {})).status).toBe(404);
  expect((await apiStatus(h, "DELETE", `${providersPath}/unknown`)).status).toBe(404);
}));

test("provider writes reject encoded keys in base URLs without echoing credentials", withDaemon(async (h, client) => {
  const key = "provider-http-key+/=%";
  const encodedKey = encodeURIComponent(key);
  const baseUrl = `${custom.baseUrl}?token=${encodedKey}`;

  async function expectRejected(method: string, path: string, body: { baseUrl: string } & Record<string, unknown>) {
    const response = await authedFetch(h, `${h.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expectSecretFree(text);
    expect(text).not.toContain(key);
    expect(text).not.toContain(encodedKey);
    expect(text).not.toContain(body.baseUrl);
  }

  await expectRejected("POST", providersPath, { ...custom, key, baseUrl });
  await expectRejected("POST", providersPath, { ...custom, key, baseUrl: `${custom.baseUrl}/${key}` });
  await expectRejected("POST", providersPath, { ...custom, key, baseUrl: `${baseUrl}&malformed=%ZZ` });
  expect(h.svc.credentials.getAllForRuntime()).toEqual([]);

  await client.createProvider({ ...custom, key });
  await expectRejected("POST", providersPath, { ...custom, name: "Other gateway", baseUrl });
  const existing = await client.createProvider({ ...custom, name: "Other gateway" });
  await expectRejected("PUT", `${providersPath}/${existing.id}`, { baseUrl });
  expect(h.svc.credentials.getForRuntime(existing.id)?.baseUrl).toBe(custom.baseUrl);
}));

test("provider listing hides legacy metadata containing an encoded stored key", withDaemon(async (h, client) => {
  const apiKey = "legacy-provider-key+/=%";
  const encodedKey = encodeURIComponent(apiKey);
  const legacy = { id: "legacy-gateway", name: "Legacy Gateway", protocol: custom.protocol, baseUrl: `${custom.baseUrl}?token=${encodedKey}`, apiKey };
  await h.svc.credentials.add(legacy);
  const created = await client.createProvider(custom);
  const { apiKey: safeKey, ...safe } = h.svc.credentials.getForRuntime(created.id)!;
  await h.svc.credentials.add({
    ...safe,
    apiKey: safeKey,
    models: [{ id: "example-model" }, { id: "unsafe-model", name: `Label ${encodedKey}` }],
  });
  expect(h.svc.credentials.getForRuntime(legacy.id)).toEqual(legacy);
  expect(h.svc.credentials.list()).toEqual([{ ...safe, hasKey: true }]);

  const response = await authedFetch(h, `${h.baseUrl}${providersPath}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(apiKey);
  expect(text).not.toContain(encodedKey);
  expect(JSON.parse(text)).toEqual([created]);
}));

test("provider listing omits a legacy base URL containing userinfo", withDaemon(async (h) => {
  const providers = await providerRequest<ProviderDto[]>(h, "GET", providersPath, 200);
  expect(providers).toContainEqual({ id: "Legacy.Provider", name: "Legacy", protocol: "openai-compatible", hasKey: true, models: [] });
  const removed = await authedFetch(h, `${h.baseUrl}${providersPath}/${encodeURIComponent("Legacy.Provider")}`, { method: "DELETE" });
  expect(removed.status).toBe(204);
  expect(await removed.text()).toBe("");
}, { legacyModelCredentials: [{ id: "Legacy.Provider", name: "Legacy", protocol: "openai-compatible", baseUrl: credentialUrl, apiKey: fixtureKey }] }));

for (const [body, providerId, modelId, reply] of [
  [custom, "example-gateway", "example-model", "Custom provider completed this Turn."],
  [{ protocol: "built-in", id: "openai", key: fixtureKey }, "openai", "gpt-4o", "Built-in provider completed this Turn."],
] as const satisfies readonly (readonly [CreateProviderBody, string, string, string])[]) {
  test(`an HTTP-added ${body.protocol} provider completes a durable Turn`, () =>
    withFakeRuntimeProvider([{ segments: [{ type: "text", text: reply }] }], { providerId, tokensPerSecond: 10000 }, withDaemon(async (h, client) => {
      const created = await client.createProvider(body);
      expect(created.id).toBe(providerId);
      expect(created.models.some(({ id }) => id === modelId)).toBeTrue();
      setSetting(h.svc.db, DEFAULT_MODEL_SETTING, `${created.id}/${modelId}`);
      setSetting(h.svc.db, "runtime", "durable");
      const botId = await makeBot(h, "Provider API Bot");
      const sent = await sendToBot(h, botId, "Use the Settings provider.");
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
      expect(await messages(h, sent.threadId)).toContainEqual(expect.objectContaining({ kind: "response", text: reply, response: expect.objectContaining({ state: "completed" }) }));
    })), 20000);
}
