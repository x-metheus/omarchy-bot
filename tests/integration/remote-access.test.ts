import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/daemon/src/bootstrap/config.ts";
import { startDaemon } from "./helpers/harness.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";

const saved = { ...process.env };
let root: string;
let daemon: { stop(): Promise<void> } | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "remote-access-"));
  process.env.OMARCHY_BOT_HOME = path.join(root, "data");
  process.env.OMARCHY_BOT_STATE = path.join(root, "state");
  process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");
  process.env.OMARCHY_BOT_HOST = "127.0.0.1";
  delete process.env.OMARCHY_BOT_TLS_CERT;
  delete process.env.OMARCHY_BOT_TLS_KEY;
  delete process.env.OMARCHY_BOT_TRUSTED_PROXY;
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

for (const host of ["192.168.1.10", "0.0.0.0", "::", "[::]", "127.service.example", "localhost.example", "127.1", "127.0.0.256"]) {
  test(`startup refuses unprotected ${host} before creating data`, () => {
    process.env.OMARCHY_BOT_HOST = host;
    expect(() => loadConfig()).toThrow(new RegExp(`${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*certificate.*OMARCHY_BOT_TLS_CERT.*OMARCHY_BOT_TLS_KEY.*OMARCHY_BOT_TRUSTED_PROXY`));
    expect(existsSync(process.env.OMARCHY_BOT_HOME!)).toBe(false);
  });
}
for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1", "[::1]"]) {
  test(`loopback ${host} starts without TLS`, () => {
    process.env.OMARCHY_BOT_HOST = host;
    expect(loadConfig().host).toBe(host);
  });
}
for (const proxy of ["127.0.0.1", "::1"]) {
  test(`declared proxy ${proxy} permits a wildcard listener`, () => {
    process.env.OMARCHY_BOT_HOST = "0.0.0.0";
    process.env.OMARCHY_BOT_TRUSTED_PROXY = proxy;
    expect(loadConfig()).toMatchObject({ host: "0.0.0.0", trustedProxy: proxy });
  });
}
for (const proxy of ["bot.example", "127.0.0.1/8", "127.0.0.1:1", "127.1", "127.0.0.256", "127.00.0.1"]) {
  test(`startup refuses invalid trusted proxy ${proxy} before creating data`, () => {
    process.env.OMARCHY_BOT_HOST = "0.0.0.0";
    process.env.OMARCHY_BOT_TRUSTED_PROXY = proxy;
    expect(() => loadConfig()).toThrow(/OMARCHY_BOT_TRUSTED_PROXY.*IP address/);
    expect(existsSync(process.env.OMARCHY_BOT_HOME!)).toBe(false);
  });
}
test("a certificate and key permit a LAN listener", () => {
  process.env.OMARCHY_BOT_HOST = "192.168.1.10";
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  writeFileSync(cert, "certificate"); writeFileSync(key, "key");
  process.env.OMARCHY_BOT_TLS_CERT = cert;
  process.env.OMARCHY_BOT_TLS_KEY = key;
  expect(loadConfig()).toMatchObject({ tlsCert: cert, tlsKey: key });
});
for (const missing of ["OMARCHY_BOT_TLS_CERT", "OMARCHY_BOT_TLS_KEY"]) {
  test(`startup refuses missing ${missing}`, () => {
    process.env.OMARCHY_BOT_TLS_CERT = path.join(root, "cert");
    process.env.OMARCHY_BOT_TLS_KEY = path.join(root, "key");
    delete process.env[missing];
    expect(() => loadConfig()).toThrow(/OMARCHY_BOT_TLS_CERT.*OMARCHY_BOT_TLS_KEY/);
  });
}
test("startup identifies a missing certificate path", () => {
  process.env.OMARCHY_BOT_TLS_CERT = path.join(root, "missing-cert.pem");
  process.env.OMARCHY_BOT_TLS_KEY = path.join(root, "key.pem");
  writeFileSync(process.env.OMARCHY_BOT_TLS_KEY, "key");
  expect(() => loadConfig()).toThrow(process.env.OMARCHY_BOT_TLS_CERT);
});

