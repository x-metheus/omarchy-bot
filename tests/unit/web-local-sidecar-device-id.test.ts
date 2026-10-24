import { afterEach, describe, expect, test } from "bun:test";
import type { api as webApi } from "../../apps/web/src/lib/api.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface SentRequest {
  body: Record<string, unknown>;
}

function stubFetch(sent: SentRequest[]): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({ body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify({ threadId: "thread-1", messageId: "message-1", turnId: "turn-1", action: "sent" }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const GLOBAL = "__OMARCHY_BOT_DEVICE_ID__";
const originalFetch = globalThis.fetch;

/**
 * A fresh module instance per case: the client reads the shell global when the
 * web bundle loads, so each case loads the module with its own specifier.
 */
function loadApi(caseName: string): Promise<{ api: typeof webApi }> {
  const specifier = `../../apps/web/src/lib/api.ts?case=${caseName}`;
  return import(specifier) as Promise<{ api: typeof webApi }>;
}

async function sentBody(caseName: string, shellValue: unknown): Promise<Record<string, unknown>> {
  if (shellValue === undefined) Reflect.deleteProperty(globalThis, GLOBAL);
  else Reflect.set(globalThis, GLOBAL, shellValue);
  const sent: SentRequest[] = [];
  globalThis.fetch = stubFetch(sent);
  const { api } = await loadApi(caseName);
  await api.sendMessage("thread-1", { text: "hello" });
  expect(sent).toHaveLength(1);
  return sent[0]?.body ?? {};
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, GLOBAL);
});

describe("web client Local Sidecar bootstrap", () => {
  test("a browser tab with no shell identity sends no This Device tag", async () => {
    expect(await sentBody("browser", undefined)).not.toHaveProperty("deviceId");
  });

  test("a client shell that installed the Sidecar identity tags its sends", async () => {
    expect((await sentBody("shell", DEVICE_A)).deviceId).toBe(DEVICE_A);
  });

  test("a malformed shell identity fails closed and sends no tag", async () => {
    expect(await sentBody("malformed", "not-a-device")).not.toHaveProperty("deviceId");
    expect(await sentBody("malformed-number", 42)).not.toHaveProperty("deviceId");
  });
});
