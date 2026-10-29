import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("container Launcher attaches image assets and preserves one state volume across launches", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ob-container-launcher-"));
  roots.push(root);
  const runtime = path.join(root, "image", "runtime");
  mkdirSync(path.join(runtime, "scripts"), { recursive: true });
  writeFileSync(path.join(runtime, "scripts", "serve.sh"), '#!/bin/sh\nprintf \'serve stdout\\n\'\nprintf %s "$HOME" > "$OMARCHY_BOT_STATE/started"\nprintf %s "$OMARCHY_BOT_BROWSER_PACK_DIR" > "$OMARCHY_BOT_STATE/browser"\n');
  const volume = path.join(root, "volume");
  const env = {
    ...process.env,
    HOME: path.join(volume, "home"),
    OMARCHY_BOT_HOME: path.join(volume, "data"),
    OMARCHY_BOT_STATE: path.join(volume, "state"),
  };
  const entrypoint = path.resolve(import.meta.dir, "../../scripts/container-image/entrypoint.sh");
  // The image installs the entrypoint next to runtime/ and browser/.
  const installed = path.join(root, "image", "entrypoint.sh");
  writeFileSync(installed, readFileSync(entrypoint));
  for (let launch = 0; launch < 2; launch += 1) {
    const profile = path.join(env.OMARCHY_BOT_HOME, "screens/computer/config/chromium");
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "profile-marker"), "retained browser state");
    for (const file of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) symlinkSync("old-container-404", path.join(profile, file));
    const child = Bun.spawn(["bash", installed], { env, stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("serve stdout\n");
    expect(readFileSync(path.join(env.OMARCHY_BOT_STATE, "started"), "utf8")).toBe(env.HOME);
    expect(readlinkSync(path.join(env.OMARCHY_BOT_HOME, "runtime/current"))).toBe(runtime);
    expect(readFileSync(path.join(env.OMARCHY_BOT_STATE, "browser"), "utf8"))
      .toBe(path.join(root, "image/browser"));
    if (launch === 0) writeFileSync(path.join(env.HOME, "work"), "retained");
    expect(readFileSync(path.join(env.HOME, "work"), "utf8")).toBe("retained");
    expect(statSync(env.OMARCHY_BOT_STATE).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(profile, "profile-marker"), "utf8")).toBe("retained browser state");
    for (const file of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) expect(() => lstatSync(path.join(profile, file))).toThrow();
  }
});

test("container build refuses a corrupt runtime before launching Docker or fetching assets", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ob-container-integrity-"));
  roots.push(root);
  const archive = path.join(root, "runtime.tar.zst");
  writeFileSync(archive, "corrupt runtime");
  writeFileSync(`${archive}.sha256`, `${"0".repeat(64)}  runtime.tar.zst\n`);
  const child = Bun.spawn([
    "bash", path.resolve(import.meta.dir, "../../scripts/build-container-image.sh"),
    archive, "unused-container-test", path.join(root, "cache"),
  ], { env: { ...process.env, OMARCHY_BOT_BUN: process.execPath }, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).not.toBe(0);
  expect(await stderr).toContain("runtime archive checksum mismatch");
});

