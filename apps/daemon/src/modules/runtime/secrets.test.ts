import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { fallbackSecretValuesPath, fillSecretPlaceholders, redactSecretValues, SecretStore, type SecretBackend } from "./secrets.ts";

class MemoryKeychain implements SecretBackend {
  readonly kind = "keychain";
  readonly values = new Map<string, string>();
  readError?: Error;
  writeError?: Error;
  deleteError?: Error;

  async get(account: string): Promise<string | undefined> {
    if (this.readError) throw this.readError;
    return this.values.get(account);
  }

  async set(account: string, value: string): Promise<void> {
    if (this.writeError) throw this.writeError;
    this.values.set(account, value);
  }

  async delete(account: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    this.values.delete(account);
  }
}

const availableProbe = async () => ({ available: true } as const);
const unavailableProbe = async () => ({ available: false, reason: "no-backend" } as const);
const keychain = (backend: SecretBackend, probe: () => Promise<import("./bunSecrets.ts").BunSecretsProbeResult> = availableProbe) => ({ backend, probe });
const markerPath = (dataDir: string) => path.join(dataDir, "secrets", "keychain.json");
const unavailableError = "Unable to access secret storage";

async function expectUnavailableWithinDeadline(operation: Promise<unknown>): Promise<void> {
  const deadline = Promise.withResolvers<void>();
  const timer = setTimeout(deadline.resolve, 500);
  try {
    await expect(Promise.race([operation, deadline.promise])).rejects.toThrow(unavailableError);
  } finally {
    clearTimeout(timer);
  }
}

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "runtime-secrets-"));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("app secrets and Bot secrets use separate scopes", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  const app = store.forApp();
  const bot = store.forBot("app");
  expect(store.kind).toBe("checking");
  await app.save("token", "Provider credential", "app-value");
  expect(store.kind).toBe("keychain");
  expect(await bot.list()).toEqual([]);
  expect(await store.getBotSecretForRuntime("app", "token")).toBeUndefined();
  await bot.delete("token");
  expect(await store.getAppSecretForRuntime("token")).toBe("app-value");

  await bot.save("token", "Bot credential", "bot-value");
  expect(await app.list()).toEqual([{ name: "token", description: "Provider credential" }]);
  expect(await bot.list()).toEqual([{ name: "token", description: "Bot credential" }]);
  expect(await store.getAppSecretForRuntime("token")).toBe("app-value");
  expect(await store.getBotSecretForRuntime("app", "token")).toBe("bot-value");
  expect(Object.keys(bot).sort()).toEqual(["delete", "list", "save"]);
  expect(readdirSync(dataDir).sort()).toEqual(["secret-index.json", "secrets"]);
}));

test("Bots cannot get, list, or delete another Bot's secrets", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir, keychain(new MemoryKeychain()));
  await store.forBot("one").save("token", "First Bot credential", "one-value");
  expect(await store.getBotSecretForRuntime("two", "token")).toBeUndefined();
  expect(await store.forBot("two").list()).toEqual([]);
  await store.forBot("two").delete("token");
  expect(await store.getBotSecretForRuntime("one", "token")).toBe("one-value");

  await store.forBot("two").save("token", "Second Bot credential", "two-value");
  await store.forBot("two").delete("token");
  expect(await store.forBot("one").list()).toEqual([{ name: "token", description: "First Bot credential" }]);
  expect(await store.getBotSecretForRuntime("one", "token")).toBe("one-value");
  expect(await store.getBotSecretForRuntime("two", "token")).toBeUndefined();
}));

test("list and the 0600 metadata index contain only metadata and descriptions round-trip", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  const description = 'Token for "Q&A" 🔑';
  const value = "example-value-123";
  await store.forBot("one").save("api_token", description, value);
  expect(await store.forBot("one").list()).toEqual([{ name: "api_token", description }]);
  const indexPath = path.join(dataDir, "secret-index.json");
  expect(statSync(indexPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(indexPath, "utf8")).not.toContain(value);

  const original = openSync(indexPath, "r");
  try {
    await store.forBot("one").save("api_token", "Updated description", value);
    expect(readFileSync(original, "utf8")).toContain("Q&A");
  } finally {
    closeSync(original);
  }
  const reopened = new SecretStore(dataDir, keychain(backend));
  const list = await reopened.forBot("one").list();
  expect(list).toEqual([{ name: "api_token", description: "Updated description" }]);
  expect(JSON.stringify(list)).not.toContain(value);
  expect(await reopened.getBotSecretForRuntime("one", "api_token")).toBe(value);
  expect(readdirSync(dataDir).sort()).toEqual(["secret-index.json", "secrets"]);
}));

test("secret operations enforce the placeholder name format", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  const bot = store.forBot("one");
  for (const name of ["", "A", "héllo", "api token", "api/token", "a}", "name\n", "a".repeat(65)]) {
    await expect(bot.save(name, "Description", "value")).rejects.toThrow("Invalid secret name");
    await expect(bot.delete(name)).rejects.toThrow("Invalid secret name");
    await expect(store.getBotSecretForRuntime("one", name)).rejects.toThrow("Invalid secret name");
  }
  expect(backend.values.size).toBe(0);
  expect(await bot.list()).toEqual([]);
  const name = `a0-_${"z".repeat(60)}`;
  await bot.save(name, "Description", "value");
  expect(await store.getBotSecretForRuntime("one", name)).toBe("value");
}));

test("delete removes the backend value and the indexed listing", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  await store.forApp().save("token", "Provider credential", "value");
  await store.forApp().delete("token");
  expect(backend.values.size).toBe(0);
  expect(await store.getAppSecretForRuntime("token")).toBeUndefined();
  expect(await new SecretStore(dataDir, keychain(backend)).forApp().list()).toEqual([]);
}));

