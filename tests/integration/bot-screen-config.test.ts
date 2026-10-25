import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../apps/daemon/src/bootstrap/config.ts";

const original = {
  capacity: process.env.OMARCHY_BOT_SCREEN_CAPACITY,
  profile: process.env.OMARCHY_BOT_SCREEN_PROFILE,
  host: process.env.OMARCHY_BOT_HOST,
  home: process.env.OMARCHY_BOT_HOME,
  state: process.env.OMARCHY_BOT_STATE,
  cert: process.env.OMARCHY_BOT_TLS_CERT,
  key: process.env.OMARCHY_BOT_TLS_KEY,
  proxy: process.env.OMARCHY_BOT_TRUSTED_PROXY,
};
let temporaryRoot: string | undefined;


afterEach(() => {
  for (const [name, value] of [
    ["OMARCHY_BOT_SCREEN_CAPACITY", original.capacity],
    ["OMARCHY_BOT_SCREEN_PROFILE", original.profile],
    ["OMARCHY_BOT_HOST", original.host],
    ["OMARCHY_BOT_HOME", original.home],
    ["OMARCHY_BOT_STATE", original.state],
    ["OMARCHY_BOT_TLS_CERT", original.cert],
    ["OMARCHY_BOT_TLS_KEY", original.key],
    ["OMARCHY_BOT_TRUSTED_PROXY", original.proxy],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

test("selects the measured 720p Bot Screen fallback from configuration", () => {
  process.env.OMARCHY_BOT_SCREEN_CAPACITY = "2";
  process.env.OMARCHY_BOT_SCREEN_PROFILE = "720p";
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-screen-config-"));
  process.env.OMARCHY_BOT_HOME = path.join(temporaryRoot, "data");
  process.env.OMARCHY_BOT_STATE = path.join(temporaryRoot, "state");

  expect(loadConfig()).toMatchObject({
    botScreenCapacity: 2,
    botScreenProfile: "720p",
    botScreenLogicalWidth: 1280,
    botScreenLogicalHeight: 720,
    botScreenSwayRuntimeSupplyDir: path.join(temporaryRoot, "data", "runtime", "sway"),
  });
  expect(loadConfig()).not.toHaveProperty("botScreenRuntimeSupplyDir");
});

test("keeps HTTP loopback-only unless LAN binding is explicitly configured", () => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-screen-config-"));
  process.env.OMARCHY_BOT_HOME = path.join(temporaryRoot, "data");
  process.env.OMARCHY_BOT_STATE = path.join(temporaryRoot, "state");
  delete process.env.OMARCHY_BOT_HOST;
  delete process.env.OMARCHY_BOT_TLS_CERT;
  delete process.env.OMARCHY_BOT_TLS_KEY;
  delete process.env.OMARCHY_BOT_TRUSTED_PROXY;

  expect(loadConfig().host).toBe("127.0.0.1");

  process.env.OMARCHY_BOT_HOST = "0.0.0.0";
  expect(() => loadConfig()).toThrow(/certificate.*trusted proxy/);
});

test("uses the measured conservative Bot Screen default", () => {
  delete process.env.OMARCHY_BOT_SCREEN_CAPACITY;
  delete process.env.OMARCHY_BOT_SCREEN_PROFILE;
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-screen-config-"));
  process.env.OMARCHY_BOT_HOME = path.join(temporaryRoot, "data");
  process.env.OMARCHY_BOT_STATE = path.join(temporaryRoot, "state");

  expect(loadConfig()).toMatchObject({
    botScreenCapacity: 4,
    botScreenProfile: "1080p",
    botScreenLogicalWidth: 1920,
    botScreenLogicalHeight: 1080,
  });
});

test("enforces the measured capacity for each production profile", () => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-screen-config-"));
  process.env.OMARCHY_BOT_HOME = path.join(temporaryRoot, "data");
  process.env.OMARCHY_BOT_STATE = path.join(temporaryRoot, "state");
  process.env.OMARCHY_BOT_SCREEN_CAPACITY = "8";
  process.env.OMARCHY_BOT_SCREEN_PROFILE = "1080p";

  expect(() => loadConfig()).toThrow();

  process.env.OMARCHY_BOT_SCREEN_PROFILE = "720p";
  expect(loadConfig()).toMatchObject({
    botScreenCapacity: 8,
    botScreenProfile: "720p",
    botScreenLogicalWidth: 1280,
    botScreenLogicalHeight: 720,
  });
});
