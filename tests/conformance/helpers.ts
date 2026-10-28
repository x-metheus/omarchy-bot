/**
 * Conformance harness: boots the real daemon with the REAL workers (pi +
 * computer) against private copies of Pi credentials and model configuration.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizedEnv } from "../../apps/daemon/src/supervision/workerClient.ts";

export interface ConformanceDaemon {
  baseUrl: string;
  port: number;
  home: string;
  token: string;
  agentEnv: Record<string, string>;
  svc: import("../../apps/daemon/src/api/http.ts").DaemonServices;
  stop: () => Promise<void>;
}

/** Keep daemon-supervised workers in the same private HOME as the direct worker. */
export function createConformanceHome() {
  const source = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-conformance-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const agentDir = path.join(root, ".pi/agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    // Never copy packages, extensions or sessionDir from the user's settings.
    for (const name of ["auth.json", "models.json", "settings.json"]) {
      const file = path.join(source, name);
      if (!existsSync(file)) continue;
      let config = JSON.parse(readFileSync(file, "utf8"));
      if (name === "settings.json") {
        const { defaultProvider, defaultModel, defaultThinkingLevel, modelThinkingLevels } = config;
        config = { defaultProvider, defaultModel, defaultThinkingLevel, modelThinkingLevels };
      }
      writeFileSync(path.join(agentDir, name), JSON.stringify(config), { mode: 0o600 });
    }
    const env = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, ".config"),
      XDG_DATA_HOME: path.join(root, ".local/share"),
      XDG_STATE_HOME: path.join(root, ".local/state"),
      XDG_CACHE_HOME: path.join(root, ".cache"),
      XDG_RUNTIME_DIR: path.join(root, "r"),
      TMPDIR: path.join(root, "tmp"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
      OMARCHY_BOT_CONFORMANCE_HOME: root,
      OMARCHY_BOT_HOME: path.join(root, ".local/share/omarchy-bot"),
      OMARCHY_BOT_STATE: path.join(root, ".local/state/omarchy-bot"),
    };
    for (const dir of [env.TMPDIR, env.XDG_RUNTIME_DIR]) mkdirSync(dir, { mode: 0o700 });
    return { root, env, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** A loopback-only form whose receipt is revealed only after a real submission. */
export function startBrowserConformanceFixture() {
  const value = `PI-BROWSER-${crypto.randomUUID()}`;
  const receipt = `BROWSER-RECEIPT-${crypto.randomUUID()}`;
  const submissions: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/") return new Response("Not found", { status: 404 });
      if (request.method === "POST") {
        const submitted = (await request.formData()).get("message");
        if (submitted !== value) return new Response("Incorrect form value", { status: 400 });
        submissions.push(submitted);
        return new Response(`<!doctype html><title>Browser conformance result</title><h1>Form submitted</h1><p>${receipt}</p>`, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return new Response(`<!doctype html><title>Browser conformance form</title><h1>Local browser fixture</h1><form method="post"><label for="message">Conformance message</label><input id="message" name="message" required><button type="submit">Submit form</button></form>`, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    },
  });
  return { url: server.url.href, value, receipt, submissions, stop: () => server.stop(true) };
}

export async function startConformanceDaemon(): Promise<ConformanceDaemon> {
  const root = process.env.OMARCHY_BOT_CONFORMANCE_HOME;
  if (!root || process.env.HOME !== root) throw new Error("run Pi conformance through pi.test.ts for private HOME isolation");
  const home = path.join(root, ".local/share/omarchy-bot");
  const state = path.join(root, ".local/state/omarchy-bot");
  // NOTE: no conformance record is pre-baked — the suite writes it on success.

  process.env.OMARCHY_BOT_HOME = home;
  process.env.OMARCHY_BOT_STATE = state;
  process.env.OMARCHY_BOT_PORT = "0";
  delete process.env.OMARCHY_BOT_WORKERS_DIR; // real workers
  // The isolated home has no installed runtime, so the Bot Screen needs the
  // prepared development bundle and fonts (build-sway-runtime.sh, prepare-fonts.sh).
  const repo = path.resolve(import.meta.dir, "../..");
  process.env.OMARCHY_BOT_SWAY_BUNDLE_DIR ??= path.join(repo, ".lane/dist/sway");
  process.env.OMARCHY_BOT_FONT_DIR ??= path.join(repo, ".lane/fonts");
  process.env.OMARCHY_BOT_BROWSER_PACK_DIR ??= path.join(repo, ".lane/browser");
  delete process.env.OMARCHY_BOT_BROWSER; // Always exercise the owned pack, never a host browser.
  for (const dir of [process.env.OMARCHY_BOT_SWAY_BUNDLE_DIR, process.env.OMARCHY_BOT_FONT_DIR, process.env.OMARCHY_BOT_BROWSER_PACK_DIR]) {
    if (!existsSync(dir)) {
      throw new Error(`conformance needs ${dir}; set OMARCHY_BOT_SWAY_BUNDLE_DIR, OMARCHY_BOT_FONT_DIR and OMARCHY_BOT_BROWSER_PACK_DIR to prepared runtime assets`);
    }
  }
  const agentEnv = sanitizedEnv();

  // Dynamic import: the harness mutates process.env above; importing main.ts fresh keeps that contract explicit.
  const { main } = await import("../../apps/daemon/src/bootstrap/main.ts");
  const { stop, port, svc } = await main({ useHostApplicationUnits: false, botScreenRuntimeDir: path.join(root, "r/screens") });
  const secret = readFileSync(path.join(state, "pairing-host-secret"), "utf8").trim();
  const baseUrl = `http://127.0.0.1:${port}`;
  const issued = await fetch(`${baseUrl}/api/pairing/codes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ name: "conformance" }),
  });
  if (!issued.ok) throw new Error(`conformance pairing code -> ${issued.status}`);
  const issuedBody: unknown = await issued.json();
  const code = typeof issuedBody === "object" && issuedBody !== null && "code" in issuedBody && typeof issuedBody.code === "string"
    ? issuedBody.code
    : undefined;
  const exchanged = await fetch(`${baseUrl}/api/pairing/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const exchangedBody: unknown = await exchanged.json();
  const token = typeof exchangedBody === "object" && exchangedBody !== null && "token" in exchangedBody && typeof exchangedBody.token === "string"
    ? exchangedBody.token
    : undefined;
  const deviceName = typeof exchangedBody === "object" && exchangedBody !== null && "device" in exchangedBody
    && typeof exchangedBody.device === "object" && exchangedBody.device !== null && "name" in exchangedBody.device
    && typeof exchangedBody.device.name === "string"
    ? exchangedBody.device.name
    : undefined;
  if (exchanged.status !== 201 || token === undefined) throw new Error(`conformance pairing exchange -> ${exchanged.status}`);
  if (deviceName !== "conformance") throw new Error("pairing exchange dropped the issued device name");
  return { baseUrl, port, home, token, agentEnv, svc, stop };
}

/** 1×1 red PNG. */
export const RED_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
