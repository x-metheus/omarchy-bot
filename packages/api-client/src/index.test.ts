import { describe, expect, test } from "bun:test";
import { ApiClient } from "./index.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface SentRequest {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(sent: SentRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ threadId: "thread-1", messageId: "message-1", turnId: "turn-1", action: "sent" }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("ApiClient This Device tag", () => {
  test("a client with a device id tags its sends", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:7321", fetch: stubFetch(sent), localSidecarDeviceId: DEVICE_A });

    await client.sendBotMessage("bot-1", { text: "hello" });
    await client.sendMessage("thread-1", { text: "hello again" });

    expect(sent.map((request) => request.url)).toEqual([
      "http://127.0.0.1:7321/api/bots/bot-1/messages",
      "http://127.0.0.1:7321/api/threads/thread-1/messages",
    ]);
    expect(sent[0]?.body.deviceId).toBe(DEVICE_A);
    expect(sent[1]?.body.deviceId).toBe(DEVICE_A);
  });

  test("a client without a device id sends no tag", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ baseUrl: "", fetch: stubFetch(sent) });

    await client.sendBotMessage("bot-1", { text: "hello" });
    await client.sendMessage("thread-1", { text: "hello again" });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).not.toHaveProperty("deviceId");
    expect(sent[1]?.body).not.toHaveProperty("deviceId");
  });

  test("the client's own device id is the only tag authority", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ baseUrl: "", fetch: stubFetch(sent), localSidecarDeviceId: DEVICE_A });

    await client.sendMessage("thread-1", { text: "hello", deviceId: DEVICE_B });

    expect(sent[0]?.body.deviceId).toBe(DEVICE_A);
  });

  test("a client without a device id strips a body claim", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ baseUrl: "", fetch: stubFetch(sent) });

    await client.sendMessage("thread-1", { text: "hello", deviceId: DEVICE_B });

    expect(sent[0]?.body).not.toHaveProperty("deviceId");
  });

  test("a malformed device id is refused", () => {
    expect(() => new ApiClient({ localSidecarDeviceId: "not-a-device" })).toThrow(/device identity/);
  });
});
