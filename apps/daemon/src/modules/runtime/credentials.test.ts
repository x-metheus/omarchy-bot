import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore, type StoredModel, type StoredProvider } from "./credentials.ts";
import { EXA_SEARCH_KEY_DESCRIPTION, EXA_SEARCH_KEY_SECRET } from "./extensions/web.ts";
import { fallbackSecretValuesPath, SecretStore, type SecretBackend } from "./secrets.ts";

const providers = [
  { id: "Custom.Provider", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "secret-example", models: [{ id: "model" }] },
  { id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: "another-secret" },
] satisfies [StoredProvider, StoredProvider];

async function withCredentialDirectory(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "credentials-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CredentialStore promotes provider keys and resolves them after removing the fallback", () => withCredentialDirectory(async (dir) => {
  const store = await CredentialStore.open(dir, new SecretStore(dir));
  for (const provider of providers) await store.add(provider);
  expect(existsSync(fallbackSecretValuesPath(dir))).toBeTrue();
  const values = new Map<string, string>();
  const backend: SecretBackend = {
    kind: "keychain",
    async get(account) { return values.get(account); },
    async set(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
  const secrets = new SecretStore(dir, { backend, probe: async () => ({ available: true }) });
  const promoted = await CredentialStore.open(dir, secrets);
  expect(existsSync(fallbackSecretValuesPath(dir))).toBeFalse();
  expect(await secrets.status()).toEqual({ backend: "keychain" });
  expect(values.size).toBe(providers.length);
  const projection = JSON.stringify(promoted.list());
  for (const { id, apiKey } of providers) {
    expect(promoted.getForRuntime(id)?.apiKey === apiKey).toBeTrue();
    expect([...values.values()].includes(apiKey)).toBeTrue();
    expect(projection.includes(apiKey)).toBeFalse();
  }
}));

test("provider listings hide model metadata containing the Exa app secret", () => withCredentialDirectory(async (dir) => {
  const secrets = new SecretStore(dir);
  await secrets.forApp().save(EXA_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_DESCRIPTION, "exa-test+metadata-key \t");
  const rawKey = (await secrets.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET))!;
  const key = rawKey.trim();
  const existing = await CredentialStore.open(dir, secrets);
  const model = { id: "safe-model", name: "Safe model" };
  await existing.add({
    ...providers[0],
    models: [model, { id: "unsafe-model", name: `Contains ${rawKey}` }, { id: key }],
  });
  const store = await CredentialStore.open(dir, secrets, { sensitiveValues: [rawKey, key] });
  expect(store.list()[0]?.models).toEqual([model]);
  expect(store.list(({ models }) => [...(models ?? []), { id: encodeURIComponent(key) }])[0]?.models).toEqual([model]);
}));

test("adding a provider rejects raw, trimmed, and URL-encoded Exa secrets in metadata before saving", () => withCredentialDirectory(async (dir) => {
  const secrets = new SecretStore(dir);
  await secrets.forApp().save(EXA_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_DESCRIPTION, "exa-test+write-key \t");
  const rawKey = (await secrets.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET))!;
  const key = rawKey.trim();
  const encodedKey = encodeURIComponent(key);
  const store = await CredentialStore.open(dir, secrets, { sensitiveValues: [rawKey, key] });
  const before = await secrets.forApp().list();
  const { apiKey, ...normal } = providers[0];
  const unsafeMetadata: Partial<StoredProvider>[] = [
    { name: `Provider ${rawKey}` },
    { name: `Provider ${encodedKey}` },
    { id: `provider-${key}` },
    { baseUrl: `https://example.test?token=${encodedKey}` },
    { models: [{ id: "model", name: `Model ${key}` }] },
    { models: [{ id: "model", name: `Model ${encodeURIComponent(rawKey)}` }] },
    { models: [{ id: `model-${encodedKey}` }] },
  ];
  for (const metadata of unsafeMetadata) {
    await expect(store.add({ ...normal, apiKey, ...metadata })).rejects.toThrow(/^Provider metadata must not contain a key$/);
  }
  expect(await secrets.forApp().list()).toEqual(before);
  expect(store.list()).toEqual([]);
  await store.add({ ...normal, apiKey });
  expect(store.list()).toEqual([{ ...normal, hasKey: true }]);
}));

