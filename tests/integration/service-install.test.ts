import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { layoutFromEnv } from "../../apps/cli/src/layout.ts";
import { BROWSER_ASSETS_RELEASE } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";
import { elfFixture, interpreterPath } from "./helpers/browserPackFixture.ts";

const projectRoot = path.resolve(import.meta.dir, "../..");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function shim(bin: string, name: string, script: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
}

async function fixture(options: { manager?: boolean; opener?: string; browser?: "native" | "snap" | "absent" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ob-install-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin,
    HOME: path.join(root, "home"),
    USER: "fixture-user",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_DATA_DIRS: path.join(root, "empty-data-dirs"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    OMARCHY_BOT_HOME: path.join(root, "data/omarchy-bot"),
    OMARCHY_BOT_STATE: path.join(root, "state/omarchy-bot"),
    OMARCHY_BOT_HOST: "127.0.0.1",
    OMARCHY_BOT_OPEN: options.opener || "xdg-open",
    SYSTEMCTL_CALLS: path.join(root, "systemctl-calls"),
    OPEN_CALLS: path.join(root, "open-calls"),
  };
  const launcher = path.join(root, "systemctl.ts");
  for (const name of ["dirname"]) shim(bin, name, `exec /usr/bin/${name} "$@"`);
  if (options.browser !== "absent") shim(bin, "chromium", options.browser === "snap" ? "exec /snap/bin/chromium \"$@\"" : "exit 0");
  writeFileSync(launcher, `import {readFileSync,existsSync,appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2); appendFileSync(process.env.SYSTEMCTL_CALLS!, args.join(" ")+"\\n");
const pidFile=process.env.SYSTEMCTL_CALLS+".pid";
if(args.includes("stop") || args.includes("disable")){if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,"utf8")),"SIGTERM")}catch{}}}
if(args.includes("enable") || args.includes("start")){
let running=false;if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,"utf8")),0);running=true}catch{}}
if(!running){const unit=readFileSync(process.env.XDG_CONFIG_HOME+"/systemd/user/omarchy-bot.service","utf8");
const env={...process.env};for(const line of unit.split("\\n")){if(line.startsWith("Environment=")){const value=line.slice(12);const index=value.indexOf("=");env[value.slice(0,index)]=value.slice(index+1)}}
const executable=unit.split("\\n").find(line=>line.startsWith("ExecStart="))!.slice(10);
const child=Bun.spawn([executable],{env,stdin:"ignore",stdout:"ignore",stderr:"ignore"});writeFileSync(pidFile,String(child.pid));child.unref();}}
`);
  shim(bin, "systemctl", `exec '${process.execPath}' '${launcher}' "$@"`);
  cleanups.push(() => {
    const pidFile = `${env.SYSTEMCTL_CALLS}.pid`;
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} }
  });
  shim(bin, options.opener || "xdg-open", 'printf "%s\\n" "$*" >> "$OPEN_CALLS"\nexit "${OPEN_EXIT:-0}"');
  if (options.manager !== false) {
    const directory = path.join(env.XDG_RUNTIME_DIR!, "systemd");
    mkdirSync(directory, { recursive: true });
    const socket = Bun.listen({ unix: path.join(directory, "private"), socket: { data() {} } });
    cleanups.push(() => socket.stop(true));
  }
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  env.OMARCHY_BOT_PORT = String(reservation.port);
  reservation.stop(true);
  const secret = "fixture-host-secret-never-print";
  const layout = layoutFromEnv(env);
  const archive = path.join(root, "omarchy-bot-runtime-fixture-x86_64.tar.zst");
  const checksum = `${archive}.sha256`;
  const serve = `#!/bin/bash
exec '${process.execPath}' run - <<'SERVICE'
import {mkdirSync,writeFileSync} from "node:fs";
mkdirSync(process.env.OMARCHY_BOT_STATE,{recursive:true,mode:0o700});
writeFileSync(process.env.OMARCHY_BOT_STATE+"/pairing-host-secret",${JSON.stringify(secret)},{mode:0o600});
Bun.serve({hostname:"127.0.0.1",port:Number(process.env.OMARCHY_BOT_PORT),fetch(request){
const route=new URL(request.url).pathname;
if(route==="/api/health" && request.method==="GET")return Response.json({ok:true});
if(request.headers.get("authorization")!==${JSON.stringify(`Bearer ${secret}`)})return new Response("unauthorized",{status:401});
if(route==="/api/pairing/codes" && request.method==="POST")return Response.json({code:"ABCD2345",url:"/pair?code=ABCD2345"});
return new Response("not found",{status:404});}});
SERVICE
`;
  const packed = await new Bun.Archive({ "scripts/serve.sh": serve }).bytes();
  writeFileSync(archive, Bun.zstdCompressSync(packed));
  writeFileSync(checksum, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  runtime.tar.zst\n`);
  const archiveArgs = ["--archive", archive, "--checksum", checksum];
  return { root, env, layout, archiveArgs, checksum, secret, serve, bin,
    pairingUrl: `http://127.0.0.1:${env.OMARCHY_BOT_PORT}/pair?code=ABCD2345` };
}

