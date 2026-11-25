import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getSetting, setSetting } from "../../persistence/settings.ts";
import { CredentialStore, type StoredModel } from "./credentials.ts";
import { createRuntimeModels, DEFAULT_MODEL_SETTING, resolveModelForBot } from "./models.ts";
import { importPiProviders, PI_PROVIDER_IMPORT_SETTING } from "./providerImport.ts";
import { SecretStore, type SecretBackend } from "./secrets.ts";

let homeDir: string;
let agentDir: string;
let db: Database;
let credentials: CredentialStore;

beforeEach(async () => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-provider-import-"));
  agentDir = path.join(homeDir, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  db = new Database(":memory:");
  db.exec("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT)");
  credentials = await CredentialStore.open(homeDir, new SecretStore(homeDir));
});

afterEach(() => {
  db.close();
  rmSync(homeDir, { recursive: true, force: true });
});

function writePi(name: string, value: unknown): string {
  const file = path.join(agentDir, name);
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  return file;
}

function runImport(env: NodeJS.ProcessEnv = {}) {
  return importPiProviders({ db, credentials, homeDir, env });
}

const gatewayId = "example-gateway";
const gatewayUrl = "https://example.invalid/v1";
const authKey = "test-auth-key-value";
const modelKey = "test-model-key-value";
const builtinKey = "test-builtin-key-value";
const gateway = { baseUrl: gatewayUrl, api: "openai-completions", apiKey: modelKey };

function writeGatewayFixtures() {
  const model: StoredModel = {
    id: "catalog/example", name: "Example Model", contextWindow: 32000, maxTokens: 4096,
    reasoning: false, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  };
  const files = [
    writePi("auth.json", { [gatewayId]: { type: "api_key", key: authKey }, openai: { type: "api_key", key: builtinKey } }),
    writePi("models.json", { providers: { [gatewayId]: { ...gateway, name: "Example Gateway", models: [{ ...model, unsupported: { example: true } }] } } }),
    writePi("settings.json", { defaultProvider: gatewayId, defaultModel: model.id }),
  ];
  return { model, files };
}

test("imports custom and built-in providers, prefers literal auth keys, and seeds the Service default", async () => {
  const { model } = writeGatewayFixtures();
  const selected = `${gatewayId}/${model.id}`;
  const result = await runImport();
  expect(result.imported.toSorted()).toEqual([gatewayId, "openai"]);
  expect(result.seededModel).toBe(selected);
  expect(credentials.list()).toEqual([
    { id: gatewayId, name: "Example Gateway", protocol: "openai-compatible", baseUrl: gatewayUrl, models: [model], hasKey: true },
    { id: "openai", name: builtinProviders().find(({ id }) => id === "openai")!.name, protocol: "built-in", hasKey: true },
  ]);
  expect(credentials.getForRuntime(gatewayId)?.apiKey === authKey).toBeTrue();
  expect(credentials.getForRuntime("openai")?.apiKey === builtinKey).toBeTrue();
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBe(selected);
  expect(getSetting(db, PI_PROVIDER_IMPORT_SETTING)).not.toBeNull();
});

test("skips a second pass after deletion and leaves the Pi file contents and mtimes intact", async () => {
  const { files } = writeGatewayFixtures();
  const oldTime = new Date("2020-01-02T03:04:05Z");
  for (const file of files) utimesSync(file, oldTime, oldTime);
  const bytes = files.map((file) => readFileSync(file));

  await runImport();
  await credentials.remove(gatewayId);
  expect(await runImport()).toEqual({ imported: [] });
  expect(credentials.getForRuntime(gatewayId)).toBeUndefined();
  for (const [index, file] of files.entries()) {
    expect(readFileSync(file).equals(bytes[index]!)).toBeTrue();
    expect(statSync(file).mtimeMs).toBe(oldTime.getTime());
  }
});

