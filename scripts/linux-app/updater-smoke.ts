import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// Exercise the shipped shell in real WebKit, including the native signature verifier.
const run = process.env.OMARCHY_BOT_SMOKE_DIR;
const app = process.env.OMARCHY_BOT_SMOKE_APP;
assert.ok(run && app, "Run through scripts/linux-app/updater-smoke.sh");
const evidence = path.resolve(".lane/linux-app/evidence");
mkdirSync(evidence, { recursive: true });
const checks: string[] = [];
let session = "";
const candidate = path.resolve(process.env.OMARCHY_BOT_UPDATE_ARTIFACT ?? ".lane/dist/omarchy-bot_0.1.1_amd64.AppImage");
assert.ok(existsSync(candidate), `Missing signed candidate: ${candidate}`);
const signature = readFileSync(`${candidate}.sig`, "utf8").trim();
let version = "0.1.1";
let tampered = false;
const genuine = await Bun.file(candidate).arrayBuffer();
const damaged = new Uint8Array(genuine.slice(0));
damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
const server = Bun.serve({ hostname: "127.0.0.1", port: 7436, fetch(request) {
  if (new URL(request.url).pathname === "/update.AppImage") return new Response(tampered ? damaged : genuine);
  return Response.json({ version, platforms: { "linux-x86_64": { url: "http://127.0.0.1:7436/update.AppImage", signature } } });
} });
async function wd(method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:4444${route}`, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000),
  });
  const result = z.object({ value: z.unknown() }).parse(await response.json());
  assert.ok(response.ok, JSON.stringify(result));
  return result.value;
}
async function shell(method: string): Promise<unknown> {
  return wd("POST", `/session/${session}/execute/async`, { script: `const done=arguments[arguments.length-1]; window.__OMARCHY_BOT_SHELL__.updates[arguments[0]]().then(value=>done({ok:true,value:value===undefined?null:value}),error=>done({ok:false,error:String(error)}))`, args: [method] });
}
async function until<T>(label: string, action: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result !== undefined) return result;
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}`);
}
function pids(): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      return path.basename(readlinkSync(`/proc/${name}/exe`)) === "omarchy-bot"
        && readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`OMARCHY_BOT_SMOKE_DIR=${run}`) ? [Number(name)] : [];
    } catch { return []; }
  });
}
async function open(): Promise<void> {
  const opened = z.object({ sessionId: z.string() }).parse(await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } }));
  session = opened.sessionId;
  await wd("POST", `/session/${session}/timeouts`, { script: 120_000 });
}
const installed = path.join(run, "installed.AppImage");
const hash = async (file: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex");
const credential = JSON.stringify({ baseUrl: "http://127.0.0.1:7431", token: "updater-private-test-device-token" });
const store = Bun.spawn(["secret-tool", "store", "--label=Updater smoke", "service", "com.omarchy.bot", "username", "service-connection"], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
store.stdin.write(credential);
store.stdin.end();
assert.equal(await store.exited, 0);
const readCredential = () => Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot", "username", "service-connection"]).stdout.toString().trim();
try {
  await until("native driver ready", async () => (await fetch("http://127.0.0.1:4444/status")).ok ? true : undefined);
  await open();
  assert.deepEqual(await shell("check"), { ok: true, value: { available: true, version: "0.1.1" } });
  checks.push("packaged app detects newer independently versioned app release");
  version = "0.1.0";
  assert.deepEqual(await shell("check"), { ok: true, value: { available: false } });
  version = "0.0.9";
  assert.deepEqual(await shell("check"), { ok: true, value: { available: false } });
  checks.push("same and older versions are unavailable");
  version = "0.1.1";
  tampered = true;
  await shell("check");
  const original = await hash(installed);
  const refused = z.object({ ok: z.literal(false), error: z.string() }).parse(await shell("download"));
  assert.match(refused.error, /signature|verify|verification/i);
  assert.equal(await hash(installed), original);
  assert.equal(readCredential(), credential);
  assert.deepEqual(await shell("check"), { ok: true, value: { available: true, version: "0.1.1" } });
  checks.push("tampered update refused; installed app and pairing unchanged; shell remains usable");
  tampered = false;
  version = "0.1.2";
  const relabeled = z.object({ ok: z.literal(false), error: z.string() }).parse(await shell("download"));
  assert.match(relabeled.error, /version/i);
  assert.equal(await hash(installed), original);
  checks.push("authentic artifact relabeled as a different version is refused");
  version = "0.1.1";
  assert.deepEqual(await shell("download"), { ok: true, value: null });
  assert.equal(await hash(installed), await hash(candidate));
  checks.push("authentic newer artifact downloads, verifies, and replaces installed AppImage");
  const before = pids();
  assert.equal(before.length, 1);
  const previousExecutable = await hash(`/proc/${before[0]}/exe`);
  await shell("restart").catch(() => {}); // Native exit can close IPC before its response arrives.
  const after = await until("restart into new native process", async () => {
    const current = pids();
    return current.length === 1 && current.every(pid => !before.includes(pid)) ? current : undefined;
  });
  assert.notEqual(await hash(`/proc/${after[0]}/exe`), previousExecutable, "restart runs the replacement executable");
  assert.equal(readCredential(), credential);
  // WebKitWebDriver owns the original process; relaunch the installed artifact to reattach.
  await wd("DELETE", `/session/${session}`).catch(() => {});
  session = "";
  for (const pid of after) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await until("restarted app exits before reattachment", async () => pids().length === 0 ? true : undefined);
  await open();
  assert.deepEqual(await shell("check"), { ok: true, value: { available: false } });
  assert.equal(readCredential(), credential);
  checks.push("restart launches new process; installed version is current and OS keychain pairing survives");
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  for (const pid of pids()) { try { process.kill(pid, "SIGTERM"); } catch {} }
  server.stop(true);
  writeFileSync(path.join(evidence, "updater-results.json"), JSON.stringify({ candidate: path.basename(candidate), checks }, null, 2));
  for (const check of checks) console.log(`PASS ${check}`);
}
