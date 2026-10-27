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