test("preserves pre-existing provider credentials, the Service default, and the Bot model", async () => {
  writeGatewayFixtures();
  const existingKey = "test-existing-provider-key";
  await credentials.add({ id: gatewayId, name: "Existing Gateway", protocol: "anthropic-messages", baseUrl: gatewayUrl, apiKey: existingKey });
  setSetting(db, DEFAULT_MODEL_SETTING, "original/default");
  db.run("INSERT INTO bots VALUES ('bot', 'original/bot-model')");

  expect(await runImport()).toEqual({ imported: ["openai"] });
  expect(credentials.list().find(({ id }) => id === gatewayId)).toMatchObject({ name: "Existing Gateway", protocol: "anthropic-messages" });
  expect(credentials.getForRuntime(gatewayId)?.apiKey === existingKey).toBeTrue();
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBe("original/default");
  expect(db.query("SELECT * FROM bots").all()).toEqual([{ id: "bot", model: "original/bot-model" }]);
});

test("uses the explicit Pi agent directory and leaves an unknown built-in default unset", async () => {
  agentDir = path.join(homeDir, "custom-agent");
  mkdirSync(agentDir);
  writePi("auth.json", { anthropic: { type: "api_key", key: authKey } });
  writePi("settings.json", { defaultProvider: "openai", defaultModel: "unknown-model" });
  await credentials.add({ id: "openai", name: "Example Provider", protocol: "built-in", apiKey: builtinKey });

  expect(await runImport({ PI_CODING_AGENT_DIR: agentDir })).toEqual({ imported: ["anthropic"] });
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
});

test.each(["~", "~/custom-agent", "relative"])("uses the selected Pi agent directory for %s", async (selection) => {
  writePi("auth.json", { openai: { type: "api_key", key: builtinKey } });
  agentDir = selection === "~" ? homeDir : path.join(homeDir, "custom-agent");
  mkdirSync(agentDir, { recursive: true });
  writePi("auth.json", { anthropic: { type: "api_key", key: authKey } });
  const override = selection === "relative" ? path.relative(process.cwd(), agentDir) : selection;

  expect(await runImport({ PI_CODING_AGENT_DIR: override })).toEqual({ imported: ["anthropic"] });
  expect(credentials.getForRuntime("anthropic")?.apiKey === authKey).toBeTrue();
  expect(credentials.getForRuntime("openai")).toBeUndefined();
});

test("skips malformed, OAuth, command, environment and unsupported entries while importing usable literals", async () => {
  writePi("auth.json", {
    anthropic: { type: "oauth", access: "test-oauth-access" },
    openai: { type: "api_key", key: "!read-from-keychain" },
    malformed: null,
    "example-fallback": { type: "api_key", env: { KEY: "test-env-key-value" } },
  });
  writePi("models.json", { providers: {
    command: { ...gateway, apiKey: "!read-from-keychain" },
    environment: { ...gateway, apiKey: "prefix-${API_KEY}" },
    unsupported: { ...gateway, api: "openai-responses" },
    "missing-url": { ...gateway, baseUrl: undefined },
    "invalid-url": { ...gateway, baseUrl: "relative" },
    "bad/id": gateway,
    invalid: [],
    "example-fallback": { ...gateway, api: "anthropic-messages", models: [null, { id: 12 }, { id: "valid", maxTokens: "invalid" }] },
    "example-escaped": { ...gateway, apiKey: "$!example-$$key" },
  } });
  writePi("settings.json", { defaultProvider: "unsupported", defaultModel: "unavailable" });

  expect((await runImport()).imported.toSorted()).toEqual(["example-escaped", "example-fallback"]);
  expect(credentials.list().find(({ id }) => id === "example-fallback")).toMatchObject({ protocol: "anthropic-messages", models: [{ id: "valid" }] });
  expect(credentials.getForRuntime("example-fallback")?.apiKey === modelKey).toBeTrue();
  expect(credentials.getForRuntime("example-escaped")?.apiKey === "!example-$key").toBeTrue();
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
});

