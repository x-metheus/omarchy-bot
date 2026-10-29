import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Shell } from "../../apps/web/src/lib/shell.ts";

function install(platform: string, initial: Record<string, unknown> = {}, fetcher: (input: string | URL | Request, options?: RequestInit) => Promise<Response> = globalThis.fetch, digest = async () => "b".repeat(64)) {
  const calls: { command: string; args: unknown }[] = [];
  const window = new EventTarget();
  const values = new Map<string, string>();
  const context = vm.createContext({
    window: Object.assign(window, {
      fetch: fetcher,
      __TAURI_INTERNALS__: { async invoke(command: string, args: unknown) {
        calls.push({ command, args });
        if (command === "host_digest") return digest();
        if (command === "sidecar_start") return;
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
    queueMicrotask, URL, Request, Uint8Array, AbortSignal,
  });
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  vm.runInContext(`(${source})(${JSON.stringify({ platform, connection: null, defaults: { serviceUrl: "http://127.0.0.1:7321", metaSendsSuperKey: "omarchy-bot.meta-sends-super" }, ...initial })})`, context);
  return { shell: context.window.__OMARCHY_BOT_SHELL__ as Shell, window: context.window, calls };
}

test("native adapter leaves the shell unavailable when Tauri IPC is missing", () => {
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(`(${source})({})`, { window });
  expect(window).toEqual({});
});

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

test("host identity is verified only through explicit Sidecar startup and starts remote loopback local actions once", async () => {
  const requests: string[] = [];
  const { shell, calls } = install("linux", { connection: { baseUrl: "http://localhost:7321", token: "paired-token" } }, (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer paired-token");
    return Response.json({ salt: "a".repeat(64), digest: "c".repeat(64) });
  }) as typeof fetch);
  expect(requests).toEqual([]);
  await Promise.all([shell.localSidecar.start(), shell.localSidecar.start()]);
  expect(requests).toEqual(["http://localhost:7321/api/host-identity"]);
  expect(calls.filter(call => call.command === "sidecar_start")).toHaveLength(1);
});

test("same-machine identity suppresses Sidecar startup over loopback and LAN HTTPS", async () => {
  for (const baseUrl of ["http://127.0.0.1:7321", "https://10.0.0.9:8443"]) {
    const { shell, calls } = install("linux", { connection: { baseUrl, token: "paired-token" } }, (async (_input: string | URL | Request) => Response.json({ salt: "a".repeat(64), digest: "b".repeat(64) })) as typeof fetch);
    await shell.localSidecar.start();
    expect(calls.some(call => call.command === "sidecar_start")).toBe(false);
  }
});

test("failed identity checks reject Sidecar startup with recovery instructions before any document exists", async () => {
  const failures = [
    async () => { throw new Error("Service unreachable"); },
    async () => new Response("failed", { status: 503 }),
    async () => Response.json({ salt: "a".repeat(64), digest: "invalid" }),
    async () => Response.json({ salt: "invalid", digest: "c".repeat(64) }),
    async () => Response.json(null),
  ];
  for (const failure of failures) {
    const { shell, calls } = install("linux", { connection: { baseUrl: "http://localhost:7321", token: "paired-token" } }, (async (_input: string | URL | Request) => failure()) as typeof fetch);
    await expect(shell.localSidecar.start()).rejects.toThrow("reopen Omarchy Bot to retry");
    expect(calls.some(call => call.command === "sidecar_start")).toBe(false);
  }
  const { shell, calls } = install("linux", { connection: { baseUrl: "http://localhost:7321", token: "paired-token" } }, (async (_input: string | URL | Request) => Response.json({ salt: "a".repeat(64), digest: "c".repeat(64) })) as typeof fetch, async () => { throw new Error("Machine identity unavailable"); });
  await expect(shell.localSidecar.start()).rejects.toThrow("Machine identity unavailable");
  expect(calls.some(call => call.command === "sidecar_start")).toBe(false);
});

test("macOS and Windows start Sidecars without comparing the Linux Service identity", async () => {
  for (const platform of ["macos", "windows"]) {
    const { shell, calls } = install(platform, { connection: { baseUrl: "http://localhost:7321", token: "paired-token" } }, async () => { throw new Error("Unexpected identity request"); });
    await shell.localSidecar.start();
    expect(calls.filter(call => call.command === "sidecar_start")).toHaveLength(1);
  }
});
