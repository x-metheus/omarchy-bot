import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Shell } from "../../apps/omarchy-bot/src/lib/shell.ts";

function install(initial: Record<string, unknown> = {}, fetcher: (input: string | URL | Request, options?: RequestInit) => Promise<Response> = globalThis.fetch) {
  const calls: { command: string; args: unknown }[] = [];
  const window = new EventTarget();
  const context = vm.createContext({
    window: Object.assign(window, {
      fetch: fetcher,
      __TAURI_INTERNALS__: { async invoke(command: string, args: unknown) {
        calls.push({ command, args });
        if (command === "take_pairing_request") return null;
        if (command === "save_attachment") return "/home/test/Downloads/1-report.txt";
        if (command === "open_browser") return;
        if (command === "certificate_untrusted") return true;
        throw new Error(`Unexpected native command: ${command}`);
      } },
    }),
    // Native installation must not access the page DOM, even for startup errors.
    queueMicrotask, URL, Uint8Array,
  });
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  vm.runInContext(`(${source})(${JSON.stringify({
    connection: null, localDaemon: { baseUrl: "http://127.0.0.1:8765", autostart: false },
    ...initial,
  })})`, context);
  return { shell: context.window.__OMARCHY_BOT_SHELL__ as Shell, window: context.window, calls };
}

test("native adapter leaves the shell unavailable when Tauri IPC is missing", () => {
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(`(${source})({})`, { window });
  expect(window).toEqual({});
});

test("native shell keeps the WebView fetch implementation", () => {
  expect(install().window.fetch).toBe(globalThis.fetch);
});

test("native attachment saves authenticated bytes and returns the Downloads collision path without opening a browser", async () => {
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(input), options });
    return new Response("report bytes");
  }) as typeof fetch;
  const { shell, calls } = install({ connection: { baseUrl: "https://service.example", token: "private-token" } }, fetcher);
  const paths = [
    "/bots/ab193370-7814-45b9-9f33-6af3cf97818b/attachments/e30e61e5-aaea-4840-a622-ebe5167d4df5",
  ];
  for (const path of paths) {
    expect(await shell.attachments.save(path, "report.txt")).toBe("/home/test/Downloads/1-report.txt");
    await expect(shell.attachments.save(`https://foreign.example${path}`, "report.txt")).rejects.toThrow("paired Service");
  }
  await expect(shell.attachments.save("/api/attachments/att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "report.txt")).rejects.toThrow("paired Service");
  expect(requests).toEqual(paths.map(path => ({ url: `https://service.example${path}`,
    options: { headers: { authorization: "Bearer private-token" }, redirect: "error", cache: "no-store" },
  })));
  expect(calls.filter(call => call.command === "save_attachment").map(call => call.args)).toEqual(paths.map(() => ({
    filename: "report.txt", bytes: Array.from(new TextEncoder().encode("report bytes")),
  })));
  await expect(shell.browser.open("https://service.example/file?access_token=private-token")).rejects.toThrow("authenticated Service link");
  expect(calls.filter(call => call.command === "open_browser")).toEqual([]);
  await shell.browser.open("https://example.com/docs");
  expect(calls.filter(call => call.command === "open_browser")).toEqual([{ command: "open_browser", args: { value: "https://example.com/docs" } }]);
});

test("native shell exposes startup notices and certificate diagnosis through the connection capability", async () => {
  const { shell } = install({ error: "The OS keychain is unavailable.", revoked: "https://service.example" });
  expect(shell.service.status()).toEqual({ error: "The OS keychain is unavailable.", revoked: true });
  expect(await shell.service.certificateUntrusted("https://service.example")).toBe(true);
});

test("native shell rejects failed or unpaired attachment downloads before writing", async () => {
  const attachment = "/bots/ab193370-7814-45b9-9f33-6af3cf97818b/attachments/e30e61e5-aaea-4840-a622-ebe5167d4df5";
  const unpaired = install();
  await expect(unpaired.shell.attachments.save(attachment, "report.txt")).rejects.toThrow("paired Service");
  const { shell, calls } = install({ connection: { baseUrl: "https://service.example", token: "private-token" } }, (async (_input: string | URL | Request, _options?: RequestInit) => new Response("revoked", { status: 401 })) as typeof fetch);
  await expect(shell.attachments.save(attachment, "report.txt")).rejects.toThrow("downloaded");
  expect(calls.some(call => call.command === "save_attachment")).toBe(false);
});
