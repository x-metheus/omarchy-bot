import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/async";
import { isCallExpression, isIdentifier, isPropertyAccessExpression, type Node } from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { BunSecretsBackend, probeBunSecrets, type BunSecretsApi } from "./bunSecrets.ts";

type Account = Parameters<BunSecretsApi["get"]>[0];
type Write = Parameters<BunSecretsApi["set"]>[0];

const service = "com.omarchy.bot";
const sentinel = "fake-credential";
const apiError = () => new Error(`Keychain error for ${sentinel}`, { cause: sentinel });
const never = new Promise<never>(() => {});

class FakeBunSecrets implements BunSecretsApi {
  readonly values = new Map<string, string>();
  readonly calls: { operation: string; service: string; name: string }[] = [];
  readonly writeKeys: string[][] = [];
  readonly persistence: Write["persist"][] = [];
  afterGet?: (value: string | null) => Promise<string | null>;
  afterSet?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;

  async get(options: Account): Promise<string | null> {
    this.record("get", options);
    const value = this.values.get(options.name) ?? null;
    return this.afterGet ? this.afterGet(value) : value;
  }

  async set(options: Write): Promise<void> {
    const { value, persist, ...account } = options;
    this.record("set", account);
    if (typeof value !== "string" || (persist !== undefined && persist !== "local")) {
      throw new Error("Unexpected keychain write arguments");
    }
    this.writeKeys.push(Object.keys(options).sort());
    this.persistence.push(persist);
    this.values.set(account.name, value);
    await this.afterSet?.();
  }

  async delete(options: Account): Promise<boolean> {
    this.record("delete", options);
    await this.beforeDelete?.();
    return this.values.delete(options.name);
  }

  private record(operation: string, options: Account): void {
    this.calls.push({ operation, service: options.service, name: options.name });
    if (Object.keys(options).sort().join() !== "name,service" || options.service !== service || !options.name) {
      throw new Error("Unexpected keychain account arguments");
    }
  }
}

test.each([
  ["win32", ["name", "persist", "service", "value"], "local"],
  ["linux", ["name", "service", "value"], undefined],
] as const)("BunSecretsBackend forwards the exact service, account, and %s write options", async (platform, keys, persist) => {
  const api = new FakeBunSecrets();
  const backend = new BunSecretsBackend(api, platform);
  const name = `${"a".repeat(64)}:${"b".repeat(64)}`;

  expect(backend.kind).toBe("keychain");
  expect(await backend.get(name)).toBeUndefined();
  await backend.set(name, sentinel);
  expect(await backend.get(name) === sentinel).toBe(true);
  await backend.delete(name);
  expect(await backend.delete(name)).toBeUndefined();
  expect(api.values.size).toBe(0);
  expect(api.calls).toEqual(["get", "set", "get", "delete", "delete"].map((operation) => ({ operation, service, name })));
  expect(api.writeKeys).toEqual([[...keys]]);
  expect(api.persistence).toEqual([persist]);
});

test("BunSecretsBackend propagates API rejections", async () => {
  const api = new FakeBunSecrets();
  const backend = new BunSecretsBackend(api);
  const error = new Error("Keychain unavailable");
  const fail = async () => { throw error; };
  api.afterGet = fail;
  api.afterSet = fail;
  api.beforeDelete = fail;

  await expect(backend.get("account")).rejects.toBe(error);
  await expect(backend.set("account", sentinel)).rejects.toBe(error);
  await expect(backend.delete("account")).rejects.toBe(error);
});

test("probeBunSecrets verifies round trips and leaves no probe items", async () => {
  const api = new FakeBunSecrets();
  const written = new Set<string>();
  api.afterSet = async () => {
    for (const value of api.values.values()) written.add(value);
  };

  expect(await probeBunSecrets(api, { platform: "win32" })).toEqual({ available: true });
  expect(await probeBunSecrets(api, { platform: "linux" })).toEqual({ available: true });
  expect(api.values.size).toBe(0);
  expect(written.size).toBe(2);
  expect([...written].every(Boolean)).toBe(true);
  expect(api.persistence).toEqual(["local", undefined]);
  const operations = ["get", "set", "get", "delete", "get"];
  const probeNames = api.calls.filter((_, index) => index % operations.length === 0).map(({ name }) => name);
  expect(probeNames).toHaveLength(2);
  expect(new Set(probeNames).size).toBe(2);
  for (const name of probeNames) expect(name).toMatch(/^probe:[0-9a-f-]{36}$/);
  expect(api.calls).toEqual(probeNames.flatMap((name) => operations.map((operation) => ({ operation, service, name }))));
});

test("probeBunSecrets treats an initial get rejection as value-free unavailability", async () => {
  const api = new FakeBunSecrets();
  api.afterGet = async () => { throw apiError(); };

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "no-backend" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get"]);
});

test("probeBunSecrets leaves an occupied probe account alone", async () => {
  const api = new FakeBunSecrets();
  api.afterGet = async () => "";

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "no-backend" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get"]);
});

test("probeBunSecrets cleans up a rejected write and omits its error", async () => {
  const api = new FakeBunSecrets();
  api.afterSet = async () => { throw apiError(); };

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "write-failed" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "delete"]);
  expect(api.values.size).toBe(0);
});

test("probeBunSecrets cleans up a read-back mismatch and omits the value", async () => {
  const api = new FakeBunSecrets();
  api.afterGet = async (value) => value === null ? null : `${value} `;

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "readback-mismatch" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "get", "delete"]);
  expect(api.values.size).toBe(0);
});

