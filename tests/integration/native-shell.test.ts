import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Shell } from "../../apps/web/src/lib/shell.ts";

function install(platform: string, initial: Record<string, unknown> = {}, fetcher: typeof fetch = globalThis.fetch) {
  const calls: { command: string; args: unknown }[] = [];
  const window = new EventTarget();
  const values = new Map<string, string>();
  const context = vm.createContext({
    window: Object.assign(window, {
      fetch: fetcher,
      __TAURI_INTERNALS__: { async invoke(command: string, args: unknown) {
        calls.push({ command, args });
        if (command === "sidecar_events") return { status: { running: false }, approvals: [] };
        if (command === "take_pairing_request") return null;
        if (command === "save_attachment") return "/home/test/Downloads/1-report.txt";
        if (command === "open_browser") return;
        if (command === "certificate_untrusted") return true;
        throw new Error(`Unexpected native command: ${command}`);
      } },
    }),
    // Native installation must not access the page DOM, even for startup errors.
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    queueMicrotask, URL, Request, Uint8Array,
  });
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  vm.runInContext(`(${source})(${JSON.stringify({ platform, connection: null, defaults: { serviceUrl: "http://127.0.0.1:7321", metaSendsSuperKey: "omarchy-bot.meta-sends-super" }, ...initial })})`, context);
  return { shell: context.window.__OMARCHY_BOT_SHELL__ as Shell, window: context.window, calls };
}

test("native shell reports its OS and retains the device key mapping without replacing fetch", async () => {
  for (const platform of ["linux", "macos", "windows"] as const) {
    const { shell, window } = install(platform);
    expect(window.fetch).toBe(globalThis.fetch);
    expect(shell.keyMapping.platform()).toBe(platform);
    expect(shell.keyMapping.metaSendsSuper()).toBe(false);
    await shell.keyMapping.setMetaSendsSuper(true);
    expect(shell.keyMapping.metaSendsSuper()).toBe(true);
    await shell.keyMapping.setMetaSendsSuper(false);
    expect(shell.keyMapping.metaSendsSuper()).toBe(false);
  }
});

test("native attachment saves authenticated bytes and returns the Downloads collision path without opening a browser", async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(input), options });
    return new Response("report bytes");
  }) as typeof fetch;
  const { shell, calls } = install("linux", { connection: { baseUrl: "https://service.example", token: "private-token" } }, fetcher);
  expect(await shell.attachments.save("/api/attachments/att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "report.txt")).toBe("/home/test/Downloads/1-report.txt");
  expect(requests).toEqual([{ url: "https://service.example/api/attachments/att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", options: { headers: { authorization: "Bearer private-token" }, redirect: "error" } }]);
  expect(calls.find(call => call.command === "save_attachment")?.args).toEqual({ filename: "report.txt", bytes: Array.from(new TextEncoder().encode("report bytes")) });
  await expect(shell.attachments.save("https://foreign.example/api/attachments/att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "report.txt")).rejects.toThrow("paired Service");
  await expect(shell.browser.open("https://service.example/file?access_token=private-token")).rejects.toThrow("authenticated Service link");
  expect(calls.filter(call => call.command === "open_browser")).toEqual([]);
  await shell.browser.open("https://example.com/docs");
  expect(calls.filter(call => call.command === "open_browser")).toEqual([{ command: "open_browser", args: { value: "https://example.com/docs" } }]);
});

test("native shell exposes startup notices and certificate diagnosis through the connection capability", async () => {
  const { shell } = install("linux", { error: "The OS keychain is unavailable.", revoked: "https://service.example" });
  expect(shell.service.status()).toEqual({ error: "The OS keychain is unavailable.", revoked: true });
  expect(await shell.service.certificateUntrusted("https://service.example")).toBe(true);
});

test("native shell rejects failed or unpaired attachment downloads before writing", async () => {
  const unpaired = install("linux");
  await expect(unpaired.shell.attachments.save("/api/attachments/att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "report.txt")).rejects.toThrow("paired Service");
  const { shell, calls } = install("linux", { connection: { baseUrl: "https://service.example", token: "private-token" } }, (async (_input: string | URL | Request, _options?: RequestInit) => new Response("revoked", { status: 401 })) as typeof fetch);
  await expect(shell.attachments.save("/api/attachments/att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "report.txt")).rejects.toThrow("downloaded");
  expect(calls.some(call => call.command === "save_attachment")).toBe(false);
});
