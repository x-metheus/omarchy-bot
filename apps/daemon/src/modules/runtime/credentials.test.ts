import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credentials.ts";

test("credential file is atomic, protected, redacted and round trips", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "credentials-"));
  try {
    const store = new CredentialStore(dir);
    store.add({ id: "custom", name: "Custom", protocol: "openai-compatible", baseUrl: "https://example.test", apiKey: "secret-example" });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "model-credentials.json")).mode & 0o777).toBe(0o600);
    expect(store.getForRuntime("custom")?.apiKey.length).toBe(14);
    expect(JSON.stringify(store.list())).not.toContain("secret-example");
    expect(JSON.parse(readFileSync(path.join(dir, "model-credentials.json"), "utf8"))).toHaveLength(1);
    const oldFile = openSync(path.join(dir, "model-credentials.json"), "r");
    store.remove("custom");
    expect(readFileSync(oldFile, "utf8")).toContain("secret-example");
    closeSync(oldFile);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir)).toEqual(["model-credentials.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("malformed credentials and invalid inputs fail without disclosing keys", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "credentials-"));
  try {
    const store = new CredentialStore(dir);
    writeFileSync(path.join(dir, "model-credentials.json"), '{"apiKey":"secret-example"');
    expect(() => store.list()).toThrow("Unable to read model credential store");
    try { store.list(); } catch (e) { expect(String(e)).not.toContain("secret-example"); }
    expect(() => store.add({ id: "bad/id", name: "x", protocol: "built-in", apiKey: "secret-example" })).toThrow("Invalid model provider");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("whole-store projection drops unrecognized catalog data and copies inputs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "credentials-projection-"));
  try {
    const file = path.join(dir, "model-credentials.json");
    const keys = ["secret-example", "other-secret", "builtin-secret"];
    writeFileSync(file, JSON.stringify([
      { id: "one", name: "One", protocol: "built-in", apiKey: keys[0], models: [{ id: "first", input: ["text", "image"], extra: keys[1], cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, secret: keys[2] } }] },
      { id: "two", name: "Two", protocol: "built-in", apiKey: keys[1], models: [{ id: "second", input: { secret: keys[0] }, contextWindow: { secret: keys[2] }, cost: { input: keys[0] } }] },
      { id: "three", name: "Three", protocol: "built-in", apiKey: keys[2], models: [{ id: keys[0] }, { id: keys[1] }, { id: "safe", name: keys[1] }, { id: "safe-id", name: "Safe" }] },
    ]));
    const store = new CredentialStore(dir);
    const projection = store.list();
    for (const key of keys) expect(JSON.stringify(projection).includes(key)).toBe(false);
    expect(projection[0]?.models?.[0]?.input).toEqual(["text", "image"]);
    expect(projection[1]?.models?.[0]).toEqual({ id: "second" });
    expect(projection[2]?.models).toEqual([{ id: "safe-id", name: "Safe" }]);
    projection[0]?.models?.[0]?.input?.push("text");
    expect(store.list()[0]?.models?.[0]?.input).toEqual(["text", "image"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const modelProvider = { id: "custom", name: "Custom", protocol: "built-in", apiKey: "model-key-example" } as const;
const exaKey = "exa-key-example";

function withCredentialStore(check: (store: CredentialStore, file: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "credentials-search-"));
  try { check(new CredentialStore(dir), path.join(dir, "model-credentials.json")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("Exa key round trips in the same private file as model credentials", () => {
  withCredentialStore((store, file) => {
    store.add(modelProvider);
    store.setWebSearchKey("exa", `${exaKey} \t\n`);
    const reopened = new CredentialStore(path.dirname(file));
    expect(reopened.getWebSearchKey("exa")).toBe(exaKey);
    expect(reopened.getForRuntime(modelProvider.id)).toEqual(modelProvider);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ webSearchKeys: { exa: exaKey } });
    expect(readdirSync(path.dirname(file))).toEqual(["model-credentials.json"]);
  });
});

test("provider credentials load with a missing or unrecognized web search key section", () => {
  withCredentialStore((store, file) => {
    for (const data of [
      [modelProvider],
      { providers: [modelProvider] },
      { providers: [modelProvider], webSearchKeys: { futureProvider: "future-key", exa: 42 } },
    ]) {
      writeFileSync(file, JSON.stringify(data));
      expect(store.getWebSearchKey("exa")).toBeUndefined();
      expect(store.getAllForRuntime()).toEqual([modelProvider]);
    }
  });
});

test("provider projections exclude both forms of an Exa key with trailing whitespace", () => {
  withCredentialStore((store, file) => {
    const pastedKey = `${exaKey} \t\n`;
    const provider = { ...modelProvider, models: [{ id: exaKey }, { id: pastedKey }, { id: "safe" }] };
    writeFileSync(file, JSON.stringify({ providers: [provider], webSearchKeys: { exa: pastedKey } }));
    expect(store.getWebSearchKey("exa")).toBe(exaKey);
    expect(store.list()).toEqual([{ id: "custom", name: "Custom", protocol: "built-in", hasKey: true, models: [{ id: "safe" }] }]);
    expect(JSON.stringify(store.list())).not.toContain(exaKey);
    expect(JSON.stringify(store.list())).not.toContain(JSON.stringify(pastedKey).slice(1, -1));
  });
});

test("removing a model provider preserves the Exa key", () => {
  withCredentialStore((store) => {
    store.setWebSearchKey("exa", exaKey);
    store.add(modelProvider);
    store.remove(modelProvider.id);
    expect(store.getForRuntime(modelProvider.id)).toBeUndefined();
    expect(store.getWebSearchKey("exa")).toBe(exaKey);
  });
});

test("a credential file containing only web search keys loads with no model providers", () => {
  withCredentialStore((store, file) => {
    writeFileSync(file, JSON.stringify({ webSearchKeys: { exa: exaKey } }));
    expect(store.getWebSearchKey("exa")).toBe(exaKey);
    expect(store.getAllForRuntime()).toEqual([]);
    expect(store.list()).toEqual([]);
    for (const providers of [null, {}, "invalid", [{ id: "incomplete" }]]) {
      writeFileSync(file, JSON.stringify({ providers, webSearchKeys: { exa: exaKey } }));
      expect(() => store.getWebSearchKey("exa")).toThrow("Unable to read model credential store");
    }
  });
});

test("credential writes preserve unknown sections and search providers after reopening", () => {
  withCredentialStore((store, file) => {
    const unknown = { futureSearchKeys: { other: "other-key" }, futureMetadata: ["work", { enabled: true }] };
    const webSearchKeys = { exa: exaKey, futureProvider: "future-key" };
    writeFileSync(file, JSON.stringify({ ...unknown, providers: [], webSearchKeys }));
    store.add(modelProvider);
    const reopened = new CredentialStore(path.dirname(file));
    expect(reopened.getAllForRuntime()).toEqual([modelProvider]);
    expect(reopened.getWebSearchKey("exa")).toBe(exaKey);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...unknown, providers: [modelProvider], webSearchKeys });
    reopened.remove(modelProvider.id);
    reopened.setWebSearchKey("exa", "updated-key  ");
    const updated = new CredentialStore(path.dirname(file));
    expect(updated.getAllForRuntime()).toEqual([]);
    expect(updated.getWebSearchKey("exa")).toBe("updated-key");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...unknown, providers: [], webSearchKeys: { ...webSearchKeys, exa: "updated-key" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