test("ignores malformed Pi JSON and still imports available credentials", async () => {
  writeFileSync(path.join(agentDir, "models.json"), "{ invalid json");
  writeFileSync(path.join(agentDir, "settings.json"), "null");
  writePi("auth.json", { openai: { type: "api_key", key: builtinKey } });

  expect(await runImport()).toEqual({ imported: ["openai"] });
  expect(getSetting(db, PI_PROVIDER_IMPORT_SETTING)).not.toBeNull();
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
});

test("accepts BOMs, comments and trailing commas in models.json and imports a built-in ID proxy as custom", async () => {
  const proxyName = 'Example "Proxy" // path /* label */';
  writeFileSync(path.join(agentDir, "auth.json"), `\uFEFF${JSON.stringify({
    openai: { type: "api_key", key: authKey },
    anthropic: { type: "api_key", key: builtinKey },
  })}`, { mode: 0o600 });
  writeFileSync(path.join(agentDir, "models.json"), `\uFEFF{
    // The proxy uses the API shared by its configured models.
    "providers": {
      "openai": {
        "name": ${JSON.stringify(proxyName)},
        "baseUrl": "${gatewayUrl}", /* keep the URL inside the string */
        "models": [{ "id": "proxy-model", "api": "openai-completions", }, { "id": "second-model", "api": "openai-completions" },],
      },
      "anthropic": { "baseUrl": "${gatewayUrl}", "models": [{ "id": "example-model" }] },
    },
  }`);
  writeFileSync(path.join(agentDir, "settings.json"), '\uFEFF{"defaultProvider":"openai","defaultModel":"proxy-model"}');

  expect(await runImport()).toEqual({ imported: ["openai", "anthropic"], seededModel: "openai/proxy-model" });
  expect(credentials.list()).toEqual([
    { id: "openai", name: proxyName, protocol: "openai-compatible", baseUrl: gatewayUrl, models: [{ id: "proxy-model" }, { id: "second-model" }], hasKey: true },
    { id: "anthropic", name: builtinProviders().find(({ id }) => id === "anthropic")!.name, protocol: "anthropic-messages", baseUrl: gatewayUrl, models: [{ id: "example-model" }], hasKey: true },
  ]);
  db.run("INSERT INTO bots VALUES ('bot', NULL)");
  expect(resolveModelForBot(db, credentials, "bot")).toMatchObject({ id: "proxy-model", provider: "openai", api: "openai-completions", baseUrl: gatewayUrl });
});

test("infers a custom provider route when every model shares the API and base URL", async () => {
  writePi("models.json", { providers: {
    [gatewayId]: { apiKey: modelKey, models: [
      { id: "first-model", api: "anthropic-messages", baseUrl: gatewayUrl },
      { id: "second-model", api: "anthropic-messages", baseUrl: gatewayUrl },
    ] },
    "conflicting-urls": { apiKey: modelKey, api: "anthropic-messages", models: [
      { id: "first-model", baseUrl: gatewayUrl },
      { id: "second-model", baseUrl: "https://other.example.invalid/v1" },
    ] },
    "conflicting-apis": { apiKey: modelKey, baseUrl: gatewayUrl, models: [
      { id: "first-model", api: "anthropic-messages" },
      { id: "second-model", api: "openai-completions" },
    ] },
  } });
  writePi("settings.json", { defaultProvider: gatewayId, defaultModel: "uncatalogued-model" });

  expect(await runImport()).toEqual({ imported: [gatewayId] });
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
  expect(credentials.list()).toEqual([
    { id: gatewayId, name: gatewayId, protocol: "anthropic-messages", baseUrl: gatewayUrl, models: [{ id: "first-model" }, { id: "second-model" }], hasKey: true },
  ]);
  expect(createRuntimeModels(credentials).getModel(gatewayId, "second-model")).toMatchObject({
    id: "second-model", provider: gatewayId, api: "anthropic-messages", baseUrl: gatewayUrl,
  });
});

