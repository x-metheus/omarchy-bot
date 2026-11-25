import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createPiMcpAdapterTokenReader,
  PI_MCP_ADAPTER_OAUTH_SERVICE,
  piMcpAdapterOAuthAccountName,
  PiMcpAdapterKeyringUnavailableError,
  PiMcpAdapterTokenEntryError,
  type SecretGet,
} from "./mcpOAuthKeyringReader.ts";

const serverName = "fixture-serveur-é";
const account = `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
const accessToken = "fixture-access-token";
const plainEntry = { tokens: { accessToken }, clientInfo: { clientId: "fixture-client" } };

function fakeKeyring(load: (name: string) => string | null | Promise<string | null>) {
  const calls: Parameters<SecretGet>[0][] = [];
  const get: SecretGet = async (options) => {
    calls.push(options);
    return load(options.name);
  };
  return { get, calls };
}

function expectedGets(...names: string[]) {
  return names.map((name) => ({ service: "pi-mcp-adapter.oauth", name }));
}

function chunkedEntry(payload: string, chunks: string[]) {
  const chunkDigest = createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
  const manifest = JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: chunks.length, chunkDigest });
  const names = chunks.map((_, index) => `${account}.chunk.${chunkDigest}.${index}`);
  const values = new Map([[account, manifest]]);
  for (const [index, chunk] of chunks.entries()) values.set(names[index]!, chunk);
  return { names, values };
}

async function expectSafeError(
  read: Promise<unknown>,
  errorType: typeof PiMcpAdapterKeyringUnavailableError | typeof PiMcpAdapterTokenEntryError,
) {
  const error = await read.then(() => undefined, (caught: unknown) => caught);
  expect(error instanceof errorType).toBe(true);
  expect(error instanceof Error && !error.message.includes(accessToken) && !error.message.includes(account)).toBe(true);
  expect(error instanceof Error && error.cause === undefined).toBe(true);
}

test("reads a plain adapter entry using the exact service and UTF-8 hashed account", async () => {
  const fake = fakeKeyring(() => JSON.stringify(plainEntry));
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  expect(PI_MCP_ADAPTER_OAUTH_SERVICE).toBe("pi-mcp-adapter.oauth");
  expect(piMcpAdapterOAuthAccountName(serverName)).toBe(account);
  expect("available" in reader).toBe(false);
  expect(Bun.deepEquals(await reader.read(serverName), plainEntry)).toBe(true);
  expect(fake.calls).toEqual(expectedGets(account));
});

function requireHeadlessKeychain() {
  if (!Bun.secrets) throw new Error("Bun.secrets is undefined. Run with the headless-keychain preload configured in bunfig.toml.");
}

test("reads a plain adapter entry through the preloaded Bun.secrets stub", async () => {
  requireHeadlessKeychain();
  const get = spyOn(Bun.secrets, "get").mockImplementation(async ({ name }) => name === account ? JSON.stringify(plainEntry) : null);
  try {
    const reader = createPiMcpAdapterTokenReader({ get: (options) => Bun.secrets.get(options) });

    expect(Bun.deepEquals(await reader.read(serverName), plainEntry)).toBe(true);
    expect(get.mock.calls.map(([options]) => options)).toEqual(expectedGets(account));
  } finally {
    get.mockRestore();
  }
});

test("reports a rejected get through the preloaded Bun.secrets stub as unavailable", async () => {
  requireHeadlessKeychain();
  const get = spyOn(Bun.secrets, "get").mockImplementation(async () => { throw new Error(`${accessToken} ${account}`); });
  try {
    const reader = createPiMcpAdapterTokenReader({ get: (options) => Bun.secrets.get(options) });

    await expectSafeError(reader.read(serverName), PiMcpAdapterKeyringUnavailableError);
    expect(get.mock.calls.map(([options]) => options)).toEqual(expectedGets(account));
  } finally {
    get.mockRestore();
  }
});

test("reassembles a chunked adapter entry through the preloaded Bun.secrets stub", async () => {
  requireHeadlessKeychain();
  const entry = { ...plainEntry, tokens: { accessToken: accessToken.repeat(60) } };
  const payload = JSON.stringify(entry);
  const { names, values } = chunkedEntry(payload, [payload.slice(0, 1000), payload.slice(1000)]);
  const get = spyOn(Bun.secrets, "get").mockImplementation(async ({ name }) => values.get(name) ?? null);
  try {
    const reader = createPiMcpAdapterTokenReader({ get: (options) => Bun.secrets.get(options) });

    expect(Bun.deepEquals(await reader.read(serverName), entry)).toBe(true);
    expect(get.mock.calls.map(([options]) => options)).toEqual(expectedGets(account, ...names));
  } finally {
    get.mockRestore();
  }
});

test("returns undefined for a missing base entry without reading chunks", async () => {
  const fake = fakeKeyring(() => null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  expect(await reader.read(serverName)).toBeUndefined();
  expect(fake.calls).toEqual(expectedGets(account));
});

test("reports a rejected base get as unavailable with a safe error", async () => {
  const fake = fakeKeyring(() => Promise.reject(new Error(`${accessToken} ${account}`)));
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  await expectSafeError(reader.read(serverName), PiMcpAdapterKeyringUnavailableError);
  expect(fake.calls).toEqual(expectedGets(account));
});

test("times out a never-resolving base get within one second", async () => {
  const fake = fakeKeyring(() => new Promise(() => {}));
  const reader = createPiMcpAdapterTokenReader({ get: fake.get, timeoutMs: 25 });

  const started = performance.now();
  await expectSafeError(reader.read(serverName), PiMcpAdapterKeyringUnavailableError);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(fake.calls).toEqual(expectedGets(account));
}, 1000);

test("keeps a rejection after the read deadline handled", async () => {
  const pending = Promise.withResolvers<string | null>();
  const reader = createPiMcpAdapterTokenReader({ get: () => pending.promise, timeoutMs: 25 });

  await expectSafeError(reader.read(serverName), PiMcpAdapterKeyringUnavailableError);
  pending.reject(new Error("Late keyring rejection."));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test.each([
  ["malformed JSON", `{"tokens":"${accessToken}"`],
  ["JSON null", "null"],
  ["an array", JSON.stringify([plainEntry])],
  ["a primitive", JSON.stringify(accessToken)],
])("rejects a base entry containing %s with a safe error", async (_label, payload) => {
  const fake = fakeKeyring(() => payload);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(fake.calls).toEqual(expectedGets(account));
});

test("reassembles adapter slices using sequential 0-based chunk gets and the same service", async () => {
  const entry = { tokens: { accessToken: accessToken.repeat(100) } };
  const payload = JSON.stringify(entry);
  const fixture = chunkedEntry(payload, [payload.slice(0, 1000), payload.slice(1000, 2000), payload.slice(2000)]);
  let inProgress = false;
  let overlapped = false;
  const fake = fakeKeyring(async (name) => {
    overlapped ||= inProgress;
    inProgress = true;
    await Promise.resolve();
    inProgress = false;
    return fixture.values.get(name) ?? null;
  });
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  expect(Bun.deepEquals(await reader.read(serverName), entry)).toBe(true);
  expect(fake.calls).toEqual(expectedGets(account, ...fixture.names));
  expect(overlapped).toBe(false);
});

test.each([
  ["a zero count", { chunkCount: 0 }],
  ["a count over 64", { chunkCount: 65 }],
  ["a fractional count", { chunkCount: 1.5 }],
  ["a bad digest", { chunkDigest: accessToken }],
  ["an invalid marker", { __piMcpAdapterOAuthChunked: 0 }],
  ["an extra field", { tokens: plainEntry.tokens }],
])("rejects a manifest with %s before reading chunks", async (_label, overrides) => {
  const manifest = { __piMcpAdapterOAuthChunked: 1, chunkCount: 1, chunkDigest: "0123456789abcdef", ...overrides };
  const fake = fakeKeyring(() => JSON.stringify(manifest));
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(fake.calls).toEqual(expectedGets(account));
});

test("honors a configured chunk count limit before reading chunks", async () => {
  const payload = JSON.stringify(plainEntry);
  const { values } = chunkedEntry(payload, [payload.slice(0, 10), payload.slice(10)]);
  const fake = fakeKeyring((name) => values.get(name) ?? null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get, maxChunks: 1 });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(fake.calls).toEqual(expectedGets(account));
});

test.each([
  ["an infinite configured limit", Infinity],
  ["a finite configured limit above 64", 1_000_000],
] as const)("rejects a huge chunk count with %s before reading chunks", async (_label, maxChunks) => {
  const manifest = JSON.stringify({ __piMcpAdapterOAuthChunked: 1, chunkCount: 1_000_000, chunkDigest: "0123456789abcdef" });
  const fake = fakeKeyring((name) => name === account ? manifest : null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get, maxChunks });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(fake.calls).toHaveLength(1);
});

test.each([
  ["an infinite limit", Infinity],
  ["a NaN limit", NaN],
  ["a negative limit", -1],
  ["a fractional limit", 1.5],
] as const)("rejects %s for an otherwise valid chunk manifest", async (_label, maxChunks) => {
  const payload = JSON.stringify(plainEntry);
  const { values } = chunkedEntry(payload, [payload]);
  const fake = fakeKeyring((name) => values.get(name) ?? null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get, maxChunks });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(fake.calls).toHaveLength(1);
});

test.each([
  ["missing", (): null => null, PiMcpAdapterTokenEntryError],
  ["rejected", (): Promise<never> => Promise.reject(new Error(accessToken)), PiMcpAdapterKeyringUnavailableError],
  ["timed out", (): Promise<null> => new Promise(() => {}), PiMcpAdapterKeyringUnavailableError],
] as const)("reports a %s chunk read with the expected safe error", async (_label, load, errorType) => {
  const payload = JSON.stringify(plainEntry);
  const { names, values } = chunkedEntry(payload, [payload.slice(0, 10), payload.slice(10)]);
  const fake = fakeKeyring((name) => name === names[0] ? load() : values.get(name) ?? null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get, timeoutMs: 25 });

  await expectSafeError(reader.read(serverName), errorType);
  expect(fake.calls).toEqual(expectedGets(account, names[0]!));
});

test.each([
  ["a mismatched digest", JSON.stringify(plainEntry), JSON.stringify({ ...plainEntry, altered: true })],
  ["invalid JSON with a valid digest", `{"tokens":"${accessToken}"`, `{"tokens":"${accessToken}"`],
  ["an array with a valid digest", JSON.stringify([plainEntry]), JSON.stringify([plainEntry])],
])("rejects assembled chunks with %s", async (_label, expectedPayload, actualPayload) => {
  const { names, values } = chunkedEntry(expectedPayload, [actualPayload]);
  const fake = fakeKeyring((name) => values.get(name) ?? null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(fake.calls).toEqual(expectedGets(account, ...names));
});

test("rejects a 100,000-code-unit first chunk before fetching the second chunk", async () => {
  const payload = JSON.stringify({ ...plainEntry, padding: "x".repeat(100_000) });
  const { names, values } = chunkedEntry(payload, [payload.slice(0, 100_000), payload.slice(100_000)]);
  const fake = fakeKeyring((name) => values.get(name) ?? null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  await expectSafeError(reader.read(serverName), PiMcpAdapterTokenEntryError);
  expect(Bun.deepEquals(fake.calls, expectedGets(account, names[0]!))).toBe(true);
});

test("reassembles 64,000 code units with a surrogate pair split across chunks", async () => {
  const prefix = '{"padding":"';
  const paddingStart = "界".repeat(999 - prefix.length) + "😀";
  const entry = { padding: paddingStart.padEnd(64_000 - prefix.length - 2, "界") };
  const payload = JSON.stringify(entry);
  const chunks = Array.from({ length: 64 }, (_, index) => payload.slice(index * 1000, (index + 1) * 1000));
  const { values } = chunkedEntry(payload, chunks);
  const fake = fakeKeyring((name) => values.get(name) ?? null);
  const reader = createPiMcpAdapterTokenReader({ get: fake.get });

  expect(Bun.deepEquals(await reader.read(serverName), entry)).toBe(true);
  expect(fake.calls).toHaveLength(65);
});

test("reads successfully through read-only factory options that reject unexpected property access", async () => {
  const fake = fakeKeyring(() => JSON.stringify(plainEntry));
  const options = new Proxy(Object.freeze({ get: fake.get }), {
    get(target, property, receiver) {
      if (property !== "get" && property !== "timeoutMs" && property !== "maxChunks") {
        throw new Error("Unexpected reader option access.");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const reader = createPiMcpAdapterTokenReader(options);

  expect(Bun.deepEquals(await reader.read(serverName), plainEntry)).toBe(true);
  expect(fake.calls).toEqual(expectedGets(account));
});
