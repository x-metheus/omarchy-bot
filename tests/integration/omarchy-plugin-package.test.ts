import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { layoutFromEnv, type Layout } from "../../apps/cli/src/layout.ts";
import { BROWSER_ASSETS_RELEASE } from "../../apps/daemon/src/modules/computer/botComputerAssets.ts";
import { runnableBrowserFiles } from "./helpers/browserPackFixture.ts";

const root = path.resolve(import.meta.dir, "../..");
const entry = path.join(root, "packages/omarchy-plugin/entry.sh");
const pluginId = "io.github.xmethues.omarchy-bot";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function shim(bin: string, name: string, script: string) {
  writeFileSync(path.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
}
async function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "ob-plugin-package-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin"); mkdirSync(bin);
  const source = path.join(home, "plugin"); mkdirSync(source);
  copyFileSync(entry, path.join(source, "entry.sh"));
  const bunDir = path.join(home, "resolved-bun"); mkdirSync(bunDir);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"), XDG_RUNTIME_DIR: path.join(home, "run"),
    OMARCHY_BOT_HOME: path.join(home, "data/omarchy-bot"), OMARCHY_BOT_STATE: path.join(home, "state/omarchy-bot"),
    OMARCHY_BOT_PLUGIN_OS_RELEASE: path.join(home, "os-release"), OMARCHY_BOT_PLUGIN_BUN: path.join(bunDir, "bun"),
    OMARCHY_BOT_PLUGIN_REVISION: "fixture-revision", OMARCHY_BOT_PLUGIN_CURL: path.join(bin, "curl"),
    CALLS: path.join(home, "calls"), CLI_CALLS: path.join(home, "cli-calls"), DOWNLOADS: path.join(home, "downloads"), OMARCHY_BOT_OPEN: "true" };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  writeFileSync(env.OMARCHY_BOT_PLUGIN_OS_RELEASE!, 'ID="omarchy"\n');
  const layout = layoutFromEnv(env);
  const manager = path.join(env.XDG_RUNTIME_DIR!, "systemd"); mkdirSync(manager, { recursive: true });
  const socket = Bun.listen({ unix: path.join(manager, "private"), socket: { data() {} } });
  cleanups.push(() => socket.stop(true));
  const control = path.join(home, "systemctl.ts");
  writeFileSync(control, `import {appendFileSync,readFileSync,writeFileSync,existsSync} from "node:fs";
const args=process.argv.slice(2);appendFileSync(process.env.CALLS!,args.join(" ")+"\\n");
const pidFile=process.env.CALLS+".pid";
if(args.includes("stop")||args.includes("disable")){if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,"utf8")),"SIGTERM")}catch{}}}
const env={...process.env};
if(args.includes("enable")||args.includes("start")){for(const line of readFileSync(process.env.XDG_CONFIG_HOME+"/systemd/user/omarchy-bot.service","utf8").split("\\n")){if(line.startsWith("Environment=")){const value=line.slice(12),index=value.indexOf("=");env[value.slice(0,index)]=value.slice(index+1);}}}
if(args.includes("enable")||args.includes("start")){let live=false;if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,"utf8")),0);live=true}catch{}}
if(!live){const unit=readFileSync(process.env.XDG_CONFIG_HOME+"/systemd/user/omarchy-bot.service","utf8");const executable=unit.split("\\n").find(s=>s.startsWith("ExecStart="))!.slice(10);const child=Bun.spawn(["setsid",executable],{env,stdin:"ignore",stdout:"ignore",stderr:"ignore"});writeFileSync(pidFile,String(child.pid));child.unref();}}
`);
  shim(bin, "systemctl", `exec '${process.execPath}' '${control}' "$@"`);
  cleanups.push(() => { const pid = `${env.CALLS}.pid`; if (existsSync(pid)) { try { process.kill(Number(readFileSync(pid, "utf8")), "SIGKILL"); } catch {} } });
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  env.OMARCHY_BOT_PORT = String(reservation.port); reservation.stop(true);
  const serve = `#!/bin/bash\nexec bun run - <<'SERVICE'\nimport {existsSync,mkdirSync,writeFileSync} from 'node:fs';\nmkdirSync(process.env.OMARCHY_BOT_STATE,{recursive:true});const secret=process.env.OMARCHY_BOT_STATE+'/pairing-host-secret';if(!existsSync(secret))writeFileSync(secret,'fixture-secret');\nBun.serve({hostname:'127.0.0.1',port:Number(process.env.OMARCHY_BOT_PORT),fetch(r){return new URL(r.url).pathname==='/api/health'?Response.json({ok:true}):Response.json({code:'ABCD2345',url:'omarchy-bot://pair?service='+encodeURIComponent(new URL(r.url).origin)+'&code=ABCD2345'})}});\nSERVICE\n`;
  const archive = path.join(home, "runtime.tar.zst");
  const files: Record<string, string> = { "scripts/serve.sh": serve };
  for (const name of ["main", "layout", "archive", "lifecycle", "browserPack", "appInstall"]) files[`apps/cli/src/${name}.ts`] = readFileSync(path.join(root, `apps/cli/src/${name}.ts`), "utf8");
  for (const name of ["swayRuntimeSupply", "botComputerAssets", "browserPack"]) files[`apps/daemon/src/modules/computer/${name}.ts`] = readFileSync(path.join(root, `apps/daemon/src/modules/computer/${name}.ts`), "utf8");
  files["apps/daemon/src/bootstrap/listenerConfig.ts"] = readFileSync(path.join(root, "apps/daemon/src/bootstrap/listenerConfig.ts"), "utf8");
  writeFileSync(archive, Bun.zstdCompressSync(await new Bun.Archive(files).bytes()));
  writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  runtime.tar.zst\n`);
  env.ARCHIVE = archive;
  const pack = path.join(home, "browser.tar.zst");
  writeFileSync(pack, Bun.zstdCompressSync(await new Bun.Archive({ ".omarchy-bot-browser-pack": `${BROWSER_ASSETS_RELEASE}\n`, ...runnableBrowserFiles() }).bytes()));
  const hook = path.join(home, "pack-fetch.ts");
  writeFileSync(hook, `const original=globalThis.fetch; globalThis.fetch=async(input,init)=>{const url=String(input); if(!url.startsWith("https://github.com/")) return original(input,init); if(!url.startsWith("https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture-revision/omarchy-bot-browser-")) throw new Error("unexpected fixture URL: "+url); require("node:fs").appendFileSync(${JSON.stringify(path.join(home, "browser-downloads"))},url+"\\n"); const response=new Response(url.endsWith(".sha256")?${JSON.stringify(createHash("sha256").update(readFileSync(pack)).digest("hex"))}:Bun.file(${JSON.stringify(pack)}));Object.defineProperty(response,"url",{value:url});return response;};`);
  shim(bunDir, "bun", `if [[ \${1:-} == */apps/cli/src/main.ts ]]; then printf '%s\\n' "$*" >> "$CLI_CALLS"; fi\nexec '${process.execPath}' --preload '${hook}' "$@"`);
  shim(bin, "curl", 'printf "%s\\n" "$*" >> "$DOWNLOADS"\nwhile [[ $1 != -o ]]; do shift; done\ndest=$2; url=$3\nif [[ $url == *.sha256 ]]; then cp "$ARCHIVE.sha256" "$dest"; else cp "$ARCHIVE" "$dest"; fi');
  return { home, bin, bunDir, source, env, layout, serve };
}
async function invoke(setup: { env: NodeJS.ProcessEnv; source: string }, ...args: string[]) {
  const child = Bun.spawn(["bash", path.join(setup.source, "entry.sh"), ...args], { env: setup.env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
const calls = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
function spawnSettle(setup: { env: NodeJS.ProcessEnv; layout: Layout; source: string; home: string }) {
  const child = Bun.spawn(["setsid", "bash", path.join(setup.layout.runtimeDir, "plugin-entry.sh"), "settle", setup.source, path.join(setup.home, ".config/omarchy/shell.json"), pluginId], { env: setup.env, stdout: "pipe", stderr: "pipe" });
  cleanups.push(async () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} await child.exited; });
  return child;
}
function setEnabled(setup: { home: string }, enabled: boolean) {
  const config = path.join(setup.home, ".config/omarchy/shell.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ version: 1, plugins: enabled ? [{ id: pluginId }] : [] }));
}

// Readiness comes from real child processes; fake JS timers cannot advance them.
async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (existsSync(file)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForStop(setup: { env: NodeJS.ProcessEnv }) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (calls(setup.env.CALLS!).includes("--user stop omarchy-bot.service")) return;
    await Bun.sleep(20);
  }
  throw new Error("persisted disable did not stop the Service");
}

test("manifest keeps the service loaded and QML declares the injected manifest and lifecycle hooks", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(1); expect(manifest.id).toBe("io.github.xmethues.omarchy-bot"); expect(manifest.kinds).toEqual(["service"]);
  expect(manifest.keepLoaded).toBe(true);
  expect(manifest.entryPoints.service).toBe("packages/omarchy-plugin/Service.qml");
  expect(path.isAbsolute(manifest.entryPoints.service)).toBe(false); expect(manifest.entryPoints.service.split("/")).not.toContain("..");
  const qml = readFileSync(path.join(root, manifest.entryPoints.service), "utf8");
  expect(qml).toContain('Qt.resolvedUrl("entry.sh")');
  expect(qml).toMatch(/property var manifest: null/);
  expect(qml).toMatch(/Component.onCompleted:.*enable/); expect(qml).toMatch(/Component.onDestruction:.*settle/);
  expect(qml).toMatch(/Component.onDestruction:.*\["bash", installedEntryPath,/);
  expect(qml).toContain('"/runtime/plugin-entry.sh"');
  expect(qml).toContain('"/.config/omarchy/shell.json"');
  expect(qml).toContain("manifest.__sourceDir"); expect(qml).not.toContain("notify-send");
  const pkg = JSON.parse(readFileSync(path.join(root, "packages/omarchy-plugin/package.json"), "utf8"));
  expect(pkg.name).toBe("@omarchy-bot/omarchy-plugin"); expect(pkg.private).toBe(true); expect(Object.keys(pkg.dependencies || {})).toHaveLength(0);
});

test("refuses non-Omarchy and unsupported architecture before invoking Bun", async () => {
  const setup = await fixture();
  shim(setup.bin, "bun-trap", 'touch "$HOME/bun-invoked"\nexit 99');
  setup.env.OMARCHY_BOT_PLUGIN_BUN = path.join(setup.bin, "bun-trap");
  writeFileSync(setup.env.OMARCHY_BOT_PLUGIN_OS_RELEASE!, "ID=arch\n");
  expect(await invoke(setup, "enable")).toEqual({ code: 1, stdout: "", stderr: "Omarchy Bot supports Omarchy on x86_64 only\n" });
  writeFileSync(setup.env.OMARCHY_BOT_PLUGIN_OS_RELEASE!, "ID=omarchy\n"); shim(setup.bin, "uname", 'echo aarch64');
  expect((await invoke(setup, "enable")).stderr).toBe("Omarchy Bot supports Omarchy on x86_64 only\n");
  expect(existsSync(path.join(setup.home, "bun-invoked"))).toBe(false); expect(calls(setup.env.DOWNLOADS!)).toEqual([]);
});

test("enable installs using the archive CLI and records the resolved Bun directory in the unit PATH; reuse does not download or double-enable", async () => {
  const setup = await fixture();
  expect(setup.env.PATH!.split(":")).not.toContain(setup.bunDir);
  const installed = await invoke(setup, "enable"); expect(installed).toMatchObject({ code: 0, stderr: "" });
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe(setup.serve);
  expect(readFileSync(setup.layout.unitPath, "utf8")).toContain(`Environment=PATH=${path.dirname(process.execPath)}:${setup.bunDir}:`);
  expect(calls(setup.env.CALLS!)).toEqual(["--user daemon-reload", "--user enable --now omarchy-bot.service"]);
  expect(calls(setup.env.DOWNLOADS!)).toHaveLength(2);
  expect(readFileSync(setup.env.DOWNLOADS!, "utf8")).toContain("https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture-revision/omarchy-bot-runtime-fixture-revision-x86_64.tar.zst");
  expect(calls(setup.env.CLI_CALLS!)[0]).toMatch(/\/apps\/cli\/src\/main.ts install --archive .* --checksum /);
  expect(calls(setup.env.CLI_CALLS!)[0]).not.toContain(setup.source);
  const reused = await invoke(setup, "enable"); expect(reused).toMatchObject({ code: 0, stderr: "" }); expect(reused.stdout).toContain("reusing installed Service");
  expect(calls(setup.env.DOWNLOADS!)).toHaveLength(2); expect(calls(setup.env.CALLS!).filter(s => s.includes("enable"))).toHaveLength(1);
  expect(calls(setup.env.CLI_CALLS!).at(-1)).toBe(`${setup.layout.currentDir}/apps/cli/src/main.ts install --archive missing --checksum missing`);
  expect(calls(setup.env.CALLS!).at(-1)).toBe("--user start omarchy-bot.service");
});

test("graphical plugin enable installs the Service and checksum-verified app through the shared installer", async () => {
  const setup = await fixture();
  setup.env.DISPLAY = ":fixture";
  const image = path.join(setup.home, "fixture.AppImage");
  writeFileSync(image, "#!/bin/sh\nexit 0\n");
  writeFileSync(`${image}.sha256`, createHash("sha256").update(readFileSync(image)).digest("hex"));
  setup.env.OMARCHY_BOT_APP_IMAGE = image;
  const result = await invoke(setup, "enable");
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(result.stdout).toContain("pairing: omarchy-bot://pair?");
  expect(readFileSync(setup.layout.servePath, "utf8")).toBe(setup.serve);
  expect(readFileSync(setup.layout.appImage)).toEqual(readFileSync(image));
  expect(readFileSync(setup.layout.desktopEntry, "utf8")).toContain("MimeType=x-scheme-handler/omarchy-bot;");
  expect(readFileSync(setup.layout.mimeappsPath, "utf8")).toContain("x-scheme-handler/omarchy-bot=omarchy-bot.desktop;");
});

test("plugin enable repairs the missing pack from the retained runtime release after the plugin revision changes", async () => {
  const setup = await fixture();
  expect(await invoke(setup, "enable")).toMatchObject({ code: 0, stderr: "" });
  rmSync(setup.layout.browserPackDir, { recursive: true });
  setup.env.OMARCHY_BOT_PLUGIN_REVISION = "different-plugin-revision";
  expect(await invoke(setup, "enable")).toMatchObject({ code: 0, stderr: "" });
  expect(readFileSync(path.join(setup.layout.browserPackDir, ".omarchy-bot-assets"), "utf8")).toBe(`${BROWSER_ASSETS_RELEASE}\n`);
  expect(calls(path.join(setup.home, "browser-downloads"))).toEqual([
    `https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture-revision/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst`,
    `https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture-revision/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst.sha256`,
    `https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture-revision/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst`,
    `https://github.com/XMethues/omarchy-bot/releases/download/runtime-fixture-revision/omarchy-bot-browser-${BROWSER_ASSETS_RELEASE}-x86_64.tar.zst.sha256`,
  ]);
  expect(calls(setup.env.DOWNLOADS!)).toHaveLength(2);
  expect(calls(setup.env.CALLS!).at(-1)).toBe("--user start omarchy-bot.service");
});