test("keychain accounts are isolated by Service data directory", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const first = new SecretStore(path.join(dataDir, "first"), keychain(backend));
  const second = new SecretStore(path.join(dataDir, "second"), keychain(backend));
  await first.forBot("one").save("token", "First Service credential", "first-value");
  await second.forBot("one").save("token", "Second Service credential", "second-value");
  expect(await first.getBotSecretForRuntime("one", "token")).toBe("first-value");
  expect(await second.getBotSecretForRuntime("one", "token")).toBe("second-value");
  await first.forBot("one").delete("token");
  expect(await second.getBotSecretForRuntime("one", "token")).toBe("second-value");
}));

test.each([
  ["the value is empty", "token", "Description", ""],
  ["the name contains the value", "my_credential", "Description", "credential"],
  ["the description contains the value", "token", "Pasted token: private_value", "private_value"],
])("save rejects a secret when %s", (_reason, name, description, value) => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const bot = new SecretStore(dataDir, keychain(backend)).forBot("one");
  const error = await bot.save(name, description, value).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  if (value) expect(inspect(error, { showHidden: true })).not.toContain(value);
  expect(await bot.list()).toEqual([]);
  expect(backend.values.size).toBe(0);
}));

test("save rejects a replacement value found in the existing description", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir, keychain(new MemoryKeychain()));
  const app = store.forApp();
  const value = "replacement-sentinel";
  const description = `Previous description with ${value}`;
  await app.save("token", description, "original-value");
  const error = await app.save("token", "Updated description", value).catch((error: unknown) => error);
  expect(String(error)).toBe("Error: Secret metadata must not contain the value");
  expect(inspect(error, { showHidden: true })).not.toContain(value);
  expect(await app.list()).toEqual([{ name: "token", description }]);
  expect(await store.getAppSecretForRuntime("token")).toBe("original-value");
}));

test("the file fallback is private, atomically replaced, and persistent", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir);
  expect(await store.status()).toMatchObject({ backend: "file" });
  await store.forBot("one").save("password", "Login password", "old-value");
  const fallbackDir = path.join(dataDir, "secrets");
  const valuesPath = path.join(fallbackDir, "secret-values.json");
  expect(statSync(fallbackDir).mode & 0o7777).toBe(0o700);
  expect(statSync(valuesPath).mode & 0o7777).toBe(0o600);
  const original = openSync(valuesPath, "r");
  try {
    await store.forBot("one").save("password", "New login description", "new-value");
    expect(readFileSync(original, "utf8")).toContain("old-value");
    expect(statSync(valuesPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(valuesPath, "utf8")).toContain("new-value");
  } finally {
    closeSync(original);
  }
  const reopened = new SecretStore(dataDir);
  expect(await reopened.getBotSecretForRuntime("one", "password")).toBe("new-value");
  expect(await reopened.forBot("one").list()).toEqual([{ name: "password", description: "New login description" }]);
  await reopened.forBot("one").delete("password");
  expect(readFileSync(valuesPath, "utf8")).not.toContain("new-value");
  expect(await reopened.forBot("one").list()).toEqual([]);
  expect(readdirSync(dataDir).sort()).toEqual(["secret-index.json", "secrets"]);
  expect(readdirSync(fallbackDir)).toEqual(["secret-values.json"]);
}));

test.each([0o700, 0o755])("fallback startup sets the directory to 0700 from mode %i", (mode) => withDataDir(async (dataDir) => {
  const fallbackDir = path.join(dataDir, "secrets");
  mkdirSync(fallbackDir);
  chmodSync(fallbackDir, mode);
  const store = new SecretStore(dataDir);
  await store.forApp().list();
  expect(statSync(fallbackDir).mode & 0o7777).toBe(0o700);
}));

test("a fallback file with broader permissions is rejected", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir);
  await store.forApp().save("token", "Provider credential", "value");
  const valuesPath = path.join(dataDir, "secrets", "secret-values.json");
  chmodSync(valuesPath, 0o644);
  await expect(store.getAppSecretForRuntime("token")).rejects.toThrow("Unable to read secret");
  await expect(store.forApp().save("token", "Update", "new-value")).rejects.toThrow("Unable to save secret");
  expect(readFileSync(valuesPath, "utf8")).not.toContain("new-value");
  expect(statSync(valuesPath).mode & 0o7777).toBe(0o644);
}));

test.each([
  ["save", "writeError", "Unable to save secret"],
  ["read", "readError", "Unable to read secret"],
  ["delete", "deleteError", "Unable to delete secret"],
] as const)("a backend %s failure exposes only a value-free error", (operation, backendError, message) => withDataDir(async (dataDir) => {
  const value = "sensitive-sentinel-value";
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  const app = store.forApp();
  await app.save("token", "Existing credential", value);
  backend[backendError] = new Error(`keychain ${operation} failed for ${value}`, { cause: value });
  const attempt = {
    save: () => app.save("token", "Updated credential", value),
    read: () => store.getAppSecretForRuntime("token"),
    delete: () => app.delete("token"),
  };
  const error = await attempt[operation]().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toBe(`Error: ${message}`);
  expect(inspect(error, { showHidden: true })).not.toContain(value);
  expect(JSON.stringify(error)).not.toContain(value);
  expect(JSON.stringify(await app.list())).not.toContain(value);
  expect(readFileSync(path.join(dataDir, "secret-index.json"), "utf8")).not.toContain(value);
  expect(readdirSync(dataDir).sort()).toEqual(["secret-index.json", "secrets"]);
}));

