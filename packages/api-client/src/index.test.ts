import { describe, expect, test } from "bun:test";
import { SurfaceIdDto, type ApprovalDto } from "@omarchy-bot/protocol";
import { ApiClient } from "./index.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface SentRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function stubFetch(sent: SentRequest[], response?: Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return response ?? new Response(
      JSON.stringify({ threadId: "thread-1", messageId: "message-1", turnId: "turn-1", action: "sent" }),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("ApiClient Service address", () => {
  test("reads the current Service for HTTP, browser URLs, and events", async () => {
    let serviceUrl = "http://127.0.0.1:7321/";
    const requests: string[] = [];
    const client = new ApiClient({
      baseUrl: () => serviceUrl,
      deviceToken: "paired-token",
      fetch: (async (input: string | URL | Request): Promise<Response> => {
        requests.push(String(input));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const owner = { botId: "bot-1", surfaceId: SurfaceIdDto.parse("surf_0123456789abcdef0123456789abcdef") };
    const sockets: string[] = [];
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor(readonly url: string | URL) {
        sockets.push(String(url));
      }
    } as unknown as typeof WebSocket;
    try {
      expect(client.baseUrl).toBe("http://127.0.0.1:7321");
      await client.listBots();
      await client.uploadAvatar("bot-1", new Blob(["avatar"]));
      await client.stageAttachment("bot-1", "a7126bac-a201-413f-a212-5f495aba0cda", new File(["attachment"], "file.txt"));
      expect(client.avatarUrl("bot-1")).toBe("http://127.0.0.1:7321/api/bots/bot-1/avatar?access_token=paired-token");
      expect(client.attachmentUrl("attachment-1")).toBe("http://127.0.0.1:7321/api/attachments/attachment-1?access_token=paired-token");
      expect(client.computerProjectionUrl(owner)).toBe("http://127.0.0.1:7321/api/computer/projection?botId=bot-1&surfaceId=surf_0123456789abcdef0123456789abcdef&access_token=paired-token");
      client.connectEvents(undefined, () => {});

      serviceUrl = "https://service.example///";
      expect(client.baseUrl).toBe("https://service.example");
      await client.listBots();
      await client.uploadAvatar("bot-1", new Blob(["avatar"]));
      await client.stageAttachment("bot-1", "a7126bac-a201-413f-a212-5f495aba0cda", new File(["attachment"], "file.txt"));
      expect(client.avatarUrl("bot-1")).toBe("https://service.example/api/bots/bot-1/avatar?access_token=paired-token");
      expect(client.attachmentUrl("attachment-1")).toBe("https://service.example/api/attachments/attachment-1?access_token=paired-token");
      expect(client.computerProjectionUrl(owner)).toBe("https://service.example/api/computer/projection?botId=bot-1&surfaceId=surf_0123456789abcdef0123456789abcdef&access_token=paired-token");
      client.connectEvents(undefined, () => {});
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
    expect(requests).toEqual([
      "http://127.0.0.1:7321/api/bots",
      "http://127.0.0.1:7321/api/bots/bot-1/avatar/upload",
      "http://127.0.0.1:7321/api/attachments/stage",
      "https://service.example/api/bots",
      "https://service.example/api/bots/bot-1/avatar/upload",
      "https://service.example/api/attachments/stage",
    ]);
    expect(sockets).toEqual([
      "ws://127.0.0.1:7321/api/events?access_token=paired-token",
      "wss://service.example/api/events?access_token=paired-token",
    ]);
  });
});

describe("ApiClient Paired Device token", () => {
  test("sends the token as a Bearer header and on the events socket", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:7321",
      fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
      deviceToken: () => "a".repeat(64),
    });

    await client.listBots();

    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${"a".repeat(64)}`);
    expect(client.avatarUrl("bot-1")).toBe(`http://127.0.0.1:7321/api/bots/bot-1/avatar?access_token=${"a".repeat(64)}`);

    const sockets: string[] = [];
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class {
      constructor(readonly url: string | URL) {
        sockets.push(String(url));
      }
    } as unknown as typeof WebSocket;
    try {
      client.connectEvents(undefined, () => {});
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
    expect(sockets).toEqual([`ws://127.0.0.1:7321/api/events?access_token=${"a".repeat(64)}`]);
  });
});

test("every HTTP fetch path reports a revoked device while preserving the 401 error", async () => {
  let unauthorized = 0;
  const client = new ApiClient({
    baseUrl: "http://127.0.0.1:7321",
    deviceToken: "revoked-token",
    onUnauthorized: () => { unauthorized++; },
    fetch: Object.assign(async () => new Response('{"error":"unauthorized"}', { status: 401 }), { preconnect: fetch.preconnect }),
  });
  for (const request of [
    () => client.listBots(),
    () => client.uploadAvatar("bot-1", new Blob(["avatar"])),
    () => client.stageAttachment("bot-1", "a7126bac-a201-413f-a212-5f495aba0cda", new File(["attachment"], "file.txt")),
  ]) {
    await expect(request()).rejects.toMatchObject({ status: 401 });
  }
  expect(unauthorized).toBe(3);
});

test("delayed 401 responses from replaced credentials leave the new connection paired", async () => {
  for (const change of ["token", "address"]) {
    for (const method of ["json", "avatar", "attachment", "projection"]) {
      let token = "old-token";
      let baseUrl = "https://old.example";
      let unauthorized = 0;
      const pending = Promise.withResolvers<Response>();
      const client = new ApiClient({
        baseUrl: () => baseUrl,
        deviceToken: () => token,
        onUnauthorized: () => { unauthorized++; },
        fetch: Object.assign(() => pending.promise, { preconnect: fetch.preconnect }),
      });
      const oldRequest = method === "json" ? client.listBots()
        : method === "avatar" ? client.uploadAvatar("bot-1", new Blob(["avatar"]))
        : method === "attachment" ? client.stageAttachment("bot-1", "a7126bac-a201-413f-a212-5f495aba0cda", new File(["attachment"], "file.txt"))
        : client.fetchResponse("https://old.example/api/computer/projection?access_token=old-token");
      if (change === "token") token = "new-token";
      else baseUrl = "https://new.example";
      pending.resolve(new Response("unauthorized", { status: 401 }));
      if (method === "projection") expect((await oldRequest as Response).status).toBe(401);
      else await expect(oldRequest).rejects.toMatchObject({ status: 401 });
      expect(unauthorized).toBe(0);
    }
  }
});

describe("ApiClient approvals", () => {
  const pending: ApprovalDto = {
    id: "approval-1",
    threadId: "thread / 1",
    botId: "bot-1",
    turnId: null,
    tool: "read",
    path: "/outside/file.txt",
    folder: "/outside",
    status: "pending",
    createdAt: "2026-11-24T00:00:00.000Z",
    expiresAt: "2026-11-24T00:05:00.000Z",
    answeredAt: null,
  };

  test("listApprovals gets pending approvals without a thread query", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ fetch: stubFetch(sent, Response.json([pending])) });

    expect(await client.listApprovals()).toEqual([pending]);
    expect(sent).toEqual([{ url: "/api/approvals", method: "GET", body: undefined }]);
  });

  test("listApprovals encodes the thread filter", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ fetch: stubFetch(sent, Response.json([pending])) });

    expect(await client.listApprovals(pending.threadId)).toEqual([pending]);
    expect(sent).toEqual([{ url: "/api/approvals?threadId=thread%20%2F%201", method: "GET", body: undefined }]);
  });

  test.each([
    ["allow_once", "allowed_once"],
    ["allow_folder", "allowed_folder"],
    ["deny", "denied"],
  ] as const)("answerApproval posts %s to the approval URL and returns the updated approval", async (answer, status) => {
    const sent: SentRequest[] = [];
    const answered: ApprovalDto = {
      ...pending,
      status,
      answeredAt: "2026-11-24T00:01:00.000Z",
    };
    const client = new ApiClient({ fetch: stubFetch(sent, Response.json(answered)) });

    expect(await client.answerApproval(pending.id, { answer })).toEqual(answered);
    expect(sent).toEqual([{
      url: "/api/approvals/approval-1/answer",
      method: "POST",
      body: { answer },
    }]);
  });

  test("answerApproval encodes reserved characters in the approval path", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ fetch: stubFetch(sent, new Response(null, { status: 204 })) });

    await client.answerApproval("approval / 1", { answer: "deny" });

    expect(sent.map((request) => request.url)).toEqual(["/api/approvals/approval%20%2F%201/answer"]);
  });

  test.each([
    [409, "approval is already allowed_once"],
    [404, "approval not found"],
  ])("answerApproval preserves the %i ApiError status and body", async (status, error) => {
    const body = { error };
    const client = new ApiClient({ fetch: stubFetch([], Response.json(body, { status })) });

    await expect(client.answerApproval(pending.id, { answer: "deny" })).rejects.toMatchObject({ status, body });
  });
});

