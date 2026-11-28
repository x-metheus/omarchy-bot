import { expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const daemonBinary = process.env.OMARCHY_BOT_AGENT_DAEMON_BIN;
const operator = "desktop-test-operator-token-4bfe1657";
const web = "http://127.0.0.1:7322";
const webDirectory = fileURLToPath(new URL("../../apps/web", import.meta.url));
const duties = "Classify new color samples by shade.";
const instruction = `Your ongoing job is to ${duties[0]?.toLowerCase()}${duties.slice(1)}`;
const hold = "Hold the neutral swatch check.";
const firstKey = "desktop-provider-initial";
const secondKey = "desktop-provider-rotated";

function providerChunk(delta: object, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1,
    model: "scripted-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function ready(url: string, child: Bun.Subprocess) {
  await browserExpect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`${url} exited (${child.exitCode}) before responding`);
    return fetch(url).then(response => response.ok).catch(() => false);
  }, { timeout: 10_000, message: `${url} should become ready` }).toBe(true);
}

test.skipIf(!daemonBinary)("desktop pairs, manages a Conversation, rotates Settings, retries and deletes through the real daemon", async () => {
  if (!daemonBinary) throw new Error("set OMARCHY_BOT_AGENT_DAEMON_BIN");
  const profile = await mkdtemp(join(tmpdir(), "omarchy-agent-desktop-"));
  const master = join(profile, "master.key");
  const token = join(profile, "settings-token");
  await writeFile(master, new Uint8Array(32).fill(18), { mode: 0o600 });
  await writeFile(token, operator, { mode: 0o600 });
  const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const calls: { key: string | null; model: string; text: string }[] = [];
  let holds = 0;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { model, messages } = await request.json() as { model: string; messages: { role: string; content: string }[] };
    const authored = messages.findLast(message => message.role === "user")?.content ?? "";
    const text = typeof authored === "string" ? authored : JSON.stringify(authored);
    calls.push({ key: request.headers.get("authorization"), model, text });
    const headers = { "content-type": "text/event-stream" };
    if (text.includes(hold) && ++holds === 1) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(providerChunk({ role: "assistant", content: "Checking the swatch…" })));
      } }), { headers });
    }
    if (text.includes(instruction) && messages.at(-1)?.role === "user") {
      return new Response(providerChunk({ role: "assistant", tool_calls: [{ index: 0, id: "fixture_duties", type: "function",
        function: { name: "set_bot_duties", arguments: JSON.stringify({ duties, evidence: instruction }) } }] })
        + providerChunk({}, "tool_calls") + "data: [DONE]\n\n", { headers });
    }
    const reply = text.includes(hold) ? "The swatch is amber." : "I will classify the samples.";
    return new Response(providerChunk({ role: "assistant", content: reply }) + providerChunk({}, "stop") + "data: [DONE]\n\n", { headers });
  } });
  const start = () => Bun.spawn([daemonBinary], { stdout: "ignore", stderr: "inherit", env: {
    ...process.env,
    OMARCHY_AGENT_PORT: String(port), OMARCHY_AGENT_DB: join(profile, "conversation.sqlite3"),
    OMARCHY_AGENT_MASTER_KEY_FILE: master, OMARCHY_AGENT_SETTINGS_TOKEN_FILE: token,
    OMARCHY_AGENT_WORK_DIR: undefined, OMARCHY_AGENT_RECALL_MODEL_DIR: undefined,
    OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, OPENAI_API_KEY: undefined,
  } });
  let daemon = start();
  let staticUi: Bun.Server<undefined> | undefined;
  let browser: Browser | undefined;
  try {
    await ready(`${origin}/health`, daemon);
    const headers = { Authorization: `Bearer ${operator}`, "Content-Type": "application/json" };
    const issued = await fetch(`${origin}/api/pairing/codes`, { method: "POST", headers, body: JSON.stringify({ name: "Disposable desktop" }) });
    expect(issued.status).toBe(200);
    const { code } = await issued.json() as { code: string };
    const build = Bun.spawn(["bun", "run", "build"], { cwd: webDirectory, stdout: "ignore", stderr: "inherit" });
    if (await build.exited !== 0) throw new Error("production web build failed");
    const dist = join(webDirectory, "dist");
    staticUi = Bun.serve({ hostname: "127.0.0.1", port: Number(new URL(web).port), fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const asset = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
      if (!asset.startsWith(`${dist}${sep}`)) return new Response(null, { status: 404 });
      return new Response(Bun.file(asset));
    } });
    const bridge = await Bun.build({
      entrypoints: [join(webDirectory, "src/dev-shell.ts")], target: "browser", format: "iife",
      define: { "import.meta.env.VITE_OMARCHY_AGENT_DAEMON_URL": JSON.stringify(origin) },
    });
    const bridgeScript = bridge.outputs[0];
    if (!bridgeScript) throw new Error("development shell bridge was not built");
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript({ content: await bridgeScript.text() });
    await page.goto(web, { waitUntil: "domcontentloaded" });
    await browserExpect(page.getByRole("heading", { name: "Connect to an Agent Daemon" })).toBeVisible();
    await page.getByRole("textbox", { name: "Pairing code" }).fill(code);
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await page.getByRole("button", { name: "New Bot", exact: true }).click();
    await page.getByRole("textbox", { name: "Bot name" }).fill("Lumen");
    await page.getByRole("button", { name: "Create Bot", exact: true }).click();
    await browserExpect(page.getByRole("heading", { name: "Lumen", exact: true })).toBeVisible();
    const list = await fetch(`${origin}/bots`, { headers }).then(response => response.json()) as { id: string }[];
    const bot = list[0]?.id;
    expect(bot).toBeDefined();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("textbox", { name: "Model ID" }).fill("scripted-model");
    const apiKeyField = page.getByRole("dialog", { name: "Settings" }).getByLabel(/^API key\b/);
    await browserExpect(apiKeyField).toHaveAttribute("type", "password");
    await browserExpect(apiKeyField).toHaveAttribute("aria-required", "true");
    await apiKeyField.fill(firstKey);
    await page.getByRole("button", { name: "Save daemon Settings" }).click();
    await browserExpect(page.getByText("Daemon Settings saved.")).toBeVisible();
    await page.keyboard.press("Escape");
    const composer = page.locator("[contenteditable=true]");
    await composer.fill(instruction);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect(page.getByText("I will classify the samples.", { exact: true })).toHaveCount(1);
    await browserExpect(page.getByText(`Duties: ${duties}`)).toBeVisible();
    await browserExpect(page.getByText("set_bot_duties · completed")).toBeVisible();
    expect(calls[0]?.key).toBe(`Bearer ${firstKey}`);

    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Bot name" }).fill("Prism");
    await page.getByRole("button", { name: "Save name" }).click();
    await browserExpect(page.getByRole("heading", { name: "Prism", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("textbox", { name: "Model ID" }).fill("scripted-rotated");
    await page.getByLabel("Replacement API key").fill(secondKey);
    await page.getByRole("button", { name: "Save daemon Settings" }).click();
    await browserExpect(page.getByText("Daemon Settings saved.")).toBeVisible();
    await browserExpect(page.getByLabel("Replacement API key")).toHaveValue("");
    await page.keyboard.press("Escape");

    await composer.fill(hold);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect(page.getByText("Checking the swatch…", { exact: true })).toBeVisible();
    daemon.kill();
    await daemon.exited;
    daemon = start();
    await ready(`${origin}/health`, daemon);
    await browserExpect(page.getByRole("button", { name: "Retry interrupted work" })).toBeVisible();
    await browserExpect(page.getByText("Checking the swatch…", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry interrupted work" }).click();
    await browserExpect(page.getByText("The swatch is amber.", { exact: true })).toHaveCount(1);
    expect(calls.filter(call => call.text.includes(hold)).map(call => [call.key, call.model])).toEqual([
      [`Bearer ${secondKey}`, "scripted-rotated"], [`Bearer ${secondKey}`, "scripted-rotated"],
    ]);

    await page.reload();
    await browserExpect(page.getByRole("heading", { name: "Prism", exact: true })).toBeVisible();
    await browserExpect(page.getByText(hold, { exact: true })).toHaveCount(1);
    await browserExpect(page.getByText("The swatch is amber.", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Delete Bot", exact: true }).click();
    await page.getByRole("button", { name: "Delete Bot permanently" }).click();
    await browserExpect(page.getByText("Create a Bot to start a Conversation.")).toBeVisible();
    for (const path of [`/bots/${bot}`, `/bots/${bot}/events`]) {
      expect((await fetch(`${origin}${path}`, { headers })).status).toBe(404);
    }
    expect(await fetch(`${origin}/bots`, { headers }).then(response => response.json())).toEqual([]);
  } finally {
    await browser?.close();
    staticUi?.stop(true);
    daemon.kill();
    provider.stop(true);
    await daemon.exited;
    await rm(profile, { recursive: true, force: true });
  }
}, 45_000);
