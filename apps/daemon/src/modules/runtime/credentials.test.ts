import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore, MODEL_CREDENTIALS_FILENAME, type StoredProvider } from "./credentials.ts";
import { SecretStore, type SecretBackend } from "./secrets.ts";

const providers = [
  { id: "Custom.Provider", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "secret-example", models: [{ id: "model" }] },
  { id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: "another-secret" },
] satisfies [StoredProvider, StoredProvider];

async function withCredentialDirectory(run: (dir: string, file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "credentials-"));
  try {
    await run(dir, path.join(dir, MODEL_CREDENTIALS_FILENAME));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("migrates two legacy providers into app secrets once and reloads them without the file", () => withCredentialDirectory(async (dir, file) => {
  writeFileSync(file, JSON.stringify(providers), { mode: 0o600 });
  const secrets = new SecretStore(dir);
  const store = await CredentialStore.open(dir, secrets);
  expect(existsSync(file)).toBeFalse();
  const metadata = await secrets.forApp().list();
  expect(metadata).toHaveLength(2);
  for (const provider of providers) {
    const { apiKey, ...record } = provider;
    const entry = metadata.find(({ description }) => JSON.parse(description).id === record.id)!;
    const digest = createHash("sha256").update(record.id).digest("hex");
    expect(entry.name).toBe(`provider-${digest.slice(0, 48)}`);
    expect(JSON.parse(entry.description)).toEqual(record);
    expect(await secrets.getAppSecretForRuntime(entry.name)).toBe(apiKey);
    expect(store.getForRuntime(record.id)).toEqual(provider);
    expect(JSON.stringify(store.list())).not.toContain(apiKey);
  }
  const reopened = await CredentialStore.open(dir, new SecretStore(dir));
  expect(reopened.getAllForRuntime()).toEqual(providers);
  expect(reopened.list()).toEqual(store.list());
  expect(existsSync(file)).toBeFalse();
  await reopened.remove(providers[0].id);
  expect((await CredentialStore.open(dir, secrets)).getAllForRuntime()).toEqual([providers[1]]);
}));

test("keeps the legacy file until every provider verifies and retries without duplicate secrets", () => withCredentialDirectory(async (dir, file) => {
  const legacy = JSON.stringify(providers);
  writeFileSync(file, legacy, { mode: 0o600 });
  const values = new Map<string, string>();
  let verify = false;
  const backend: SecretBackend = {
    kind: "keychain",
    async get(account) {
      const value = values.get(account);
      return verify || value !== providers[1].apiKey ? value : undefined;
    },
    async set(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
  const secrets = new SecretStore(dir, backend);
  const partiallyMigrated = await CredentialStore.open(dir, secrets);
  expect(partiallyMigrated.getAllForRuntime()).toEqual([providers[0]]);
  expect(readFileSync(file, "utf8")).toBe(legacy);
  verify = true;
  const reopened = await CredentialStore.open(dir, secrets);
  expect(reopened.getAllForRuntime()).toEqual(providers);
  expect(await secrets.forApp().list()).toHaveLength(2);
  expect(existsSync(file)).toBeFalse();
}));

test("a failed provider removal drops the cached credential and preserves the indexed entry for retry", () => withCredentialDirectory(async (dir) => {
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
  const secrets = new SecretStore(dir, backend);
  const store = await CredentialStore.open(dir, secrets);
  const provider = providers[0];
  await store.add(provider);
  await expect(store.remove(provider.id)).rejects.toThrow("Unable to delete secret");
  expect(store.getForRuntime(provider.id)).toBeUndefined();
  expect(await secrets.forApp().list()).toHaveLength(1);
  failDelete = false;
  await store.remove(provider.id);
  expect((await CredentialStore.open(dir, secrets)).list()).toEqual([]);
  expect(values.size).toBe(0);
}));

test("malformed credentials and invalid inputs fail without disclosing keys", () => withCredentialDirectory(async (dir, file) => {
  const secrets = new SecretStore(dir);
  const store = await CredentialStore.open(dir, secrets);
  writeFileSync(file, '{"apiKey":"secret-example"');
  await expect(CredentialStore.open(dir, secrets)).rejects.toThrow(/^Unable to read model credential store$/);
  await expect(store.add({ id: "bad/id", name: "x", protocol: "built-in", apiKey: "secret-example" })).rejects.toThrow("Invalid model provider");
}));

test("whole-store projection drops unrecognized catalog data and copies inputs", () => withCredentialDirectory(async (dir, file) => {
  const keys = ["secret-example", "other-secret", "builtin-secret"];
  writeFileSync(file, JSON.stringify([
    { id: "one", name: "One", protocol: "built-in", apiKey: keys[0], models: [{ id: "first", input: ["text", "image"], extra: keys[1], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, secret: keys[2] } }] },
    { id: "two", name: "Two", protocol: "built-in", apiKey: keys[1], models: [{ id: "second", input: { secret: keys[0] }, contextWindow: { secret: keys[2] }, cost: { input: keys[0] } }] },
    { id: "three", name: "Three", protocol: "built-in", apiKey: keys[2], models: [{ id: keys[0] }, { id: keys[1] }, { id: "safe", name: keys[1] }, { id: "safe-id", name: "Safe" }] },
  ]));
  const secrets = new SecretStore(dir);
  const store = await CredentialStore.open(dir, secrets);
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
