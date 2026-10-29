import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Spec WebView seam: packaged WebView2, real Service/Sway, compiled Windows Sidecar.
assert.equal(process.platform, "win32", "Run the Windows smoke on Windows");
const app = process.env.OMARCHY_BOT_SMOKE_APP!;
const origin = process.env.WINDOWS_SMOKE_SERVICE_ORIGIN!;
const secret = process.env.WINDOWS_SMOKE_HOST_SECRET!;
const fixture = process.env.WINDOWS_SMOKE_X11_FIXTURE!;
assert.ok(app && secret && fixture, "Installed app, Linux host secret and X11 fixture path are required");
const service = new URL(origin);
assert.equal(service.protocol, "https:", "Use a publicly trusted HTTPS Service for off-host Sidecar coverage");
assert.ok(!["localhost", "127.0.0.1", "[::1]"].includes(service.hostname), "Off-host Service is required to start the Sidecar");
const evidence = path.resolve(".lane/windows-app/evidence");
mkdirSync(evidence, { recursive: true });
const driver = "http://127.0.0.1:4444";
const checks: string[] = [];
let session = "";
let ownsCredential = false;
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
async function until<T>(label: string, action: () => Promise<T>, timeout = 45_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let error: unknown;
  while (Date.now() < deadline) {
    try { const value = await action(); if (value !== undefined && value !== false && value !== null) return value!; }
    catch (caught) { error = caught; }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out: ${label}: ${String(error ?? "condition not met")}`);
}
async function wd(method: string, route: string, body?: unknown): Promise<any> {
  const response = await fetch(`${driver}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000) });
  const result = await response.json();
  assert.ok(response.ok && !result.value?.error, `WebDriver ${route}: ${JSON.stringify(result)}`);
  return result.value;
}
async function script(source: string, args: unknown[] = []): Promise<any> {
  return wd("POST", `/session/${session}/execute/sync`, { script: source, args });
}
async function native(action: string, value = ""): Promise<any> {
  const child = Bun.spawn(["pwsh", "-NoProfile", "-File", "scripts/windows-app/native.ps1", "-Action", action, "-Value", value], { stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `Native ${action}: ${error}`);
  return out.trim() ? JSON.parse(out) : undefined;
}
async function visible(label: string): Promise<void> {
  await until(label, async () => (await script("return document.body.innerText")).includes(label));
}
async function element(selector: string): Promise<string> {
  return until(selector, async () => (await wd("POST", `/session/${session}/element`, { using: "css selector", value: selector }))[elementKey]);
}
async function button(label: string): Promise<void> {
  const found = await script("return [...document.querySelectorAll('button')].find(e=>e.textContent.trim()===arguments[0]||e.getAttribute('aria-label')===arguments[0])", [label]);
  assert.ok(found, `Missing button ${label}`);
  await wd("POST", `/session/${session}/element/${found[elementKey]}/click`, {});
}
async function input(label: string, value: string): Promise<void> {
  const id = await script("return [...document.querySelectorAll('label')].find(e=>e.textContent.includes(arguments[0]))?.htmlFor", [label]);
  assert.ok(id, `Missing input ${label}`);
  const field = await element(`[id=${JSON.stringify(id)}]`);
  await wd("POST", `/session/${session}/element/${field}/clear`, {});
  await wd("POST", `/session/${session}/element/${field}/value`, { text: value });
}
async function start(): Promise<void> {
  session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } })).sessionId;
  await wd("POST", `/session/${session}/timeouts`, { script: 15_000, implicit: 0 });
  await wd("POST", `/session/${session}/window/rect`, { width: 1380, height: 940 });
}
async function stop(): Promise<void> {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  session = "";
  // Pairing restarts the app outside WebDriver: terminate only this installed binary.
  const ids: number[] = await native("processes", app);
  for (const id of ids) { try { process.kill(id, "SIGTERM"); } catch {} }
  await until("installed app exits", async () => (await native("processes", app)).length === 0);
}
async function issue(): Promise<string> {
  const response = await fetch(`${origin}/api/pairing/codes`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ name: "WebView2 smoke" }) });
  assert.ok(response.ok, `Pairing issuance failed: ${response.status}`);
  const result = await response.json();
  assert.equal(new URL(result.url).protocol, "omarchy-bot:");
  return `omarchy-bot://pair?service=${encodeURIComponent(service.origin)}&code=${encodeURIComponent(result.code)}`;
}
async function send(message: string): Promise<void> {
  const field = await element('[aria-label="Message input"][contenteditable="true"], [aria-label="Message input"] [contenteditable="true"], textarea[aria-label="Message input"]');
  await wd("POST", `/session/${session}/element/${field}/value`, { text: `${message}\uE007` });
}
async function color(rgb: number[]): Promise<any> {
  return script(`const c=document.querySelector('[data-testid="computer-expanded-view"] canvas');if(!c?.width||!c?.height)return false;
    const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;
    for(let i=0;i<p.length;i+=4)if(Math.abs(p[i]-arguments[0][0])<4&&Math.abs(p[i+1]-arguments[0][1])<4&&Math.abs(p[i+2]-arguments[0][2])<4)n++;return n>10000`, [rgb]);
}
try {
  await until("tauri-driver", async () => (await fetch(`${driver}/status`)).ok);
  assert.equal(await native("credential"), null, "Disposable Windows user must start without an existing app credential");
  ownsCredential = true;
  await start();
  await visible("Add Service");
  assert.equal(await script("return window.__OMARCHY_BOT_SHELL__.keyMapping.platform()"), "windows");
  assert.ok(["http://tauri.localhost", "https://tauri.localhost"].includes(await script("return location.origin")));
  const appOrigin = await script("return location.origin");
  await script("location.href='https://example.invalid/foreign-navigation'");
  assert.equal(await script("return location.origin"), appOrigin, "Native navigation guard refuses foreign documents");
  const untrusted = process.env.WINDOWS_SMOKE_UNTRUSTED_ORIGIN;
  assert.ok(untrusted, "An untrusted HTTPS fixture endpoint is required");
  await input("Service address", untrusted);
  await input("Pairing code", "certificate-smoke");
  await button("Pair");
  await until("visible TLS certificate error", async () => /TLS.*certificate|certificate.*trust/i.test(await script("return document.body.innerText")));
  checks.push("WebView2 origin/platform and visible untrusted-certificate error");
  await stop();
  await native("activate", await issue());
  const connection = await until("cold URL-scheme pairing reaches Credential Manager", async () => await native("credential"));
  assert.equal(connection.baseUrl, service.origin);
  assert.equal(typeof connection.token, "string");
  await stop();
  await start();
  await element('button[aria-label="New bot"]');
  const storage = await script("return Object.values(localStorage)");
  assert.ok(!storage.some((value: string) => value.includes(connection.token)), "Device token must not enter WebView storage");
  assert.equal((await native("credential")).token, connection.token);
  checks.push("NSIS cold deep link pairs; Credential Manager survives restart; token absent from localStorage");
  const pids = await native("processes", app);
  const handles = await wd("GET", `/session/${session}/window/handles`);
  assert.equal(handles.length, 1);
  await native("activate", `omarchy-bot://pair?service=${encodeURIComponent(origin)}&code=expired-smoke-code`);
  await visible("This pairing code is invalid or has expired");
  assert.deepEqual(await native("processes", app), pids);
  assert.deepEqual(await wd("GET", `/session/${session}/window/handles`), handles);
  checks.push("running URL-scheme activation forwards into unchanged process and single window");
  await native("activate", await issue());
  await until("forwarded link exchanges a new code", async () => {
    const current = await native("credential");
    return typeof current?.token === "string" && current.token !== connection.token;
  });
  await stop(); await start();
  await element('button[aria-label="New bot"]');
  const saved = await native("credential");
  const apiHeaders = { authorization: `Bearer ${saved.token}` };
  const roster = await until("compiled Windows Sidecar registers", async () => {
    const response = await fetch(`${origin}/api/devices`, { headers: apiHeaders });
    assert.ok(response.ok);
    const devices = await response.json();
    return devices.length === 1 ? devices[0] : undefined;
  });
  assert.match(roster.id, /^dev_[0-9a-f]{32}$/);
  assert.equal(roster.os, "windows"); assert.equal(roster.shell, "powershell-5.1");
  await until("native Sidecar ready", async () => await script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status().running"));
  assert.deepEqual(await script("return window.__OMARCHY_BOT_SHELL__.localSidecar.status()"), { running: true, deviceId: roster.id });
  await button("New bot");
  await input("Name", "WebView2 Bot");
  await input("Job / Instructions", "Exercise WebView2 event stream, projection and local execution");
  await wd("POST", `/session/${session}/element/${await element('input[type="radio"][value="pi"]')}/click`, {});
  await button("Create bot");
  await visible("WebView2 Bot");
  await send("say: WEBVIEW2-EVENT-STREAM-OK");
  await until("real event stream reply", async () => await script("return [...document.querySelectorAll('[data-testid=assistant-message]')].some(e=>e.textContent.includes('WEBVIEW2-EVENT-STREAM-OK'))"));
  checks.push("real Service event stream delivers Bot reply");
  await send(`computer:open_app:${fixture}`);
  await until("real fixture launch", async () => await script("return [...document.querySelectorAll('[data-testid=assistant-message]')].some(e=>e.textContent.includes('launched '))"));
  await send('browser:request_takeover:{"reason":"WebView2 input acceptance"}');
  await visible("WebView2 input acceptance"); await button("Open Computer Surface");
  await until("live projection preview", async () => await script("const i=document.querySelector('[data-testid=computer-preview]');return i?.complete&&i.naturalWidth>0"), 60_000);
  await button("Continue takeover"); await visible("Click, scroll, or type to control");
  await until("magenta Sway fixture pixels", async () => await color([255, 0, 255]));
  const canvas = await element('[data-testid="computer-expanded-view"] canvas');
  await wd("POST", `/session/${session}/actions`, { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", duration: 0, origin: { [elementKey]: canvas }, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  await until("Takeover pointer changes real pixels cyan", async () => await color([0, 255, 255]));
  await wd("POST", `/session/${session}/actions`, { actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "k" }, { type: "keyUp", value: "k" }] }] });
  await until("Takeover keyboard changes real pixels yellow", async () => await color([255, 255, 0]));
  await Bun.write(path.join(evidence, "takeover.png"), Buffer.from(await wd("GET", `/session/${session}/screenshot`), "base64"));
  checks.push("real Sway projection and pointer/keyboard Takeover observed as magenta/cyan/yellow pixels");
  await button("I'm done");
  await until("previous Turn idle", async () => await script("return !document.querySelector('[data-testid=working-avatar]')"));
  await script(`const original=window.fetch;window.__smokeDeviceIds=[];window.fetch=function(input,options){if(options?.method==='POST'&&String(input).endsWith('/messages'))window.__smokeDeviceIds.push(JSON.parse(options.body).deviceId);return original(input,options);}`);
  const command = "[Console]::Write('webview2-sidecar-smoke')";
  await send(`local.run:${command}`);
  await element('[data-testid="local-approval"]');
  assert.equal(await script("return document.querySelector('[data-testid=local-approval-detail]').textContent"), command);
  await Bun.write(path.join(evidence, "local-approval.png"), Buffer.from(await wd("GET", `/session/${session}/screenshot`), "base64"));
  await button("Allow once");
  await until("approved PowerShell output", async () => await script("return [...document.querySelectorAll('[data-testid=assistant-message]')].some(e=>e.textContent==='webview2-sidecar-smoke')"));
  assert.deepEqual(await script("return window.__smokeDeviceIds"), [roster.id]);
  checks.push("approved exact local.run executes in compiled Windows Sidecar and carries its dev_ identity");
} catch (error) {
  if (session) {
    const screenshot = await wd("GET", `/session/${session}/screenshot`).catch(() => undefined);
    if (screenshot) await Bun.write(path.join(evidence, "failure.png"), Buffer.from(screenshot, "base64"));
  }
  throw error;
} finally {
  await Bun.write(path.join(evidence, "results.json"), `${JSON.stringify({ platform: "windows-x86_64", checks, completed: checks.length === 6 }, null, 2)}\n`);
  try { await stop(); } finally { if (ownsCredential) await native("clear-credential"); }
}
assert.equal(checks.length, 6, "Every required WebView2 check must complete");