test("graceful teardown waits for persisted disable, and re-enable ends the watcher without uninstalling", async () => {
  const setup = await fixture();
  expect((await invoke(setup, "enable")).code).toBe(0);
  const kept = preserveData(setup.layout);
  setEnabled(setup, true);
  const pid = Number(readFileSync(`${setup.env.CALLS}.pid`, "utf8"));
  const child = spawnSettle(setup);
  // QML destruction precedes Shell persistence; the old enabled set is still on disk.
  await Bun.sleep(1_200);
  expect(child.exitCode).toBeNull();
  expect(calls(setup.env.CALLS!).includes("--user stop omarchy-bot.service")).toBe(false);
  expect(() => process.kill(pid, 0)).not.toThrow();
  setEnabled(setup, false);
  await waitForStop(setup);
  expect(calls(setup.env.CLI_CALLS!).at(-1)).toBe(`${setup.layout.currentDir}/apps/cli/src/main.ts stop`);
  for (let attempt = 0; attempt < 250 && existsSync(`/proc/${pid}`); attempt++) await Bun.sleep(20);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(calls(setup.env.CLI_CALLS!).some(line => line.endsWith(" uninstall"))).toBe(false);
  setEnabled(setup, true);
  expect(await invoke(setup, "enable")).toMatchObject({ code: 0, stderr: "" });
  expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
  expect(existsSync(setup.layout.unitPath)).toBe(true); expect(existsSync(setup.layout.servePath)).toBe(true);
  for (const [file, data] of kept) expect(readFileSync(file)).toEqual(data);
}, 10_000);

