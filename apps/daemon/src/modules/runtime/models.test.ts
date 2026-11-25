import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createFakeProvider } from "../../../../../packages/testkit/src/fake-provider.ts";
import { setSetting } from "../../persistence/settings.ts";
import { CredentialStore } from "./credentials.ts";
import { EXA_SEARCH_KEY_DESCRIPTION, EXA_SEARCH_KEY_SECRET } from "./extensions/web.ts";
import { SecretStore } from "./secrets.ts";
import { createRuntimeModels, DEFAULT_MODEL_METADATA, DEFAULT_MODEL_SETTING, resolveModelForBot } from "./models.ts";

test("provider protocols, catalog metadata, defaults, and live model selection", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT); CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO bots VALUES ('bot', NULL)");
  try {
    const store = await CredentialStore.open(dir, new SecretStore(dir));
    await store.add({ id: "compatible", name: "Compatible", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "secret-example", models: [{ id: "catalog/model", contextWindow: 256000, maxTokens: 16000, reasoning: true }] });
    await store.add({ id: "messages", name: "Messages", protocol: "anthropic-messages", baseUrl: "https://example.test", apiKey: "other-secret" });
    const builtin = builtinProviders().find((p) => p.getModels().length > 0)!;
    const builtModel = builtin.getModels()[0]!;
    await store.add({ id: builtin.id, name: builtin.id, protocol: "built-in", apiKey: "builtin-secret" });
    setSetting(db, DEFAULT_MODEL_SETTING, "compatible/catalog/model");
    expect(resolveModelForBot(db, store, "bot").contextWindow).toBe(256000);
    db.query("UPDATE bots SET model = ? WHERE id = 'bot'").run("messages/arbitrary/model");
    const custom = resolveModelForBot(db, store, "bot");
    expect(custom.api).toBe("anthropic-messages");
    expect(custom.contextWindow).toBe(DEFAULT_MODEL_METADATA.contextWindow);
    expect(custom.maxTokens).toBe(DEFAULT_MODEL_METADATA.maxTokens);
    db.query("UPDATE bots SET model = NULL WHERE id = 'bot'").run();
    setSetting(db, DEFAULT_MODEL_SETTING, `${builtin.id}/${builtModel.id}`);
    expect(resolveModelForBot(db, store, "bot").contextWindow).toBe(builtModel.contextWindow);
    db.query("UPDATE bots SET model = 'missing/model' WHERE id = 'bot'").run();
    expect(() => resolveModelForBot(db, store, "bot")).toThrow("Unable to resolve Bot provider/model selection");
    try { resolveModelForBot(db, store, "bot"); } catch (e) { expect(String(e)).not.toContain("secret-example"); }
    expect(createRuntimeModels(store).getProvider("compatible")).toBeDefined();
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an Anthropic extra model and a pinned catalog model resolve on the native route", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-anthropic-"));
  try {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT); CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const pinned = "claude-sonnet-4-6";
    db.run("INSERT INTO bots VALUES ('default', NULL), ('pinned', ?)", [`anthropic/${pinned}`]);
    const extra = { id: "custom-claude-model", name: "Custom Claude Model" };
    const store = await CredentialStore.open(dir, new SecretStore(dir));
    await store.add({ id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: "fixture-key", models: [extra] });
    setSetting(db, DEFAULT_MODEL_SETTING, `anthropic/${extra.id}`);

    const route = { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
    expect(resolveModelForBot(db, store, "default")).toMatchObject({ ...extra, ...route });
    expect(resolveModelForBot(db, store, "pinned")).toMatchObject({ id: pinned, ...route });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an Anthropic provider-level proxy routes a built-in model to its configured endpoint", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-anthropic-proxy-"));
  try {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT); CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO bots VALUES ('bot', NULL)");
    const defaultModel = "claude-sonnet-4-6";
    const baseUrl = "https://gateway.example.test/anthropic";
    const store = await CredentialStore.open(dir, new SecretStore(dir));
    await store.add({ id: "anthropic", name: "Anthropic Gateway", protocol: "anthropic-messages", baseUrl, apiKey: "fixture-key", models: [{ id: "proxy-model" }] });
    setSetting(db, DEFAULT_MODEL_SETTING, `anthropic/${defaultModel}`);

    expect(resolveModelForBot(db, store, "bot")).toMatchObject({
      id: defaultModel, provider: "anthropic", api: "anthropic-messages", baseUrl,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake provider streams ordered thinking and response and scripted failure", async () => {
  const fake = createFakeProvider([{ segments: [{ type: "thinking", text: "consider" }, { type: "text", text: "answer" }] }, { segments: [], failure: "scripted failure" }], { tokensPerSecond: 10000 });
  const models = createModels();
  models.setProvider(fake.provider);
  const stream = models.streamSimple(fake.getModel(), { messages: [] });
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  expect(types.indexOf("thinking_delta")).toBeLessThan(types.indexOf("text_delta"));
  const failure = await models.streamSimple(fake.getModel(), { messages: [] }).result();
  expect(failure.stopReason).toBe("error");
  expect(failure.errorMessage).toBe("scripted failure");
});