test("doubly encoded Exa keys and over-depth escapes are rejected before saving provider metadata", () => withCredentialDirectory(async (dir) => {
  const secrets = new SecretStore(dir);
  await secrets.forApp().save(EXA_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_DESCRIPTION, "exa+nested-write-key \t");
  const rawKey = (await secrets.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET))!;
  const key = rawKey.trim();
  const encodedKey = encodeURIComponent(encodeURIComponent(key));
  const store = await CredentialStore.open(dir, secrets, { sensitiveValues: [rawKey, key] });
  const { apiKey, ...normal } = providers[0];
  await store.add({ ...normal, apiKey });
  const before = await secrets.forApp().list();
  const unsafeMetadata: Partial<StoredProvider>[] = [
    { models: [{ id: `model-${encodedKey}` }] },
    { baseUrl: `https://example.test?token=${encodedKey}` },
    { models: [{ id: "model-%25252541" }] },
  ];
  for (const metadata of unsafeMetadata) {
    await expect(store.add({ ...normal, apiKey, ...metadata })).rejects.toThrow(/^Provider metadata must not contain a key$/);
  }
  expect(await secrets.forApp().list()).toEqual(before);
  expect(store.getForRuntime(normal.id)).toEqual({ ...normal, apiKey });
  expect(store.list()).toEqual([{ ...normal, hasKey: true }]);
}));

test("list hides stored metadata containing doubly encoded Exa keys", () => withCredentialDirectory(async (dir) => {
  const secrets = new SecretStore(dir);
  await secrets.forApp().save(EXA_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_DESCRIPTION, "exa+legacy-key \t");
  const rawKey = (await secrets.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET))!;
  const key = rawKey.trim();
  const encodedKey = encodeURIComponent(encodeURIComponent(key));
  const { apiKey, ...normal } = providers[0];
  // Simulate persisted metadata that add() now rejects before the listing can project it.
  for (const { apiKey: value, ...record } of [
    { ...normal, apiKey, models: [{ id: "safe" }, { id: `model-${encodedKey}` }, { id: "model-%25252541" }] },
    { ...normal, id: "legacy-url", apiKey: "legacy-api-key", baseUrl: `https://example.test?token=${encodedKey}` },
  ]) {
    const digest = createHash("sha256").update(record.id).digest("hex");
    await secrets.forApp().save(`provider-${digest.slice(0, 48)}`, JSON.stringify(record), value);
  }
  const store = await CredentialStore.open(dir, secrets, { sensitiveValues: [rawKey, key] });
  expect(store.list()).toEqual([{ ...normal, hasKey: true, models: [{ id: "safe" }] }]);
}));

test("provider redaction checks decoded forms of configured keys and bounds selection decoding", () => withCredentialDirectory(async (dir) => {
  const secrets = new SecretStore(dir);
  const exaKey = "exa%252Bnested-key";
  await secrets.forApp().save(EXA_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_DESCRIPTION, exaKey);
  const exaValue = (await secrets.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET))!;
  const store = await CredentialStore.open(dir, secrets, { sensitiveValues: [exaValue] });
  await store.add({ ...providers[0], apiKey: "provider%252Bnested-key" });
  for (const key of ["exa+nested-key", "provider+nested-key"]) {
    expect(store.redactKeys(`missing/${key}`)).toBe("missing/[redacted]");
    const encodedKey = encodeURIComponent(encodeURIComponent(key));
    expect(store.redactKeys(`missing/${encodedKey}`)).not.toContain(encodedKey);
  }
  expect(store.redactKeys("missing/model-%25252541")).toBe("[redacted]");
  expect(store.redactKeys("missing/model-%252541")).toBe("missing/model-%252541");
  const overlappingKey = new CredentialStore(secrets, { sensitiveValues: ["25"] });
  expect(overlappingKey.redactKeys("missing/model-%25252541")).toBe("[redacted]");
}));

test("a failed provider removal keeps the ID listed for retry and hides the key from runtime", () => withCredentialDirectory(async (dir) => {
  const values = new Map<string, string>();
  let failDelete = true;
  const backend: SecretBackend = {
    kind: "keychain",
    async get(account) { return values.get(account); },
    async set(account, value) { values.set(account, value); },
    async delete(account) {
      if (failDelete) throw new Error("keychain failure");
      values.delete(account);
    },
  };
  const secrets = new SecretStore(dir, { backend, probe: async () => ({ available: true }) });
  const store = await CredentialStore.open(dir, secrets);
  const { apiKey, ...provider } = providers[0];
  await store.add({ ...provider, apiKey });
  await expect(store.remove(provider.id)).rejects.toThrow("Unable to delete secret");
  expect(store.list()).toEqual([{ ...provider, hasKey: true }]);
  expect(store.has(provider.id)).toBeTrue();
  expect(store.getForRuntime(provider.id)).toBeUndefined();
  expect(store.getAllForRuntime()).toEqual([]);
  expect(store.redactKeys(`${provider.id}/${apiKey}`)).toBe(`${provider.id}/[redacted]`);
  const other = { ...provider, id: "other", baseUrl: `https://example.test?token=${apiKey.replace("-", "%2D")}`, apiKey: "new-key" };
  await expect(store.add(other, { checkEncodedKeys: true })).rejects.toThrow("Provider metadata must not contain a key");
  expect(store.has(other.id)).toBeFalse();
  expect(await secrets.forApp().list()).toHaveLength(1);
  expect(values.size).toBe(1);
  failDelete = false;
  await store.remove(provider.id);
  expect(store.list()).toEqual([]);
  expect(store.has(provider.id)).toBeFalse();
  expect(store.getForRuntime(provider.id)).toBeUndefined();
  expect(store.getAllForRuntime()).toEqual([]);
  expect((await CredentialStore.open(dir, secrets)).list()).toEqual([]);
  expect(values.size).toBe(0);
  await store.add({ ...provider, apiKey });
  expect(store.getForRuntime(provider.id)).toEqual({ ...provider, apiKey });
}));

