import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AUTH_STORAGE_STATE } from "./fixtures.ts";

async function pairForToken(origin: string, stateDir: string): Promise<string> {
  const secret = readFileSync(path.join(stateDir, "pairing-host-secret"), "utf8").trim();
  const issued = await fetch(`${origin}/api/pairing/codes`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ name: "e2e" }),
  });
  if (!issued.ok) throw new Error(`e2e pairing code issue -> ${issued.status}: ${await issued.text()}`);
  const issuedBody: unknown = await issued.json();
  if (typeof issuedBody !== "object" || issuedBody === null || !("code" in issuedBody) || typeof issuedBody.code !== "string") {
    throw new Error("e2e pairing code issue returned no code");
  }
  const exchanged = await fetch(`${origin}/api/pairing/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: issuedBody.code, name: "e2e" }),
  });
  if (exchanged.status !== 201) throw new Error(`e2e pairing exchange -> ${exchanged.status}: ${await exchanged.text()}`);
  const exchangedBody: unknown = await exchanged.json();
  if (typeof exchangedBody !== "object" || exchangedBody === null || !("token" in exchangedBody) || typeof exchangedBody.token !== "string") {
    throw new Error("e2e pairing exchange returned no token");
  }
  return exchangedBody.token;
}

/** The web client reads its device token from localStorage; Playwright seeds it per origin. */
function writeStorageState(token: string, origin: string): void {
  writeFileSync(AUTH_STORAGE_STATE, JSON.stringify({
    cookies: [],
    origins: [{
      origin: new URL(origin).origin,
      localStorage: [{ name: "omarchy-bot.device-token", value: token }],
    }],
  }));
}

/**
 * Build the web once for this run, then boot the real daemon with the fake
 * agent worker and isolated storage. Playwright runs under Node, so the daemon
 * itself lives in a Bun child that imports main() rather than shelling out to a
 * packaged executable.
 */
export default async function globalSetup(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const build = spawnSync("bun", ["run", "--filter=@omarchy-bot/web", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("web build failed");

  const runDir = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-e2e-"));
  const dataDir = path.join(runDir, "data");
  const stateDir = path.join(runDir, "state");
  const conformanceDir = path.join(dataDir, "conformance");
  mkdirSync(conformanceDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(conformanceDir, "pi-fake-pi-1.json"), JSON.stringify({ ok: true }));

  const port = process.env.OMARCHY_BOT_E2E_PORT ?? "7399";
  const child = spawn("bun", [path.join(import.meta.dirname, "daemon-boot.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OMARCHY_BOT_HOME: dataDir,
      OMARCHY_BOT_STATE: stateDir,
      OMARCHY_BOT_PORT: port,
      OMARCHY_BOT_WORKERS_DIR: path.join(repoRoot, "tests/integration/fake-workers"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (child.pid === undefined) {
    rmSync(runDir, { recursive: true, force: true });
    throw new Error("e2e daemon did not receive a process id");
  }
  const stateFile = path.join(import.meta.dirname, ".daemon.json");
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid, runDir }));

  try {
    const ready = Promise.withResolvers<void>();
    const timer = setTimeout(() => ready.reject(new Error("e2e daemon did not become ready in 30s")), 30_000);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("E2E_DAEMON_READY")) {
        clearTimeout(timer);
        ready.resolve();
      }
    });
    child.stdout.on("close", () => {
      clearTimeout(timer);
      ready.reject(new Error("e2e daemon exited before setup completed"));
    });
    await ready.promise;

    const origin = process.env.OMARCHY_BOT_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
    // Health is the only unauthenticated route, so readiness is polled there.
    let healthDeadline = Date.now() + 20_000;
    for (;;) {
      const health = await fetch(`${origin}/api/health`).catch(() => undefined);
      if (health?.ok) break;
      if (Date.now() > healthDeadline) throw new Error("e2e daemon never answered /api/health");
      await delay(150);
    }

    const token = await pairForToken(origin, stateDir);
    writeStorageState(token, origin);

    const deadline = Date.now() + 20_000;
    for (;;) {
      const response = await fetch(`${origin}/api/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const agents: unknown = await response.json();
      if (
        Array.isArray(agents) &&
        agents.some(
          (agent) =>
            agent !== null &&
            typeof agent === "object" &&
            "id" in agent &&
            agent.id === "pi" &&
            "status" in agent &&
            agent.status === "ready",
        )
      ) {
        break;
      }
      if (Date.now() > deadline) throw new Error("pi agent never became ready for e2e");
      await delay(150);
    }
  } catch (error) {
    child.kill("SIGTERM");
    rmSync(runDir, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
    throw error;
  }
}