test("stored credentials drive provider auth and request overrides", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-auth-"));
  try {
    const store = await CredentialStore.open(dir, new SecretStore(dir));
    await store.add({ id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: "builtin-secret" });
    await store.add({ id: "custom", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "custom-secret", models: [{ id: "model" }] });
    const models = createRuntimeModels(store);
    expect((await models.getAuth("anthropic"))?.auth.apiKey === "builtin-secret").toBe(true);
    expect((await models.getAuth("custom"))?.auth.apiKey === "custom-secret").toBe(true);
    const fake = createFakeProvider([{ segments: [{ type: "text", text: "ok" }] }]);
    const provider = models.getProvider("custom")!;
    let usedKey: string | undefined;
    models.setProvider({ ...provider, streamSimple(_model, context, options) { usedKey = options?.apiKey; return fake.provider.streamSimple(fake.getModel(), context, options); } });
    await models.streamSimple(models.getModel("custom", "model")!, { messages: [] }, { apiKey: "request-secret" }).result();
    expect(usedKey === "request-secret").toBe(true);
    await store.remove("custom");
    expect(await models.getAuth("custom")).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolution fails closed and redacts every stored key including causes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-errors-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT); CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO bots VALUES ('bot', NULL)");
  const keys = ["secret-example", "other-secret", "builtin-secret"];
  const assertFailure = (botId: string, text: string) => {
    let error: unknown;
    try { resolveModelForBot(db, store, botId); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const message = String(error);
    expect(message).toContain(text);
    for (const key of keys) {
      expect(message.includes(key)).toBe(false);
      expect(String((error as Error).cause).includes(key)).toBe(false);
    }
  };
  const store = await CredentialStore.open(dir, new SecretStore(dir));
  try {
    assertFailure("missing", "provider/model");
    assertFailure("bot", "provider/model");
    const select = (value: string) => db.query("UPDATE bots SET model = ? WHERE id = 'bot'").run(value);
    select("bare"); assertFailure("bot", "provider/model");
    select("provider/"); assertFailure("bot", "provider/model");
    select("missing/model"); assertFailure("bot", "missing/model");
    await store.add({ id: "custom", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: keys[0]! });
    await store.add({ id: "other", name: "Other", protocol: "anthropic-messages", baseUrl: "https://example.test", apiKey: keys[1]! });
    await store.add({ id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: keys[2]! });
    select("anthropic/not-a-real-model"); assertFailure("bot", "anthropic/not-a-real-model");
    for (const key of keys) { select(`missing/${key}`); assertFailure("bot", "[redacted]"); }
    await store.add({ id: "my-copy", name: "openai", protocol: "built-in", apiKey: "copy-key" });
    select("my-copy/model"); assertFailure("bot", "my-copy/model");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("model selection errors redact raw, trimmed, and doubly encoded Exa app secret values", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-exa-redaction-"));
  try {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT); INSERT INTO bots VALUES ('bot', NULL)");
    const secrets = new SecretStore(dir);
    await secrets.forApp().save(EXA_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_DESCRIPTION, "exa+selection-key \t\n");
    const rawKey = (await secrets.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET))!;
    const sensitiveValues = [rawKey, rawKey.trim()];
    const store = new CredentialStore(secrets, { sensitiveValues });
    for (const key of sensitiveValues) {
      db.query("UPDATE bots SET model = ? WHERE id = 'bot'").run(`missing/${key}`);
      expect(() => resolveModelForBot(db, store, "bot"))
        .toThrow(/^Unable to resolve Bot provider\/model selection: missing\/\[redacted\]$/);
    }
    const encodedKey = encodeURIComponent(encodeURIComponent(rawKey.trim()));
    db.query("UPDATE bots SET model = ? WHERE id = 'bot'").run(`missing/${encodedKey}`);
    expect(() => resolveModelForBot(db, store, "bot"))
      .toThrow(/^Unable to resolve Bot provider\/model selection: \[redacted\]$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom endpoints validate URL and avoid metadata from a different native API", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-custom-"));
  try {
    const store = await CredentialStore.open(dir, new SecretStore(dir));
    const native = builtinProviders().find((p) => p.id === "openai")!.getModels().find((m) => m.api !== "openai-completions")!;
    await store.add({ id: "openai", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "key", models: [{ id: native.id }] });
    const model = createRuntimeModels(store).getModel("openai", native.id)!;
    expect(model.contextWindow).toBe(DEFAULT_MODEL_METADATA.contextWindow);
    expect(model.maxTokens).toBe(DEFAULT_MODEL_METADATA.maxTokens);
    expect(model.reasoning).toBe(DEFAULT_MODEL_METADATA.reasoning);
    expect(model.input).toEqual(DEFAULT_MODEL_METADATA.input);
    expect(model.cost).toEqual(DEFAULT_MODEL_METADATA.cost);
    await store.add({ id: "invalid", name: "Invalid", protocol: "openai-compatible", baseUrl: "relative", apiKey: "url-secret" });
    expect(() => createRuntimeModels(store)).toThrow("Invalid custom provider base URL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