test("a failed backend save preserves the indexed metadata", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const app = new SecretStore(dataDir, keychain(backend)).forApp();
  backend.writeError = new Error("keychain write failed");
  await expect(app.save("token", "New credential", "value")).rejects.toThrow("Unable to save secret");
  expect(await app.list()).toEqual([]);
  expect(readdirSync(dataDir)).toEqual(["secrets"]);
  expect(readdirSync(path.join(dataDir, "secrets"))).toEqual(["keychain.json"]);
}));

test("status reports a live keychain read failure until a new selection succeeds", () => withDataDir(async (dataDir) => {
  const value = "unreadable-secret-sentinel";
  const backend = new MemoryKeychain();
  const probe = spyOn({ check: availableProbe }, "check");
  const store = new SecretStore(dataDir, keychain(backend, probe));
  await store.forApp().save("token", "App credential", value);
  expect(await store.status()).toEqual({ backend: "keychain" });

  backend.readError = new Error(`Unable to read ${value}`);
  await expect(store.getAppSecretForRuntime("token")).rejects.toThrow("Unable to read secret");
  expect(await store.status()).toEqual({ backend: "unavailable", reason: "The OS keychain is unavailable." });
  expect(store.kind).toBe("unavailable");
  expect(probe).toHaveBeenCalledTimes(1);

  delete backend.readError;
  expect(await store.getAppSecretForRuntime("token")).toBe(value);
  expect(await store.status()).toEqual({ backend: "keychain" });
  expect(probe).toHaveBeenCalledTimes(2);
}));

test("a failed individual backend delete leaves the Bot secret listed until retry succeeds", () => withDataDir(async (dataDir) => {
  const value = "sensitive-sentinel-value";
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  const bot = store.forBot("one");
  await bot.save("token", "Existing credential", value);
  backend.deleteError = new Error(`keychain delete failed for ${value}`);
  const error = await bot.delete("token").catch((error: unknown) => error);
  expect(await bot.list()).toEqual([{ name: "token", description: "Existing credential" }]);
  expect(await store.getBotSecretForRuntime("one", "token")).toBe(value);
  expect(String(error)).toBe("Error: Unable to delete secret");
  expect(inspect(error, { showHidden: true })).not.toContain(value);
  delete backend.deleteError;
  await bot.delete("token");
  expect(await bot.list()).toEqual([]);
  expect(await store.deleteAll("one")).toBe(0);
  expect(backend.values.size).toBe(0);
}));

test("redactKnown hides the diagnostic when an indexed value cannot be read", () => withDataDir(async (dataDir) => {
  const value = "unreadable-secret-sentinel";
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  await store.forApp().save("token", "App credential", value);
  backend.readError = new Error(`Unable to read ${value}`);
  expect(await store.redactKnown(`Provider rejected ${value}`, "one")).toBe("[redacted]");
}));

test("redactKnown reads just app and owning Bot values and hides unsafe placeholders", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir, keychain(new MemoryKeychain()));
  await store.forApp().save("credential", "App credential", "app-value");
  await store.forBot("one").save("short", "Bot token", "credential");
  await store.forBot("two").save("token", "Other Bot credential", "other-value");
  expect(await store.redactKnown("app-value credential other-value", "one"))
    .toBe("[redacted] {{secret:short}} other-value");
}));

test("status and operations share one lazy selection while app and Bot scopes can be created immediately", () => withDataDir(async (dataDir) => {
  const probe = Promise.withResolvers<{ available: true }>();
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const store = new SecretStore(dataDir, keychain(new MemoryKeychain(), () => {
    calls += 1;
    started.resolve();
    return probe.promise;
  }));
  const app = store.forApp();
  const bot = store.forBot("one");
  expect(store.kind).toBe("checking");
  expect(calls).toBe(0);
  const status = store.status();
  const save = app.save("token", "App credential", "app-value");
  const list = bot.list();
  const remove = store.deleteAll("one");
  await started.promise;
  expect(store.kind).toBe("checking");
  expect(calls).toBe(1);
  probe.resolve({ available: true });
  expect(await Promise.all([status, save, list, remove])).toEqual([{ backend: "keychain" }, undefined, [], 0]);
  expect(store.kind).toBe("keychain");
  expect(calls).toBe(1);
}));

test("a never-promoted directory uses file storage when the probe is unavailable", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend, unavailableProbe));
  expect(await store.status()).toEqual({ backend: "file", reason: "No OS keychain is available." });
  await store.forApp().save("token", "App credential", "app-value");
  expect(await store.getAppSecretForRuntime("token")).toBe("app-value");
  expect(existsSync(fallbackSecretValuesPath(dataDir))).toBeTrue();
  expect(existsSync(markerPath(dataDir))).toBeFalse();
  expect(backend.values.size).toBe(0);
}));

test("a fresh keychain save commits the private marker before writing and a restart fails closed", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const marker = markerPath(dataDir);
  const set = backend.set.bind(backend);
  const value = "fresh-keychain-sentinel";
  let markerContents: unknown;
  let files: string[] | undefined;
  backend.set = async (account, secret) => {
    markerContents = JSON.parse(readFileSync(marker, "utf8"));
    files = readdirSync(path.dirname(marker));
    await set(account, secret);
  };
  const store = new SecretStore(dataDir, keychain(backend));
  expect(existsSync(marker)).toBeFalse();
  await store.forApp().save("token", "App credential", value);
  expect(markerContents).toEqual({ version: 1, service: "com.omarchy.bot" });
  expect(files).toEqual(["keychain.json"]);
  expect(statSync(marker).mode & 0o7777).toBe(0o600);
  expect(readFileSync(marker, "utf8").includes(value)).toBeFalse();

  const restarted = new SecretStore(dataDir, keychain(backend, unavailableProbe));
  expect(await restarted.status()).toMatchObject({ backend: "unavailable" });
  await expect(restarted.getAppSecretForRuntime("token")).rejects.toThrow(unavailableError);
  await expect(restarted.forApp().save("other", "App credential", value)).rejects.toThrow(unavailableError);
  expect(existsSync(fallbackSecretValuesPath(dataDir))).toBeFalse();
}));

