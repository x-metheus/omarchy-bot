import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startDaemon, type Harness } from "./helpers/harness.ts";
import daemonPkg from "../../apps/daemon/package.json" with { type: "json" };

let h: Harness;

beforeAll(async () => {
  h = await startDaemon();
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("health probe", () => {
  test("answers without a token with only liveness and the Service version", async () => {
    const res = await fetch(`${h.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, version: daemonPkg.version });
  });
});