test.each(["enabled", "missing", "malformed"])("graceful teardown with no Shell returning keeps the Service running (config=%s)", async configState => {
  const setup = await fixture();
  expect((await invoke(setup, "enable")).code).toBe(0);
  if (configState !== "missing") setEnabled(setup, true);
  if (configState === "malformed") writeFileSync(path.join(setup.home, ".config/omarchy/shell.json"), "{");
  const pid = Number(readFileSync(`${setup.env.CALLS}.pid`, "utf8"));
  const child = spawnSettle(setup);
  // Observe more than one real watcher interval with no subsequent Shell event.
  await Bun.sleep(2_200);
  expect(calls(setup.env.CALLS!).includes("--user stop omarchy-bot.service")).toBe(false);
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect(existsSync(setup.layout.unitPath)).toBe(true);
  // Re-enable also retires a session-ending teardown's watcher.
  setEnabled(setup, true);
  expect((await invoke(setup, "enable")).code).toBe(0);
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
}, 10_000);

test("a slow removal still uninstalls after disable has stopped the unit for more than one second", async () => {
  const setup = await fixture();
  expect((await invoke(setup, "enable")).code).toBe(0);
  const kept = preserveData(setup.layout);
  setEnabled(setup, true);
  const child = spawnSettle(setup);
  setEnabled(setup, false);
  await waitForStop(setup);
  // Host deletion has no deadline, and fake JS timers cannot drive the bash watcher.
  await Bun.sleep(1_200);
  expect(child.exitCode).toBeNull();
  expect(calls(setup.env.CLI_CALLS!).at(-1)).toBe(`${setup.layout.currentDir}/apps/cli/src/main.ts stop`);
  expect(existsSync(setup.layout.unitPath)).toBe(true);
  rmSync(setup.source, { recursive: true });
  expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
  expect(calls(setup.env.CLI_CALLS!).at(-1)).toBe(`${setup.layout.currentDir}/apps/cli/src/main.ts uninstall`);
  expect(existsSync(setup.layout.unitPath)).toBe(false); expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  for (const [file, data] of kept) expect(readFileSync(file)).toEqual(data);
});