test("opening with a keychain migrates all indexed fallback values once", () => withDataDir(async (dataDir) => {
  const fallback = new SecretStore(dataDir);
  await fallback.forApp().save("token", "Provider credential", "app-value");
  await fallback.forBot("one").save("token", "Bot credential", "bot-value");
  const valuesPath = path.join(dataDir, "secrets", "secret-values.json");
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  expect(await store.forApp().list()).toEqual([{ name: "token", description: "Provider credential" }]);
  expect(existsSync(valuesPath)).toBe(false);
  expect(await store.getAppSecretForRuntime("token")).toBe("app-value");
  expect(await store.getBotSecretForRuntime("one", "token")).toBe("bot-value");
  backend.writeError = new Error("keychain should receive no further writes");
  expect(await new SecretStore(dataDir, keychain(backend)).getBotSecretForRuntime("one", "token")).toBe("bot-value");
  expect([...backend.values.values()].sort()).toEqual(["app-value", "bot-value"]);
  expect(existsSync(markerPath(dataDir))).toBeTrue();
}));

test.each([
  ["fallback", "keychain"],
  ["legacy", "keychain"],
  ["fallback", "file"],
  ["legacy", "file"],
] as const)("an unindexed %s value blocks migration to the %s backend", (source, kind) => withDataDir(async (dataDir) => {
  const fallback = new SecretStore(dataDir);
  await fallback.forApp().save("token", "App credential", "indexed-value");
  const fallbackPath = fallbackSecretValuesPath(dataDir);
  const legacyPath = path.join(dataDir, "secret-values.json");
  const indexedAccount = createHash("sha256").update(JSON.stringify(["app", "token"])).digest("hex");
  const unindexedAccount = createHash("sha256").update(JSON.stringify(["app", "unindexed"])).digest("hex");
  const unindexedValue = "unindexed-sensitive-sentinel";
  const indexed = { [indexedAccount]: "indexed-value" };
  const unindexed = { ...indexed, [unindexedAccount]: unindexedValue };
  const fallbackContents = JSON.stringify(source === "fallback" ? unindexed : indexed);
  const legacyContents = JSON.stringify(source === "legacy" ? unindexed : indexed);
  writeFileSync(fallbackPath, fallbackContents);
  writeFileSync(legacyPath, legacyContents, { mode: 0o600 });

  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, kind === "keychain" ? keychain(backend) : undefined);
  expect(await store.status()).toEqual({
    backend: "unavailable",
    reason: kind === "keychain" ? "Unable to promote secrets to the OS keychain." : "Unable to prepare file secret storage.",
  });
  await expect(store.getAppSecretForRuntime("token")).rejects.toThrow(unavailableError);
  expect(readFileSync(fallbackPath, "utf8")).toBe(fallbackContents);
  expect(readFileSync(legacyPath, "utf8")).toBe(legacyContents);
  expect(existsSync(markerPath(dataDir))).toBeFalse();
  expect(backend.values.size).toBe(0);
}));

test("a promoted directory fails closed after a failed probe or missing keychain API", () => withDataDir(async (dataDir) => {
  const value = "fallback-sensitive-sentinel";
  const fallback = new SecretStore(dataDir);
  await fallback.forBot("one").save("token", "Bot credential", value);
  const backend = new MemoryKeychain();
  const promoted = new SecretStore(dataDir, keychain(backend));
  await promoted.status();

  const failingProbe = async () => { throw new Error(value, { cause: value }); };
  for (const descriptor of [undefined, keychain(backend, unavailableProbe), keychain(backend, failingProbe)]) {
    const store = new SecretStore(dataDir, descriptor);
    const bot = store.forBot("one");
    expect(await store.status()).toEqual({ backend: "unavailable", reason: "The OS keychain is unavailable." });
    expect(store.kind).toBe("unavailable");
    for (const operation of [
      () => store.getBotSecretForRuntime("one", "token"),
      () => store.getAppSecretForRuntime("token"),
      () => bot.save("token", "New credential", value),
      () => bot.list(),
      () => bot.delete("token"),
      () => store.deleteAll("one"),
      () => store.redactKnown(value, "one"),
    ]) {
      const error = await operation().catch((error: unknown) => error);
      expect(String(error)).toBe(`Error: ${unavailableError}`);
      expect(inspect(error, { showHidden: true }).includes(value)).toBeFalse();
    }
    expect(existsSync(fallbackSecretValuesPath(dataDir))).toBeFalse();
    expect(backend.values.size).toBe(1);
  }
}));

