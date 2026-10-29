import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { authedFetch, startDaemon, type Harness } from "./helpers/harness.ts";

let h: Harness | undefined;
const original = process.env.OMARCHY_BOT_MACHINE_ID_FILE;
const fixture = mkdtempSync(path.join(os.tmpdir(), "host-identity-"));
afterEach(async () => {
  await h?.stop();
  h = undefined;
  if (original === undefined) delete process.env.OMARCHY_BOT_MACHINE_ID_FILE;
  else process.env.OMARCHY_BOT_MACHINE_ID_FILE = original;
  rmSync(fixture, { recursive: true, force: true });
});

test("only Paired Devices receive a stable salted host identity without the machine ID", async () => {
  const machineId = "0123456789abcdef0123456789abcdef";
  const file = path.join(fixture, "machine-id");
  writeFileSync(file, `  ${machineId}\n`);
  process.env.OMARCHY_BOT_MACHINE_ID_FILE = file;
  h = await startDaemon();
  const url = `${h.baseUrl}/api/host-identity`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { authorization: `Bearer ${h.svc.pairingHostSecret}` } })).status).toBe(401);
  const response = await authedFetch(h, url);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(machineId);
  const identity = JSON.parse(text);
  expect(Object.keys(identity).sort()).toEqual(["digest", "salt"]);
  expect(identity.salt).toMatch(/^[0-9a-f]{64}$/);
  expect(identity.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(identity.digest).toBe(createHash("sha256").update(`${identity.salt}:${machineId}`).digest("hex"));
  expect(await (await authedFetch(h, url)).json()).toEqual(identity);
  const saltFile = path.join(h.svc.cfg.stateDir, "host-identity-salt");
  expect(readFileSync(saltFile, "utf8").trim()).toBe(identity.salt);
  expect(statSync(saltFile).mode & 0o777).toBe(0o600);
  writeFileSync(file, "fedcba9876543210fedcba9876543210\n");
  const other = await (await authedFetch(h, url)).json() as { salt: string; digest: string };
  expect(other.salt).toBe(identity.salt);
  expect(other.digest).not.toBe(identity.digest);
  for (const invalid of ["uninitialized", "0".repeat(32), "A".repeat(32), "1234"]) {
    writeFileSync(file, `${invalid}\n`);
    expect((await authedFetch(h, url)).status).toBe(503);
  }
  rmSync(file);
  expect((await authedFetch(h, url)).status).toBe(503);
});
