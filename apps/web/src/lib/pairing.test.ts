import { afterEach, expect, test } from "bun:test";
import { consumePairingCode, pairingError } from "./pairing.ts";
import { createMemoryShell, getShell, installShell } from "./shell.ts";

const originalShell = getShell();
const saved = new Map<string, string>();
const originalWindow = globalThis.window;
const originalHistory = globalThis.history;
const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as Record<string, unknown>).localStorage;

afterEach(() => {
  Object.assign(globalThis, {
    window: originalWindow,
    history: originalHistory,
    fetch: originalFetch,
    localStorage: originalLocalStorage,
  });
  saved.clear();
  installShell(originalShell);
});

function install(pathname: string, search: string, response: { status: number; body: unknown }): string[] {
  const requests: string[] = [];
  Object.assign(globalThis, {
    window: { location: { pathname, search } },
    history: { replaceState: (_state: unknown, _title: string, url: string) => requests.push(url) },
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
    fetch: async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify(response.body), { status: response.status });
    },
  });
  installShell(createMemoryShell({ baseUrl: "https://service.example" }));
  return requests;
}

test("exchanges a pairing code, stores the token, and leaves /pair", async () => {
  const requests = install("/pair", "?code=ABCD2345", {
    status: 201,
    body: { token: "a".repeat(64), device: { id: "paired_0123456789abcdef", name: "Laptop" } },
  });

  await consumePairingCode();

  expect(requests).toEqual(["https://service.example/api/pairing/exchange", "/"]);
  expect(getShell().service.deviceToken()).toBe("a".repeat(64));
  expect(pairingError()).toBeUndefined();
});

test("a rejected code keeps the stored token and reports the daemon error", async () => {
  const requests = install("/pair", "?code=WRONG234", { status: 401, body: { error: "unauthorized" } });

  await consumePairingCode();

  expect(requests).toEqual(["https://service.example/api/pairing/exchange", "/"]);
  expect(getShell().service.deviceToken()).toBeUndefined();
  expect(pairingError()).toBe("unauthorized");
});

test("a storage failure reports that the used link must be replaced", async () => {
  install("/pair", "?code=ABCD2345", {
    status: 201,
    body: { token: "b".repeat(64), device: { id: "paired_0123456789abcdef", name: "Laptop" } },
  });
  Object.assign(globalThis, {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    },
  });
  installShell(createMemoryShell({ baseUrl: "https://service.example" }));

  await consumePairingCode();

  expect(pairingError()).toContain("new link");
});