test.each(["matches", "probe fails", "read fails", "item differs", "item is missing"])("a marker and fallback file recover safely when the keychain %s", (condition) => withDataDir(async (dataDir) => {
  const value = "crash-recovery-sentinel";
  const fallback = new SecretStore(dataDir);
  await fallback.forBot("one").save("token", "Bot credential", value);
  const valuesPath = fallbackSecretValuesPath(dataDir);
  const contents = readFileSync(valuesPath);
  const marker = markerPath(dataDir);
  // Seed the crash state after the marker was committed and before the fallback was removed.
  writeFileSync(marker, JSON.stringify({ version: 1, service: "com.omarchy.bot" }), { mode: 0o600 });
  const backend = new MemoryKeychain();
  const namespace = createHash("sha256").update(realpathSync(dataDir)).digest("hex");
  const account = createHash("sha256").update(JSON.stringify(["bot:one", "token"])).digest("hex");
  if (condition !== "item is missing") backend.values.set(`${namespace}:${account}`, condition === "item differs" ? "different-value" : value);
  backend.writeError = new Error("Recovery must only read the keychain");
  if (condition === "read fails") backend.readError = new Error(value);
  const store = new SecretStore(dataDir, keychain(backend, condition === "probe fails" ? unavailableProbe : availableProbe));

  const status = await store.status();
  if (condition === "matches") {
    expect(status).toEqual({ backend: "keychain" });
    expect(existsSync(valuesPath)).toBeFalse();
    expect(await store.getBotSecretForRuntime("one", "token") === value).toBeTrue();
  } else {
    expect(status).toEqual({
      backend: "unavailable",
      reason: condition === "probe fails" ? "The OS keychain is unavailable." : "Unable to verify the OS keychain copy.",
    });
    await expect(store.getBotSecretForRuntime("one", "token")).rejects.toThrow(unavailableError);
    await expect(store.forBot("one").save("other", "New credential", value)).rejects.toThrow(unavailableError);
    await expect(store.deleteAll("one")).rejects.toThrow(unavailableError);
    expect(readFileSync(valuesPath).equals(contents)).toBeTrue();
    expect(readdirSync(path.dirname(valuesPath)).sort()).toEqual(["keychain.json", "secret-values.json"]);
  }
  expect(statSync(marker).mode & 0o7777).toBe(0o600);
}));

test("recovery retains both values files if the marker directory cannot be synced", () => withDataDir(async (dataDir) => {
  const value = "crash-recovery-sentinel";
  const legacyPath = path.join(dataDir, "secret-values.json");
  const fallbackPath = fallbackSecretValuesPath(dataDir);
  const backend = new MemoryKeychain();
  await new SecretStore(dataDir, keychain(backend)).forApp().save("token", "App credential", value);
  const account = createHash("sha256").update(JSON.stringify(["app", "token"])).digest("hex");
  const namespace = createHash("sha256").update(realpathSync(dataDir)).digest("hex");
  const legacyContents = JSON.stringify({ [account]: value });
  const fallbackContents = JSON.stringify({ [`${namespace}:${account}`]: value });
  writeFileSync(legacyPath, legacyContents, { mode: 0o600 });
  writeFileSync(fallbackPath, fallbackContents, { mode: 0o600 });

  const markerDirectory = statSync(path.dirname(markerPath(dataDir)));
  const syncedDirectories: [number, number][] = [];
  const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const { dev, ino } = fs.fstatSync(fd);
    syncedDirectories.push([dev, ino]);
    throw new Error(value);
  });
  try {
    const store = new SecretStore(dataDir, keychain(backend));
    if (process.platform === "win32") {
      expect(await store.status()).toEqual({ backend: "keychain" });
      expect(sync).not.toHaveBeenCalled();
      expect(existsSync(legacyPath)).toBeFalse();
      expect(existsSync(fallbackPath)).toBeFalse();
      return;
    }
    expect(await store.status()).toEqual({ backend: "unavailable", reason: "Unable to verify the OS keychain copy." });
    expect(syncedDirectories).toEqual([[markerDirectory.dev, markerDirectory.ino]]);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyContents);
    expect(readFileSync(fallbackPath, "utf8")).toBe(fallbackContents);
    expect(existsSync(markerPath(dataDir))).toBeTrue();
  } finally {
    sync.mockRestore();
  }
}));

test("a moved fallback file can be promoted to a keychain", () => withDataDir(async (dataDir) => {
  const originalDir = path.join(dataDir, "original");
  const movedDir = path.join(dataDir, "moved");
  await new SecretStore(originalDir).forApp().save("token", "Provider credential", "moved-value");
  renameSync(originalDir, movedDir);

  const store = new SecretStore(movedDir, keychain(new MemoryKeychain()));
  expect(await store.getAppSecretForRuntime("token")).toBe("moved-value");
  expect(existsSync(path.join(movedDir, "secrets", "secret-values.json"))).toBe(false);
}));

test("a moved path-bound fallback file is retained when any indexed account is missing", () => withDataDir(async (dataDir) => {
  const originalDir = path.join(dataDir, "original");
  const movedDir = path.join(dataDir, "moved");
  const fallback = new SecretStore(originalDir);
  await fallback.forApp().save("available", "Available credential", "available-value");
  await fallback.forApp().save("token", "Provider credential", "moved-value");
  const namespace = createHash("sha256").update(realpathSync(originalDir)).digest("hex");
  const availableAccount = createHash("sha256").update(JSON.stringify(["app", "available"])).digest("hex");
  const tokenAccount = createHash("sha256").update(JSON.stringify(["app", "token"])).digest("hex");
  const originalValues = JSON.stringify({
    [availableAccount]: "available-value",
    [`${namespace}:${tokenAccount}`]: "moved-value",
  });
  writeFileSync(path.join(originalDir, "secrets", "secret-values.json"), originalValues);
  renameSync(originalDir, movedDir);

  const backend = new MemoryKeychain();
  const store = new SecretStore(movedDir, keychain(backend));
  await expect(store.getAppSecretForRuntime("token")).rejects.toThrow(unavailableError);
  expect(readFileSync(path.join(movedDir, "secrets", "secret-values.json"), "utf8")).toBe(originalValues);
  expect(backend.values.size).toBe(0);
}));