test("container health probe follows configured IPv4, IPv6 and wildcard listeners", async () => {
  const dockerfile = readFileSync(path.resolve(import.meta.dir, "../../scripts/container-image/Dockerfile"), "utf8");
  expect(dockerfile).toContain("STOPSIGNAL SIGINT");
  const line = dockerfile.split("\n").find((line) => line.trimStart().startsWith("CMD ["));
  if (!line) throw new Error("container has no health command");
  const command = JSON.parse(line.trim().slice(4)) as string[];
  for (const [host, address, tls] of [
    ["127.0.0.2", "127.0.0.2", false],
    ["::1", "[::1]", false],
    ["[::1]", "[::1]", false],
    ["2001:db8::2", "[2001:db8::2]", true],
    ["0.0.0.0", "127.0.0.1", true],
    ["::", "[::1]", true],
  ] as const) {
    const child = Bun.spawn([process.execPath, "-e", `globalThis.fetch = async url => { console.log(url); return Response.json({ok:true}); }; ${command[2]}`], {
      env: { ...process.env, OMARCHY_BOT_HOST: host, OMARCHY_BOT_PORT: "17321", OMARCHY_BOT_TLS_CERT: tls ? "/fixture/cert.pem" : "" },
      stdout: "pipe", stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe(`${tls ? "https" : "http"}://${address}:17321/api/health`);
  }
});

test("fresh TLS container prints one pairing URL, retains paired state and forwards shutdown", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ob-container-pairing-")); roots.push(root);
  const image = path.join(root, "image"), runtime = path.join(image, "runtime");
  mkdirSync(path.join(runtime, "scripts"), { recursive: true });
  mkdirSync(path.join(runtime, "apps/cli/src"), { recursive: true });
  for (const file of ["main", "layout", "lifecycle", "archive", "browserPack", "appInstall", "appSignature"]) writeFileSync(path.join(runtime, `apps/cli/src/${file}.ts`), readFileSync(path.resolve(import.meta.dir, `../../apps/cli/src/${file}.ts`)));
  mkdirSync(path.join(runtime, "apps/daemon/src/modules/computer"), { recursive: true });
  for (const file of ["swayRuntimeSupply", "botComputerAssets", "browserPack", "desktopEntry"]) writeFileSync(path.join(runtime, `apps/daemon/src/modules/computer/${file}.ts`), readFileSync(path.resolve(import.meta.dir, `../../apps/daemon/src/modules/computer/${file}.ts`)));
  mkdirSync(path.join(runtime, "apps/daemon/src/bootstrap"), { recursive: true });
  writeFileSync(path.join(runtime, "apps/daemon/src/bootstrap/listenerConfig.ts"), readFileSync(path.resolve(import.meta.dir, "../../apps/daemon/src/bootstrap/listenerConfig.ts")));
  const cert = path.join(root, "cert.pem"), key = path.join(root, "key.pem");
  expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"]).exitCode).toBe(0);
  let paired = false;
  let listed = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert: Bun.file(cert), key: Bun.file(key) }, fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === "/api/health") return Response.json({ ok: true });
    expect(request.headers.get("authorization")).toBe("Bearer container-private-secret");
    if (route === "/api/devices/paired") { listed.resolve(); return Response.json({ devices: paired ? [{ revokedAt: null }] : [] }); }
    return Response.json({ code: "FRESH234", url: `omarchy-bot://pair?service=${encodeURIComponent(new URL(request.url).origin)}&code=FRESH234` });
  } });
  const env = { ...process.env, HOME: path.join(root, "home"), XDG_RUNTIME_DIR: path.join(root, "run"), OMARCHY_BOT_HOME: path.join(root, "data"), OMARCHY_BOT_STATE: path.join(root, "state"), OMARCHY_BOT_HOST: "0.0.0.0", OMARCHY_BOT_PORT: String(server.port), OMARCHY_BOT_TLS_CERT: cert, OMARCHY_BOT_TLS_KEY: key };
  mkdirSync(env.OMARCHY_BOT_STATE, { recursive: true });
  writeFileSync(path.join(env.OMARCHY_BOT_STATE, "pairing-host-secret"), "container-private-secret");
  writeFileSync(path.join(runtime, "scripts/serve.sh"), `#!/bin/sh\nexec '${process.execPath}' -e 'process.on("SIGINT",()=>{console.log("fixture stopped");process.exit(0)});Bun.serve({port:0,fetch:()=>new Response()})'\n`);
  const installed = path.join(image, "entrypoint.sh"); writeFileSync(installed, readFileSync(path.resolve(import.meta.dir, "../../scripts/container-image/entrypoint.sh")));
  try {
    for (const state of [false, true]) {
      paired = state;
      listed = Promise.withResolvers<void>();
      const child = Bun.spawn(["bash", installed], { env, stdout: "pipe", stderr: "pipe" });
      const errors = new Response(child.stderr).text();
      const reader = child.stdout.getReader();
      try {
        if (!paired) {
          // Read the pairing line before signalling the private service.
          const first = await Promise.race([reader.read(), child.exited.then(() => ({ value: undefined }))]);
          expect(new TextDecoder().decode(first.value)).toBe(`address: https://127.0.0.1:${server.port}\ncode: FRESH234\npairing: omarchy-bot://pair?service=https%3A%2F%2F127.0.0.1%3A${server.port}&code=FRESH234\n`);
        } else await listed.promise;
        const issued = Bun.spawn([process.execPath, path.join(runtime, "apps/cli/src/main.ts"), "pair"], { env, stdout: "pipe", stderr: "pipe" });
        expect(await issued.exited).toBe(0);
        expect(await new Response(issued.stdout).text()).toContain("pairing: omarchy-bot://pair?service=https%3A%2F%2F");
        child.kill("SIGINT");
        expect(await child.exited).toBe(0);
        const remaining: Uint8Array[] = [];
        for (;;) { const next = await reader.read(); if (next.done) break; remaining.push(next.value); }
        const output = Buffer.concat(remaining).toString();
        expect(output).toContain("fixture stopped");
        expect(output).not.toContain("pairing:");
        expect(output + await errors).not.toContain("container-private-secret");
      } finally { child.kill("SIGKILL"); await child.exited; }
    }
  } finally { server.stop(true); }
}, 10000);
