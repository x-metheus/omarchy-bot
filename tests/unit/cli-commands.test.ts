import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { layoutFromEnv } from "../../apps/cli/src/layout.ts";
import { run } from "../../apps/cli/src/main.ts";
import { BROWSER_ASSETS_RELEASE } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";

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

test("doctor reports every missing installed component and fails without changing the host", async () => {
  const setup = fixture();
  shim(setup.bin, "bun", 'printf "1.4.2\\n"');
  shim(setup.bin, "flock", "exit 0");
  shim(setup.bin, "bash", "exit 0");
  shim(setup.bin, "systemctl", 'printf "%s\\n" "$*" >> "$CALLS"\nprintf "inactive\\n"\nexit 3');
  shim(setup.bin, "uname", 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi');
  shim(setup.bin, "loginctl", 'test "$*" = "show-user fixture-user -p Linger" || exit 99\necho Linger=yes');
  const directory = join(setup.env.XDG_RUNTIME_DIR!, "systemd");
  mkdirSync(directory, { recursive: true });
  const socket = Bun.listen({ unix: join(directory, "private"), socket: { data() {} } });
  cleanups.push(() => socket.stop(true));
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  const output = setup.log.join("\n");
  for (const check of ["runtime:", "checksum marker:", "Sway bundle:", "fonts:", "browser pack:", "unit:", "launcher:", "health:", "pairing:"]) {
    expect(output.split("\n").filter(line => line.startsWith(check))).toHaveLength(1);
  }
  expect(output).toContain("omarchy-bot update --archive");
  expect(output).toContain("omarchy-bot pair");
  expect(readFileSync(setup.env.CALLS!, "utf8")).toBe("--user is-active omarchy-bot.service\n");
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  expect(setup.error).toEqual([]);
});

test("doctor accepts a healthy install and diagnoses damaged markers, fonts and revoked pairing", async () => {
  const setup = fixture();
  for (const [name, script] of Object.entries({ bun: 'echo 1.4.2', bash: 'exit 0', flock: 'exit 0', systemctl: 'echo active', uname: 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi', loginctl: 'echo Linger=yes' })) shim(setup.bin, name, script);
  mkdirSync(join(setup.env.XDG_RUNTIME_DIR!, "systemd"), { recursive: true });
  const socket = Bun.listen({ unix: join(setup.env.XDG_RUNTIME_DIR!, "systemd/private"), socket: { data() {} } });
  cleanups.push(() => socket.stop(true));
  const files: Record<string, string> = {
    [setup.layout.servePath]: "#!/bin/sh\n",
    [join(setup.layout.currentDir, "apps/daemon/src/bootstrap/main.ts")]: "// fixture\n",
    [join(setup.layout.currentDir, ".archive-sha256")]: `${"a".repeat(64)}\n`,
    [join(setup.layout.currentDir, "sway/.omarchy-bot-runtime")]: "sway-1.10.1-wayvnc-0.8.0-wlroots-0.18.1-v1\nc821bcb7d8e349c22bf3c9a96084a550d7d5a357b2d9d340c608adbdc5fb9344\n",
    [join(setup.layout.browserPackDir, ".omarchy-bot-assets")]: `${BROWSER_ASSETS_RELEASE}\n`,
    [join(setup.layout.browserPackDir, "browser")]: "#!/bin/sh\nprintf 'Google Chrome for Testing 156.0.8078.47\\n'\n",
    [join(setup.layout.browserPackDir, "chrome-linux64/chrome")]: "binary",
    [join(setup.layout.browserPackDir, "libs/ld-linux-x86-64.so.2")]: "loader",
    [setup.layout.unitPath]: "[Service]\n",
    [join(setup.home, ".local/bin/omarchy-bot")]: "#!/bin/sh\n",
    [setup.layout.hostSecretPath]: "doctor-secret",
  };
  for (const file of ["NotoSans[wdth,wght].ttf", "NotoSansSC[wght].ttf", "NotoSansJP[wght].ttf", "NotoSansKR[wght].ttf"]) files[join(setup.layout.currentDir, "fonts", file)] = "font";
  for (const [file, contents] of Object.entries(files)) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, contents, { mode: 0o755 }); }
  let revokedAt: string | null = null;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/health") return Response.json({ ok: true });
    expect(request.headers.get("authorization")).toBe("Bearer doctor-secret");
    return Response.json({ devices: [{ revokedAt }] });
  } });
  cleanups.push(() => server.stop(true));
  setup.env.OMARCHY_BOT_PORT = String(server.port);
  expect(await run(["doctor"], setup.env, setup.io)).toBe(0);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../apps/cli/src/main.ts"), "doctor"], { env: setup.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("All required checks passed.\n");
  expect(await new Response(child.stderr).text()).toBe("");
  expect(setup.log).toEqual(["All required checks passed."]);
  const externalPack = join(setup.home, "external-browser");
  renameSync(setup.layout.browserPackDir, externalPack);
  setup.env.OMARCHY_BOT_BROWSER_PACK_DIR = externalPack;
  expect(await run(["doctor"], setup.env, setup.io)).toBe(0);
  expect(setup.log.at(-1)).toBe("All required checks passed.");
  writeFileSync(join(externalPack, "browser"), "#!/bin/sh\nexit 7\n");
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log.at(-1)).toContain("browser pack:");
  writeFileSync(join(externalPack, "browser"), files[join(setup.layout.browserPackDir, "browser")]!);
  expect(await run(["uninstall"], setup.env, setup.io)).toBe(0);
  expect(readFileSync(join(externalPack, ".omarchy-bot-assets"), "utf8")).toBe(`${BROWSER_ASSETS_RELEASE}\n`);
  delete setup.env.OMARCHY_BOT_BROWSER_PACK_DIR;
  mkdirSync(setup.layout.runtimeDir, { recursive: true });
  renameSync(externalPack, setup.layout.browserPackDir);
  for (const [file, contents] of Object.entries(files).filter(([file]) => !file.startsWith(setup.layout.browserPackDir))) {
    mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, contents, { mode: 0o755 });
  }
  const marker = join(setup.layout.browserPackDir, ".omarchy-bot-assets");
  writeFileSync(marker, "wrong pin\n");
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log.at(-1)).toContain("browser pack:");
  expect(setup.log.at(-1)).toContain("--browser-pack");
  writeFileSync(marker, `${BROWSER_ASSETS_RELEASE}\n`);
  const browser = join(setup.layout.browserPackDir, "browser");
  writeFileSync(browser, "#!/bin/sh\nexit 7\n");
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log.at(-1)).toContain("browser pack:");
  writeFileSync(browser, "#!/bin/sh\nprintf 'Google Chrome for Testing 156.0.8078.47\\n'\n");
  chmodSync(browser, 0o644);
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log.at(-1)).toContain("browser pack:");
  chmodSync(browser, 0o755);
  rmSync(setup.layout.browserPackDir, { recursive: true });
  setup.env.OMARCHY_BOT_BROWSER = "host";
  expect(await run(["doctor"], setup.env, setup.io)).toBe(0);
  delete setup.env.OMARCHY_BOT_BROWSER;
  for (const [file, contents] of Object.entries(files).filter(([file]) => file.startsWith(setup.layout.browserPackDir))) {
    mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, contents, { mode: 0o755 });
  }
  shim(setup.bin, "loginctl", "echo Linger=no");
  shim(setup.bin, "systemctl", "echo inactive; exit 3");
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log.at(-1)).toContain("enable lingering:");
  expect(setup.log.at(-1)).toContain("unit: missing or inactive;");
  expect(setup.log.at(-1)).not.toContain("All required checks passed.");
  shim(setup.bin, "systemctl", "echo active");
  server.stop(true);
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log.at(-1)).toContain("health: Service is unreachable");
  expect(setup.log.at(-1)).not.toContain("All required checks passed.");
  shim(setup.bin, "loginctl", "echo Linger=yes");
  const replacement = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return Response.json(new URL(request.url).pathname === "/api/health" ? { ok: true } : { devices: [{ revokedAt }] });
  } });
  cleanups.push(() => replacement.stop(true));
  setup.env.OMARCHY_BOT_PORT = String(replacement.port);
  writeFileSync(join(setup.layout.currentDir, ".archive-sha256"), "corrupt");
  writeFileSync(join(setup.layout.currentDir, "sway/.omarchy-bot-runtime"), "wrong bundle");
  writeFileSync(join(setup.layout.currentDir, "fonts/NotoSansSC[wght].ttf"), "");
  revokedAt = "2026-01-01";
  setup.log.length = 0;
  expect(await run(["doctor"], setup.env, setup.io)).toBe(1);
  expect(setup.log[0]!.split("\n").map(line => line.split(":")[0])).toEqual(["checksum marker", "Sway bundle", "fonts", "pairing"]);
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
        return Response.json({ code: "ABCD2345", url: `omarchy-bot://pair?service=${encodeURIComponent(new URL(request.url).origin)}&code=ABCD2345` });
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
  expect(setup.log).toEqual([`address: http://127.0.0.1:${server.port}\ncode: ABCD2345\npairing: omarchy-bot://pair?service=http%3A%2F%2F127.0.0.1%3A${server.port}&code=ABCD2345`]);
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

