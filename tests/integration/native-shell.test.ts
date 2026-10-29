import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { Shell } from "../../apps/web/src/lib/shell.ts";

function install(platform: string, options: {
  baseUrl?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  digest?: () => Promise<string>;
  bodyReady?: boolean;
} = {}) {
  const window = new EventTarget();
  const values = new Map<string, string>();
  const starts: string[] = [];
  const notices: Array<{ id: string; textContent: string; setAttribute(name: string, value: string): void; role?: string }> = [];
  const document = Object.assign(new EventTarget(), {
    body: options.bodyReady === false ? null : { prepend: (node: typeof notices[number]) => notices.push(node) },
    getElementById: (id: string) => notices.find(node => node.id === id),
    createElement: () => ({ id: "", textContent: "", setAttribute(name: string, value: string) { Object.assign(this, { [name]: value }); } }),
  });
  const context = vm.createContext({
    window: Object.assign(window, {
      fetch: options.fetch ?? globalThis.fetch,
      __TAURI_INTERNALS__: { async invoke(command: string) {
        if (command === "host_digest") return options.digest?.() ?? "b".repeat(64);
        if (command === "sidecar_start") { starts.push(command); return; }
        if (command === "sidecar_events") return { status: { running: false }, approvals: [] };
        if (command === "take_pairing_request") return null;
        throw new Error(`Unexpected native command: ${command}`);
      } },
    }),
    document,
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    queueMicrotask, URL, Request, AbortSignal, location: { href: "tauri://localhost" },
  });
  const source = readFileSync(new URL("../../apps/omarchy-bot/src-tauri/src/shell.js", import.meta.url), "utf8");
  vm.runInContext(`(${source})(${JSON.stringify({ platform, connection: options.baseUrl ? { baseUrl: options.baseUrl, token: "paired-token" } : null })})`, context);
  return { shell: context.window.__OMARCHY_BOT_SHELL__ as Shell, starts, notices, document, window };
}

test("native shell reports its OS and retains the device key mapping", async () => {
  for (const platform of ["linux", "macos"] as const) {
    const { shell } = install(platform);
    expect(shell.keyMapping.platform()).toBe(platform);
    expect(shell.keyMapping.metaSendsSuper()).toBe(false);
    await shell.keyMapping.setMetaSendsSuper(true);
    expect(shell.keyMapping.metaSendsSuper()).toBe(true);
    await shell.keyMapping.setMetaSendsSuper(false);
    expect(shell.keyMapping.metaSendsSuper()).toBe(false);
  }
});

test("a distinct Service host reached through loopback starts the Local Sidecar", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const { starts } = install("linux", {
    baseUrl: "http://localhost:7321",
    fetch: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ salt: "a".repeat(64), digest: "c".repeat(64) });
    },
  });
  const settled = Promise.withResolvers<void>();
  setImmediate(settled.resolve);
  await settled.promise;
  expect(requests).toEqual([{ url: "http://localhost:7321/api/host-identity", authorization: "Bearer paired-token" }]);
  expect(starts).toEqual(["sidecar_start"]);
});

test("same-machine identity suppresses the Sidecar over loopback and LAN HTTPS", async () => {
  for (const baseUrl of ["http://127.0.0.1:7321", "https://10.0.0.9:8443"]) {
    const { starts } = install("linux", {
      baseUrl,
      fetch: async () => Response.json({ salt: "a".repeat(64), digest: "b".repeat(64) }),
    });
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    expect(starts).toEqual([]);
  }
});

test("failed identity checks keep local actions unavailable with a recoverable notice", async () => {
  const failures = [
    { fetch: async () => { throw new Error("Service unreachable"); } },
    { fetch: async () => new Response("failed", { status: 503 }) },
    { fetch: async () => Response.json({ salt: "a".repeat(64), digest: "invalid" }) },
    { fetch: async () => Response.json({ salt: "invalid", digest: "c".repeat(64) }) },
    { fetch: async () => Response.json(null) },
    { fetch: async () => Response.json({ salt: "a".repeat(64), digest: "c".repeat(64) }), digest: async () => { throw new Error("Machine identity unavailable"); } },
  ];
  for (const failure of failures) {
    const { starts, notices } = install("linux", { baseUrl: "http://localhost:7321", ...failure });
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    expect(starts).toEqual([]);
    expect(notices[0]?.textContent).toContain("Local actions are unavailable");
    expect(notices[0]?.textContent).toContain("reopen Omarchy Bot to retry");
    expect(notices[0]?.role).toBe("alert");
  }
});

test("macOS and Windows start a Sidecar without comparing a Linux Service identity", async () => {
  for (const platform of ["macos", "windows"]) {
    let requests = 0;
    const { starts } = install(platform, { baseUrl: "http://localhost:7321", fetch: async () => { requests++; throw new Error("Unexpected request"); } });
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    expect(starts).toEqual(["sidecar_start"]);
    expect(requests).toBe(0);
  }
});

test("identity failure before document creation displays its notice when the app is ready", async () => {
  const { starts, notices, document, window } = install("linux", {
    baseUrl: "http://localhost:7321", bodyReady: false,
    fetch: async () => { throw new Error("Service unreachable"); },
  });
  const settled = Promise.withResolvers<void>();
  setImmediate(settled.resolve);
  await settled.promise;
  expect(starts).toEqual([]);
  expect(notices).toEqual([]);
  document.body = { prepend: node => notices.push(node) };
  // Initialization scripts run before the body; DOMContentLoaded is the real recovery signal.
  window.dispatchEvent(new Event("DOMContentLoaded"));
  expect(notices[0]?.textContent).toContain("Local actions are unavailable");
});
