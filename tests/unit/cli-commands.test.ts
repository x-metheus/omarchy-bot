import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutFromEnv } from "../../apps/cli/src/layout.ts";
import { run } from "../../apps/cli/src/main.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ob-commands-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: bin, USER: "fixture-user",
    XDG_CONFIG_HOME: join(home, "config"), XDG_RUNTIME_DIR: join(home, "run"),
    OMARCHY_BOT_HOME: join(home, "data"), OMARCHY_BOT_STATE: join(home, "state"),
    OMARCHY_BOT_HOST: "127.0.0.1", OMARCHY_BOT_PORT: "17421", CALLS: join(home, "calls"),
  };
  const log: string[] = [];
  const error: string[] = [];
  const io = { log: (value: string) => { log.push(value); }, error: (value: string) => { error.push(value); } };
  return { home, bin, env, layout: layoutFromEnv(env), log, error, io };
}

function shim(bin: string, name: string, script: string) {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
}

test("status reports the Service address and startup failure through run", async () => {
  const setup = fixture();
  shim(setup.bin, "systemctl", 'printf "%s\\n" "$*" >> "$CALLS"\nprintf "failed\\n"\nexit 3');
  mkdirSync(setup.layout.stateDir, { recursive: true });
  writeFileSync(setup.layout.serviceLog, "earlier\nmissing runtime\n\n");
  expect(await run(["status"], setup.env, setup.io)).toBe(0);
  expect(setup.log).toEqual(["state: failed\naddress: http://127.0.0.1:17421\nstartup failure: missing runtime"]);
  expect(setup.error).toEqual([]);
  expect(readFileSync(setup.env.CALLS!, "utf8")).toBe("--user is-active omarchy-bot.service\n");
});

test("doctor reports complete fixture prerequisites through run", async () => {
  const setup = fixture();
  shim(setup.bin, "bun", 'printf "1.4.2\\n"');
  shim(setup.bin, "flock", "exit 0");
  shim(setup.bin, "bash", "exit 0");
  shim(setup.bin, "systemctl", "exit 0");
  shim(setup.bin, "uname", 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi');
  shim(setup.bin, "loginctl", 'test "$*" = "show-user fixture-user -p Linger" || exit 99\necho Linger=yes');
  const directory = join(setup.env.XDG_RUNTIME_DIR!, "systemd");
  mkdirSync(directory, { recursive: true });
  const socket = Bun.listen({ unix: join(directory, "private"), socket: { data() {} } });
  cleanups.push(() => socket.stop(true));
  expect(await run(["doctor"], setup.env, setup.io)).toBe(0);
  expect(setup.log).toEqual(["All prerequisites available."]);
  expect(setup.error).toEqual([]);
});

test("pair, devices, and revoke authenticate with the host secret without exposing tokens", async () => {
  const setup = fixture();
  const secret = "private-fixture-host-secret";
  mkdirSync(setup.layout.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(setup.layout.hostSecretPath, `${secret}\n`, { mode: 0o600 });
  shim(setup.bin, "xdg-open", 'printf "opened\\n" >> "$CALLS"');
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });
      const pathname = new URL(request.url).pathname;
      requests.push({ method: request.method, path: pathname, body: await request.json().catch(() => null) });
      if (request.method === "POST" && pathname === "/api/pairing/codes") {
        return Response.json({ code: "ABCD2345", url: "/pair?code=ABCD2345" });
      }
      if (request.method === "GET" && pathname === "/api/devices/paired") {
        return Response.json({ devices: [{ id: "paired_123", name: "My laptop", token: "never-print-token", revokedAt: null }] });
      }
      if (request.method === "POST" && pathname === "/api/devices/paired/paired_123/revoke") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  setup.env.OMARCHY_BOT_PORT = String(server.port);
  expect(await run(["pair"], setup.env, setup.io)).toBe(0);
  expect(setup.log).toEqual([`pairing: http://127.0.0.1:${server.port}/pair?code=ABCD2345`]);
  expect(existsSync(setup.env.CALLS!)).toBe(false);
  setup.log.length = 0;
  expect(await run(["devices"], setup.env, setup.io)).toBe(0);
  expect(setup.log).toEqual(["paired_123\tMy laptop"]);
  expect(setup.log.join("\n")).not.toContain("token");
  expect(await run(["revoke", "paired_123"], setup.env, setup.io)).toBe(0);
  expect(requests).toEqual([
    { method: "POST", path: "/api/pairing/codes", body: { name: "installer" } },
    { method: "GET", path: "/api/devices/paired", body: null },
    { method: "POST", path: "/api/devices/paired/paired_123/revoke", body: null },
  ]);
  expect(setup.error).toEqual([]);
  expect(setup.log.join("\n")).not.toContain(secret);
});

test("start and stop use the fixture user manager", async () => {
  const setup = fixture();
  shim(setup.bin, "systemctl", 'printf "%s\\n" "$*" >> "$CALLS"');
  expect(await run(["start"], setup.env, setup.io)).toBe(0);
  expect(await run(["stop"], setup.env, setup.io)).toBe(0);
  expect(readFileSync(setup.env.CALLS!, "utf8")).toBe("--user start omarchy-bot.service\n--user stop omarchy-bot.service\n");
});

test("invalid commands and missing arguments exit 2 without touching the Service", async () => {
  const setup = fixture();
  expect(await run(["unknown"], setup.env, setup.io)).toBe(2);
  for (const command of ["install", "start", "stop", "status", "pair", "devices", "revoke", "update", "uninstall", "doctor"]) {
    expect(setup.error.join("\n")).toContain(command);
  }
  expect(await run(["revoke"], setup.env, setup.io)).toBe(2);
  expect(await run(["install", "--archive", "unused"], setup.env, setup.io)).toBe(2);
  expect(setup.log).toEqual([]);
  expect(existsSync(setup.env.CALLS!)).toBe(false);
});

test("HTTP authentication errors return failure without printing the host secret", async () => {
  const setup = fixture();
  const secret = "secret-must-not-leak";
  mkdirSync(setup.layout.stateDir, { recursive: true });
  writeFileSync(setup.layout.hostSecretPath, secret, { mode: 0o600 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(secret, { status: 401 }) });
  cleanups.push(() => server.stop(true));
  setup.env.OMARCHY_BOT_PORT = String(server.port);
  expect(await run(["pair"], setup.env, setup.io)).toBe(1);
  expect(setup.error.join("\n")).toContain("401");
  expect([...setup.log, ...setup.error].join("\n")).not.toContain(secret);
});
