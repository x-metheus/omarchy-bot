import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createFakeProvider } from "../../../../../packages/testkit/src/fake-provider.ts";
import { setSetting } from "../../persistence/settings.ts";
import { CredentialStore } from "./credentials.ts";
import { createRuntimeModels, DEFAULT_MODEL_METADATA, DEFAULT_MODEL_SETTING, resolveModelForBot } from "./models.ts";

test("provider protocols, catalog metadata, defaults, and live model selection", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-"));
  const db = new Database(":memory:");
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT); CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO bots VALUES ('bot', NULL)");
  try {
    const store = new CredentialStore(dir);
    store.add({ id: "compatible", name: "Compatible", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "secret-example", models: [{ id: "catalog/model", contextWindow: 256000, maxTokens: 16000, reasoning: true }] });
    store.add({ id: "messages", name: "Messages", protocol: "anthropic-messages", baseUrl: "https://example.test", apiKey: "other-secret" });
    const builtin = builtinProviders().find((p) => p.getModels().length > 0)!;
    const builtModel = builtin.getModels()[0]!;
    store.add({ id: builtin.id, name: builtin.id, protocol: "built-in", apiKey: "builtin-secret" });
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
    const store = new CredentialStore(dir);
    store.add({ id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: "builtin-secret" });
    store.add({ id: "custom", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "custom-secret", models: [{ id: "model" }] });
    const models = createRuntimeModels(store);
    expect((await models.getAuth("anthropic"))?.auth.apiKey === "builtin-secret").toBe(true);
    expect((await models.getAuth("custom"))?.auth.apiKey === "custom-secret").toBe(true);
    const fake = createFakeProvider([{ segments: [{ type: "text", text: "ok" }] }]);
    const provider = models.getProvider("custom")!;
    let usedKey: string | undefined;
    models.setProvider({ ...provider, streamSimple(_model, context, options) { usedKey = options?.apiKey; return fake.provider.streamSimple(fake.getModel(), context, options); } });
    await models.streamSimple(models.getModel("custom", "model")!, { messages: [] }, { apiKey: "request-secret" }).result();
    expect(usedKey === "request-secret").toBe(true);
    store.remove("custom");
    expect(await models.getAuth("custom")).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolution fails closed and redacts every stored key including causes", () => {
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
  const store = new CredentialStore(dir);
  try {
    assertFailure("missing", "provider/model");
    assertFailure("bot", "provider/model");
    const select = (value: string) => db.query("UPDATE bots SET model = ? WHERE id = 'bot'").run(value);
    select("bare"); assertFailure("bot", "provider/model");
    select("provider/"); assertFailure("bot", "provider/model");
    select("missing/model"); assertFailure("bot", "missing/model"); // missing file
    writeFileSync(path.join(dir, "model-credentials.json"), "");
    assertFailure("bot", "provider/model"); // empty file
    unlinkSync(path.join(dir, "model-credentials.json"));
    store.add({ id: "custom", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: keys[0]! });
    store.add({ id: "other", name: "Other", protocol: "anthropic-messages", baseUrl: "https://example.test", apiKey: keys[1]! });
    store.add({ id: "anthropic", name: "Anthropic", protocol: "built-in", apiKey: keys[2]! });
    select("anthropic/not-a-real-model"); assertFailure("bot", "anthropic/not-a-real-model");
    for (const key of keys) { select(`missing/${key}`); assertFailure("bot", "[redacted]"); }
    store.add({ id: "my-copy", name: "openai", protocol: "built-in", apiKey: "copy-key" });
    select("my-copy/model"); assertFailure("bot", "my-copy/model");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("custom endpoints validate URL and avoid metadata from a different native API", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "models-custom-"));
  try {
    const store = new CredentialStore(dir);
    const native = builtinProviders().find((p) => p.id === "openai")!.getModels().find((m) => m.api !== "openai-completions")!;
    store.add({ id: "openai", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "key", models: [{ id: native.id }] });
    const model = createRuntimeModels(store).getModel("openai", native.id)!;
    expect(model.contextWindow).toBe(DEFAULT_MODEL_METADATA.contextWindow);
    expect(model.maxTokens).toBe(DEFAULT_MODEL_METADATA.maxTokens);
    expect(model.reasoning).toBe(DEFAULT_MODEL_METADATA.reasoning);
    expect(model.input).toEqual(DEFAULT_MODEL_METADATA.input);
    expect(model.cost).toEqual(DEFAULT_MODEL_METADATA.cost);
    store.add({ id: "invalid", name: "Invalid", protocol: "openai-compatible", baseUrl: "relative", apiKey: "url-secret" });
    expect(() => createRuntimeModels(store)).toThrow("Invalid custom provider base URL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
