import { afterEach, beforeEach, expect, test } from "bun:test";
import { createMemoryShell, installShell, type LocalSidecarStatus } from "../../apps/web/src/lib/shell.ts";
import { api } from "../../apps/web/src/lib/api.ts";

const DEVICE_A = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const originalFetch = globalThis.fetch;
const originalShell = globalThis.__OMARCHY_BOT_SHELL__;
const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ threadId: "thread-1", messageId: "message-1", turnId: "turn-1", action: "sent" }, { status: 202 });
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; globalThis.__OMARCHY_BOT_SHELL__ = originalShell; sent.length = 0; });

for (const [label, status, tagged] of [
  ["absent Sidecar", { running: false }, false],
  ["running Sidecar", { running: true, deviceId: DEVICE_A }, true],
  ["stopped Sidecar with identity", { running: false, deviceId: DEVICE_A }, false],
  ["malformed identity", { running: true, deviceId: "not-a-device" }, false],
] satisfies Array<[string, LocalSidecarStatus, boolean]>) {
  test(`the shell's ${label} controls the This Device tag`, async () => {
    installShell(createMemoryShell({ storage: null, baseUrl: "https://service.example", localSidecar: status }));
    await api.sendMessage("thread-1", { text: "hello" });
    expect(sent[0]?.url).toBe("https://service.example/api/threads/thread-1/messages");
    if (tagged) expect(sent[0]?.body.deviceId).toBe(DEVICE_A);
    else expect(sent[0]?.body).not.toHaveProperty("deviceId");
  });
}

test("the same Web UI reads a replacement shell on each send", async () => {
  installShell(createMemoryShell({ storage: null, baseUrl: "https://first.example", localSidecar: { running: true, deviceId: DEVICE_A } }));
  await api.sendMessage("thread-1", { text: "first" });
  installShell(createMemoryShell({ storage: null, baseUrl: "https://second.example" }));
  await api.sendMessage("thread-1", { text: "second", deviceId: DEVICE_A });
  expect(sent[0]?.body.deviceId).toBe(DEVICE_A);
  expect(sent[1]?.body).not.toHaveProperty("deviceId");
  expect(sent[1]?.url).toBe("https://second.example/api/threads/thread-1/messages");
});