test("an unset Bot resolves the seeded default for a configured model on the native Anthropic route", async () => {
  const model = { id: "custom-claude-model", name: "Custom Claude Model" };
  db.run("INSERT INTO bots VALUES ('bot', NULL)");
  writePi("auth.json", { anthropic: { type: "api_key", key: authKey } });
  writePi("models.json", { providers: { anthropic: { models: [model] } } });
  writePi("settings.json", { defaultProvider: "anthropic", defaultModel: model.id });

  expect(await runImport()).toEqual({ imported: ["anthropic"], seededModel: `anthropic/${model.id}` });
  expect(credentials.getForRuntime("anthropic")).toMatchObject({ protocol: "built-in", models: [model] });
  expect(resolveModelForBot(db, credentials, "bot")).toMatchObject({
    ...model, provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com",
  });
});

test("a model-level proxy leaves a pinned Anthropic Bot on the native route", async () => {
  const inheritedModel = "claude-sonnet-4-6";
  db.run("INSERT INTO bots VALUES ('bot', ?)", [`anthropic/${inheritedModel}`]);
  writePi("auth.json", { anthropic: { type: "api_key", key: authKey } });
  writePi("models.json", { providers: { anthropic: { models: [{ id: "proxy-model", baseUrl: gatewayUrl }] } } });
  writePi("settings.json", { defaultProvider: "anthropic", defaultModel: inheritedModel });

  expect(await runImport()).toEqual({ imported: ["anthropic"], seededModel: `anthropic/${inheritedModel}` });
  expect(credentials.list()).toEqual([{ id: "anthropic", name: "Anthropic", protocol: "built-in", models: [], hasKey: true }]);
  expect(resolveModelForBot(db, credentials, "bot")).toMatchObject({
    id: inheritedModel, provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com",
  });
  expect(createRuntimeModels(credentials).getModel("anthropic", "proxy-model")).toBeUndefined();
});

test("seeds an inherited Anthropic default when its provider-level proxy is preserved", async () => {
  const defaultModel = "claude-sonnet-4-6";
  writePi("auth.json", { anthropic: { type: "api_key", key: authKey } });
  writePi("models.json", { providers: { anthropic: { baseUrl: gatewayUrl, models: [{ id: "proxy-model" }] } } });
  writePi("settings.json", { defaultProvider: "anthropic", defaultModel });

  expect(await runImport()).toEqual({ imported: ["anthropic"], seededModel: `anthropic/${defaultModel}` });
  db.run("INSERT INTO bots VALUES ('bot', NULL)");
  expect(resolveModelForBot(db, credentials, "bot")).toMatchObject({
    id: defaultModel, provider: "anthropic", api: "anthropic-messages", baseUrl: gatewayUrl,
  });
});

test("drops model routes that conflict with provider routing and leaves the default unset for a dropped model", async () => {
  writePi("models.json", { providers: { [gatewayId]: { ...gateway, models: [
    { id: "inherited-route" },
    { id: "same-route", api: gateway.api, baseUrl: gatewayUrl },
    { id: "other-api", api: "anthropic-messages" },
    { id: "other-url", baseUrl: "https://other.example.invalid/v1" },
  ] } } });
  writePi("settings.json", { defaultProvider: gatewayId, defaultModel: "other-url" });

  expect((await runImport()).imported).toEqual([gatewayId]);
  expect(credentials.list()[0]?.models).toEqual([{ id: "inherited-route" }, { id: "same-route" }]);
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
});

test("leaves the default unset when a pre-existing provider uses a different model route", async () => {
  await credentials.add({ id: gatewayId, name: "Existing Gateway", protocol: "openai-compatible", baseUrl: gatewayUrl, apiKey: authKey });
  writePi("models.json", { providers: { [gatewayId]: { ...gateway, models: [{ id: "other-api", api: "anthropic-messages" }] } } });
  writePi("settings.json", { defaultProvider: gatewayId, defaultModel: "other-api" });

  expect(await runImport()).toEqual({ imported: [] });
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
});