for (const scenario of [
  { name: "declared proxy", proxy: "127.0.0.1", forwarded: true },
  { name: "HTTP from a proxy terminating TLS", proxy: "127.0.0.1", proto: "http", forwarded: true },
  { name: "another peer", proxy: "10.1.2.3", forwarded: false },
  { name: "no proxy", proxy: "", forwarded: false },
  { name: "remote app Origin", proxy: "127.0.0.1", origin: "tauri://localhost", forwarded: true },
  { name: "invalid forwarded scheme", proxy: "127.0.0.1", proto: "javascript", forwarded: false },
  { name: "forwarded host path", proxy: "127.0.0.1", host: "evil.example/path", forwarded: false },
  { name: "forwarded userinfo", proxy: "127.0.0.1", host: "user:pass@evil.example", forwarded: false },
  { name: "comma separated proxy headers", proxy: "127.0.0.1", proto: "https, http", host: "bot.example, internal", forwarded: true },
]) {
  test(`OAuth Service callback respects ${scenario.name}`, async () => {
    process.env.OMARCHY_BOT_TRUSTED_PROXY = scenario.proxy;
    let callbackUrl: string | undefined;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/plugins/oauth/start") {
        callbackUrl = (await request.json() as { callbackUrl: string }).callbackUrl;
        return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" });
      }
      return originalFetch(request);
    }, { preconnect: originalFetch.preconnect });
    const h = await startDaemon(path.join(root, "daemon"), { waitForAgentReady: false });
    daemon = h;
    // Peer identity comes from the socket, never forwarded-for headers.
    const response = await fetch(`${h.baseUrl}/api/plugins/authorize`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json", "x-forwarded-proto": scenario.proto ?? "https", "x-forwarded-host": scenario.host ?? "bot.example", ...("origin" in scenario ? { origin: scenario.origin } : {}) },
      body: JSON.stringify({ providerId: "google" }),
    });
    expect(response.status).toBe(200);
    const origin = scenario.forwarded ? `${scenario.proto === "http" ? "http" : "https"}://bot.example` : h.baseUrl;
    expect(callbackUrl).toBe(`${origin}/api/plugins/oauth/callback`);
  });
}

test("HTTPS and WSS preserve the paired-device gate", async () => {
  if (!Bun.which("openssl")) throw new Error("Skip TLS integration: openssl is unavailable");
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=127.0.0.1"]);
  expect(generated.exitCode).toBe(0);
  process.env.OMARCHY_BOT_TLS_CERT = cert;
  process.env.OMARCHY_BOT_TLS_KEY = key;
  process.env.OMARCHY_BOT_TRUSTED_PROXY = "127.0.0.1";
  process.env.OMARCHY_BOT_PORT = "0";
  process.env.HOME = root;
  process.env.OMARCHY_BOT_WORKERS_DIR = path.resolve(import.meta.dir, "fake-workers");
  // Boot after configuring the isolated environment, matching the harness loading boundary.
  const { main } = await import("../../apps/daemon/src/bootstrap/main.ts");
  const running = await main({ useHostApplicationUnits: false, botScreenRuntimeDir: path.join(root, "r"), botScreenAdapter: new FakeBotScreenRuntimeAdapter() });
  daemon = running;
  const baseUrl = `https://127.0.0.1:${running.port}`;
  const tls = { rejectUnauthorized: false };
  const request = (pathname: string, init: RequestInit = {}) => fetch(`${baseUrl}${pathname}`, { ...init, tls });
  const health = await request("/api/health");
  expect(health.status).toBe(200);
  const body = await health.json();
  expect(Object.keys(body).sort()).toEqual(["ok", "protocol", "version"]);
  expect(body.ok).toBe(true);
  expect(typeof body.version).toBe("string");
  expect(body.protocol).toBe(1);
  expect((await request("/api/agents")).status).toBe(401);
  const secret = readFileSync(path.join(process.env.OMARCHY_BOT_STATE!, "pairing-host-secret"), "utf8").trim();
  const issued = await request("/api/pairing/codes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ name: "TLS browser" }) }).then(r => r.json());
  const paired = await request("/api/pairing/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: issued.code, name: "TLS browser" }) }).then(r => r.json());
  expect((await request("/api/agents", { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(200);
  for (const scheme of ["http", "https"]) {
    const response = await request("/api/plugins/authorize", {
      method: "POST",
      headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json", "x-forwarded-proto": scheme, "x-forwarded-host": "bot.example" },
      body: JSON.stringify({ providerId: "google", accountId: "missing-account" }),
    });
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error).toBe("Provider account not found");
  }
  const socketResult = (token?: string) => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const ws = new Socket(`wss://127.0.0.1:${running.port}/api/events${token ? `?access_token=${encodeURIComponent(token)}` : ""}`, { tls });
    ws.onopen = () => { resolve(true); ws.close(); };
    ws.onerror = () => resolve(false);
    ws.onclose = () => resolve(false);
    return promise;
  };
  expect(await socketResult(paired.token)).toBe(true);
  expect(await socketResult()).toBe(false);
}, 15000);

test("Service serves no SPA documents even with a device token", async () => {
  const h = await startDaemon(path.join(root, "daemon"), { waitForAgentReady: false });
  daemon = h;
  for (const pathname of ["/", "/index.html", "/client/route"]) {
    const response = await fetch(`${h.baseUrl}${pathname}?access_token=private`);
    expect(response.status).toBe(404);
  }
});