test("a live fallback store rejects writes after keychain promotion", () => withDataDir(async (dataDir) => {
  const fallback = new SecretStore(dataDir);
  const bot = fallback.forBot("one");
  await bot.save("token", "Bot credential", "fallback-value");
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  expect(await store.getBotSecretForRuntime("one", "token")).toBe("fallback-value");
  await store.forBot("one").save("token", "New credential", "keychain-value");

  const value = "stale-write-sentinel";
  const error = await bot.save("token", "Stale credential", value).catch((error: unknown) => error);
  expect(String(error)).toBe(`Error: ${unavailableError}`);
  expect(inspect(error, { showHidden: true })).not.toContain(value);
  await expect(bot.delete("token")).rejects.toThrow(unavailableError);
  await expect(fallback.deleteAll("one")).rejects.toThrow(unavailableError);
  expect(await fallback.status()).toMatchObject({ backend: "unavailable" });
  expect(existsSync(path.join(dataDir, "secrets", "secret-values.json"))).toBe(false);
  expect(await new SecretStore(dataDir, keychain(backend)).getBotSecretForRuntime("one", "token")).toBe("keychain-value");
}));

test.each(["keychain", "file"])("opening with a %s backend migrates the earlier root-level fallback file", (kind) => withDataDir(async (dataDir) => {
  const account = createHash("sha256").update(JSON.stringify(["bot:one", "token"])).digest("hex");
  const valuesPath = path.join(dataDir, "secret-values.json");
  writeFileSync(valuesPath, JSON.stringify({ [account]: "legacy-value" }), { mode: 0o600 });
  writeFileSync(path.join(dataDir, "secret-index.json"), JSON.stringify([
    { scope: "bot:one", name: "token", description: "Earlier credential" },
  ]), { mode: 0o600 });
  const store = new SecretStore(dataDir, kind === "keychain" ? keychain(new MemoryKeychain()) : undefined);
  expect(await store.getBotSecretForRuntime("one", "token")).toBe("legacy-value");
  expect(existsSync(valuesPath)).toBe(false);
}));

test.each(["keychain", "file"])("unsafe legacy metadata is handled when selecting the %s backend", (kind) => withDataDir(async (dataDir) => {
  const value = "legacy-description-sentinel";
  const exposedName = "legacy-name-sentinel";
  const tokenAccount = createHash("sha256").update(JSON.stringify(["app", "token"])).digest("hex");
  const exposedAccount = createHash("sha256").update(JSON.stringify(["app", exposedName])).digest("hex");
  writeFileSync(path.join(dataDir, "secret-values.json"), JSON.stringify({
    [tokenAccount]: value,
    [exposedAccount]: exposedName,
  }), { mode: 0o600 });
  const indexPath = path.join(dataDir, "secret-index.json");
  writeFileSync(indexPath, JSON.stringify([
    { scope: "app", name: "token", description: `Pasted ${value} twice: ${value}` },
    { scope: "app", name: exposedName, description: "Credential" },
  ]), { mode: 0o600 });

  const store = new SecretStore(dataDir, kind === "keychain" ? keychain(new MemoryKeychain()) : undefined);
  if (kind === "keychain") {
    expect(await store.status()).toMatchObject({ backend: "unavailable" });
    await expect(store.forApp().list()).rejects.toThrow(unavailableError);
    expect(existsSync(markerPath(dataDir))).toBeFalse();
    expect(existsSync(path.join(dataDir, "secret-values.json"))).toBeTrue();
    return;
  }
  const list = await store.forApp().list();
  expect(list).toEqual([{ name: "token", description: "Pasted [redacted] twice: [redacted]" }]);
  expect(readFileSync(indexPath, "utf8")).not.toContain(value);
  expect(readFileSync(indexPath, "utf8")).not.toContain(exposedName);
  expect(await store.getAppSecretForRuntime("token")).toBe(value);
}));

test.each(["write rejection", "readback mismatch"])("a failed fallback migration preserves the value after a %s", (failure) => withDataDir(async (dataDir) => {
  const value = "fallback-sensitive-sentinel";
  const fallback = new SecretStore(dataDir);
  await fallback.forBot("one").save("token", "Bot credential", value);
  const valuesPath = path.join(dataDir, "secrets", "secret-values.json");
  const backend = new MemoryKeychain();
  const get = backend.get.bind(backend);
  if (failure === "write rejection") backend.writeError = new Error(`keychain write failed for ${value}`);
  else backend.get = async () => "unexpected-value";
  const store = new SecretStore(dataDir, keychain(backend));
  const error = await store.getBotSecretForRuntime("one", "token").catch((error: unknown) => error);
  expect(String(error)).toBe(`Error: ${unavailableError}`);
  expect(inspect(error, { showHidden: true })).not.toContain(value);
  expect(readFileSync(valuesPath, "utf8")).toContain(value);
  expect(await new SecretStore(dataDir).getBotSecretForRuntime("one", "token")).toBe(value);
  expect(await store.status()).toMatchObject({ backend: "unavailable" });
  await expect(store.forBot("one").save("new_token", "New credential", value)).rejects.toThrow(unavailableError);
  expect(existsSync(markerPath(dataDir))).toBeFalse();
  delete backend.writeError;
  backend.get = get;
  expect(await new SecretStore(dataDir, keychain(backend)).getBotSecretForRuntime("one", "token")).toBe(value);
  expect(existsSync(valuesPath)).toBe(false);
}));