test("TLS commands accept self-signed certificates only on the local loopback Service connection", async () => {
  const setup = fixture();
  const cert = join(setup.home, "cert.pem"), key = join(setup.home, "key.pem");
  expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"]).exitCode).toBe(0);
  setup.env.OMARCHY_BOT_TLS_CERT = cert;
  setup.env.OMARCHY_BOT_TLS_KEY = key;
  mkdirSync(setup.layout.stateDir, { recursive: true });
  writeFileSync(setup.layout.hostSecretPath, "tls-private-secret");
  shim(setup.bin, "systemctl", 'echo active');
  const server = Bun.serve({ hostname: "0.0.0.0", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer tls-private-secret");
    const route = new URL(request.url).pathname;
    if (route === "/api/pairing/codes") return Response.json({ code: "TLS23456", url: `omarchy-bot://pair?service=${encodeURIComponent(new URL(request.url).origin)}&code=TLS23456` });
    if (route === "/api/devices/paired") return Response.json({ devices: [{ id: "tls-device", name: "TLS browser" }] });
    return Response.json({ ok: true });
  } });
  cleanups.push(() => server.stop(true));
  setup.env.OMARCHY_BOT_PORT = String(server.port);
  for (const args of [["pair"], ["devices"], ["revoke", "tls-device"], ["status"]]) expect(await run(args, setup.env, setup.io)).toBe(0);
  expect(setup.log).toContain(`address: https://127.0.0.1:${server.port}\ncode: TLS23456\npairing: omarchy-bot://pair?service=https%3A%2F%2F127.0.0.1%3A${server.port}&code=TLS23456`);
  expect(setup.log).toContain(`state: active\naddress: https://127.0.0.1:${server.port}`);
  for (const host of ["127.0.1.0", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    expect(await run(["pair"], { ...setup.env, OMARCHY_BOT_HOST: host }, setup.io)).toBe(0);
  }
  expect(await run(["pair"], { ...setup.env, OMARCHY_BOT_HOST: "127.0.0.256" }, setup.io)).toBe(1);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../apps/cli/src/main.ts"), "pair"], { env: setup.env, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain("pairing: omarchy-bot://pair?service=https%3A%2F%2F");
  expect(await new Response(child.stderr).text()).toBe("");
  const address = Object.values(networkInterfaces()).flat().find(address => address?.family === "IPv4" && !address.internal)?.address;
  if (!address) throw new Error("A local non-loopback IPv4 interface is required for the TLS trust regression");
  setup.env.OMARCHY_BOT_HOST = address;
  expect(await run(["pair"], setup.env, setup.io)).toBe(1);
  expect([...setup.log, ...setup.error].join("\n")).not.toContain("tls-private-secret");
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

test("global and every command help exit successfully before touching the Service", async () => {
  const setup = fixture();
  for (const args of [["--help"], ["-h"], ["help"], ...["install", "start", "stop", "status", "pair", "devices", "revoke", "update", "reconfigure", "uninstall", "doctor"].map(command => [command, "--help"])]) {
    setup.log.length = 0;
    expect(await run(args, setup.env, setup.io)).toBe(0);
    expect(setup.log.join("\n")).toContain("Usage: omarchy-bot");
    if (args.length === 2) expect(setup.log.join("\n")).toContain(`omarchy-bot ${args[0]}`);
  }
  expect(setup.error).toEqual([]);
  expect(existsSync(setup.env.CALLS!)).toBe(false);
});