test("an index write failure after provider key deletion keeps the cached key out of runtime", () => withCredentialDirectory(async (dir) => {
  const values = new Map<string, string>();
  const index = path.join(dir, "secret-index.json");
  const backup = `${index}.backup`;
  let failIndexWrite = true;
  let deleteAttempts = 0;
  const backend: SecretBackend = {
    kind: "keychain",
    async get(account) { return values.get(account); },
    async set(account, value) { values.set(account, value); },
    async delete(account) {
      deleteAttempts++;
      values.delete(account);
      if (failIndexWrite) {
        // Block the index replacement after SecretStore has read the original index.
        renameSync(index, backup);
        mkdirSync(index);
      }
    },
  };
  const secrets = new SecretStore(dir, { backend, probe: async () => ({ available: true }) });
  const store = await CredentialStore.open(dir, secrets);
  const { apiKey, ...provider } = providers[0];
  await store.add({ ...provider, apiKey });
  await expect(store.remove(provider.id)).rejects.toMatchObject({ code: "EISDIR", dest: index });
  expect(values.size).toBe(0);
  expect(store.list()).toEqual([{ ...provider, hasKey: true }]);
  expect(store.getForRuntime(provider.id)).toBeUndefined();
  expect(store.getAllForRuntime()).toEqual([]);

  rmSync(index, { recursive: true });
  renameSync(backup, index);
  failIndexWrite = false;
  expect(await secrets.forApp().list()).toHaveLength(1);
  await store.remove(provider.id);
  expect(deleteAttempts).toBe(2);
  expect(store.list()).toEqual([]);
  expect(await secrets.forApp().list()).toEqual([]);
}));

test("invalid provider inputs fail without disclosing keys", () => withCredentialDirectory(async (dir) => {
  const store = await CredentialStore.open(dir, new SecretStore(dir));
  await expect(store.add({ id: "bad/id", name: "x", protocol: "built-in", apiKey: "secret-example" })).rejects.toThrow("Invalid model provider");
}));

test("whole-store projection drops unrecognized catalog data and copies inputs", () => withCredentialDirectory(async (dir) => {
  const keys = ["secret-example", "other-secret", "builtin-secret"] as const;
  const secrets = new SecretStore(dir);
  const store = await CredentialStore.open(dir, secrets);
  const firstModel = {
    id: "first",
    input: ["text", "image"] satisfies StoredModel["input"],
    extra: keys[1],
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, secret: keys[2] },
  };
  const malformedModel = { id: "second", input: { secret: keys[0] }, contextWindow: { secret: keys[2] }, cost: { input: keys[0] } };
  await store.add({ id: "one", name: "One", protocol: "built-in", apiKey: keys[0], models: [firstModel] });
  await store.add({ id: "two", name: "Two", protocol: "built-in", apiKey: keys[1], models: [malformedModel as unknown as StoredModel] });
  await store.add({ id: "three", name: "Three", protocol: "built-in", apiKey: keys[2], models: [{ id: keys[0] }, { id: keys[1] }, { id: "safe", name: keys[1] }, { id: "safe-id", name: "Safe" }] });
  const projection = store.list();
  const metadata = await secrets.forApp().list();
  for (const key of keys) {
    expect(JSON.stringify(projection)).not.toContain(key);
    expect(JSON.stringify(metadata)).not.toContain(key);
  }
  expect(projection[0]?.models?.[0]?.input).toEqual(["text", "image"]);
  expect(projection[1]?.models?.[0]).toEqual({ id: "second" });
  expect(projection[2]?.models).toEqual([{ id: "safe-id", name: "Safe" }]);
  projection[0]?.models?.[0]?.input?.push("text");
  expect(store.list()[0]?.models?.[0]?.input).toEqual(["text", "image"]);
}));