test("a stalled keychain read after a successful probe times out and retains the fallback", () => withDataDir(async (dataDir) => {
  const value = "fallback-sensitive-sentinel";
  await new SecretStore(dataDir).forApp().save("token", "App credential", value);
  const valuesPath = fallbackSecretValuesPath(dataDir);
  const contents = readFileSync(valuesPath, "utf8");
  const backend = new MemoryKeychain();
  backend.get = () => new Promise(() => {});
  const descriptor = { ...keychain(backend), operationTimeoutMs: 20 };
  const store = new SecretStore(dataDir, descriptor);

  await expectUnavailableWithinDeadline(store.getAppSecretForRuntime("token"));
  expect(await store.status()).toEqual({ backend: "unavailable", reason: "Unable to promote secrets to the OS keychain." });
  expect(readFileSync(valuesPath, "utf8")).toBe(contents);
  expect(existsSync(markerPath(dataDir))).toBeFalse();
}), 1_000);

test("a timed-out migration write must settle before another store can promote", () => withDataDir(async (dataDir) => {
  const value = "fallback-sensitive-sentinel";
  await new SecretStore(dataDir).forApp().save("token", "App credential", value);
  const valuesPath = fallbackSecretValuesPath(dataDir);
  const contents = readFileSync(valuesPath, "utf8");
  const backend = new MemoryKeychain();
  const release = Promise.withResolvers<void>();
  const set = backend.set.bind(backend);
  backend.set = async (account, value) => {
    await release.promise;
    await set(account, value);
  };
  const descriptor = { ...keychain(backend), operationTimeoutMs: 20 };
  const store = new SecretStore(dataDir, descriptor);

  await expectUnavailableWithinDeadline(store.getAppSecretForRuntime("token"));
  backend.set = set;
  const retry = new SecretStore(dataDir, descriptor);
  await expectUnavailableWithinDeadline(retry.forApp().save("token", "Updated credential", "new-value"));
  expect(readFileSync(valuesPath, "utf8")).toBe(contents);
  expect(existsSync(markerPath(dataDir))).toBeFalse();

  release.resolve();
  await Bun.sleep(0);
  await retry.forApp().save("token", "Updated credential", "new-value");
  expect(await retry.getAppSecretForRuntime("token")).toBe("new-value");
  expect(existsSync(valuesPath)).toBeFalse();
}), 1_000);

test("a timed-out live delete cannot remove a later save", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const descriptor = { ...keychain(backend), operationTimeoutMs: 20 };
  const store = new SecretStore(dataDir, descriptor);
  const app = store.forApp();
  await app.save("token", "App credential", "initial-value");
  const retry = new SecretStore(dataDir, descriptor);
  expect(await retry.status()).toEqual({ backend: "keychain" });

  const release = Promise.withResolvers<void>();
  const remove = backend.delete.bind(backend);
  backend.delete = async (account) => {
    await release.promise;
    await remove(account);
  };
  await expectUnavailableWithinDeadline(app.delete("token"));
  expect(await store.status()).toEqual({ backend: "unavailable", reason: "The OS keychain is unavailable." });
  await expectUnavailableWithinDeadline(retry.forApp().save("token", "Updated credential", "new-value"));

  release.resolve();
  await Bun.sleep(0);
  await retry.forApp().save("token", "Updated credential", "new-value");
  expect(await store.getAppSecretForRuntime("token")).toBe("new-value");
}), 1_000);

test("deleteAll removes every secret for one Bot and preserves other scopes", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  await store.forApp().save("token", "Provider credential", "app-value");
  await store.forBot("two").save("token", "Other Bot credential", "other-value");
  await store.forBot("one").save("token", "Bot credential", "one-value");
  await store.forBot("one").save("password", "Bot password", "one-password");
  expect(await store.deleteAll("one")).toBe(2);
  expect(await store.deleteAll("one")).toBe(0);
  expect(await store.forBot("one").list()).toEqual([]);
  expect(await store.getBotSecretForRuntime("one", "token")).toBeUndefined();
  expect(await store.getBotSecretForRuntime("one", "password")).toBeUndefined();
  expect(await store.getBotSecretForRuntime("two", "token")).toBe("other-value");
  expect(await store.getAppSecretForRuntime("token")).toBe("app-value");
  expect([...backend.values.values()].sort()).toEqual(["app-value", "other-value"]);
}));

test("deleteAll leaves failed entries listed for retry and removes the rest", () => withDataDir(async (dataDir) => {
  const backend = new MemoryKeychain();
  const store = new SecretStore(dataDir, keychain(backend));
  const bot = store.forBot("one");
  const value = "delete-failure-sentinel";
  await bot.save("token", "Bot credential", value);
  await bot.save("password", "Bot password", "other-value");
  const remove = backend.delete.bind(backend);
  backend.delete = async (account) => {
    if (backend.values.get(account) === value) throw new Error(`keychain delete failed for ${value}`);
    await remove(account);
  };

  const error = await store.deleteAll("one").catch((error: unknown) => error);
  expect(String(error)).toBe("Error: Unable to delete secret");
  expect(inspect(error, { showHidden: true })).not.toContain(value);
  expect(await bot.list()).toEqual([{ name: "token", description: "Bot credential" }]);
  expect([...backend.values.values()]).toEqual([value]);
  backend.delete = remove;
  expect(await store.deleteAll("one")).toBe(1);
  expect(await bot.list()).toEqual([]);
  expect(backend.values.size).toBe(0);
}));

test("deleteAll rejects an empty Bot id", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir, keychain(new MemoryKeychain()));
  await expect(store.deleteAll("")).rejects.toThrow("Bot id is required");
}));

