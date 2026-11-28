import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const nativeScript = path.join(import.meta.dirname, "windows-app/native.ps1");
const archive = process.env.OMARCHY_BOT_SMOKE_AGENT_ARCHIVE;
assert.ok(archive, "Set OMARCHY_BOT_SMOKE_AGENT_ARCHIVE to the native daemon archive");
const app = process.env.OMARCHY_BOT_SMOKE_APP;
const evidence = process.env.OMARCHY_BOT_SMOKE_EVIDENCE;
const root = mkdtempSync(path.join(os.tmpdir(), "agent-release-"));
const key = "release-smoke-key";
const marker = "The fixture swatch is cobalt. Reference QN-731.";
const readMarker = "Fixture file contains cobalt.";
const looseFile = path.join(root, "sample.txt");
writeFileSync(looseFile, readMarker);
const checks: string[] = [];
const failures: string[] = [];
const provider = Bun.serve({ hostname: "127.0.0.1", port: app ? 18443 : 0, async fetch(request) {
  try {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
    const { messages, model } = await request.json();
    assert.equal(model, "release-smoke-model");
    const user = [...messages].reverse().find(message => message.role === "user");
    const input = JSON.stringify(user.content);
    const last = messages.at(-1);
    function chunk(delta: object, finish_reason: string | null = null) {
      return `data: ${JSON.stringify({ id: "release-smoke", object: "chat.completion.chunk", created: 1, model,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    }
    let reply = "The swatch is cobalt.";
    let tool: { name: string; arguments: string } | undefined;
    if (input.includes("Recall QN-731")) {
      if (last.role === "tool") {
        assert.match(last.content, /The fixture swatch is cobalt/);
        reply = "Recalled cobalt from QN-731.";
      } else tool = { name: "recall", arguments: JSON.stringify({ query: "QN-731" }) };
    } else if (input.includes("Read selected fixture")) {
      if (last.role === "tool") {
        assert.match(last.content, /Fixture file contains cobalt/);
        reply = "The selected file contains cobalt.";
      } else tool = { name: "read", arguments: JSON.stringify({ path: "sample.txt" }) };
    } else if (input.includes("Read the attachment")) assert.ok(input.includes(readMarker), "provider received the attached text");
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `smoke_${tool.name}`, type: "function", function: tool }] }
      : { role: "assistant", content: reply };
    return new Response(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } catch (error) {
    failures.push(String(error));
    return new Response("fixture rejected request", { status: 500 });
  }
} });

async function until<T>(label: string, attempt: () => T | Promise<T>, timeout = 35_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await attempt();
      if (result) return result as NonNullable<T>;
    } catch (error) { last = error; }
    await Bun.sleep(150);
  }
  throw new Error(`${label}: ${last ?? failures.at(-1) ?? "timed out"}`);
}
function pass(label: string) { checks.push(label); console.log(`PASS ${label}`); }
function command(args: string[], env = process.env) {
  const child = Bun.spawnSync(args, { stdin: "ignore", env });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  return child.stdout.toString();
}
async function request(origin: string, route: string, token?: string, body?: object, method = body ? "POST" : "GET") {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${origin}${route}`, { method, headers, ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response;
}
async function ready(origin: string) {
  await until("Agent Daemon listener", async () => (await (await request(origin, "/health")).json()).service === "omarchy-agent-daemon");
}
async function recallReady(origin: string, token: string) {
  await until("offline bundled Recall", async () => {
    const status = await (await request(origin, "/recall/status", token)).json();
    if (status.status === "unavailable") throw new Error(JSON.stringify(status));
    return status.status === "ready";
  });
}
const operator = "release-smoke-operator";
let standalone: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
let session = "";
const driver = "http://127.0.0.1:4444";
const elementKey = "element-6066-11e4-a52e-4f735466cecf";
async function wd(method: string, route: string, body?: object) {
  const response = await fetch(`${driver}${route}`, { method, headers: { "content-type": "application/json" },
    ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const { value } = await response.json();
  assert.ok(response.ok && !value?.error, `WebDriver ${route}: ${value?.message ?? response.status}`);
  return value;
}
const browser = (method: string, route: string, body?: object) => wd(method, `/session/${session}${route}`, body);
const script = (source: string, args: unknown[] = []) => browser("POST", "/execute/sync", { script: source, args });
const visible = (text: string) => until(text, async () => (await script("return document.body.innerText")).includes(text));
const input = async (selector: string, text: string) => {
  const found = await until(selector, () => browser("POST", "/element", { using: "css selector", value: selector }));
  await browser("POST", `/element/${found[elementKey]}/value`, { text });
};
const field = async (label: string, text: string) => {
  const id = await until(label, () => script("return [...document.querySelectorAll('label')].find(el => el.textContent.includes(arguments[0]))?.htmlFor", [label]));
  await input(`[id=${JSON.stringify(id)}]`, text);
};
async function click(label: string) {
  const button = await until(label, () => script("return [...document.querySelectorAll('button')].find(el => !el.disabled && (el.textContent.trim() === arguments[0] || el.getAttribute('aria-label') === arguments[0]))", [label]));
  await browser("POST", `/element/${button[elementKey]}/click`, {});
}
async function closeDesktop() {
  if (!session) return;
  await browser("DELETE", "").catch(() => {});
  session = "";
  const profile = process.env.OMARCHY_BOT_SMOKE_DIR;
  assert.ok(profile && app);
  await until("previous smoke app exits", () => {
    const pids = process.platform === "win32"
      ? JSON.parse(command(["pwsh", "-NoProfile", "-File", nativeScript, "processes", app])) as number[]
      : readdirSync("/proc").filter(entry => /^\d+$/.test(entry)).flatMap(entry => {
        try {
          return path.basename(readlinkSync(`/proc/${entry}/exe`)) === "omarchy-bot" &&
            readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`OMARCHY_BOT_SMOKE_DIR=${profile}`) ? [Number(entry)] : [];
        } catch { return []; }
      });
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
    return pids.length === 0;
  });
}
async function openDesktop() {
  session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: app } } } })).sessionId;
  await browser("POST", "/window/rect", { width: 1320, height: 900 });
  const engine = await script("return { origin: location.origin, agent: navigator.userAgent }");
  assert.match(engine.origin, /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)$/);
  console.log(`Native WebView ${engine.agent}`);
}
async function nativeWindow(title: string) {
  assert.ok(existsSync("/etc/omarchy-bot-linux-app") && process.env.DISPLAY === ":99" &&
    process.env.OMARCHY_BOT_SMOKE_DIR?.startsWith("/tmp/omarchy-bot-webkit-"), "requires the private native smoke display");
  return until(title, () => command(["xdotool", "search", "--onlyvisible", "--name", `^${title}$`]).trim().split("\n").at(-1));
}