test("probeBunSecrets attempts cleanup after a rejected delete and omits its error", async () => {
  const api = new FakeBunSecrets();
  api.beforeDelete = async () => { throw apiError(); };

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "delete-failed" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "get", "delete", "delete"]);
});

test("probeBunSecrets reports delete-failed when delete returns false after its write", async () => {
  const api = new FakeBunSecrets();
  api.beforeDelete = async () => { api.values.clear(); };

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "delete-failed" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "get", "delete", "delete"]);
});

test("probeBunSecrets requires an absent read after deleting", async () => {
  const api = new FakeBunSecrets();
  api.afterGet = async (value) => api.calls.length === 5 ? sentinel : value;

  expect(await probeBunSecrets(api)).toEqual({ available: false, reason: "delete-failed" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "get", "delete", "get", "delete"]);
});

test("probeBunSecrets times out an initial get without touching the account", async () => {
  const api = new FakeBunSecrets();
  api.afterGet = () => never;

  expect(await probeBunSecrets(api, { timeoutMs: 20 })).toEqual({ available: false, reason: "timeout" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get"]);
}, 500);

test("probeBunSecrets times out a hung write and bounds its cleanup attempt", async () => {
  const api = new FakeBunSecrets();
  api.afterSet = () => never;
  api.beforeDelete = () => never;

  expect(await probeBunSecrets(api, { timeoutMs: 20 })).toEqual({ available: false, reason: "timeout" });
  expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "delete"]);
}, 500);

test("probeBunSecrets shares the time limit across successive calls", async () => {
  const api = new FakeBunSecrets();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  api.afterGet = async (value) => { now += 50; return value; };
  api.afterSet = async () => { now += 50; };

  try {
    expect(await probeBunSecrets(api, { timeoutMs: 85 })).toEqual({ available: false, reason: "timeout" });
    expect(api.calls.map(({ operation }) => operation)).toEqual(["get", "set", "delete"]);
    expect(api.values.size).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

function countNodeBunSecretsGetCalls(root: Node): number {
  let count = 0;
  function visit(node: Node): void {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && node.expression.name.text === "get") {
      const receiver = node.expression.expression;
      if (isPropertyAccessExpression(receiver) && receiver.name.text === "secrets" &&
        isIdentifier(receiver.expression) && receiver.expression.text === "Bun") {
        count++;
      }
    }
    node.forEachChild(visit);
  }
  visit(root);
  return count;
}

async function countBunSecretsGetCallsInFiles(files: Record<string, string>): Promise<Map<string, number>> {
  const virtualFiles: Record<string, string> = {};
  const virtualPaths = new Map<string, string>();
  for (const [file, source] of Object.entries(files)) {
    const virtualPath = `/virtual/src/${file}`;
    virtualFiles[virtualPath] = source;
    virtualPaths.set(file, virtualPath);
  }
  virtualFiles["/virtual/tsconfig.json"] = JSON.stringify({
    compilerOptions: { allowJs: true, noLib: true, types: [] },
    files: [...virtualPaths.values()],
  });
  const api = new API({ cwd: "/virtual", fs: createVirtualFileSystem(virtualFiles) });
  try {
    const snapshot = await api.updateSnapshot({ openProject: "/virtual/tsconfig.json" });
    const project = snapshot.getProject("/virtual/tsconfig.json");
    if (!project) throw new Error("Unable to open virtual TypeScript project");
    const counts = new Map<string, number>();
    for (const [file, virtualPath] of virtualPaths) {
      const sourceFile = await project.program.getSourceFile(virtualPath);
      if (!sourceFile) throw new Error(`Missing TypeScript AST for ${file}`);
      counts.set(file, countNodeBunSecretsGetCalls(sourceFile));
    }
    return counts;
  } finally {
    await api.close();
  }
}

test("countBunSecretsGetCalls counts calls and ignores comments and strings", async () => {
  const counts = await countBunSecretsGetCallsInFiles({
    "call-and-comment.ts": "Bun.secrets.get(options); // Bun.secrets.get(",
    "comment-only.ts": "// Bun.secrets.get(",
    "string-only.ts": 'const text = "Bun.secrets.get(";',
  });
  expect(counts.get("call-and-comment.ts")).toBe(1);
  expect(counts.get("comment-only.ts")).toBe(0);
  expect(counts.get("string-only.ts")).toBe(0);
});

test("daemon product source confines Bun.secrets to runtime keychain files", async () => {
  const sourceDir = new URL("../../", import.meta.url);
  const sourceFiles = new Bun.Glob("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}");
  const secretReferences = /\bBun\s*(?:\.\s*secrets\b|\[\s*["']secrets["']\s*\])/;
  const mentioningFiles: string[] = [];
  const scannedSources: Record<string, string> = {};
  for await (const file of sourceFiles.scan({ cwd: fileURLToPath(sourceDir), dot: true })) {
    if (/\.(test|spec)\.[^.]+$/.test(file)) continue;
    const source = await Bun.file(new URL(file, sourceDir)).text();
    if (secretReferences.test(source)) mentioningFiles.push(file);
    scannedSources[file] = source;
  }
  const counts = await countBunSecretsGetCallsInFiles(scannedSources);
  const directGetFiles = [...counts.entries()].filter(([, count]) => count > 0).map(([file]) => file);
  expect(directGetFiles.sort()).toEqual([]);
  expect(mentioningFiles.sort()).toEqual([
    "modules/runtime/bunSecrets.ts",
    "modules/runtime/runtime.ts",
  ]);
});
