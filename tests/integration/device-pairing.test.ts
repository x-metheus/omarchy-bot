import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import daemonPkg from "../../apps/daemon/package.json" with { type: "json" };
import { networkInterfaces, tmpdir } from "node:os";
import { startHttp } from "../../apps/daemon/src/api/http.ts";

let h: Harness;

// Raw fetch only: this suite must not race the harness token plumbing.
beforeAll(async () => {
  const development = process.env.OMARCHY_BOT_DEV;
  delete process.env.OMARCHY_BOT_DEV;
  try {
    h = await startDaemon();
  } finally {
    if (development !== undefined) process.env.OMARCHY_BOT_DEV = development;
  }
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function hostSecret(): Promise<string> {
  return readFileSync(path.join(h.svc.cfg.stateDir, "pairing-host-secret"), "utf8").trim();
}

async function issueCode(name: string): Promise<{ code: string; url: string; expiresAt: string }> {
  const res = await fetch(`${h.baseUrl}/api/pairing/codes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await hostSecret()}` },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { code: string; url: string; expiresAt: string };
}

async function exchange(code: string, name?: string): Promise<{ status: number; body: unknown }> {
  const res = await post("/api/pairing/exchange", name === undefined ? { code } : { code, name });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function pair(name = "Paired Test Client"): Promise<{ token: string; device: { id: string; name: string } }> {
  const issued = await issueCode(name);
  const result = await exchange(issued.code, name);
  expect(result.status).toBe(201);
  return result.body as { token: string; device: { id: string; name: string } };
}

/** A rejected upgrade surfaces as an error before any open frame. */
async function upgradeRejected(path: string): Promise<boolean> {
  const socket = new WebSocket(`${h.baseUrl.replace(/^http/, "ws")}${path}`);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  // Real socket against a real server: the deadline only fails a hang.
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error(`socket ${path} was neither opened nor rejected`));
  }, 5_000);
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    socket.close();
    resolve(false);
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    resolve(true);
  }, { once: true });
  return promise;
}

async function upgradeStatus(path: string, origin?: string, token?: string, daemon = h): Promise<number> {
  const url = new URL(path, daemon.baseUrl);
  if (token !== undefined) url.searchParams.set("access_token", token);
  const response = await fetch(url, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...(origin === undefined ? {} : { origin }),
    },
  });
  return response.status;
}

async function openSocket(path: string, origin?: string, daemon = h): Promise<WebSocket> {
  const url = new URL(path, daemon.baseUrl);
  url.protocol = "ws:";
  url.searchParams.set("access_token", daemon.token);
  const Socket = WebSocket as unknown as new (url: string | URL, options: Bun.WebSocketOptions) => WebSocket;
  const socket = new Socket(url, { headers: origin === undefined ? {} : { origin } });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Real network events resolve this; the platform-clock deadline only fails a hang.
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error(`socket ${url.pathname} did not open`));
  }, 5_000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`socket ${url.pathname} was rejected`)); }, { once: true });
  await promise;
  return socket;
}

const appOrigins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