test("skips base URLs with userinfo and keeps their password out of provider metadata", async () => {
  const passwordSentinel = "fixture-url-password-sentinel";
  writePi("models.json", { providers: {
    [gatewayId]: gateway,
    "password-url": { ...gateway, baseUrl: `https://fixture:${passwordSentinel}@example.invalid/v1` },
    "username-only-url": { ...gateway, baseUrl: "https://fixture@example.invalid/v1" },
    "model-password-url": { ...gateway, baseUrl: undefined, models: [{ id: "example-model", baseUrl: `https://:${passwordSentinel}@example.invalid/v1` }] },
  } });

  const result = await runImport();
  const secretIndex = readFileSync(path.join(homeDir, "secret-index.json"), "utf8");
  expect(JSON.stringify(credentials.list()).includes(passwordSentinel)).toBeFalse();
  expect(secretIndex.includes(passwordSentinel)).toBeFalse();
  expect(result.imported).toEqual([gatewayId]);
});

test("marks a pass with no Pi files and ignores files that appear later", async () => {
  expect(await runImport()).toEqual({ imported: [] });
  expect(getSetting(db, PI_PROVIDER_IMPORT_SETTING)).not.toBeNull();

  writeGatewayFixtures();
  expect(await runImport()).toEqual({ imported: [] });
  expect(credentials.list()).toEqual([]);
});

test("keeps literal keys out of other provider metadata and the Service default", async () => {
  writePi("auth.json", { [gatewayId]: { type: "api_key", key: authKey }, openai: { type: "api_key", key: builtinKey } });
  writePi("models.json", { providers: { [gatewayId]: { ...gateway, models: [{ id: "safe" }, { id: builtinKey }] } } });
  writePi("settings.json", { defaultProvider: gatewayId, defaultModel: authKey });

  expect((await runImport()).imported.toSorted()).toEqual([gatewayId, "openai"]);
  expect(credentials.getForRuntime(gatewayId)?.models?.length).toBe(1);
  expect(credentials.getForRuntime(gatewayId)?.models?.[0]?.id === "safe").toBeTrue();
  const secretIndex = readFileSync(path.join(homeDir, "secret-index.json"), "utf8");
  expect(secretIndex.includes(builtinKey) || secretIndex.includes(authKey)).toBeFalse();
  expect(getSetting(db, DEFAULT_MODEL_SETTING)).toBeNull();
});

test("a failed secret write can retry without overwriting providers imported on the first pass", async () => {
  writeGatewayFixtures();
  const values = new Map<string, string>();
  let unavailable = true;
  const backend: SecretBackend = {
    kind: "keychain",
    async get(account) { return values.get(account); },
    async set(account, value) {
      if (unavailable && value === builtinKey) throw new Error("Test backend unavailable");
      values.set(account, value);
    },
    async delete(account) { values.delete(account); },
  };
  credentials = await CredentialStore.open(homeDir, new SecretStore(homeDir, backend));
  await expect(runImport()).rejects.toThrow("Unable to import Pi model providers");
  expect(getSetting(db, PI_PROVIDER_IMPORT_SETTING)).toBeNull();
  expect(credentials.getForRuntime(gatewayId)?.apiKey === authKey).toBeTrue();

  unavailable = false;
  writePi("auth.json", { [gatewayId]: { type: "api_key", key: "test-changed-key" }, openai: { type: "api_key", key: builtinKey } });
  expect((await runImport()).imported).toEqual(["openai"]);
  expect(credentials.getForRuntime(gatewayId)?.apiKey === authKey).toBeTrue();
  expect(getSetting(db, PI_PROVIDER_IMPORT_SETTING)).not.toBeNull();
});
