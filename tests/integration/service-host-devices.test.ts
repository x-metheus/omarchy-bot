import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { startDaemon, type Harness } from "./helpers/harness.ts";

let h: Harness;
let hostHeaders: Record<string, string>;

beforeAll(async () => {
  h = await startDaemon(undefined, { waitForAgentReady: false });
  const secret = readFileSync(path.join(h.svc.cfg.stateDir, "pairing-host-secret"), "utf8").trim();
  hostHeaders = { authorization: `Bearer ${secret}` };
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

test("Service Host secret can list and revoke a paired device", async () => {
  const listed = await fetch(`${h.baseUrl}/api/devices/paired`, { headers: hostHeaders });
  expect(listed.status).toBe(200);
  const { devices } = await listed.json() as { devices: Array<{ id: string; name: string; revokedAt: string | null }> };
  const device = devices.find((device) => device.name === "test");
  expect(device).toBeDefined();
  expect(device!.revokedAt).toBeNull();

  const revoked = await fetch(`${h.baseUrl}/api/devices/paired/${device!.id}/revoke`, {
    method: "POST",
    headers: hostHeaders,
  });
  expect(revoked.status).toBe(204);
  const denied = await fetch(`${h.baseUrl}/api/bots`, { headers: { authorization: `Bearer ${h.token}` } });
  expect(denied.status).toBe(401);
});

test("missing and wrong secrets cannot list or revoke devices", async () => {
  for (const headers of [{}, { authorization: "Bearer wrong-secret" }]) {
    for (const [method, route] of [
      ["GET", "/api/devices/paired"],
      ["POST", "/api/devices/paired/paired_ffffffffffffffff/revoke"],
    ] as const) {
      const response = await fetch(`${h.baseUrl}${route}`, { method, headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  }
});

test("Service Host secret does not grant access to bots", async () => {
  const response = await fetch(`${h.baseUrl}/api/bots`, { headers: hostHeaders });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});