describe("ApiClient This Device tag", () => {
  test("reads the running Sidecar identity on every send and strips body claims", async () => {
    const sent: SentRequest[] = [];
    let deviceId: string | undefined;
    const client = new ApiClient({
      fetch: stubFetch(sent),
      localSidecarDeviceId: () => deviceId,
    });

    await client.sendBotMessage("bot-1", { text: "no Sidecar", deviceId: DEVICE_B });
    deviceId = DEVICE_A;
    await client.sendBotMessage("bot-1", { text: "Sidecar started", deviceId: DEVICE_B });
    deviceId = DEVICE_B;
    await client.sendMessage("thread-1", { text: "Sidecar changed", deviceId: DEVICE_A });
    deviceId = undefined;
    await client.sendMessage("thread-1", { text: "Sidecar stopped", deviceId: DEVICE_A });

    expect(sent.map((request) => request.body)).toEqual([
      { text: "no Sidecar" },
      { text: "Sidecar started", deviceId: DEVICE_A },
      { text: "Sidecar changed", deviceId: DEVICE_B },
      { text: "Sidecar stopped" },
    ]);
  });

  test("refuses malformed dynamic identities before either send reaches the Service", async () => {
    const sent: SentRequest[] = [];
    let deviceId = DEVICE_A;
    const client = new ApiClient({
      fetch: stubFetch(sent),
      localSidecarDeviceId: () => deviceId,
    });

    await client.sendBotMessage("bot-1", { text: "valid identity" });
    deviceId = "not-a-device";
    expect(() => client.sendBotMessage("bot-1", { text: "invalid identity" })).toThrow(
      "localSidecarDeviceId must be a Local Sidecar device identity",
    );
    expect(() => client.sendMessage("thread-1", { text: "invalid identity" })).toThrow(
      "localSidecarDeviceId must be a Local Sidecar device identity",
    );
    expect(sent).toHaveLength(1);
  });

  test("a client with a device id tags its sends", async () => {
    const sent: SentRequest[] = [];
    const client = new ApiClient({ baseUrl: "http://127.0.0.1:7321", fetch: stubFetch(sent), localSidecarDeviceId: DEVICE_A });

    await client.sendBotMessage("bot-1", { text: "hello" });
    await client.sendMessage("thread-1", { text: "hello again" });

    expect(sent.map((request) => request.url)).toEqual([
      "http://127.0.0.1:7321/api/bots/bot-1/messages",
      "http://127.0.0.1:7321/api/threads/thread-1/messages",
    ]);
    expect(sent[0]?.body?.deviceId).toBe(DEVICE_A);
    expect(sent[1]?.body?.deviceId).toBe(DEVICE_A);
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

    expect(sent[0]?.body?.deviceId).toBe(DEVICE_A);
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