try {
  const unpacked = path.join(root, "standalone");
  mkdirSync(unpacked);
  command(["tar", "-xzf", archive, "-C", unpacked]);
  const binary = path.join(unpacked, `omarchy-agent-daemon${process.platform === "win32" ? ".exe" : ""}`);
  const tokenPath = path.join(root, "settings-token");
  const masterPath = path.join(root, "master.key");
  writeFileSync(tokenPath, operator, { mode: 0o600 });
  writeFileSync(masterPath, crypto.getRandomValues(new Uint8Array(32)), { mode: 0o600 });
  standalone = Bun.spawn([binary], { cwd: root, stdout: "pipe", stderr: "inherit", env: {
    ...process.env, OMARCHY_AGENT_DB: path.join(root, "agent-daemon.sqlite3"), OMARCHY_AGENT_PORT: "0",
    OMARCHY_AGENT_RECALL_MODEL_DIR: undefined, OMARCHY_AGENT_RECALL_BUNDLE_DIR: undefined,
    OMARCHY_AGENT_RECALL_MODEL_SOURCE: "http://127.0.0.1:1", OMARCHY_AGENT_RECALL_DOWNLOAD: "1",
    OMARCHY_AGENT_SETTINGS_TOKEN_FILE: tokenPath, OMARCHY_AGENT_MASTER_KEY_FILE: masterPath,
    OMARCHY_AGENT_WORK_DIR: root, OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, OPENAI_API_KEY: undefined,
  } });
  assert.ok(standalone.stdout instanceof ReadableStream);
  const reader = standalone.stdout.getReader();
  let output = "";
  const origin = await until("standalone listener address", async () => {
    const { value } = await reader.read();
    output += new TextDecoder().decode(value);
    return output.match(/LISTENING (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  });
  reader.releaseLock();
  await ready(origin);
  await recallReady(origin, operator);
  assert.deepEqual(await (await request(origin, "/bots", operator)).json(), []);
  pass("Standalone Agent Daemon starts with an empty Bot list");
  const settings = { provider: "openai", model: "release-smoke-model", apiKey: key };
  const status = await (await request(origin, "/settings", operator, settings, "PUT")).json();
  assert.deepEqual(status.active, { provider: "openai", model: settings.model, source: "saved" });
  assert.equal(status.storedCredentials.openai, true);
  const { code } = await (await request(origin, "/api/pairing/codes", operator, { name: "Release smoke" })).json();
  const { token } = await (await request(origin, "/api/pairing/exchange", undefined, { code })).json();
  assert.ok(token);
  const { id } = await (await request(origin, "/bots", token, { name: "Standalone fixture" })).json();
  const turn = async (text: string, attachments?: object[]) => (await request(origin, `/bots/${id}/messages`, token, { text, attachments })).text();
  assert.match(await turn(marker), /event: committed/);
  assert.match(await turn("Read the attachment", [{ type: "inline", name: "sample.txt", mediaType: "text/plain", content: readMarker }]), /event: committed/);
  assert.match(await turn("Read selected fixture"), /The selected file contains cobalt/);
  assert.match(await turn("Recall QN-731"), /Recalled cobalt from QN-731/);
  const history = await (await request(origin, `/bots/${id}`, token)).json();
  assert.equal(history.messages[0].text, marker);
  pass("Standalone archive launches, pairs, configures a provider, persists Conversation and attachments, runs a host tool, and recalls offline");

  if (app) {
    const local = `http://127.0.0.1:${process.env.OMARCHY_BOT_AGENT_PORT}`;
    const profile = process.env.OMARCHY_BOT_SMOKE_AGENT_PROFILE;
    assert.ok(profile);
    const disabled = path.join(profile, "disable-autostart");
    mkdirSync(profile, { recursive: true });
    writeFileSync(disabled, "");
    await until("native driver", async () => (await fetch(`${driver}/status`)).ok);
    await openDesktop();
    await visible("Connect to an Agent Daemon");
    assert.equal(await fetch(`${local}/health`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false), false);
    await closeDesktop();
    rmSync(disabled);
    await openDesktop();
    await ready(local);
    const localToken = readFileSync(path.join(profile, "settings-token"), "utf8");
    await recallReady(local, localToken);
    await click("Pair local daemon");
    await until("paired device stored by the native shell", () => {
      const credential = process.platform === "win32"
        ? command(["pwsh", "-NoProfile", "-File", nativeScript, "credential", "-CredentialTarget", "agent-daemon-connection.com.omarchy.bot"])
        : command(["secret-tool", "lookup", "service", "com.omarchy.bot", "username", "agent-daemon-connection"]);
      return JSON.parse(credential)?.baseUrl === local;
    });
    await closeDesktop();
    await openDesktop();
    await visible("Create a Bot to start a Conversation.");
    assert.equal(readFileSync(path.join(profile, "settings-token"), "utf8"), localToken);
    assert.equal((await (await request(local, "/api/devices/paired", localToken)).json()).devices.length, 1);
    pass("Packaged WebView honors disabled launch, autostarts bundled daemon and attaches to it after pairing and reopen");
    await click("Settings");
    await visible("Start the local daemon when opening Omarchy Bot");
    await visible("Providers");
    await field("Model ID", settings.model);
    await field("API key", key);
    await click("Save daemon Settings");
    await visible("Daemon Settings saved.");
    await click("New Bot");
    await field("Bot name", "Desktop fixture");
    await click("Create Bot");
    await visible("Desktop fixture");
    const composer = '[placeholder="Message this Bot…"], [aria-label="Message input"][contenteditable="true"], textarea[aria-label="Message input"]';
    const send = async (text: string) => {
      await input(composer, text);
      await click("Send");
    };
    await send(marker);
    await visible("The swatch is cobalt.");
    await input('input[type="file"]', looseFile);
    await visible("Remove sample.txt");
    await input(composer, "Read the attachment");
    await click("Settings");
    await visible(`Current model: ${settings.model}`);
    await click("Desktop fixture");
    await visible("Remove sample.txt");
    await click("Send");
    await visible("Read the attachment");
    await click("View sample.txt");
    await visible(readMarker);
    await click("Close");
    await send("Recall QN-731");
    await visible("Recalled cobalt from QN-731.");
    pass("Packaged WebView configures its provider in Settings, preserves a draft and attachment when returning to its Bot, and invokes offline Recall");
    if (process.platform === "linux") {
      await click("Choose desktop file");
      const picker = await nativeWindow("Choose a desktop file");
      command(["xdotool", "windowfocus", "--sync", picker]);
      await Bun.sleep(300);
      command(["xdotool", "key", "--clearmodifiers", "ctrl+l"]);
      await Bun.sleep(250);
      command(["xdotool", "type", "--clearmodifiers", "--delay", "25", looseFile]);
      await Bun.sleep(300);
      if (evidence) command(["python3", path.join(import.meta.dirname, "linux-app/capture.py"), path.join(evidence, "native-file-picker.png")]);
      command(["xdotool", "key", "--clearmodifiers", "Return"]);
      await visible("Desktop file: sample.txt");
      await send("Read selected fixture");
      const prompt = await nativeWindow("Approve desktop tool");
      const geometry = command(["xdotool", "getwindowgeometry", "--shell", prompt]);
      const width = Number(geometry.match(/^WIDTH=(\d+)$/m)?.[1]);
      const height = Number(geometry.match(/^HEIGHT=(\d+)$/m)?.[1]);
      assert.ok(width > 0 && height > 30);
      command(["xdotool", "mousemove", "--window", prompt, String(Math.floor(width / 4)), String(height - 15), "click", "1"]);
      await visible("The selected file contains cobalt.");
      await visible("read · completed");
      pass("Packaged WebKitGTK drives the native file picker and desktop tool approval through the Conversation");
    }
  }
  assert.deepEqual(failures, []);
} finally {
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    if (session) {
      const screenshot = await browser("GET", "/screenshot").catch(() => undefined);
      if (screenshot) writeFileSync(path.join(evidence, "agent-release.png"), Buffer.from(screenshot, "base64"));
    }
    writeFileSync(path.join(evidence, "agent-release-results.json"), JSON.stringify({ checks, providerFailures: failures }, null, 2));
  }
  try {
    await closeDesktop();
  } finally {
    if (standalone) {
      standalone.kill();
      await standalone.exited;
    }
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}
