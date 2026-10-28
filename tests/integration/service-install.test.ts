import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { layoutFromEnv } from "../../apps/cli/src/layout.ts";
import { BROWSER_ASSETS_RELEASE } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";
import { interpreterPath, runnableBrowserFiles } from "./helpers/browserPackFixture.ts";

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

async function fixture(options: { manager?: boolean; opener?: string; browser?: "native" | "snap" | "absent"; tls?: boolean; requireBun?: boolean; pin?: string; revision?: string; priorInstaller?: boolean } = {}) {
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
  writeFileSync(launcher, `import {readFileSync,existsSync,appendFileSync,writeFileSync,rmSync} from "node:fs";
const args=process.argv.slice(2); appendFileSync(process.env.SYSTEMCTL_CALLS!, args.join(" ")+"\\n");
const pidFile=process.env.SYSTEMCTL_CALLS+".pid";
if(args.includes("stop") || args.includes("disable") || args.includes("restart")){if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,"utf8")),"SIGTERM");while(true){try{await fetch((process.env.OMARCHY_BOT_TLS_CERT?"https":"http")+"://127.0.0.1:"+process.env.OMARCHY_BOT_PORT+"/api/health",{tls:{rejectUnauthorized:false}})}catch{break}}}catch{}rmSync(pidFile,{force:true})}}
if(args.includes("restart") && process.env.FAIL_RESTART_ONCE && existsSync(process.env.FAIL_RESTART_ONCE)){rmSync(process.env.FAIL_RESTART_ONCE);console.error("fixture activation failure");process.exit(1)}
if(args.includes("enable") || args.includes("start") || args.includes("restart")){
let running=false;if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,"utf8")),0);running=true}catch{}}
if(!running){const unit=readFileSync(process.env.XDG_CONFIG_HOME+"/systemd/user/omarchy-bot.service","utf8");
const env={...process.env};for(const key of ["OMARCHY_BOT_TLS_CERT","OMARCHY_BOT_TLS_KEY","OMARCHY_BOT_TRUSTED_PROXY","OMARCHY_BOT_BROWSER"])delete env[key];for(const line of unit.split("\\n")){if(line.startsWith("Environment=")){const value=line.slice(12);const index=value.indexOf("=");env[value.slice(0,index)]=value.slice(index+1)}}
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
  if (options.tls) {
    env.OMARCHY_BOT_TLS_CERT = path.join(root, "cert.pem");
    env.OMARCHY_BOT_TLS_KEY = path.join(root, "key.pem");
    expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", env.OMARCHY_BOT_TLS_KEY, "-out", env.OMARCHY_BOT_TLS_CERT, "-days", "1", "-nodes", "-subj", "/CN=localhost"]).exitCode).toBe(0);
  }
  const layout = layoutFromEnv(env);
  const archive = path.join(root, `omarchy-bot-runtime-${options.revision ?? "fixture"}-x86_64.tar.zst`);
  const checksum = `${archive}.sha256`;
  const serve = `#!/bin/bash
${options.requireBun ? 'command -v bun >/dev/null || { echo "requires Bun in PATH" >&2; exit 1; }' : ""}
exec '${process.execPath}' run - <<'SERVICE'
import {mkdirSync,writeFileSync} from "node:fs";
mkdirSync(process.env.OMARCHY_BOT_STATE,{recursive:true,mode:0o700});
writeFileSync(process.env.OMARCHY_BOT_STATE+"/pairing-host-secret",${JSON.stringify(secret)},{mode:0o600});
Bun.serve({hostname:"127.0.0.1",port:Number(process.env.OMARCHY_BOT_PORT),...(process.env.OMARCHY_BOT_TLS_CERT?{tls:{cert:Bun.file(process.env.OMARCHY_BOT_TLS_CERT),key:Bun.file(process.env.OMARCHY_BOT_TLS_KEY)}}:{}),fetch(request){
const route=new URL(request.url).pathname;
if(route==="/api/health" && request.method==="GET")return Response.json({ok:true});
if(request.headers.get("authorization")!==${JSON.stringify(`Bearer ${secret}`)})return new Response("unauthorized",{status:401});
if(route==="/api/devices/paired")return Response.json({devices:[]});
if(route==="/api/pairing/codes" && request.method==="POST")return Response.json({code:"ABCD2345",url:"omarchy-bot://pair?service="+encodeURIComponent(new URL(request.url).origin)+"&code=ABCD2345"});
return new Response("not found",{status:404});}});
SERVICE
`;
  const files: Record<string, string> = { "scripts/serve.sh": serve };
  for (const name of ["main", "layout", "archive", "lifecycle", "browserPack"]) files[`apps/cli/src/${name}.ts`] = readFileSync(path.join(projectRoot, `apps/cli/src/${name}.ts`), "utf8");
  for (const name of ["swayRuntimeSupply", "botComputerAssets", "browserPack", "hostBrowser"]) files[`apps/daemon/src/modules/computer/${name}.ts`] = readFileSync(path.join(projectRoot, `apps/daemon/src/modules/computer/${name}.ts`), "utf8");
  files["apps/daemon/src/bootstrap/listenerConfig.ts"] = readFileSync(path.join(projectRoot, "apps/daemon/src/bootstrap/listenerConfig.ts"), "utf8");
  if (options.pin) files["apps/daemon/src/modules/computer/botComputerAssets.ts"] = files["apps/daemon/src/modules/computer/botComputerAssets.ts"]!.replace(`BROWSER_ASSETS_RELEASE = "${BROWSER_ASSETS_RELEASE}"`, `BROWSER_ASSETS_RELEASE = "${options.pin}"`);
  // Frozen from 23c944b74457df7755acab944db54c80db689858, before the installer gained a third argument.
  if (options.priorInstaller) files["apps/cli/src/browserPack.ts"] = readFileSync(path.join(import.meta.dir, "helpers/priorBrowserPack.ts.fixture"), "utf8");
  const packed = await new Bun.Archive(files).bytes();
  writeFileSync(archive, Bun.zstdCompressSync(packed));
  writeFileSync(checksum, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  runtime.tar.zst\n`);
  const pack = path.join(root, "browser.tar.zst");
  writeFileSync(pack, Bun.zstdCompressSync(await new Bun.Archive({
    ".omarchy-bot-browser-pack": `${options.pin ?? BROWSER_ASSETS_RELEASE}\n`,
    ...runnableBrowserFiles(),
  }).bytes()));
  const packHash = createHash("sha256").update(readFileSync(pack)).digest("hex");
  writeFileSync(`${pack}.sha256`, `${packHash}  browser.tar.zst\n`);
  const hook = path.join(root, "release-hook.ts");
  writeFileSync(hook, `const original=globalThis.fetch; globalThis.fetch=async(input,init)=>{const url=String(input); if(!url.startsWith("https://github.com/")) return original(input,init); if(!url.startsWith(${JSON.stringify(`https://github.com/XMethues/omarchy-bot/releases/download/runtime-${options.revision ?? "fixture"}/`)})) throw new Error("unexpected fixture URL: "+url); require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "downloads"))},url+"\\n"); const response=new Response(url.endsWith(".sha256") ? ${JSON.stringify(packHash)} : Bun.file(${JSON.stringify(pack)})); Object.defineProperty(response,"url",{value:url}); return response;};`);
  const archiveArgs = ["--archive", archive, "--checksum", checksum];
  return { root, env, layout, archiveArgs, checksum, secret, serve, bin, pack, hook,
    pairingUrl: `omarchy-bot://pair?service=${encodeURIComponent(`${options.tls ? "https" : "http"}://127.0.0.1:${env.OMARCHY_BOT_PORT}`)}&code=ABCD2345` };
}

async function cli(setup: { env: NodeJS.ProcessEnv; hook?: string; cliPath?: string }, args: string[]) {
  const child = Bun.spawn([process.execPath, ...(setup.hook ? ["--preload", setup.hook] : []), setup.cliPath ?? "apps/cli/src/main.ts", ...args], {
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
  expect(installed).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe(setup.serve);
  expect(readFileSync(path.join(setup.layout.currentDir, ".archive-sha256"), "utf8").trim()).toBe(createHash("sha256").update(readFileSync(setup.archiveArgs[1]!)).digest("hex"));
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain(`ExecStart=${setup.layout.servePath}`);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([
    "--user daemon-reload", "--user enable --now omarchy-bot.service",
  ]);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([setup.pairingUrl]);
  expect(installed.stdout + installed.stderr).not.toContain(setup.secret);

  const second = await cli(setup, ["install", "--archive", "missing", "--checksum", "missing"]);
  expect(second).toEqual({ code: 0, stdout: `reusing installed Service\naddress: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(recorded(setup.env.SYSTEMCTL_CALLS!).filter(line => line.includes("enable"))).toHaveLength(1);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!).at(-1)).toBe("--user start omarchy-bot.service");
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([setup.pairingUrl, setup.pairingUrl]);
  expect(readdirSync(setup.layout.unitDir)).toEqual(["omarchy-bot.service"]);
  expect(readdirSync(setup.layout.runtimeDir).sort()).toEqual(["browser", "current"]);

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

test("default listener settings survive install reuse, update, and reconfigure", async () => {
  const setup = await fixture();
  delete setup.env.OMARCHY_BOT_HOST;
  delete setup.env.OMARCHY_BOT_PORT;
  const pairing = "address: http://127.0.0.1:7321\ncode: ABCD2345\npairing: omarchy-bot://pair?service=http%3A%2F%2F127.0.0.1%3A7321&code=ABCD2345\n";
  expect(await cli(setup, ["install", ...setup.archiveArgs])).toEqual({ code: 0, stdout: pairing, stderr: "" });
  const saved = JSON.parse(readFileSync(path.join(setup.layout.dataDir, "service.json"), "utf8"));
  expect(saved).toMatchObject({ OMARCHY_BOT_HOST: "127.0.0.1", OMARCHY_BOT_PORT: "7321" });
  expect(await cli(setup, ["install", "--archive", "missing", "--checksum", "missing"])).toEqual({ code: 0, stdout: `reusing installed Service\n${pairing}`, stderr: "" });
  expect(await cli(setup, ["update", ...setup.archiveArgs])).toEqual({ code: 0, stdout: pairing, stderr: "" });
  expect(await cli(setup, ["reconfigure"])).toEqual({ code: 0, stdout: "Service reconfigured.\n", stderr: "" });
});

test.each(["install", "update", "reconfigure"])("legacy empty listener defaults allow %s", async command => {
  const setup = await fixture();
  delete setup.env.OMARCHY_BOT_HOST;
  delete setup.env.OMARCHY_BOT_PORT;
  const pairing = "address: http://127.0.0.1:7321\ncode: ABCD2345\npairing: omarchy-bot://pair?service=http%3A%2F%2F127.0.0.1%3A7321&code=ABCD2345\n";
  expect(await cli(setup, ["install", ...setup.archiveArgs])).toEqual({ code: 0, stdout: pairing, stderr: "" });
  writeFileSync(path.join(setup.layout.dataDir, "service.json"), JSON.stringify({ OMARCHY_BOT_HOST: "", OMARCHY_BOT_PORT: "" }));
  const args = command === "reconfigure" ? [command] : [command, ...setup.archiveArgs];
  const stdout = command === "reconfigure" ? "Service reconfigured.\n" : `${command === "install" ? "reusing installed Service\n" : ""}${pairing}`;
  expect(await cli(setup, args)).toEqual({ code: 0, stdout, stderr: "" });
});

test("saved listener settings retain valid values and environment precedence", async () => {
  const setup = await fixture();
  const port = setup.env.OMARCHY_BOT_PORT!;
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  delete setup.env.OMARCHY_BOT_HOST;
  delete setup.env.OMARCHY_BOT_PORT;
  expect(layoutFromEnv(setup.env).env).toMatchObject({ OMARCHY_BOT_HOST: "127.0.0.1", OMARCHY_BOT_PORT: port });
  expect(await cli(setup, ["reconfigure"])).toEqual({ code: 0, stdout: "Service reconfigured.\n", stderr: "" });
  const overridden = layoutFromEnv({ ...setup.env, OMARCHY_BOT_HOST: "::1", OMARCHY_BOT_PORT: "17499" });
  expect(overridden.env).toMatchObject({ OMARCHY_BOT_HOST: "::1", OMARCHY_BOT_PORT: "17499" });
  expect(overridden.host).toBe("::1");
  expect(overridden.port).toBe("17499");
  const reset = layoutFromEnv({ ...setup.env, OMARCHY_BOT_HOST: "", OMARCHY_BOT_PORT: "" });
  expect(reset.env).toMatchObject({ OMARCHY_BOT_HOST: "127.0.0.1", OMARCHY_BOT_PORT: "7321" });
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
  expect(result).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe(setup.serve);
  expect(existsSync(path.join(setup.layout.currentDir, "old-file"))).toBe(false);
  expect(readdirSync(setup.layout.runtimeDir).sort()).toEqual(["browser", "current"]);
  const calls = recorded(setup.env.SYSTEMCTL_CALLS!);
  expect(calls.indexOf("--user stop omarchy-bot.service")).toBeLessThan(calls.indexOf("--user start omarchy-bot.service"));
});

test("update and install reuse select the target runtime pin rather than the executing CLI pin", async () => {
  const setup = await fixture();
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const target = await fixture({ pin: "chrome-for-testing-target-fixture-linux64", revision: "target-release" });
  expect(readFileSync(target.archiveArgs[1]!)).not.toEqual(readFileSync(setup.archiveArgs[1]!));
  const updated = await cli({ ...setup, hook: target.hook, cliPath: path.join(setup.layout.currentDir, "apps/cli/src/main.ts") }, ["update", ...target.archiveArgs]);
  expect(updated).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  const marker = path.join(setup.layout.browserPackDir, ".omarchy-bot-assets");
  expect(readFileSync(marker, "utf8")).toBe("chrome-for-testing-target-fixture-linux64\n");
  expect(recorded(path.join(target.root, "downloads"))).toEqual([
    "https://github.com/XMethues/omarchy-bot/releases/download/runtime-target-release/omarchy-bot-browser-chrome-for-testing-target-fixture-linux64-x86_64.tar.zst",
    "https://github.com/XMethues/omarchy-bot/releases/download/runtime-target-release/omarchy-bot-browser-chrome-for-testing-target-fixture-linux64-x86_64.tar.zst.sha256",
  ]);
  writeFileSync(path.join(setup.layout.browserPackDir, "keep"), "retained runtime pin");
  expect(await cli(setup, ["install", ...setup.archiveArgs, "--browser-pack", setup.pack])).toEqual({ code: 0, stdout: `reusing installed Service\naddress: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  expect(readFileSync(marker, "utf8")).toBe("chrome-for-testing-target-fixture-linux64\n");
  expect(readFileSync(path.join(setup.layout.browserPackDir, "keep"), "utf8")).toBe("retained runtime pin");
  rmSync(setup.layout.browserPackDir, { recursive: true });
  expect((await cli(setup, ["install", ...setup.archiveArgs, "--browser-pack", target.pack])).code).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("chrome-for-testing-target-fixture-linux64\n");
});

test.each(["missing", "broken", "target archive"])("a prior two-argument runtime installer leaves a runnable browser after %s pack preparation", async mode => {
  const setup = await fixture({ priorInstaller: true, pin: "chrome-for-testing-prior-fixture-linux64", revision: "prior-release" });
  if (mode !== "target archive") {
    expect((await cli(setup, ["install", ...setup.archiveArgs, "--no-browser-pack"])).code).toBe(0);
    if (mode === "broken") {
      // The fixture's retained runtime selects the module and browser pin.
      const installer = path.join(setup.layout.currentDir, "apps/cli/src/browserPack.ts");
      expect(Bun.spawnSync([process.execPath, "--eval", `const { installBrowserPack } = await import(${JSON.stringify(installer)}); await installBrowserPack(${JSON.stringify(setup.pack)}, ${JSON.stringify(setup.layout.browserPackDir)});`], { cwd: projectRoot, env: setup.env }).exitCode).toBe(0);
      writeFileSync(path.join(setup.layout.browserPackDir, "browser"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    }
  }
  const args = mode === "target archive" ? ["update", ...setup.archiveArgs] : ["install", "--archive", "missing", "--checksum", "missing"];
  expect(await cli(setup, args)).toEqual({ code: 0, stdout: `${mode === "target archive" ? "" : "reusing installed Service\n"}address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  const version = Bun.spawnSync([path.join(setup.layout.browserPackDir, "browser"), "--version"], { env: setup.env });
  expect(version.stderr.toString()).toBe("");
  expect(version.exitCode).toBe(0);
  expect(interpreterPath(path.join(setup.layout.browserPackDir, "chrome-linux64/chrome"))).toMatchObject({ path: path.join(setup.layout.browserPackDir, "libs/ld-linux-x86-64.so.2"), mapped: true });
  expect(readFileSync(path.join(setup.layout.browserPackDir, ".omarchy-bot-assets"), "utf8")).toBe("chrome-for-testing-prior-fixture-linux64\n");
  expect(readFileSync(path.join(setup.layout.currentDir, ".runtime-archive"), "utf8")).toBe("omarchy-bot-runtime-prior-release-x86_64.tar.zst\n");
  expect(readdirSync(setup.layout.runtimeDir).sort()).toEqual(["browser", "current"]);
  expect(recorded(path.join(setup.root, "downloads"))).toEqual([
    "https://github.com/XMethues/omarchy-bot/releases/download/runtime-prior-release/omarchy-bot-browser-chrome-for-testing-prior-fixture-linux64-x86_64.tar.zst",
    "https://github.com/XMethues/omarchy-bot/releases/download/runtime-prior-release/omarchy-bot-browser-chrome-for-testing-prior-fixture-linux64-x86_64.tar.zst.sha256",
  ]);
});

test("target browser validation failure preserves the running runtime and pack without stopping the Service", async () => {
  const setup = await fixture();
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const target = await fixture({ pin: "chrome-for-testing-target-fixture-linux64" });
  const marker = path.join(setup.layout.browserPackDir, ".omarchy-bot-assets");
  const runtime = readFileSync(path.join(setup.layout.currentDir, ".archive-sha256"), "utf8");
  const calls = recorded(setup.env.SYSTEMCTL_CALLS!);
  const rejected = await cli(setup, ["update", ...target.archiveArgs, "--browser-pack", setup.pack]);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain("browser pack version mismatch");
  expect(readFileSync(marker, "utf8")).toBe(`${BROWSER_ASSETS_RELEASE}\n`);
  expect(readFileSync(path.join(setup.layout.currentDir, ".archive-sha256"), "utf8")).toBe(runtime);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual(calls);
  expect(readdirSync(setup.layout.runtimeDir).sort()).toEqual(["browser", "current"]);
  expect((await cli(setup, ["pair"])).code).toBe(0);
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
  expect(result.stdout).toBe(`address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`);
  expect(result.stderr).toContain("opener");
  expect(result.stderr).toContain("7");
  expect(result.stderr).not.toContain(setup.secret);
  expect(recorded(setup.env.OPEN_CALLS!)).toEqual([setup.pairingUrl]);
});

test("installs a local pack, preserves an unchanged pin, replaces a stale pin and removes it on uninstall", async () => {
  const setup = await fixture({ browser: "absent" });
  const pack = setup.pack;
  const installed = await cli(setup, ["install", ...setup.archiveArgs, "--browser-pack", pack]);
  expect(installed.stderr).toBe(""); expect(installed.code).toBe(0);
  expect(interpreterPath(path.join(setup.layout.browserPackDir, "chrome-linux64/chrome"))).toMatchObject({ path: path.join(setup.layout.browserPackDir, "libs/ld-linux-x86-64.so.2"), mapped: true });
  writeFileSync(path.join(setup.layout.browserPackDir, "obsolete"), "old");
  expect((await cli(setup, ["update", ...setup.archiveArgs, "--browser-pack", pack])).code).toBe(0);
  expect(readFileSync(path.join(setup.layout.browserPackDir, "obsolete"), "utf8")).toBe("old");
  writeFileSync(path.join(setup.layout.browserPackDir, ".omarchy-bot-assets"), "older-pin\n");
  expect((await cli(setup, ["update", ...setup.archiveArgs, "--browser-pack", pack])).code).toBe(0);
  expect(existsSync(path.join(setup.layout.browserPackDir, "obsolete"))).toBe(false);
  rmSync(path.join(setup.layout.browserPackDir, "chrome-linux64/chrome"));
  expect((await cli(setup, ["update", ...setup.archiveArgs, "--browser-pack", pack])).code).toBe(0);
  expect(existsSync(path.join(setup.layout.browserPackDir, "chrome-linux64/chrome"))).toBe(true);
  expect((await cli(setup, ["uninstall"])).code).toBe(0);
  expect(existsSync(setup.layout.browserPackDir)).toBe(false);
});

test("doctor's advertised update repairs a same-pin browser that exits 7 or has a missing dependency", async () => {
  const setup = await fixture();
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const browser = path.join(setup.layout.browserPackDir, "browser");
  for (const broken of ["#!/bin/sh\nexit 7\n", "#!/nonexistent/browser-loader\n"]) {
    writeFileSync(browser, broken, { mode: 0o755 });
    expect((await cli(setup, ["doctor"])).stdout).toContain("browser pack:");
    expect(await cli(setup, ["update", ...setup.archiveArgs, "--browser-pack", setup.pack])).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
    expect(readFileSync(browser, "utf8")).not.toBe(broken);
    const version = Bun.spawnSync([browser, "--version"], { env: setup.env });
    expect(version.exitCode).toBe(0);
    expect((await cli(setup, ["doctor"])).stdout).not.toContain("browser pack:");
  }
});

test("installs the release pack by default on native, snap and browserless hosts and keeps the same pin on update", async () => {
  for (const browser of ["native", "snap", "absent"] as const) {
    const setup = await fixture({ browser });
    expect(await cli(setup, ["install", ...setup.archiveArgs])).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
    expect(existsSync(path.join(setup.layout.browserPackDir, "browser"))).toBe(true);
    const downloads = path.join(setup.root, "downloads");
    expect(recorded(downloads)).toEqual([
      `https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst`,
      `https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst.sha256`,
    ]);
    writeFileSync(path.join(setup.layout.browserPackDir, "keep"), "same pin");
    expect((await cli(setup, ["update", ...setup.archiveArgs])).code).toBe(0);
    expect(readFileSync(path.join(setup.layout.browserPackDir, "keep"), "utf8")).toBe("same pin");
    expect(recorded(downloads)).toHaveLength(2);
  }
});

test("--browser-pack installs an explicit HTTPS archive and its checksum sidecar", async () => {
  const setup = await fixture();
  const source = "https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture/custom-browser.tar.zst";
  expect((await cli(setup, ["install", ...setup.archiveArgs, "--browser-pack", source])).code).toBe(0);
  expect(recorded(path.join(setup.root, "downloads"))).toEqual([source, `${source}.sha256`]);
  expect(existsSync(path.join(setup.layout.browserPackDir, "browser"))).toBe(true);
});

test("--no-browser-pack skips install and update without downloads or changing an existing pack", async () => {
  const setup = await fixture();
  expect((await cli(setup, ["install", ...setup.archiveArgs, "--no-browser-pack"])).code).toBe(0);
  expect(existsSync(setup.layout.browserPackDir)).toBe(false);
  mkdirSync(setup.layout.browserPackDir);
  writeFileSync(path.join(setup.layout.browserPackDir, ".omarchy-bot-assets"), "older-pin\n");
  expect((await cli(setup, ["update", ...setup.archiveArgs, "--no-browser-pack"])).code).toBe(0);
  expect(readFileSync(path.join(setup.layout.browserPackDir, ".omarchy-bot-assets"), "utf8")).toBe("older-pin\n");
  expect(recorded(path.join(setup.root, "downloads"))).toEqual([]);
});

test.each(["install", "update"])("%s rejects conflicting browser flags and obsolete flags before mutation", async command => {
  const setup = await fixture();
  for (const flags of [["--no-browser-pack", "--browser-pack", setup.pack], ["--with-browser"], ["--browser-pack"]]) {
    expect((await cli(setup, [command, ...setup.archiveArgs, ...flags])).code).toBe(2);
  }
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([]);
});

test("host opt-in persists through install, saved settings, update and explicit clearing", async () => {
  const setup = await fixture();
  setup.env.OMARCHY_BOT_BROWSER = "host";
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain("Environment=OMARCHY_BOT_BROWSER=host");
  const configPath = path.join(setup.layout.dataDir, "service.json");
  expect(JSON.parse(readFileSync(configPath, "utf8")).OMARCHY_BOT_BROWSER).toBe("host");
  expect(existsSync(setup.layout.browserPackDir)).toBe(true);
  delete setup.env.OMARCHY_BOT_BROWSER;
  expect((await cli(setup, ["reconfigure"])).code).toBe(0);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain("Environment=OMARCHY_BOT_BROWSER=host");
  setup.env.OMARCHY_BOT_BROWSER = "";
  expect((await cli(setup, ["update", ...setup.archiveArgs])).code).toBe(0);
  expect(readFileSync(setup.layout.unitPath, "utf8")).not.toContain("OMARCHY_BOT_BROWSER=");
  expect(JSON.parse(readFileSync(configPath, "utf8")).OMARCHY_BOT_BROWSER).toBe("");
  setup.env.OMARCHY_BOT_BROWSER = "host";
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain("Environment=OMARCHY_BOT_BROWSER=host");
  setup.env.OMARCHY_BOT_BROWSER = "";
  expect((await cli(setup, ["reconfigure"])).code).toBe(0);
  expect(readFileSync(setup.layout.unitPath, "utf8")).not.toContain("OMARCHY_BOT_BROWSER=");
});

test.each(["install", "update", "reconfigure"])("%s rejects invalid host browser selection before mutation", async command => {
  const setup = await fixture();
  setup.env.OMARCHY_BOT_BROWSER = "chromium";
  const result = await cli(setup, [command, ...(command === "reconfigure" ? [] : setup.archiveArgs)]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("OMARCHY_BOT_BROWSER must be host or empty");
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual([]);
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

test("install and update health waits connect to an existing TLS-bound Service", async () => {
  const setup = await fixture({ tls: true });
  mkdirSync(setup.layout.unitDir, { recursive: true });
  writeFileSync(setup.layout.unitPath, `ExecStart=${setup.layout.servePath}\nEnvironment=OMARCHY_BOT_TLS_CERT=${setup.env.OMARCHY_BOT_TLS_CERT}\nEnvironment=OMARCHY_BOT_TLS_KEY=${setup.env.OMARCHY_BOT_TLS_KEY}\n`);
  for (const command of ["install", "update"]) {
    const result = await cli(setup, [command, ...setup.archiveArgs]);
    expect(result).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  }
});

test("TLS flags configure the unit and reconfigure restarts without replacing the runtime", async () => {
  const setup = await fixture({ tls: true });
  const cert = setup.env.OMARCHY_BOT_TLS_CERT!, key = setup.env.OMARCHY_BOT_TLS_KEY!;
  delete setup.env.OMARCHY_BOT_TLS_CERT;
  delete setup.env.OMARCHY_BOT_TLS_KEY;
  const installed = await cli(setup, ["install", ...setup.archiveArgs, "--tls-cert", cert, "--tls-key", key, "--trusted-proxy", "127.0.0.1"]);
  expect(installed).toEqual({ code: 0, stdout: `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`, stderr: "" });
  const unit = readFileSync(setup.layout.unitPath, "utf8");
  expect(unit).toContain(`Environment=OMARCHY_BOT_TLS_CERT=${cert}`);
  expect(unit).toContain(`Environment=OMARCHY_BOT_TLS_KEY=${key}`);
  expect(unit).toContain("Environment=OMARCHY_BOT_TRUSTED_PROXY=127.0.0.1");
  expect((await cli(setup, ["pair"])).stdout).toBe(`address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}\n`);
  const marker = path.join(setup.layout.currentDir, "retain-runtime");
  writeFileSync(marker, "unchanged");
  expect(await cli(setup, ["reconfigure", "--tls-cert", cert, "--tls-key", key, "--trusted-proxy", "::1"])).toEqual({ code: 0, stdout: "Service reconfigured.\n", stderr: "" });
  expect(readFileSync(marker, "utf8")).toBe("unchanged");
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain("Environment=OMARCHY_BOT_TRUSTED_PROXY=::1");
  expect(recorded(setup.env.SYSTEMCTL_CALLS!).slice(-2)).toEqual(["--user daemon-reload", "--user restart omarchy-bot.service"]);
  const changed = readFileSync(setup.layout.unitPath, "utf8");
  expect((await cli(setup, ["reconfigure", "--tls-cert", cert, "--tls-key", ""])).code).toBe(2);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toBe(changed);
});

test("install and update carry TLS and trusted proxy environment and reconfigure can disable TLS", async () => {
  const setup = await fixture({ tls: true });
  setup.env.OMARCHY_BOT_TRUSTED_PROXY = "127.0.0.1";
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  setup.env.OMARCHY_BOT_TRUSTED_PROXY = "::1";
  expect((await cli(setup, ["update", ...setup.archiveArgs])).code).toBe(0);
  const unit = readFileSync(setup.layout.unitPath, "utf8");
  expect(unit).toContain(`OMARCHY_BOT_TLS_CERT=${setup.env.OMARCHY_BOT_TLS_CERT}`);
  expect(unit).toContain(`OMARCHY_BOT_TLS_KEY=${setup.env.OMARCHY_BOT_TLS_KEY}`);
  expect(unit).toContain("OMARCHY_BOT_TRUSTED_PROXY=::1");
  expect((await cli(setup, ["reconfigure", "--tls-cert", "", "--tls-key", "", "--trusted-proxy", ""])).code).toBe(0);
  expect(readFileSync(setup.layout.unitPath, "utf8")).not.toContain("OMARCHY_BOT_TLS");
  expect(readFileSync(setup.layout.unitPath, "utf8")).not.toContain("OMARCHY_BOT_TRUSTED_PROXY");
  delete setup.env.OMARCHY_BOT_TLS_CERT;
  delete setup.env.OMARCHY_BOT_TLS_KEY;
  expect((await cli(setup, ["pair"])).stdout).toContain("address: http://");
});

test("install creates an executable local launcher that invokes installed help and pairing, uninstall removes it", async () => {
  const setup = await fixture({ tls: true });
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const launcher = path.join(setup.env.HOME!, ".local/bin/omarchy-bot");
  expect(statSync(launcher).mode & 0o777).toBe(0o755);
  const env = { ...setup.env }; delete env.OMARCHY_BOT_TLS_CERT; delete env.OMARCHY_BOT_TLS_KEY;
  for (const args of [["--help"], ["pair", "--help"], ["pair"]]) {
    const child = Bun.spawn([launcher, ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(args.length === 1 && args[0] === "pair" ? `address: ${new URL(setup.pairingUrl).searchParams.get("service")}\ncode: ABCD2345\npairing: ${setup.pairingUrl}` : "Usage: omarchy-bot");
    expect(await new Response(child.stderr).text()).toBe("");
  }
  expect((await cli(setup, ["uninstall"])).code).toBe(0);
  expect(existsSync(launcher)).toBe(false);
});

test("install refuses a foreign launcher or symlink before changing runtime or units", async () => {
  for (const symlink of [false, true]) {
    const setup = await fixture();
    const launcher = path.join(setup.env.HOME!, ".local/bin/omarchy-bot");
    mkdirSync(path.dirname(launcher), { recursive: true });
    const target = path.join(setup.root, "foreign"); writeFileSync(target, "user-owned");
    if (symlink) symlinkSync(target, launcher); else writeFileSync(launcher, "user-owned");
    const result = await cli(setup, ["install", ...setup.archiveArgs]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("launcher");
    expect(readFileSync(target, "utf8")).toBe("user-owned");
    expect(readFileSync(launcher, "utf8")).toBe("user-owned");
    expect(existsSync(setup.layout.runtimeDir)).toBe(false);
    expect(existsSync(setup.layout.unitPath)).toBe(false);
    expect((await cli(setup, ["uninstall"])).code).toBe(0);
    expect(existsSync(launcher)).toBe(true);
  }
});

test("invalid TLS files and trusted proxy are rejected before replacing an installed unit", async () => {
  const setup = await fixture();
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const unit = readFileSync(setup.layout.unitPath, "utf8");
  for (const args of [["--tls-cert", "/missing/cert.pem", "--tls-key", "/missing/key.pem"], ["--trusted-proxy", "untrusted.example"]]) {
    const result = await cli(setup, ["reconfigure", ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/TLS file|trusted proxy/);
    expect(readFileSync(setup.layout.unitPath, "utf8")).toBe(unit);
  }
});

test("reconfigure rejects insecure and unusable TLS listeners before mutating a working install", async () => {
  const setup = await fixture({ tls: true });
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const unit = readFileSync(setup.layout.unitPath, "utf8");
  const config = readFileSync(path.join(setup.layout.dataDir, "service.json"), "utf8");
  const calls = recorded(setup.env.SYSTEMCTL_CALLS!);
  const bad = path.join(setup.root, "bad.pem"); writeFileSync(bad, "not PEM");
  const other = await fixture({ tls: true });
  for (const [env, args] of [
    [{ ...setup.env, OMARCHY_BOT_HOST: "0.0.0.0" }, ["--tls-cert", "", "--tls-key", ""]],
    [setup.env, ["--tls-cert", bad]],
    [setup.env, ["--tls-key", other.env.OMARCHY_BOT_TLS_KEY!]],
  ] as const) {
    const result = await cli({ env }, ["reconfigure", ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/requires a certificate|TLS/);
    expect(readFileSync(setup.layout.unitPath, "utf8")).toBe(unit);
    expect(readFileSync(path.join(setup.layout.dataDir, "service.json"), "utf8")).toBe(config);
    expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual(calls);
    expect((await cli(setup, ["pair"])).code).toBe(0);
  }
});

test("failed reconfigure activation restores the prior unit, saved settings and running Service", async () => {
  const setup = await fixture({ tls: true });
  setup.env.OMARCHY_BOT_BROWSER = "host";
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const unit = readFileSync(setup.layout.unitPath, "utf8");
  const configPath = path.join(setup.layout.dataDir, "service.json");
  const config = readFileSync(configPath, "utf8");
  setup.env.FAIL_RESTART_ONCE = path.join(setup.root, "fail-restart");
  writeFileSync(setup.env.FAIL_RESTART_ONCE, "once");
  setup.env.OMARCHY_BOT_BROWSER = "";
  const result = await cli(setup, ["reconfigure", "--trusted-proxy", "127.0.0.2"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("fixture activation failure");
  expect(readFileSync(setup.layout.unitPath, "utf8")).toBe(unit);
  expect(readFileSync(configPath, "utf8")).toBe(config);
  expect((await cli(setup, ["pair"])).code).toBe(0);
});

test("reconfigure identifies legacy TLS drop-ins before mutation and preserves unrelated user settings", async () => {
  const setup = await fixture({ tls: true });
  expect((await cli(setup, ["install", ...setup.archiveArgs])).code).toBe(0);
  const unit = readFileSync(setup.layout.unitPath, "utf8");
  const config = readFileSync(path.join(setup.layout.dataDir, "service.json"), "utf8");
  const directory = `${setup.layout.unitPath}.d`; mkdirSync(directory);
  const override = path.join(directory, "override.conf");
  const previous = `[Service]\nEnvironment=OMARCHY_BOT_BROWSER=host\nEnvironment=OMARCHY_BOT_HOST=0.0.0.0\nEnvironment=OMARCHY_BOT_TLS_CERT=${setup.env.OMARCHY_BOT_TLS_CERT}\nEnvironment=OMARCHY_BOT_TLS_KEY=${setup.env.OMARCHY_BOT_TLS_KEY}\nNice=5\nEnvironment=USER_SETTING=keep\n`;
  writeFileSync(override, previous);
  const calls = recorded(setup.env.SYSTEMCTL_CALLS!);
  const refused = await cli(setup, ["reconfigure", "--tls-cert", "", "--tls-key", ""]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(override);
  expect(refused.stderr).toContain("OMARCHY_BOT_");
  expect(readFileSync(override, "utf8")).toBe(previous);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toBe(unit);
  expect(readFileSync(path.join(setup.layout.dataDir, "service.json"), "utf8")).toBe(config);
  expect(recorded(setup.env.SYSTEMCTL_CALLS!)).toEqual(calls);
  expect((await cli(setup, ["pair"])).code).toBe(0);
  const unrelated = "[Service]\nNice=5\nEnvironment=USER_SETTING=keep\n";
  writeFileSync(override, unrelated);
  expect((await cli(setup, ["reconfigure", "--tls-cert", "", "--tls-key", ""])).code).toBe(0);
  expect(readFileSync(override, "utf8")).toBe(unrelated);
});

test("installed launcher reconfigure retains available Bun when the caller PATH omits it", async () => {
  const setup = await fixture({ requireBun: true });
  const installedEnv = { ...setup.env, PATH: `${path.dirname(process.execPath)}:${setup.env.PATH}` };
  expect((await cli({ env: installedEnv, hook: setup.hook }, ["install", ...setup.archiveArgs])).code).toBe(0);
  expect(Bun.which("bun", { PATH: setup.env.PATH || "" })).toBeNull();
  const child = Bun.spawn([setup.layout.launcherPath, "reconfigure"], { env: setup.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "Service reconfigured.\n", stderr: "" });
  expect((await cli(setup, ["pair"])).code).toBe(0);
}, 40_000);