function preserveData(layout: Layout): Array<[string, Buffer<ArrayBuffer>]> {
  const files = [layout.dbPath, path.join(layout.screensDir, "profile"), path.join(layout.workspaceDir, "note"), layout.serviceLog, layout.hostSecretPath];
  return files.map((file, index) => {
    const data = file === layout.hostSecretPath ? Buffer.from("seeded-host-secret") : Buffer.from([0, index, 255, 10, 65]);
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data);
    return [file, data];
  });
}

test("remove deletes the checkout immediately after settle is spawned and uninstalls through the installed CLI preserving every data file", async () => {
  const setup = await fixture();
  expect((await invoke(setup, "enable")).code).toBe(0);
  const kept = preserveData(setup.layout);
  setEnabled(setup, false);
  const child = spawnSettle(setup);
  rmSync(setup.source, { recursive: true });
  expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
  expect(calls(setup.env.CLI_CALLS!).at(-1)).toBe(`${setup.layout.currentDir}/apps/cli/src/main.ts uninstall`);
  expect(calls(setup.env.CALLS!).slice(-2)).toEqual(["--user disable --now omarchy-bot.service", "--user daemon-reload"]);
  expect(existsSync(setup.layout.unitPath)).toBe(false); expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  for (const [file, data] of kept) expect(readFileSync(file)).toEqual(data);
});