test("deleteAll occupies one slot in the write queue", () => withDataDir(async (dataDir) => {
  const store = new SecretStore(dataDir, keychain(new MemoryKeychain()));
  const bot = store.forBot("one");
  const [, removed] = await Promise.all([
    bot.save("token", "Earlier credential", "earlier-value"),
    store.deleteAll("one"),
    bot.save("token", "Later credential", "later-value"),
  ]);
  expect(removed).toBe(1);
  expect(await store.getBotSecretForRuntime("one", "token")).toBe("later-value");
}));

test("concurrent writes preserve all entries for a Service data directory", () => withDataDir(async (dataDir) => {
  const first = new SecretStore(dataDir);
  const second = new SecretStore(dataDir);
  await Promise.all([
    first.forApp().save("a", "First credential", "value-a"),
    second.forApp().save("b", "Second credential", "value-b"),
  ]);
  expect(await first.forApp().list()).toEqual([
    { name: "a", description: "First credential" },
    { name: "b", description: "Second credential" },
  ]);
  expect(await first.getAppSecretForRuntime("a")).toBe("value-a");
  expect(await second.getAppSecretForRuntime("b")).toBe("value-b");
}));

test("different paths to one Service data directory share the same backend namespace and write queue", () => withDataDir(async (dataDir) => {
  const actualDir = path.join(dataDir, "actual");
  const aliasDir = path.join(dataDir, "alias");
  mkdirSync(actualDir);
  symlinkSync(actualDir, aliasDir, "dir");
  const backend = new MemoryKeychain();
  const first = new SecretStore(actualDir, keychain(backend));
  const second = new SecretStore(aliasDir, keychain(backend));
  await Promise.all([
    first.forApp().save("a", "First credential", "value-a"),
    second.forApp().save("b", "Second credential", "value-b"),
  ]);
  expect(await first.getAppSecretForRuntime("b")).toBe("value-b");
  expect(await second.getAppSecretForRuntime("a")).toBe("value-a");
}));

test("fillSecretPlaceholders fills multiple exact names and records each used value", () => {
  const values = new Map([["api-token", "private-token"], ["user_1", "private-user"], ["unused", "unused-value"]]);
  const resolved: string[] = [];
  const result = fillSecretPlaceholders("{{secret:api-token}}/{{secret:user_1}}/{{secret:api-token}}", (name) => {
    resolved.push(name);
    return values.get(name);
  });
  expect(result.text).toBe("private-token/private-user/private-token");
  expect([...result.used]).toEqual([["api-token", "private-token"], ["user_1", "private-user"]]);
  expect(resolved).toEqual(["api-token", "user_1"]);
});

test("fillSecretPlaceholders names a missing placeholder without revealing any resolved value", () => {
  const value = "sensitive-sentinel-value";
  const fill = () => fillSecretPlaceholders("{{secret:token}} {{secret:missing}}", (name) => name === "token" ? value : undefined);
  expect(fill).toThrow("Missing secret: {{secret:missing}}");
  try {
    fill();
  } catch (error) {
    expect(inspect(error, { showHidden: true })).not.toContain(value);
  }
});

test("fillSecretPlaceholders leaves text without exact placeholders unchanged", () => {
  const text = `{{secret: token}} {{secret:token }} {{secret:}} {secret:token} {{Secret:token}} {{secret:UPPER}} {{secret:${"a".repeat(65)}}}`;
  const filled = fillSecretPlaceholders(text, () => { throw new Error("Unexpected lookup"); });
  expect(filled.text).toBe(text);
  expect(filled.used.size).toBe(0);
  expect(redactSecretValues(text, filled.used)).toBe(text);
});

test("fillSecretPlaceholders inserts a value literally without resolving placeholders inside it", () => {
  const value = "{{secret:nested}}";
  const filled = fillSecretPlaceholders("{{secret:token}}", (name) => name === "token" ? value : undefined);
  expect(filled.text).toBe(value);
  expect([...filled.used]).toEqual([["token", value]]);
});

test("redactSecretValues removes repeated diagnostic values and gives longer matches priority", () => {
  const shortValue = "private-abc";
  const longValue = `${shortValue}-full`;
  const values = new Map([["short", shortValue], ["long", longValue], ["unused", "unused-value"]]);
  const { used } = fillSecretPlaceholders("{{secret:short}} {{secret:long}}", (name) => values.get(name));
  const diagnostic = `Error: ${longValue} rejected ${shortValue}. Retry: ${longValue}. Other: unused-value.`;
  const redacted = redactSecretValues(diagnostic, used);
  expect(redacted).toBe("Error: {{secret:long}} rejected {{secret:short}}. Retry: {{secret:long}}. Other: unused-value.");
  for (const value of used.values()) expect(redacted).not.toContain(value);
});

test("fill and redact preserve literal newlines and shell metacharacters", () => {
  const value = "line one\n$(command) ; | & < > ' \" \\ [x] .* $& $1";
  const { text, used } = fillSecretPlaceholders("run {{secret:token}}", () => value);
  expect(text).toBe(`run ${value}`);
  const redacted = redactSecretValues(`${text}\ncopy=${value}`, used);
  expect(redacted).toBe("run {{secret:token}}\ncopy={{secret:token}}");
  expect(redacted).not.toContain(value);
});

test("redactSecretValues does not rescan generated placeholders containing a used value", () => {
  const values = new Map([["token", "long-private-value"], ["short", "token"]]);
  const { used } = fillSecretPlaceholders("{{secret:token}} {{secret:short}}", (name) => values.get(name));
  expect(redactSecretValues("Error: long-private-value rejected token", used))
    .toBe("Error: {{secret:token}} rejected {{secret:short}}");
});
