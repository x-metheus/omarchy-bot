import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pairForToken } from "./helpers/harness.ts";

const projectRoot = path.resolve(import.meta.dir, "../..");
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function shim(bin: string, name: string, script: string) {
  writeFileSync(path.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
}

function relationship(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]) };
}

// Child-process filesystem readiness uses the OS clock; fake timers cannot advance it.
async function waitForFile(file: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (existsSync(file)) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

test.each(["SIGKILL", "graceful restart"])("%s of the plugin session leaves the same Service and real scripted Turn running", async teardown => {
  const root = mkdtempSync(path.join(tmpdir(), "ob-plugin-lifetime-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const uid = 900_000 + process.pid * 10;
  cleanups.push(() => rmSync(`/tmp/omarchy-bot-${uid}`, { recursive: true, force: true }));
  cleanups.push(() => rmSync(`/tmp/ob-${uid}`, { recursive: true, force: true }));
  shim(bin, "id", `printf '%s\\n' ${uid}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    OMARCHY_BOT_HOME: path.join(root, "data/omarchy-bot"),
    OMARCHY_BOT_STATE: path.join(root, "state/omarchy-bot"),
    OMARCHY_BOT_PLUGIN_BUN: process.execPath,
    OMARCHY_BOT_PLUGIN_OS_RELEASE: path.join(root, "os-release"),
    OMARCHY_BOT_PLUGIN_REVISION: "fixture-revision",
    OMARCHY_BOT_PLUGIN_CURL: path.join(bin, "curl"),
    OMARCHY_BOT_OPEN: "true",
    CALLS: path.join(root, "systemctl-calls"),
    SERVICE_PID: path.join(root, "service.pid"),
    OMARCHY_BOT_WORKERS_DIR: path.join(projectRoot, "tests/integration/fake-workers"),
    ARCHIVE: path.join(root, "runtime.tar.zst"),
  };
  mkdirSync(env.HOME!, { recursive: true });
  writeFileSync(env.OMARCHY_BOT_PLUGIN_OS_RELEASE!, 'ID="omarchy"\n');
  const source = path.join(root, "plugin"); mkdirSync(source);
  copyFileSync(path.join(projectRoot, "packages/omarchy-plugin/entry.sh"), path.join(source, "entry.sh"));
  const shellConfig = path.join(env.HOME!, ".config/omarchy/shell.json");
  mkdirSync(path.dirname(shellConfig), { recursive: true });
  const enabledConfig = JSON.stringify({ version: 1, plugins: [{ id: "io.github.xmethues.omarchy-bot" }] });
  writeFileSync(shellConfig, enabledConfig);
  mkdirSync(path.join(env.OMARCHY_BOT_HOME!, "conformance"), { recursive: true });
  writeFileSync(path.join(env.OMARCHY_BOT_HOME!, "conformance/pi-fake-pi-1.json"), JSON.stringify({ ok: true, image: "verified" }));
  const manager = path.join(env.XDG_RUNTIME_DIR!, "systemd");
  mkdirSync(manager, { recursive: true });
  const socket = Bun.listen({ unix: path.join(manager, "private"), socket: { data() {} } });
  cleanups.push(() => socket.stop(true));
  const control = path.join(root, "systemctl.ts");
  writeFileSync(control, `import {appendFileSync,existsSync,readFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(process.env.CALLS!,args.join(" ")+"\\n");
if(args.includes("stop")||args.includes("disable")){
  try{process.kill(Number(readFileSync(process.env.SERVICE_PID!,"utf8")),"SIGINT")}catch{}
}
if(args.includes("enable")||args.includes("start")){
  if(existsSync(process.env.SERVICE_PID!)){try{process.kill(Number(readFileSync(process.env.SERVICE_PID!,"utf8")),0);process.exit(0)}catch{}}
  const unit=readFileSync(process.env.XDG_CONFIG_HOME+"/systemd/user/omarchy-bot.service","utf8");
  const env={...process.env};
  for(const line of unit.split("\\n")){
    if(line.startsWith("Environment=")){
      const value=line.slice(12), index=value.indexOf("=");
      env[value.slice(0,index)]=value.slice(index+1);
    }
  }
  const executable=unit.split("\\n").find(line=>line.startsWith("ExecStart="))!.slice(10);
  // A user manager starts the unit outside the requesting plugin's session.
  const child=Bun.spawn(["setsid",executable],{env,stdin:"ignore",stdout:"ignore",stderr:"ignore"});
  writeFileSync(process.env.SERVICE_PID!,String(child.pid));
  child.unref();
}
`);
  shim(bin, "systemctl", `exec '${process.execPath}' '${control}' "$@"`);
  cleanups.push(async () => {
    if (!existsSync(env.SERVICE_PID!)) return;
    const pid = Number(readFileSync(env.SERVICE_PID!, "utf8"));
    try { process.kill(pid, "SIGINT"); } catch {}
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if (!existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ")) return;
      await Bun.sleep(10);
    }
    try { process.kill(-pid, "SIGKILL"); } catch {}
    throw new Error(`Service ${pid} did not stop`);
  });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  env.OMARCHY_BOT_PORT = String(reservation.port);
  reservation.stop(true);
  // The existing scripted worker and fake Screen adapter run real Turns without a model or graphical session.
  const daemon = `import {main} from ${JSON.stringify(path.join(projectRoot, "apps/daemon/src/bootstrap/main.ts"))};
import {FakeBotScreenRuntimeAdapter} from ${JSON.stringify(path.join(projectRoot, "apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts"))};
const daemon=await main({useHostApplicationUnits:false,botScreenAdapter:new FakeBotScreenRuntimeAdapter(),botScreenRuntimeDir:process.env.HOME+"/r"});
process.removeAllListeners("SIGINT");
process.once("SIGINT",async()=>{await daemon.stop();process.exit(0)});
`;
  const files: Record<string, string> = {
    "scripts/serve.sh": readFileSync(path.join(projectRoot, "scripts/serve.sh"), "utf8"),
    "apps/daemon/src/bootstrap/main.ts": daemon,
  };
  for (const name of ["main", "layout", "archive", "lifecycle"]) files[`apps/cli/src/${name}.ts`] = readFileSync(path.join(projectRoot, `apps/cli/src/${name}.ts`), "utf8");
  for (const name of ["swayRuntimeSupply", "botComputerAssets"]) files[`apps/daemon/src/modules/computer/${name}.ts`] = readFileSync(path.join(projectRoot, `apps/daemon/src/modules/computer/${name}.ts`), "utf8");
  files["apps/daemon/src/bootstrap/listenerConfig.ts"] = readFileSync(path.join(projectRoot, "apps/daemon/src/bootstrap/listenerConfig.ts"), "utf8");
  writeFileSync(env.ARCHIVE!, Bun.zstdCompressSync(await new Bun.Archive(files).bytes()));
  writeFileSync(`${env.ARCHIVE}.sha256`, `${createHash("sha256").update(readFileSync(env.ARCHIVE!)).digest("hex")}  runtime.tar.zst\n`);
  shim(bin, "curl", 'while [[ $1 != -o ]]; do shift; done\ndest=$2; url=$3\nif [[ $url == *.sha256 ]]; then cp "$ARCHIVE.sha256" "$dest"; else cp "$ARCHIVE" "$dest"; fi');

  const baseUrl = `http://127.0.0.1:${env.OMARCHY_BOT_PORT}`;
  const pluginReady = path.join(root, "plugin-ready");
  const pluginOutput = path.join(root, "plugin-output");
  const pluginError = path.join(root, "plugin-error");
  const plugin = Bun.spawn(["setsid", "bash", "-c", 'bash "$1" enable > "$2" 2> "$3" || exit $?; printf ready > "$4"; exec sleep 300', "quickshell", path.join(source, "entry.sh"), pluginOutput, pluginError, pluginReady], {
    env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  cleanups.push(async () => { try { process.kill(-plugin.pid, "SIGKILL"); } catch {} await plugin.exited; });
  await waitForFile(pluginReady);
  expect(readFileSync(pluginError, "utf8")).toBe("");
  expect(readFileSync(pluginOutput, "utf8")).toContain("pairing:");
  expect(readFileSync(env.CALLS!, "utf8").trim().split("\n")).toEqual([
    "--user daemon-reload", "--user enable --now omarchy-bot.service",
  ]);
  const servicePid = Number(readFileSync(env.SERVICE_PID!, "utf8"));
  expect(relationship(plugin.pid)).toMatchObject({ group: plugin.pid, session: plugin.pid });
  const service = relationship(servicePid);
  expect(service.parent).not.toBe(plugin.pid);
  expect(service.group).not.toBe(plugin.pid);
  expect(service.session).not.toBe(plugin.pid);
  const token = await pairForToken(baseUrl, env.OMARCHY_BOT_STATE!);
  async function api<T>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  // The worker probe and Turn events arrive from real subprocesses, outside fake JS time.
  async function until(condition: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await condition()) return;
      await Bun.sleep(20);
    }
    throw new Error("scripted Turn condition did not arrive");
  }
  await until(async () => (await api<Array<{ id: string; status: string }>>("/api/agents")).some(agent => agent.id === "pi" && agent.status === "ready"));
  const bot = await api<{ id: string }>("/api/bots", { name: "Surviving Turn", agentId: "pi" });
  const sent = await api<{ threadId: string; turnId: string }>(`/api/bots/${bot.id}/messages`, { text: "steer-echo" });
  const threadRoute = `/api/threads/${sent.threadId}`;
  await until(async () => (await api<{ activeTurn?: { id: string; status: string } }>(threadRoute)).activeTurn?.status === "working");

  if (teardown === "SIGKILL") {
    process.kill(-plugin.pid, "SIGKILL");
    await plugin.exited;
    expect(plugin.signalCode).toBe("SIGKILL");
  } else {
    // Simulate QML onDestruction's detached installed entry, followed by the next Shell.
    const settling = Bun.spawn(["setsid", "bash", path.join(env.OMARCHY_BOT_HOME!, "runtime/plugin-entry.sh"), "settle", source, shellConfig, "io.github.xmethues.omarchy-bot"], { env, stdout: "pipe", stderr: "pipe" });
    cleanups.push(async () => { try { process.kill(-settling.pid, "SIGKILL"); } catch {} await settling.exited; });
    process.kill(-plugin.pid, "SIGTERM");
    await plugin.exited;
    // The bash watcher and daemon run outside JS timers; observe the gap before re-enable.
    await Bun.sleep(1_200);
    expect(readFileSync(env.CALLS!, "utf8")).not.toContain("--user stop ");
    expect(relationship(servicePid)).toEqual(service);
    expect((await api<{ activeTurn?: { id: string; status: string } }>(threadRoute)).activeTurn).toMatchObject({ id: sent.turnId, status: "working" });
    writeFileSync(shellConfig, enabledConfig);
    const enabling = Bun.spawn(["bash", path.join(source, "entry.sh"), "enable"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await enabling.exited).toBe(0);
    expect(await new Response(enabling.stderr).text()).toBe("");
    expect(await settling.exited).toBe(0);
    expect(await new Response(settling.stderr).text()).toBe("");
    expect(Number(readFileSync(env.SERVICE_PID!, "utf8"))).toBe(servicePid);
  }
  expect(() => process.kill(plugin.pid, 0)).toThrow();
  expect(() => process.kill(servicePid, 0)).not.toThrow();
  expect(relationship(servicePid)).toEqual(service);
  expect((await api<{ activeTurn?: { id: string; status: string } }>(threadRoute)).activeTurn).toMatchObject({ id: sent.turnId, status: "working" });
  await api(`${threadRoute}/messages`, { text: "finish after plugin teardown" });
  await until(async () => (await api<{ activeTurn?: unknown }>(threadRoute)).activeTurn === undefined);
  expect((await api<{ latestTurn: { id: string; status: string } }>(threadRoute)).latestTurn).toMatchObject({ id: sent.turnId, status: "completed" });
  const messages = await api<Array<{ text?: string }>>(`${threadRoute}/messages`);
  expect(messages.some(message => message.text?.includes("finish after plugin teardown"))).toBe(true);
  expect(readFileSync(env.CALLS!, "utf8")).not.toMatch(/--user (?:stop|disable) /);
  const health = await fetch(`${baseUrl}/api/health`);
  expect(health.status).toBe(200);
}, 20_000);