async function cli(setup: { env: NodeJS.ProcessEnv }, args: string[]) {
  const child = Bun.spawn([process.execPath, "apps/cli/src/main.ts", ...args], {
    cwd: projectRoot, env: setup.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function recorded(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

test("installs on a non-Omarchy fixture, pairs, reuses the Service, and preserves user data on uninstall", async () => {
  const setup = await fixture();
  const installed = await cli(setup, ["install", ...setup.archiveArgs]);
  expect(installed).toEqual({ code: 0, stdout: `pairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe(setup.serve);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain(`ExecStart=${setup.layout.servePath}`);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([
    "--user daemon-reload", "--user enable --now omarchy-bot.service",
  ]);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([setup.pairingUrl]);
  expect(installed.stdout + installed.stderr).not.toContain(setup.secret);

  const second = await cli(setup, ["install", "--archive", "missing", "--checksum", "missing"]);
  expect(second).toEqual({ code: 0, stdout: `reusing installed Service\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(recorded(setup.env.SYSTEMCTL_CALLS!).filter(line => line.includes("enable"))).toHaveLength(1);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!).at(-1)).toBe("--user start omarchy-bot.service");
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([setup.pairingUrl, setup.pairingUrl]);
  expect(readdirSync(setup.layout.unitDir)).toEqual(["omarchy-bot.service"]);
  expect(readdirSync(setup.layout.runtimeDir)).toEqual(["current"]);

  const kept: [string, string][] = [
    [setup.layout.dbPath, "database"],
    [path.join(setup.layout.screensDir, "profile"), "profile"],
    [path.join(setup.layout.workspaceDir, "note"), "note"],
  ];
  for (const [file, contents] of kept) {
    mkdirSync(path.dirname(file!), { recursive: true });
    writeFileSync(file!, contents!);
  }
  expect((await cli(setup, ["uninstall"])).code).toBe(0);
  expect(existsSync(setup.layout.unitPath)).toBe(false);
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  for (const [file, contents] of kept) expect(readFileSync(file!, "utf8")).toBe(contents);
});

test("a bad install checksum creates no runtime or unit and never opens a browser", async () => {
  const setup = await fixture();
  writeFileSync(setup.checksum, `${"0".repeat(64)}  runtime.tar.zst\n`);
  const result = await cli(setup, ["install", ...setup.archiveArgs]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("checksum mismatch");
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  expect(existsSync(setup.layout.unitPath)).toBe(false);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([]);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([]);
});

test("a bad update checksum leaves the installed runtime untouched without staging", async () => {
  const setup = await fixture();
  mkdirSync(path.dirname(setup.layout.servePath), { recursive: true });
  writeFileSync(setup.layout.servePath, "original");
  writeFileSync(setup.checksum, `${"0".repeat(64)}  runtime.tar.zst\n`);
  const result = await cli(setup, ["update", ...setup.archiveArgs]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("checksum mismatch");
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe("original");
  expect(readdirSync(setup.layout.runtimeDir)).toEqual(["current"]);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([]);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([]);
});

test("update replaces the installed runtime after checksum verification", async () => {
  const setup = await fixture();
  mkdirSync(path.dirname(setup.layout.servePath), { recursive: true });
  writeFileSync(setup.layout.servePath, "original");
  writeFileSync(path.join(setup.layout.currentDir, "old-file"), "obsolete");
  const result = await cli(setup, ["update", ...setup.archiveArgs]);
  expect(result).toEqual({ code: 0, stdout: `pairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe(setup.serve);
  expect(existsSync(path.join(setup.layout.currentDir, "old-file"))).toBe(false);
  expect(readdirSync(setup.layout.runtimeDir)).toEqual(["current"]);
  const calls = recorded(setup.env.SYSTEMCTL_CALLS!);
  expect(calls.indexOf("--user stop omarchy-bot.service")).toBeLessThan(calls.indexOf("--user start omarchy-bot.service"));
});

test("install reports a missing user manager without invoking host systemctl", async () => {
  const setup = await fixture({ manager: false });
  const result = await cli(setup, ["install", ...setup.archiveArgs]);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/user systemd manager/i);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([]);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([]);
});

test("a failing custom opener is reported after successful install without failing the command", async () => {
  const setup = await fixture({ opener: "fixture-open" });
  setup.env.OPEN_EXIT = "7";
  const result = await cli(setup, ["install", ...setup.archiveArgs]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`pairing: ${setup.pairingUrl}\n`);
  expect(result.stderr).toContain("opener");
  expect(result.stderr).toContain("7");
  expect(result.stderr).not.toContain(setup.secret);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([setup.pairingUrl]);
});

test("installs a local pack on a browserless host, refreshes on update, and removes it on uninstall", async () => {
  const setup = await fixture({ browser: "absent" });
  const pack = path.join(setup.root, "browser.tar.zst");
  writeFileSync(pack, Bun.zstdCompressSync(await new Bun.Archive({
    ".omarchy-bot-browser-pack": `${BROWSER_ASSETS_RELEASE}\n`,
    "chrome-linux64/chrome": elfFixture(),
    "libs/ld-linux-x86-64.so.2": "fixture-loader",
  }).bytes()));
  writeFileSync(`${pack}.sha256`, `${createHash("sha256").update(readFileSync(pack)).digest("hex")}  browser.tar.zst\n`);
  const installed = await cli(setup, ["install", ...setup.archiveArgs, "--browser-pack", pack]);
  expect(installed.stderr).toBe(""); expect(installed.code).toBe(0);
  expect(interpreterPath(path.join(setup.layout.browserPackDir, "chrome-linux64/chrome"))).toMatchObject({ path: path.join(setup.layout.browserPackDir, "libs/ld-linux-x86-64.so.2"), mapped: true });
  writeFileSync(path.join(setup.layout.browserPackDir, "obsolete"), "old");
  expect((await cli(setup, ["update", ...setup.archiveArgs, "--browser-pack", pack])).code).toBe(0);
  expect(existsSync(path.join(setup.layout.browserPackDir, "obsolete"))).toBe(false);
  expect((await cli(setup, ["uninstall"])).code).toBe(0);
  expect(existsSync(setup.layout.browserPackDir)).toBe(false);
});

test("skips the pack for a native host browser, automatically installs for snap-only hosts, and honors --with-browser", async () => {
  for (const browser of ["native", "snap"] as const) {
    const setup = await fixture({ browser });
    const pack = Bun.zstdCompressSync(await new Bun.Archive({
      ".omarchy-bot-browser-pack": `${BROWSER_ASSETS_RELEASE}\n`, "chrome-linux64/chrome": elfFixture(), "libs/ld-linux-x86-64.so.2": "loader",
    }).bytes());
    const packFile = path.join(setup.root, "release-pack"); writeFileSync(packFile, pack);
    const hook = path.join(setup.root, "release-hook.ts");
    writeFileSync(hook, `const original=globalThis.fetch; globalThis.fetch=async(input,init)=>{const url=String(input); if(!url.startsWith("https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture/")) return original(input,init); require("node:fs").appendFileSync(${JSON.stringify(path.join(setup.root, "downloads"))},url+"\\n"); const response=new Response(url.endsWith(".sha256") ? ${JSON.stringify(new Bun.CryptoHasher("sha256").update(pack).digest("hex"))} : Bun.file(${JSON.stringify(packFile)})); Object.defineProperty(response,"url",{value:url}); return response;};`);
    const execute = async (flags: string[]) => {
      const child = Bun.spawn([process.execPath, "--preload", hook, "apps/cli/src/main.ts", "install", ...setup.archiveArgs, ...flags], { env: setup.env, stdout: "pipe", stderr: "pipe" });
      const stderr = new Response(child.stderr).text(); expect(await child.exited, await stderr).toBe(0);
    };
    await execute([]);
    expect(existsSync(setup.layout.browserPackDir)).toBe(browser === "snap");
    expect(recorded(path.join(setup.root, "downloads"))).toHaveLength(browser === "snap" ? 2 : 0);
    await execute(["--with-browser"]);
    expect(existsSync(path.join(setup.layout.browserPackDir, "browser"))).toBe(true);
    expect(recorded(path.join(setup.root, "downloads"))).toHaveLength(browser === "snap" ? 4 : 2);
  }
});

test("refuses a mismatched browser pack before publishing the runtime or starting systemctl", async () => {
  const setup = await fixture({ browser: "absent" });
  const pack = path.join(setup.root, "bad-browser.tar.zst");
  writeFileSync(pack, "tampered"); writeFileSync(`${pack}.sha256`, "0".repeat(64));
  const result = await cli(setup, ["install", ...setup.archiveArgs, "--browser-pack", pack]);
  expect(result.code).toBe(1); expect(result.stderr).toContain("checksum mismatch");
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  expect(existsSync(setup.layout.unitPath)).toBe(false);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([]);
});