describe("cross-origin Service boundary", () => {
  test("answers app preflights without a token for every API client method and header", async () => {
    for (const origin of appOrigins) {
      const res = await fetch(`${h.baseUrl}/api/bots`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, x-command-id, x-bot-id, x-attachment-draft-token",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      const methods = res.headers.get("access-control-allow-methods")?.split(/,\s*/);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) expect(methods).toContain(method);
      const headers = res.headers.get("access-control-allow-headers")?.toLowerCase().split(/,\s*/);
      for (const header of ["authorization", "content-type", "x-command-id", "x-bot-id", "x-attachment-draft-token"]) {
        expect(headers).toContain(header);
      }
      expect(res.headers.get("vary")?.toLowerCase().split(/,\s*/)).toContain("origin");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  test("makes app responses readable while preserving token authentication and errors", async () => {
    for (const origin of appOrigins) {
      const requests: Array<[string, RequestInit, number]> = [
        ["/api/agents", {}, 401],
        ["/api/agents", { headers: bearer(h.token) }, 200],
        ["/api/bots", { method: "POST", headers: { ...bearer(h.token), "content-type": "application/json" }, body: "{" }, 400],
      ];
      for (const [path, init, status] of requests) {
        const res = await fetch(`${h.baseUrl}${path}`, { ...init, headers: { ...init.headers, origin } });
        expect(res.status).toBe(status);
        expect(res.headers.get("access-control-allow-origin")).toBe(origin);
        expect(res.headers.get("vary")?.toLowerCase().split(/,\s*/)).toContain("origin");
        expect(res.headers.get("access-control-allow-credentials")).toBeNull();
        if (status === 401) expect(await res.json()).toEqual({ error: "unauthorized" });
        if (status === 400) expect(await res.json()).toEqual({ error: "invalid JSON body" });
      }
    }
  });

  test("does not grant CORS to foreign, opaque, or malformed origins", async () => {
    for (const origin of ["https://evil.example", "null", "not an origin", "tauri://localhost/", "http://tauri.localhost/path", "http://localhost:7322", "constructor"]) {
      for (const method of ["OPTIONS", "GET"]) {
        const res = await fetch(`${h.baseUrl}/api/agents`, { method, headers: { origin } });
        expect(res.status).toBe(method === "OPTIONS" ? 204 : 401);
        expect([...res.headers.keys()].filter(key => key.startsWith("access-control-allow-"))).toEqual([]);
        expect(res.headers.get("vary")?.toLowerCase().split(/,\s*/)).toContain("origin");
      }
    }
    const noOrigin = await fetch(`${h.baseUrl}/api/agents`);
    expect(noOrigin.status).toBe(401);
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(noOrigin.headers.get("vary")?.toLowerCase().split(/,\s*/)).toContain("origin");
  });

  test("allows only exact HTTP loopback development origins with explicit opt-in", async () => {
    const original = process.env.OMARCHY_BOT_DEV;
    let dev: Harness;
    try {
      process.env.OMARCHY_BOT_DEV = "1";
      dev = await startDaemon(undefined, { waitForAgentReady: false });
    } finally {
      if (original === undefined) delete process.env.OMARCHY_BOT_DEV;
      else process.env.OMARCHY_BOT_DEV = original;
    }
    try {
      for (const origin of ["http://localhost", "http://localhost:7322", "http://127.0.0.1:49876", "http://[::1]:3000"]) {
        for (const method of ["OPTIONS", "GET"]) {
          const production = await fetch(`${h.baseUrl}/api/agents`, { method, headers: { origin } });
          expect(production.headers.get("access-control-allow-origin")).toBeNull();
          const response = await fetch(`${dev.baseUrl}/api/agents`, { method, headers: { origin } });
          expect(response.status).toBe(method === "OPTIONS" ? 204 : 401);
          expect(response.headers.get("access-control-allow-origin")).toBe(origin);
          expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        }
        expect(await upgradeStatus("/api/events", origin, undefined, dev)).toBe(401);
        const socket = await openSocket("/api/events", origin, dev);
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
      }
      for (const origin of ["null", "https://localhost:7322", "http://localhost.evil:7322", "http://127.1:7322", "http://127.0.0.2:7322", "http://2130706433:7322", "http://user@localhost:7322", "http://localhost:7322/", "http://localhost:7322/path", "http://localhost:7322?query", "http://localhost:7322#fragment", "http://localhost:99999", "http://localhost:", "http://localhost\\evil"]) {
        for (const method of ["OPTIONS", "GET"]) {
          const response = await fetch(`${dev.baseUrl}/api/agents`, { method, headers: { origin } });
          expect([...response.headers.keys()].filter(key => key.startsWith("access-control-allow-"))).toEqual([]);
        }
        expect(await upgradeStatus("/api/events", origin, dev.token, dev)).toBe(403);
      }
    } finally {
      await dev.stop();
    }
  });

  test("refuses foreign WebSocket origins before token checks on every upgrade family", async () => {
    for (const path of ["/api/events", "/api/devices", "/api/computer/projection/control", "/api/computer/projection/rfb"]) {
      for (const origin of ["https://evil.example", "null", "http://localhost:7322", "tauri://localhost/"]) {
        expect(await upgradeStatus(path, origin)).toBe(403);
        expect(await upgradeStatus(path, origin, h.token)).toBe(403);
      }
      for (const origin of [undefined, ...appOrigins]) {
        expect(await upgradeStatus(path, origin)).toBe(401);
        expect(await upgradeStatus(path, origin, "0".repeat(64))).toBe(401);
      }
    }
  });

  test("paired tokens open every WebSocket family with absent or app origins", async () => {
    const sockets: WebSocket[] = [];
    const botId = await makeBot(h, "Cross-origin projection");
    const bot = await api<{ surfaceId: string }>(h, "GET", `/api/bots/${botId}`);
    try {
      for (const origin of [undefined, ...appOrigins]) {
        for (const path of ["/api/events", "/api/devices"]) {
          const socket = await openSocket(path, origin);
          sockets.push(socket);
          expect(socket.readyState).toBe(WebSocket.OPEN);
        }
        const session = await api<{ controlUrl: string; rfbUrl: string; sessionId: string; surfaceId: string; runtimeGeneration: number }>(
          h, "POST", `/api/computer/projection?botId=${botId}&surfaceId=${bot.surfaceId}`, { version: 3 },
        );
        const control = await openSocket(session.controlUrl, origin);
        sockets.push(control);
        expect(control.readyState).toBe(WebSocket.OPEN);
        const expanded = Promise.withResolvers<void>();
        // Await the server acknowledgement; the real-time deadline only fails a hung transport.
        const timer = setTimeout(() => expanded.reject(new Error("expanded projection was not acknowledged")), 5_000);
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as { type: string; mode?: string };
          if (message.type !== "view-state" || message.mode !== "expanded") return;
          clearTimeout(timer);
          control.removeEventListener("message", onMessage);
          expanded.resolve();
        };
        control.addEventListener("message", onMessage);
        control.send(JSON.stringify({ version: 3, sessionId: session.sessionId, surfaceId: session.surfaceId, runtimeGeneration: session.runtimeGeneration, type: "view", mode: "expanded" }));
        await expanded.promise;
        const rfb = await openSocket(session.rfbUrl, origin);
        sockets.push(rfb);
        expect(rfb.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      for (const socket of sockets) socket.close();
    }
  }, 30_000);
});

describe("unpaired callers", () => {
  test("receive 401 on every route family and socket", async () => {
    const requests: Array<[string, string, unknown?]> = [
      ["GET", "/api/agents"],
      ["GET", "/api/bots"],
      ["GET", "/api/devices"],
      ["GET", "/api/devices/paired"],
      ["POST", "/api/bots", { name: "Sneaky Bot", agentId: "pi" }],
      ["GET", "/api/plugins"],
      ["GET", "/api/not-a-route"],
    ];
    for (const [method, path, body] of requests) {
      const res = await fetch(`${h.baseUrl}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    for (const path of ["/api/events", "/api/devices", "/api/computer/projection/control"]) {
      expect(await upgradeRejected(path)).toBe(true);
    }
  });

  test("health stays unauthenticated and reveals only liveness and version", async () => {
    const res = await fetch(`${h.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: daemonPkg.version });
  });

  test("former static, SPA fallback and pairing paths return 404", async () => {
    for (const path of ["/", "/index.html", "/pair?code=ABCD2345", "/client/route", "/missing-static-file.js"]) {
      const res = await fetch(`${h.baseUrl}${path}`);
      expect(res.status).toBe(404);
    }
  });

  test("refuses a pairing code to a loopback caller without the host secret", async () => {
    const res = await post("/api/pairing/codes", { name: "Stranger" });
    expect(res.status).toBe(401);
    const mode = statSync(path.join(h.svc.cfg.stateDir, "pairing-host-secret")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("lets the provider OAuth redirect complete without a device token", async () => {
    const res = await fetch(`${h.baseUrl}/api/plugins/oauth/callback`);
    expect(res.status).not.toBe(401);
  });
});

describe("pairing exchange", () => {
  test("issues a one-time code and a code is exchanged exactly once", async () => {
    const issued = await issueCode("Test Client");
    expect(issued.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(issued.url).toBe(`omarchy-bot://pair?service=${encodeURIComponent(h.baseUrl)}&code=${issued.code}`);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
    const stored = h.svc.db.query("SELECT code_hash FROM pairing_codes").all() as { code_hash: string }[];
    expect(stored.some((row) => row.code_hash === issued.code)).toBe(false);

    const first = await exchange(issued.code);
    expect(first.status).toBe(201);
    const { token, device } = first.body as { token: string; device: { id: string; name: string } };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(device.id).toMatch(/^paired_[0-9a-f]{16}$/);

    expect((await exchange(issued.code)).status).toBe(401);
    expect(await fetch(`${h.baseUrl}/api/agents`, { headers: bearer(token) })).toMatchObject({ status: 200 });
  });

  test("keeps the name issued with the code when the exchange omits one", async () => {
    const issued = await issueCode("Laptop");
    const result = await exchange(issued.code);
    expect(result.status).toBe(201);
    const body = result.body as { device: { name: string } };
    expect(body.device.name).toBe("Laptop");
  });

  test("rejects an expired code and drops the row", async () => {
    const issued = await issueCode("Expired Client");
    h.svc.db
      .query("UPDATE pairing_codes SET expires_at = ? WHERE name = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), "Expired Client");
    expect((await exchange(issued.code)).status).toBe(401);
    const row = h.svc.db.query("SELECT count(*) AS n FROM pairing_codes WHERE name = ?").get("Expired Client");
    expect(row).toEqual({ n: 0 });
  });

  test("rejects an unknown code", async () => {
    expect((await exchange("ZZZZZZZZ")).status).toBe(401);
  });
});

describe("paired device tokens", () => {
  test("authenticate by header and by query, header winning", async () => {
    const { token } = await pair();
    const byHeader = await fetch(`${h.baseUrl}/api/agents`, { headers: bearer(token) });
    expect(byHeader.status).toBe(200);
    const byQuery = await fetch(`${h.baseUrl}/api/agents?access_token=${token}`);
    expect(byQuery.status).toBe(200);
    const wrongHeader = await fetch(`${h.baseUrl}/api/agents?access_token=${token}`, {
      headers: bearer("0".repeat(64)),
    });
    expect(wrongHeader.status).toBe(401);
    const malformed = await fetch(`${h.baseUrl}/api/agents`, { headers: { authorization: `Bearer  ${token}` } });
    expect(malformed.status).toBe(401);
  });

  test("store only hashes and consume the code", async () => {
    const { token } = await pair("Hash Check");
    const rows = h.svc.db.query("SELECT token_hash FROM paired_devices").all() as { token_hash: string }[];
    expect(rows.some((row) => row.token_hash === token)).toBe(false);
    expect(rows.some((row) => row.token_hash === createHash("sha256").update(token).digest("hex"))).toBe(true);
    expect(h.svc.db.query("SELECT count(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
  });

  test("lists paired devices without secrets", async () => {
    const { token, device } = await pair("Roster Device");
    const res = await fetch(`${h.baseUrl}/api/devices/paired`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: Array<Record<string, unknown>> };
    const listed = body.devices.find((d) => d.id === device.id);
    expect(listed).toMatchObject({ id: device.id, name: "Roster Device", revokedAt: null });
    expect(typeof listed?.createdAt).toBe("string");
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  test("revoke closes live sockets and rejects the next request", async () => {
    const { token, device } = await pair("Revoked Device");
    const socket = new WebSocket(`${h.baseUrl.replace(/^http/, "ws")}/api/events?access_token=${token}`);
    const opened = Promise.withResolvers<void>();
    const timer = setTimeout(() => opened.reject(new Error("events socket did not open")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      opened.resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      opened.reject(new Error("events socket was rejected for a valid token"));
    }, { once: true });
    await opened.promise;
    const closed = Promise.withResolvers<number>();
    socket.addEventListener("close", (event) => closed.resolve(event.code), { once: true });

    expect(await fetch(`${h.baseUrl}/api/agents`, { headers: bearer(token) })).toMatchObject({ status: 200 });
    const revoked = await fetch(`${h.baseUrl}/api/devices/paired/${device.id}/revoke`, {
      method: "POST",
      headers: bearer(token),
    });
    expect(revoked.status).toBe(204);
    expect(await closed.promise).toBe(1008);
    expect((await fetch(`${h.baseUrl}/api/agents`, { headers: bearer(token) })).status).toBe(401);

    // Idempotent from another paired device: the row is already revoked, sockets gone.
    const { token: otherToken } = await pair("Revoker Device");
    const again = await fetch(`${h.baseUrl}/api/devices/paired/${device.id}/revoke`, {
      method: "POST",
      headers: bearer(otherToken),
    });
    expect(again.status).toBe(204);
  });

  test("unknown revoke target is 404", async () => {
    const { token } = await pair("Lookup Device");
    const res = await fetch(`${h.baseUrl}/api/devices/paired/paired_ffffffffffffffff/revoke`, {
      method: "POST",
      headers: bearer(token),
    });
    expect(res.status).toBe(404);
  });
});

test("interface-bound TLS CLI management retains loopback host authorization and certificate validation", async () => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!address) throw new Error("A local IPv4 interface is required");
  const root = mkdtempSync(path.join(tmpdir(), "ob-interface-tls-"));
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost", "-addext", `subjectAltName=IP:${address}`]).exitCode).toBe(0);
  const listener = startHttp({ ...h.svc, cfg: { ...h.svc.cfg, host: address, port: 0, tlsCert: cert, tlsKey: key } });
  const origin = `https://${address}:${listener.port}`;
  const env = { ...process.env, HOME: h.home, OMARCHY_BOT_HOME: h.svc.cfg.dataDir, OMARCHY_BOT_STATE: h.svc.cfg.stateDir, OMARCHY_BOT_HOST: address, OMARCHY_BOT_PORT: String(listener.port), OMARCHY_BOT_TLS_CERT: cert, OMARCHY_BOT_TLS_KEY: key, NODE_EXTRA_CA_CERTS: cert };
  const cli = async (args: string[], trusted = true) => {
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../apps/cli/src/main.ts"), ...args], { env: { ...env, NODE_EXTRA_CA_CERTS: trusted ? cert : "" }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  try {
    expect((await fetch(`${origin}/api/devices/paired`, { headers: bearer(await hostSecret()), tls: { rejectUnauthorized: false } })).status).toBe(401);
    const issued = await cli(["pair"]);
    expect(issued.code).toBe(0);
    expect(issued.stderr).toBe("");
    const [addressLine, codeLine, pairingLine] = issued.stdout.trim().split("\n");
    expect(addressLine).toBe(`address: ${origin}`);
    const link = new URL(pairingLine!.slice("pairing: ".length));
    expect(link.protocol).toBe("omarchy-bot:");
    expect(link.hostname).toBe("pair");
    expect(link.searchParams.get("service")).toBe(origin);
    const code = link.searchParams.get("code");
    expect(codeLine).toBe(`code: ${code}`);
    const exchanged = await fetch(`${origin}/api/pairing/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Interface browser" }), tls: { rejectUnauthorized: false } });
    expect(exchanged.status).toBe(201);
    const { device } = await exchanged.json() as { device: { id: string } };
    expect((await cli(["devices"])).stdout).toContain(`${device.id}\tInterface browser`);
    expect((await cli(["doctor"])).stdout).not.toContain("pairing:");
    expect((await cli(["revoke", device.id])).code).toBe(0);
    expect((await cli(["pair"], false)).code).toBe(1);
  } finally {
    await listener.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
