import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { startDaemon, type Harness } from "./helpers/harness.ts";
import daemonPkg from "../../apps/daemon/package.json" with { type: "json" };
import { networkInterfaces, tmpdir } from "node:os";
import { startHttp } from "../../apps/daemon/src/api/http.ts";

let h: Harness;

// Raw fetch only: this suite must not race the harness token plumbing.
beforeAll(async () => {
  h = await startDaemon(undefined, { waitForAgentReady: false });
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

  test("static SPA paths are not gated so the pairing page can load", async () => {
    for (const path of ["/", "/pair?code=ABCD2345", "/missing-static-file.js"]) {
      const res = await fetch(`${h.baseUrl}${path}`);
      expect(res.status).not.toBe(401);
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
    expect(issued.url).toBe(`/pair?code=${issued.code}`);
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
    expect(issued.stdout).toStartWith(`pairing: ${origin}/pair?code=`);
    const code = new URL(issued.stdout.trim().slice("pairing: ".length)).searchParams.get("code");
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