test("removing the checkout during download waits for enable and leaves no running unit", async () => {
  const setup = await fixture();
  shim(setup.bin, "curl", 'touch "$HOME/download-waiting"\nwhile [[ ! -f $HOME/download-release ]]; do sleep 0.02; done\nwhile [[ $1 != -o ]]; do shift; done\ndest=$2; url=$3\nif [[ $url == *.sha256 ]]; then cp "$ARCHIVE.sha256" "$dest"; else cp "$ARCHIVE" "$dest"; fi');
  const enabling = invoke(setup, "enable");
  await waitForFile(path.join(setup.home, "download-waiting"));
  setEnabled(setup, false);
  const settling = spawnSettle(setup);
  rmSync(setup.source, { recursive: true });
  writeFileSync(path.join(setup.home, "download-release"), "");
  expect(await enabling).toMatchObject({ code: 0, stderr: "" });
  expect(await settling.exited).toBe(0);
  expect(await new Response(settling.stderr).text()).toBe("");
  expect(calls(setup.env.CALLS!).at(-2)).toBe("--user disable --now omarchy-bot.service");
  expect(existsSync(setup.layout.unitPath)).toBe(false);
  expect(existsSync(setup.layout.runtimeDir)).toBe(false);
  const pid = Number(readFileSync(`${setup.env.CALLS}.pid`, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test.each([false, true])("a removal watcher rechecks generation and enabled state before uninstall (persisted enabled=%s)", async persistedEnabled => {
  const setup = await fixture();
  expect((await invoke(setup, "enable")).code).toBe(0);
  setEnabled(setup, false);
  const gate = path.join(setup.home, "watcher-lock");
  // Pause only this watcher's second lock acquisition, after it sees the missing checkout.
  shim(setup.bin, "flock", 'if [[ -n ${WATCHER_GATE:-} && $1 != -u ]]; then\n  count=$(cat "$WATCHER_GATE.count" 2>/dev/null || echo 0)\n  count=$((count + 1)); printf "%s" "$count" > "$WATCHER_GATE.count"\n  if [[ $count == 2 ]]; then\n    touch "$WATCHER_GATE.ready"\n    while [[ ! -f $WATCHER_GATE.release ]]; do /usr/bin/sleep 0.02; done\n  fi\nfi\nexec /usr/bin/flock "$@"');
  const settling = spawnSettle({ ...setup, env: { ...setup.env, WATCHER_GATE: gate } });
  rmSync(setup.source, { recursive: true });
  await waitForFile(`${gate}.ready`);
  if (!persistedEnabled) {
    mkdirSync(setup.source);
    copyFileSync(entry, path.join(setup.source, "entry.sh"));
    expect(await invoke(setup, "enable")).toMatchObject({ code: 0, stderr: "" });
  }
  setEnabled(setup, persistedEnabled);
  writeFileSync(`${gate}.release`, "");
  expect(await settling.exited).toBe(0);
  expect(await new Response(settling.stderr).text()).toBe("");
  expect(calls(setup.env.CALLS!).some(line => line.includes("disable"))).toBe(false);
  expect(calls(setup.env.CLI_CALLS!).some(line => line.endsWith(" uninstall"))).toBe(false);
  expect(existsSync(setup.layout.unitPath)).toBe(true);
  if (!persistedEnabled) expect(() => process.kill(Number(readFileSync(`${setup.env.CALLS}.pid`, "utf8")), 0)).not.toThrow();
});

test.each([false, true])("a disable watcher rechecks generation and enabled state before stopping (persisted enabled=%s)", async persistedEnabled => {
  const setup = await fixture();
  expect((await invoke(setup, "enable")).code).toBe(0);
  setEnabled(setup, false);
  const pid = Number(readFileSync(`${setup.env.CALLS}.pid`, "utf8"));
  const gate = path.join(setup.home, "disable-lock");
  // Hold the destructive recheck while a newer Shell enable or persistence wins.
  shim(setup.bin, "flock", 'if [[ -n ${WATCHER_GATE:-} ]]; then\n  count=$(cat "$WATCHER_GATE.count" 2>/dev/null || echo 0)\n  if [[ $1 != -u ]]; then\n    count=$((count + 1)); printf "%s" "$count" > "$WATCHER_GATE.count"\n    if [[ $count == 2 ]]; then\n      touch "$WATCHER_GATE.ready"\n      while [[ ! -f $WATCHER_GATE.release ]]; do /usr/bin/sleep 0.02; done\n    fi\n  elif [[ $count == 2 ]]; then\n    touch "$WATCHER_GATE.checked"\n  fi\nfi\nexec /usr/bin/flock "$@"');
  const settling = spawnSettle({ ...setup, env: { ...setup.env, WATCHER_GATE: gate } });
  await waitForFile(`${gate}.ready`);
  if (!persistedEnabled) expect(await invoke(setup, "enable")).toMatchObject({ code: 0, stderr: "" });
  setEnabled(setup, persistedEnabled);
  writeFileSync(`${gate}.release`, "");
  if (persistedEnabled) {
    // Wait for the actual locked decision before retiring the watcher via re-enable.
    await waitForFile(`${gate}.checked`);
    expect(calls(setup.env.CALLS!).includes("--user stop omarchy-bot.service")).toBe(false);
    expect(await invoke(setup, "enable")).toMatchObject({ code: 0, stderr: "" });
  }
  expect(await settling.exited).toBe(0);
  expect(await new Response(settling.stderr).text()).toBe("");
  expect(calls(setup.env.CALLS!).some(line => /--user (stop|disable) /.test(line))).toBe(false);
  expect(Number(readFileSync(`${setup.env.CALLS}.pid`, "utf8"))).toBe(pid);
  expect(() => process.kill(pid, 0)).not.toThrow();
});
