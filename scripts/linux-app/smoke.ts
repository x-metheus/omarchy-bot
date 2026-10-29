import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Database } from "bun:sqlite";

// The spec's WebView seam: drive the packaged application, never a browser harness.
const artifact = path.resolve(process.argv[2] ?? ".lane/dist/omarchy-bot_0.1.0_amd64.AppImage");
assert.ok(existsSync(artifact), `Packaged Linux app is missing: ${artifact}`);
const app = process.env.OMARCHY_BOT_SMOKE_APP;
const run = process.env.OMARCHY_BOT_SMOKE_DIR;
assert.ok(app && run, "Run through scripts/smoke-linux-app.sh for the private WebKit/keyring session");
const driver = "http://127.0.0.1:4444";
const origin = "http://127.0.0.1:7431";
const tlsOrigin = "https://127.0.0.1:7432";
const artifactSha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(artifact).arrayBuffer()).digest("hex");
const evidence = path.resolve(".lane/linux-app/evidence");
const checks: string[] = [];
let session = "";
const children: Bun.Subprocess[] = [];
const services = new Map<number, Bun.Subprocess>();
const webElement = z.object({ "element-6066-11e4-a52e-4f735466cecf": z.string() });

async function until<T>(label: string, action: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let error: unknown;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value !== undefined && value !== false && value !== null) return value; }
    catch (caught) { error = caught; }
    await Bun.sleep(150);
  }
  throw new Error(`Timed out: ${label}${error ? `: ${String(error)}` : ""}`);
}
function pass(label: string): void { checks.push(label); console.log(`PASS ${label}`); }
async function wd(method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${driver}${route}`, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000),
  });
  const result = z.object({ value: z.unknown() }).parse(await response.json());
  const failure = z.object({ error: z.string() }).safeParse(result.value);
  assert.ok(response.ok && !failure.success, `WebDriver ${method} ${route}: ${JSON.stringify(result)}`);
  return result.value;
}
async function script(source: string, args: unknown[] = []): Promise<unknown> {
  return wd("POST", `/session/${session}/execute/sync`, { script: source, args });
}
async function asyncScript(source: string, args: unknown[] = []): Promise<unknown> {
  return wd("POST", `/session/${session}/execute/async`, { script: source, args });
}
async function text(): Promise<string> { return z.string().parse(await script("return document.body.innerText")); }
async function visible(label: string): Promise<void> { await until(label, async () => (await text()).includes(label) || undefined); }
async function element(selector: string): Promise<string> {
  return until(selector, async () => {
    const found = webElement.parse(await wd("POST", `/session/${session}/element`, { using: "css selector", value: selector }));
    return found["element-6066-11e4-a52e-4f735466cecf"];
  });
}
async function button(label: string): Promise<void> {
  const found = webElement.parse(await script("return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()===arguments[0] || e.getAttribute('aria-label')===arguments[0])", [label]));
  assert.ok(found, `Missing button: ${label}`);
  await wd("POST", `/session/${session}/element/${found["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
}
async function keys(selector: string, value: string): Promise<void> {
  await wd("POST", `/session/${session}/element/${await element(selector)}/value`, { text: value });
}
async function input(label: string, value: string): Promise<void> {
  const id = z.string().parse(await script("const l=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(arguments[0])); return l?.htmlFor", [label]));
  assert.ok(id, `Missing input label ${label}`);
  const selector = `#${id.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`)}`;
  await wd("POST", `/session/${session}/element/${await element(selector)}/clear`, {});
  await keys(selector, value);
}
async function start(args: string[] = [], application = app): Promise<void> {
  const opened = z.object({ sessionId: z.string() }).parse(await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application, args } } } }));
  session = opened.sessionId;
  await wd("POST", `/session/${session}/timeouts`, { script: 15_000, implicit: 0 });
  await wd("POST", `/session/${session}/window/rect`, { width: 1380, height: 940 });
}
function appPids(): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const executable = readlinkSync(`/proc/${name}/exe`);
      const environment = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      const packagedApp = path.basename(executable) === "omarchy-bot" || executable === "/artifact/omarchy-bot.AppImage";
      return packagedApp && environment.includes(`OMARCHY_BOT_SMOKE_DIR=${run}`) ? [Number(name)] : [];
    }
    catch { return []; }
  });
}
function sidecarPids(): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      return path.basename(readlinkSync(`/proc/${name}/exe`)) === "omarchy-bot-sidecar"
        && readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`OMARCHY_BOT_SMOKE_DIR=${run}`) ? [Number(name)] : [];
    } catch { return []; }
  });
}
async function stop(): Promise<void> {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  session = "";
  await until("packaged app exits", async () => {
    const remaining = appPids();
    for (const pid of remaining) { try { process.kill(pid, "SIGTERM"); } catch {} }
    return remaining.length === 0 || undefined;
  });
}
async function restart(): Promise<void> { await stop(); await start(); }
async function bootService(port: number, tls: false | "trusted" | "untrusted" = false, host = "127.0.0.1", machineIdFile = process.env.OMARCHY_BOT_MACHINE_ID_FILE): Promise<string> {
  const dir = path.join(run!, `service-${port}`);
  mkdirSync(path.join(dir, "data/conformance"), { recursive: true });
  mkdirSync(path.join(dir, "state"), { recursive: true });
  writeFileSync(path.join(dir, "data/conformance/pi-fake-pi-1.json"), JSON.stringify({ ok: true }));
  const log = Bun.file(path.join(evidence, `service-${port}${port === 7435 ? `-${tls}` : ""}.log`));
  const command = services.has(port)
    ? ["bun", "--eval", `import {main} from './apps/daemon/src/bootstrap/main.ts'; await main({useHostApplicationUnits:false,botScreenRuntimeDir:${JSON.stringify(path.join(dir, "data/r"))}});`]
    : ["bun", "tests/e2e/daemon-boot.ts"];
  const child = Bun.spawn(command, {
    env: { ...process.env, OMARCHY_BOT_HOME: path.join(dir, "data"), OMARCHY_BOT_STATE: path.join(dir, "state"),
      OMARCHY_BOT_PORT: String(port), OMARCHY_BOT_HOST: host, OMARCHY_BOT_DEV: "0",
      OMARCHY_BOT_MACHINE_ID_FILE: machineIdFile,
      OMARCHY_BOT_SCREEN_PROFILE: "720p",
      OMARCHY_BOT_WORKERS_DIR: path.resolve("tests/integration/fake-workers"),
      ...(tls ? { OMARCHY_BOT_TLS_CERT: tls === "trusted" ? path.join(process.env.OMARCHY_BOT_SMOKE_TRUST!, "cert.pem") : path.join(run!, "tls.pem"),
        OMARCHY_BOT_TLS_KEY: tls === "trusted" ? path.join(process.env.OMARCHY_BOT_SMOKE_TRUST!, "key.pem") : path.join(run!, "tls.key") } : {}),
    }, stdout: log, stderr: Bun.file(path.join(evidence, `service-${port}${port === 7435 ? `-${tls}` : ""}-stderr.log`)),
  });
  children.push(child);
  services.set(port, child);
  await until(`Service ${port} ready`, async () => {
    const response = await fetch(`${tls ? "https" : "http"}://127.0.0.1:${port}/api/health`, { tls: { rejectUnauthorized: !tls } });
    return response.ok || undefined;
  });
  return path.join(dir, "state");
}
async function issue(state: string, serviceOrigin = origin): Promise<{ code: string; url: string }> {
  const response = await fetch(`${serviceOrigin}/api/pairing/codes`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${readFileSync(path.join(state, "pairing-host-secret"), "utf8").trim()}` },
    body: JSON.stringify({ name: "WebKit smoke" }),
    tls: { rejectUnauthorized: false }, // Fixture-only: issue codes after the certificate is deliberately replaced.
  });
  assert.ok(response.ok, `issue pairing code: ${response.status}`);
  return z.object({ code: z.string(), url: z.string() }).parse(await response.json());
}
async function color(expected: number[]): Promise<boolean> {
  return z.boolean().parse(await script(`const c=document.querySelector('[data-testid="computer-expanded-view"] canvas');
    if(!c||!c.width||!c.height)return false;
    const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let count=0;
    for(let i=0;i<p.length;i+=4)if(Math.abs(p[i]-arguments[0][0])<4&&Math.abs(p[i+1]-arguments[0][1])<4&&Math.abs(p[i+2]-arguments[0][2])<4) count++;
    return count>10000`, [expected]));
}
async function send(message: string): Promise<void> {
  await keys('[aria-label="Message input"][contenteditable="true"], [aria-label="Message input"] [contenteditable="true"], textarea[aria-label="Message input"]', `${message}\uE007`);
}

mkdirSync(evidence, { recursive: true });
rmSync(path.join(evidence, "lifecycle-failure.json"), { force: true });
try {
  await until("tauri-driver ready", async () => (await fetch(`${driver}/status`)).ok || undefined);
  const state = await bootService(7431);
  await bootService(7432, "untrusted");
  await start();
  await visible("Add Service");
  pass("packaged AppImage first run shows Add Service");
  const webOrigin = await script("return location.origin");
  assert.equal(webOrigin, "tauri://localhost");
  const allowed = await asyncScript(`const done=arguments[arguments.length-1]; fetch(arguments[0]+'/api/health').then(r=>done(r.ok)).catch(e=>done(String(e)))`, [origin]);
  assert.equal(allowed, true, "real WebKit custom-origin CORS health request");
  pass(`actual WebKit origin ${webOrigin} passes fixed Service CORS allowlist`);

  await input("Service address", tlsOrigin);
  await input("Pairing code", "tls-smoke-code");
  await button("Pair");
  await until("TLS-specific certificate error", async () => /TLS.*certificate|certificate.*trust/i.test(await text()) || undefined);
  pass("untrusted HTTPS certificate produces visible TLS-specific error");

  await stop();
  const first = await issue(state);
  await start([first.url]);
  // Pairing deliberately restarts to install the narrow, stored-origin CSP.
  await until("deep-link pairing persisted in Secret Service", async () => {
    const query = Bun.spawnSync(["secret-tool", "search", "--all", "service", "com.omarchy.bot"]);
    return query.exitCode === 0 && query.stdout.byteLength > 0 || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  pass("startup deep link exchanges real pairing code and keychain survives process restart");
  assert.deepEqual(sidecarPids(), [], "same host identity over loopback must not start a Local Sidecar");
  pass("same host identity over loopback suppresses the bundled Sidecar");
  const stored = z.record(z.string(), z.string()).parse(await script("return Object.fromEntries(Object.entries(localStorage))"));
  const credential = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
  assert.equal(credential.exitCode, 0, "native connection exists in OS Secret Service");
  const connection = z.object({ token: z.string() }).parse(JSON.parse(credential.stdout.toString()));
  assert.ok(!Object.values(stored).some(value => value.includes(connection.token)), "no localStorage entry contains device token");
  assert.equal(stored["omarchy-bot.device-token"], undefined);
  pass("device token is absent from WebView localStorage");

  await stop();
  await start([], `${app}-no-keyring`);
  await visible("Could not access the OS keychain");
  await visible("credentials were not discarded");
  await stop();
  const preserved = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
  assert.equal(preserved.exitCode, 0);
  assert.equal(z.object({ token: z.string() }).parse(JSON.parse(preserved.stdout.toString())).token, connection.token, "unavailable keychain did not delete or replace credential");
  await start();
  await element('button[aria-label="New bot"]');
  pass("unavailable OS keychain shows actionable error and original connection survives recovery");

  const csp = z.object({ result: z.array(z.boolean()), blocked: z.array(z.object({ uri: z.string(), directive: z.string() })) }).parse(await asyncScript(`const done=arguments[arguments.length-1];const blocked=[];
    document.addEventListener('securitypolicyviolation', e=>blocked.push({uri:e.blockedURI,directive:e.effectiveDirective}),{once:false});
    Promise.all(arguments[0].map(url=>fetch(url).then(r=>r.ok,()=>false))).then(result=>setTimeout(()=>done({result,blocked}),100));`,
    [[`${origin}/api/health`, "http://127.0.0.1:7433/api/health", "https://example.invalid/api/health"]]));
  assert.deepEqual(csp.result, [true, false, false]);
  assert.ok(csp.blocked.some(entry => entry.uri.startsWith("http://127.0.0.1:7433") && entry.directive === "connect-src"));
  assert.ok(csp.blocked.some(entry => entry.uri.startsWith("https://example.invalid") && entry.directive === "connect-src"));
  pass("paired CSP permits Service and blocks foreign loopback and remote origins");

  const runningPids = appPids();
  const runningHandles = z.array(z.string()).parse(await wd("GET", `/session/${session}/window/handles`));
  assert.equal(runningHandles.length, 1);
  const intake = Bun.spawn([app!, `omarchy-bot://pair?service=${encodeURIComponent(origin)}&code=expired-smoke-code`], { stdout: "ignore", stderr: "inherit" });
  assert.equal(await intake.exited, 0);
  await visible("This pairing code is invalid or has expired");
  assert.deepEqual(appPids(), runningPids, "forwarded link changes current document without replacing native process");
  assert.deepEqual(z.array(z.string()).parse(await wd("GET", `/session/${session}/window/handles`)), runningHandles);
  pass("second AppImage forwards deep link into the existing document and single window");

  const hostHeaders = { authorization: `Bearer ${readFileSync(path.join(state, "pairing-host-secret"), "utf8").trim()}` };
  const pairedDevices = z.object({ devices: z.array(z.unknown()) });
  const before = pairedDevices.parse(await (await fetch(`${origin}/api/devices/paired`, { headers: hostHeaders })).json()).devices.length;
  const second = await issue(state);
  const forwarded = Bun.spawn([app!, second.url], { stdout: "ignore", stderr: "inherit" });
  assert.equal(await forwarded.exited, 0);
  await until("forwarded deep link registers another Paired Device", async () => {
    const response = await fetch(`${origin}/api/devices/paired`, { headers: hostHeaders });
    return pairedDevices.parse(await response.json()).devices.length === before + 1 || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  assert.equal(z.array(z.string()).parse(await wd("GET", `/session/${session}/window/handles`)).length, 1);
  const currentPids = appPids();
  for (const invalid of [
    "https://example.invalid/pair?service=http://127.0.0.1:7431&code=bad",
    "omarchy-bot://pair?service=http://127.0.0.1:7431&service=https://example.invalid&code=bad",
    "omarchy-bot://pair?service=http://example.invalid&code=bad",
  ]) {
    const child = Bun.spawn([app!, invalid], { stdout: "ignore", stderr: "inherit" });
    assert.equal(await child.exited, 0);
    assert.deepEqual(appPids(), currentPids, "invalid link leaves existing native process alone");
    await element('button[aria-label="New bot"]');
  }
  pass("invalid running deep links preserve the connection and existing window");

  const otherOrigin = "http://127.0.0.1:7434";
  const otherState = await bootService(7434);
  const other = await issue(otherState, otherOrigin);
  const switching = Bun.spawn([app!, other.url], { stdout: "ignore", stderr: "inherit" });
  assert.equal(await switching.exited, 0);
  await until("cross-origin link safely replaces keychain connection", async () => {
    const read = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
    if (read.exitCode !== 0) return undefined;
    return z.object({ baseUrl: z.string() }).parse(JSON.parse(read.stdout.toString())).baseUrl === otherOrigin || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  const switched = await asyncScript(`const done=arguments[arguments.length-1]; const violations=[];
    document.addEventListener('securitypolicyviolation',e=>violations.push(e.blockedURI));
    Promise.all(arguments[0].map(url=>fetch(url+'/api/health').then(r=>r.ok,()=>false))).then(result=>setTimeout(()=>done({result,violations}),100));`, [[otherOrigin, origin]]);
  const newPolicy = z.object({ result: z.array(z.boolean()), violations: z.array(z.string()) }).parse(switched);
  assert.deepEqual(newPolicy.result, [true, false]);
  assert.ok(newPolicy.violations.some(uri => uri.startsWith(origin)));
  pass("cross-origin deep link restarts with new paired-only CSP and keychain connection");

  await button("New bot");
  await input("Name", "WebKit Bot");
  await input("Job / Instructions", "Exercise the real WebKit event stream and Bot Screen");
  const radio = await element('input[type="radio"][value="pi"]');
  await wd("POST", `/session/${session}/element/${radio}/click`, {});
  await button("Create bot");
  await visible("WebKit Bot");
  await send("say: WEBKIT-EVENT-STREAM-OK");
  await until("Bot reply delivered by real event stream", async () => script("return [...document.querySelectorAll('[data-testid=assistant-message]')].some(e=>e.textContent.includes('WEBKIT-EVENT-STREAM-OK'))"));
  pass("real Service event stream delivers Bot reply inside packaged WebKit");

  const browserUrl = "https://example.com/omarchy-webkit-browser-proof";
  await send(`say: [Open browser proof](${browserUrl})`);
  const external = await element(`a[href="${browserUrl}"]`);
  await wd("POST", `/session/${session}/element/${external}/click`, {});
  await until("external anchor reaches authorized system browser", async () => existsSync(path.join(run!, "opened-urls")) && readFileSync(path.join(run!, "opened-urls"), "utf8").split("\n").includes(browserUrl) || undefined, 5_000);
  assert.equal(await script("return location.origin"), "tauri://localhost");
  pass("real Markdown external anchor click launches the system browser without replacing the app");
  await until("browser reply turn finishes before attachment send", async () => script("return !document.querySelector('[data-testid=working-avatar]')"));

  const attachmentName = "webkit-managed-proof.txt";
  const attachmentContent = "Managed attachment delivered through authenticated WebKit fetch.\n";
  await script(`const editor=document.querySelector('[aria-label="Message input"][contenteditable="true"], [aria-label="Message input"] [contenteditable="true"], textarea[aria-label="Message input"]');
    const transfer=new DataTransfer();transfer.items.add(new File([arguments[1]],arguments[0],{type:'text/plain'}));
    editor.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    editor.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));`, [attachmentName, attachmentContent]);
  await element('[data-testid="staged-attachment"]');
  await send("attachment-echo");
  const attachment = await element(`a[href*="/api/attachments/"]`);
  const attachmentUrl = z.string().parse(await wd("GET", `/session/${session}/element/${attachment}/attribute/href`));
  const unauthenticated = new URL(attachmentUrl);
  unauthenticated.searchParams.delete("access_token");
  assert.equal((await fetch(unauthenticated)).status, 401, "attachment content requires device authentication");
  const attachmentRow = await element('[data-testid="message-file-attachment"]');
  await wd("POST", `/session/${session}/element/${attachmentRow}/click`, {});
  const downloaded = path.join(process.env.HOME!, "Downloads", attachmentName);
  await until("managed text attachment saved with actual authenticated contents", async () => existsSync(downloaded) && readFileSync(downloaded, "utf8") === attachmentContent || undefined, 10_000);
  const openedUrls = readFileSync(path.join(run!, "opened-urls"), "utf8").trim().split("\n");
  assert.deepEqual(openedUrls, [browserUrl], "attachment URL/token never leaves through system browser");
  writeFileSync(path.join(evidence, "opened-urls.txt"), `${openedUrls.join("\n")}\n`);
  writeFileSync(path.join(evidence, attachmentName), readFileSync(downloaded));
  assert.equal(await script("return location.origin"), "tauri://localhost");
  pass("managed text attachment click saves exact authenticated content without exposing token to the browser");
  await send(`computer:open_app:${process.env.OMARCHY_BOT_X11_FIXTURE}`);
  await until("fixture launch reply delivered", async () => script("return [...document.querySelectorAll('[data-testid=assistant-message]')].some(e=>e.textContent.includes('launched '))"));
  await send('browser:request_takeover:{"reason":"WebKit input acceptance"}');
  await visible("WebKit input acceptance");
  await button("Open Computer Surface");
  await until("live Screen Projection preview", async () => script("const i=document.querySelector('[data-testid=computer-preview]');return i?.complete&&i.naturalWidth>0"), 60_000);
  await button("Continue takeover");
  await visible("Click, scroll, or type to control");
  await until("real magenta X11 fixture pixels", async () => await color([255, 0, 255]) || undefined);
  pass("Screen Projection paints real Sway/Xwayland fixture in noVNC canvas");
  const canvas = await element('[data-testid="computer-expanded-view"] canvas');
  await wd("POST", `/session/${session}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
    { type: "pointerMove", duration: 0, origin: { "element-6066-11e4-a52e-4f735466cecf": canvas }, x: 0, y: 0 },
    { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
  ] }] });
  await until("pointer changed actual Bot Screen to cyan", async () => await color([0, 255, 255]) || undefined);
  pass("Takeover pointer reaches Bot Screen (projected pixels turn cyan)");
  await wd("POST", `/session/${session}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "k" }, { type: "keyUp", value: "k" }] }] });
  await until("keyboard changed actual Bot Screen to yellow", async () => await color([255, 255, 0]) || undefined);
  pass("Takeover keyboard reaches Bot Screen (projected pixels turn yellow)");
  const capture = Bun.spawnSync(["python3", "scripts/linux-app/capture.py", path.join(evidence, "takeover.png")]);
  assert.equal(capture.exitCode, 0, "capture private packaged WebView evidence");
  await button("I'm done");

  const otherHeaders = { authorization: `Bearer ${readFileSync(path.join(otherState, "pairing-host-secret"), "utf8").trim()}` };
  const devices = z.object({ devices: z.array(z.object({ id: z.string(), revokedAt: z.string().nullable() })) }).parse(
    await (await fetch(`${otherOrigin}/api/devices/paired`, { headers: otherHeaders })).json(),
  );
  const active = devices.devices.filter(device => device.revokedAt === null);
  assert.equal(active.length, 1);
  const revoked = await fetch(`${otherOrigin}/api/devices/paired/${active[0]!.id}/revoke`, { method: "POST", headers: otherHeaders });
  assert.equal(revoked.status, 204);
  // The actual UI receives the socket close/401 and clears its native credential.
  await until("revocation deletes native Secret Service credential", async () => Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]).exitCode === 1 || undefined);
  await restart();
  await visible("Add Service");
  await visible("This device was revoked");
  const previousAddress = await script("const l=[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Service address'));return document.getElementById(l.htmlFor).value");
  assert.equal(previousAddress, otherOrigin);
  pass("real revocation clears OS credential and retains visible notice and Service address after restart");

  const trustedOrigin = "https://127.0.0.1:7435";
  const trustedState = await bootService(7435, "trusted");
  const trusted = await issue(trustedState, trustedOrigin);
  await stop();
  await start([trusted.url]);
  await until("trusted HTTPS pairing persists", async () => {
    const saved = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
    return saved.exitCode === 0 && z.object({ baseUrl: z.string() }).parse(JSON.parse(saved.stdout.toString())).baseUrl === trustedOrigin || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  await stop();
  const trustedService = services.get(7435)!;
  trustedService.kill("SIGINT");
  await trustedService.exited;
  await bootService(7435, "untrusted");
  await start();
  await visible("Service TLS certificate is not trusted");
  assert.equal(Bun.spawnSync(["python3", "scripts/linux-app/capture.py", path.join(evidence, "stored-tls-error.png")]).exitCode, 0, "capture visible stored-certificate error");
  const retained = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
  assert.equal(retained.exitCode, 0, "certificate failure preserves paired credential");
  assert.equal(z.object({ baseUrl: z.string() }).parse(JSON.parse(retained.stdout.toString())).baseUrl, trustedOrigin);
  pass("stored trusted HTTPS pairing shows TLS-specific error after Service certificate becomes untrusted");

  await stop();
  const recovery = await issue(otherState, otherOrigin);
  await start([recovery.url]);
  await until("recovery pairing persists", async () => {
    const saved = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
    return saved.exitCode === 0 && z.object({ baseUrl: z.string() }).parse(JSON.parse(saved.stdout.toString())).baseUrl === otherOrigin || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  const config = path.join(process.env.XDG_CONFIG_HOME!, "com.omarchy.bot");
  mkdirSync(config, { recursive: true });
  chmodSync(config, 0o500);
  try {
    assert.throws(() => writeFileSync(path.join(config, "revoked-service"), otherOrigin), "notice directory is actually unwritable");
    const remaining = z.object({ devices: z.array(z.object({ id: z.string(), revokedAt: z.string().nullable() })) }).parse(
      await (await fetch(`${otherOrigin}/api/devices/paired`, { headers: otherHeaders })).json(),
    ).devices.filter(device => device.revokedAt === null);
    assert.equal(remaining.length, 1);
    assert.equal((await fetch(`${otherOrigin}/api/devices/paired/${remaining[0]!.id}/revoke`, { method: "POST", headers: otherHeaders })).status, 204);
    await until("unwritable revocation notice cannot retain native secret", async () => Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]).exitCode === 1 || undefined);
    await restart();
    await visible("Add Service");
    assert.ok(!(await text()).includes("stored token could not be cleared"));
  } finally { chmodSync(config, 0o700); }
  const repaired = await issue(otherState, otherOrigin);
  await input("Service address", otherOrigin);
  await input("Pairing code", repaired.code);
  await button("Pair");
  await until("new pairing succeeds after notice failure", async () => Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]).exitCode === 0 || undefined);
  await restart();
  await element('button[aria-label="New bot"]');
  pass("revocation with unwritable notice still deletes secret and permits pairing recovery");

  const offhostOrigin = `https://${process.env.OMARCHY_BOT_SMOKE_OFFHOST_IP}:7436`;
  const offhostMachineId = path.join(run!, "offhost-machine-id");
  writeFileSync(offhostMachineId, "0123456789abcdef0123456789abcdef\n");
  const offhostState = await bootService(7436, "trusted", "0.0.0.0", offhostMachineId);
  const offhost = await issue(offhostState, "https://127.0.0.1:7436");
  await stop();
  await start([`omarchy-bot://pair?service=${encodeURIComponent(offhostOrigin)}&code=${encodeURIComponent(offhost.code)}`]);
  await until("offhost pairing persists", async () => {
    const saved = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
    return saved.exitCode === 0 && z.object({ baseUrl: z.string() }).parse(JSON.parse(saved.stdout.toString())).baseUrl === offhostOrigin || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  assert.deepEqual(sidecarPids(), [], "same host identity over LAN HTTPS must not start a Local Sidecar");
  pass("same host identity over LAN HTTPS suppresses the bundled Sidecar");
  writeFileSync(process.env.OMARCHY_BOT_MACHINE_ID_FILE!, "uninitialized\n");
  await restart();
  await visible("Local actions are unavailable");
  assert.deepEqual(sidecarPids(), [], "invalid native machine identity must fail closed");
  writeFileSync(process.env.OMARCHY_BOT_MACHINE_ID_FILE!, "0123456789abcdef0123456789abcdef\n");
  pass("invalid native machine identity suppresses the Sidecar with recovery instructions");
  rmSync(offhostMachineId);
  await restart();
  await visible("Local actions are unavailable");
  await visible("reopen Omarchy Bot to retry");
  assert.deepEqual(sidecarPids(), [], "unavailable host identity must fail closed");
  pass("unavailable host identity suppresses the Sidecar with recovery instructions");
  writeFileSync(offhostMachineId, "fedcba9876543210fedcba9876543210\n");
  const tunnelOrigin = "https://127.0.0.1:7436";
  const tunneled = await issue(offhostState, tunnelOrigin);
  await stop();
  await start([`omarchy-bot://pair?service=${encodeURIComponent(tunnelOrigin)}&code=${encodeURIComponent(tunneled.code)}`]);
  await until("loopback tunnel pairing persists", async () => {
    const saved = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
    return saved.exitCode === 0 && z.object({ baseUrl: z.string() }).parse(JSON.parse(saved.stdout.toString())).baseUrl === tunnelOrigin || undefined;
  });
  await restart();
  await element('button[aria-label="New bot"]');
  await until("distinct host over loopback starts one bundled Sidecar", async () => sidecarPids().length === 1 || undefined);
  pass("distinct host identity over loopback starts one bundled Sidecar");
  const saved = Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]);
  const remoteConnection = z.object({ token: z.string() }).parse(JSON.parse(saved.stdout.toString()));
  const remoteHeaders = { authorization: `Bearer ${remoteConnection.token}` };
  async function remote(route: string): Promise<unknown> {
    const response = await fetch(`${tunnelOrigin}${route}`, { headers: remoteHeaders });
    assert.ok(response.ok, `remote API ${route}: ${response.status}`);
    return response.json();
  }
  const roster = z.array(z.object({ id: z.string(), os: z.string(), shell: z.string() }));
  const registered = await until("Sidecar registration", async () => {
    const devices = roster.parse(await remote("/api/devices"));
    return devices.length === 1 ? devices[0] : undefined;
  });
  assert.match(registered.id, /^dev_[0-9a-f]{32}$/);
  assert.equal(registered.os, "linux");
  assert.equal(registered.shell, "posix-sh");
  const deviceStatus = await until("native Sidecar ready", async () => {
    const status = z.object({ running: z.boolean(), deviceId: z.string().optional() }).parse(await script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status()"));
    return status.running ? status : undefined;
  });
  assert.deepEqual(deviceStatus, { running: true, deviceId: registered.id });
  await button("New bot");
  await input("Name", "Sidecar smoke Bot");
  await input("Job / Instructions", "Exercise approved local commands");
  await wd("POST", `/session/${session}/element/${await element('input[type="radio"][value="pi"]')}/click`, {});
  await button("Create bot");
  await visible("Sidecar smoke Bot");
  await script(`const original=window.fetch;window.__sidecarSendIds=[];window.fetch=function(input,options){
    if(options?.method==='POST'&&String(input).endsWith('/messages'))window.__sidecarSendIds.push(JSON.parse(options.body).deviceId);
    return original(input,options);
  }`);
  const transcript = z.array(z.object({ id: z.string(), kind: z.string(), text: z.string().optional(), toolCall: z.object({ name: z.string(), status: z.string() }).optional() }));
  async function threadId(): Promise<string> {
    return until("selected Sidecar smoke Thread", async () => {
      const selection = z.object({ bot: z.string().nullable(), thread: z.string().nullable() }).parse(await script("const url=new URL(location.href);return {bot:url.searchParams.get('bot'),thread:url.searchParams.get('thread')}"));
      return selection.bot && selection.thread ? selection.thread : undefined;
    });
  }
  async function localTurn(command: string, decision?: string, succeeds = true): Promise<void> {
    const previousThread = await threadId();
    const previousTools = previousThread === "blank" ? 0 : transcript.parse(await remote(`/api/threads/${previousThread}/messages`)).filter(message => message.toolCall?.name === "local").length;
    await send(`local.run:${command}`);
    if (decision) {
      await element('[data-testid="local-approval"]');
      assert.equal(await script("return document.querySelector('[data-testid=local-approval-detail]').textContent"), command);
      if (command === "printf sidecar-smoke") {
        assert.equal(Bun.spawnSync(["python3", "scripts/linux-app/capture.py", path.join(evidence, "local-approval.png")]).exitCode, 0, "capture exact packaged approval");
      }
      await button(decision);
    }
    const messages = await until("local Tool Call reaches expected terminal status", async () => {
      const current = await threadId();
      if (current === "blank") return undefined;
      const messages = transcript.parse(await remote(`/api/threads/${current}/messages`));
      const tools = messages.filter(message => message.toolCall?.name === "local");
      return tools.length > previousTools && tools.at(-1)?.toolCall?.status === (succeeds ? "completed" : "error") ? messages : undefined;
    });
    assert.equal(messages.filter(message => message.toolCall?.name === "local").at(-1)?.toolCall?.status, succeeds ? "completed" : "error");
    await until("local turn idle", async () => script("return !document.querySelector('[data-testid=working-avatar]')"));
    if (!succeeds) {
      await visible("Turn failed");
      await button("Close");
    }
    assert.equal(await script("return !!document.querySelector('[data-testid=local-approval]')"), false);
  }
  await localTurn("printf sidecar-smoke", "Allow once");
  await until("approved command output in conversation", async () => script("return [...document.querySelectorAll('[data-testid=assistant-message]')].some(e=>e.textContent==='sidecar-smoke')"));
  assert.deepEqual(await script("return window.__sidecarSendIds"), [registered.id]);
  pass("approved local.run executes exact command and message dev_ tag matches registered Sidecar");
  await localTurn("printf sidecar-always", "Always allow");
  await localTurn("printf sidecar-never", "Never allow", false);
  await localTurn("printf sidecar-always");
  const localThread = await threadId();
  await restart();
  await visible("Sidecar smoke Bot");
  await until("same install re-registers", async () => roster.parse(await remote("/api/devices"))[0]?.id === registered.id || undefined);
  await until("native Sidecar ready after restart", async () => script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status().running"));
  assert.deepEqual(await script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status()"), { running: true, deviceId: registered.id });
  await localTurn("printf sidecar-always");
  await localTurn("printf sidecar-never", undefined, false);
  pass("Always/Never policies and cryptographic dev_ identity survive app restart");

  await send("local.run:printf pending-disconnect");
  await element('[data-testid="local-approval"]');
  for (const pid of sidecarPids()) process.kill(pid, "SIGTERM");
  await until("disconnected Sidecar dismisses required approval", async () => script("return !document.querySelector('[data-testid=local-approval]') && !window.__OMARCHY_BOT_SHELL__.localSidecar.status().running"));
  await until("disconnect fails pending local Tool Call", async () => transcript.parse(await remote(`/api/threads/${localThread}/messages`)).filter(message => message.toolCall?.name === "local").at(-1)?.toolCall?.status === "error" || undefined);
  await restart();
  assert.equal(await threadId(), localThread);
  await until("native Sidecar ready after disconnect restart", async () => script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status().running"));
  pass("Sidecar disconnect dismisses required approval and app accepts a new Ask after restart");

  await send("local.run:printf pending-quit");
  await element('[data-testid="local-approval"]');
  await stop();
  await until("quit terminates bundled child", async () => sidecarPids().length === 0 || undefined);
  await until("quit fails pending local Tool Call", async () => transcript.parse(await remote(`/api/threads/${localThread}/messages`)).filter(message => message.toolCall?.name === "local").at(-1)?.toolCall?.status === "error" || undefined);
  pass("quit terminates Sidecar and Service fails pending local job");
  await start();
  await visible("Sidecar smoke Bot");
  await until("Sidecar available after reopening", async () => sidecarPids().length === 1 && roster.parse(await remote("/api/devices")).length === 1 || undefined);
  assert.equal(await threadId(), localThread);
  await until("native Sidecar ready after reopening", async () => script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status().running"));
  await send("local.run:printf pending-unpair");
  await element('[data-testid="local-approval"]');
  await asyncScript("const done=arguments[arguments.length-1];window.__OMARCHY_BOT_SHELL__.service.clear().then(()=>done(true),e=>done(String(e)))").catch(() => {});
  await until("unpair removes credential and child", async () => sidecarPids().length === 0 && Bun.spawnSync(["secret-tool", "lookup", "service", "com.omarchy.bot"]).exitCode === 1 || undefined);
  await until("unpair fails pending local Tool Call", async () => transcript.parse(await remote(`/api/threads/${localThread}/messages`)).filter(message => message.toolCall?.name === "local").at(-1)?.toolCall?.status === "error" || undefined);
  await restart();
  await visible("Add Service");
  assert.deepEqual(sidecarPids(), []);
  pass("unpair terminates Sidecar, fails pending local job and restarts at Add Service");
} catch (error) {
  // Keep lifecycle facts before private session teardown; never copy the credential-bearing database.
  const lifecycle = [...services.keys()].map(port => {
    const database = path.join(run!, `service-${port}/data/db.sqlite`);
    if (!existsSync(database)) return { port, unavailable: "Service database was not created" };
    try {
      const db = new Database(database, { readonly: true });
      try {
        return { port,
          surfaces: db.query("SELECT surface_id, lifecycle_state, runtime_generation, last_failure, transitioned_at FROM bot_surfaces").all(),
          coordination: db.query("SELECT surface_id, authority_kind, updated_at FROM computer_surface_coordination").all(),
          transitions: db.query(`SELECT occurred_at, aggregate_id AS surface_id, json_extract(payload, '$.lifecycle') AS lifecycle
            FROM events WHERE aggregate_type = 'computer' AND type = 'computer.state.changed'
              AND json_extract(payload, '$.lifecycle') IN ('stopped', 'starting', 'ready', 'failed') ORDER BY cursor`).all(),
        };
      } finally { db.close(); }
    } catch { return { port, unavailable: "Service lifecycle could not be read" }; }
  });
  writeFileSync(path.join(evidence, "lifecycle-failure.json"), JSON.stringify(lifecycle, null, 2));
  const downloads = path.join(process.env.HOME!, "Downloads");
  console.error("Private Downloads on failure:", existsSync(downloads) ? readdirSync(downloads).map(name => ({ name, bytes: Bun.file(path.join(downloads, name)).size })) : "missing");
  if (session) {
    console.error("WebView on failure:", await text().catch(() => "unavailable"));
    const screenshot = await wd("GET", `/session/${session}/screenshot`).then(value => z.string().parse(value)).catch(() => undefined);
    if (screenshot) writeFileSync(path.join(evidence, "failure.png"), Buffer.from(screenshot, "base64"));
    else Bun.spawnSync(["python3", "scripts/linux-app/capture.py", path.join(evidence, "failure.png")]);
  }
  throw error;
} finally {
  try { await stop(); } finally {
    for (const child of children) child.kill("SIGINT");
    await Promise.all(children.map(child => child.exited));
  }
  writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ artifact: path.basename(artifact), sha256: artifactSha256, checks }, null, 2));
}
