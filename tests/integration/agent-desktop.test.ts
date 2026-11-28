import { expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser } from "@playwright/test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const daemonBinary = process.env.OMARCHY_BOT_AGENT_DAEMON_BIN;
const operator = "desktop-test-operator-token-4bfe1657";
const web = "http://127.0.0.1:7322";
const appDirectory = fileURLToPath(new URL("../../apps/omarchy-bot", import.meta.url));
const duties = "Classify new color samples by shade.";
const instruction = `Your ongoing job is to ${duties[0]?.toLowerCase()}${duties.slice(1)}`;
const hold = "Hold the neutral swatch check.";
const firstKey = "desktop-provider-initial";
const secondKey = "desktop-provider-rotated";
const sampleText = "Calibration sample: cobalt.\n";
const samplePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const inspectSample = "Inspect the attached calibration samples.";
const reuseSample = "Use the saved text sample again.";
const sampleReply = "Received the calibration samples.";

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
  let firstAttachmentInput: unknown;
  let reusedAttachmentInput: unknown;
  const releaseSample = Promise.withResolvers<void>();
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { model, messages } = await request.json() as { model: string; messages: { role: string; content: unknown }[] };
    const authored = messages.findLast(message => message.role === "user")?.content ?? "";
    const text = typeof authored === "string" ? authored : JSON.stringify(authored);
    calls.push({ key: request.headers.get("authorization"), model, text });
    const headers = { "content-type": "text/event-stream" };
    if (text.includes(inspectSample)) {
      firstAttachmentInput = authored;
      await releaseSample.promise;
      return new Response(providerChunk({ role: "assistant", content: sampleReply }) + providerChunk({}, "stop") + "data: [DONE]\n\n", { headers });
    }
    if (text.includes(reuseSample)) reusedAttachmentInput = authored;
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
    const build = Bun.spawn(["bun", "run", "build:frontend"], { cwd: appDirectory, stdout: "ignore", stderr: "inherit" });
    if (await build.exited !== 0) throw new Error("production desktop frontend build failed");
    const dist = join(appDirectory, "dist");
    staticUi = Bun.serve({ hostname: "127.0.0.1", port: Number(new URL(web).port), fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const asset = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
      if (!asset.startsWith(`${dist}${sep}`)) return new Response(null, { status: 404 });
      return new Response(Bun.file(asset));
    } });
    const bridge = await Bun.build({
      entrypoints: [join(appDirectory, "src/dev-shell.ts")], target: "browser", format: "iife",
      define: { "import.meta.env.VITE_OMARCHY_AGENT_DAEMON_URL": JSON.stringify(origin) },
    });
    const bridgeScript = bridge.outputs[0];
    if (!bridgeScript) throw new Error("development shell bridge was not built");
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript({ content: await bridgeScript.text() });
    let page = await context.newPage();
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

    const sourcePath = join(profile, "sample.txt");
    await writeFile(sourcePath, sampleText);
    const imagePath = join(profile, "pixel.png");
    await writeFile(imagePath, Buffer.from(samplePng, "base64"));
    const attach = page.getByRole("button", { name: "Attach files", exact: true });
    await browserExpect(attach).toBeVisible({ timeout: 3_000 });
    const [choice] = await Promise.all([page.waitForEvent("filechooser"), attach.click()]);
    await choice.setFiles(sourcePath);
    await page.getByRole("region", { name: "Message composer" }).drop({ files: imagePath });
    await browserExpect(page.getByRole("button", { name: "Remove sample.txt" })).toBeVisible();
    await browserExpect(page.getByRole("button", { name: "Remove pixel.png" })).toBeVisible();
    await page.locator("[contenteditable=true]").fill(inspectSample);
    const admitted = page.waitForResponse(response => response.url() === `${origin}/bots/${bot}/messages` && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const submission = await admitted;
    expect(submission.status()).toBe(200);
    const requestHeaders = await submission.request().allHeaders();
    expect(requestHeaders["content-type"]).toBe("application/json");
    const deviceHeaders = { Authorization: requestHeaders.authorization!, "Content-Type": "application/json" };
    expect(deviceHeaders.Authorization).toMatch(/^Bearer /);
    expect(deviceHeaders.Authorization).not.toBe(headers.Authorization);
    expect(submission.request().postDataJSON()).toEqual({ text: inspectSample, attachments: [
      { type: "inline", name: "sample.txt", mediaType: "text/plain", content: sampleText },
      { type: "inline", name: "pixel.png", mediaType: "image/png", content: samplePng },
    ] });
    await page.close();
    try {
      await browserExpect.poll(() => firstAttachmentInput, { timeout: 5_000 }).toEqual([
        { type: "text", text: inspectSample }, { type: "text", text: sampleText },
        { type: "image_url", image_url: { url: `data:image/png;base64,${samplePng}`, detail: "auto" } },
      ]);
      expect(await readFile(sourcePath, "utf8")).toBe(sampleText);
      expect(await readFile(imagePath, "base64")).toBe(samplePng);
      await rename(sourcePath, join(profile, "moved-sample.txt"));
    } finally { releaseSample.resolve(); }
    const history = () => fetch(`${origin}/bots/${bot}`, { headers: deviceHeaders }).then(response => response.json()) as Promise<{
      messages: { text: string; attachments?: { id: string; name: string; mediaType: string; available: boolean }[] }[];
    }>;
    await browserExpect.poll(async () => (await history()).messages.some(message => message.text === sampleReply)).toBe(true);
    const stored = (await history()).messages.find(message => message.text === inspectSample)?.attachments;
    expect(stored).toEqual([
      { id: expect.any(String), name: "sample.txt", mediaType: "text/plain", available: true },
      { id: expect.any(String), name: "pixel.png", mediaType: "image/png", available: true },
    ]);
    const attachment = stored?.[0];

    page = await context.newPage();
    await page.goto(web, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "View sample.txt" }).click();
    const note = page.getByRole("dialog", { name: "sample.txt" });
    await browserExpect(note.getByText(sampleText.trim(), { exact: true })).toBeVisible();
    await browserExpect(note.getByText("Original file unavailable in Conversation.")).toBeVisible();
    const downloading = page.waitForEvent("download");
    await note.getByRole("button", { name: "Save submitted content" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("sample.txt");
    expect(await readFile(await download.path(), "utf8")).toBe(sampleText);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "View pixel.png" }).click();
    const image = page.getByRole("dialog", { name: "pixel.png" }).getByRole("img", { name: "pixel.png" });
    await browserExpect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Reuse sample.txt" }).click();
    await page.locator("[contenteditable=true]").fill(reuseSample);
    const reused = page.waitForResponse(response => response.url() === `${origin}/bots/${bot}/messages` && response.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const reusedSubmission = await reused;
    expect(reusedSubmission.status()).toBe(200);
    expect(reusedSubmission.request().postDataJSON()).toEqual({ text: reuseSample, attachments: [{ type: "reference", id: attachment?.id }] });
    await browserExpect.poll(() => reusedAttachmentInput).toEqual([
      { type: "text", text: reuseSample }, { type: "text", text: sampleText },
    ]);
    const other = await fetch(`${origin}/bots`, { method: "POST", headers: deviceHeaders, body: JSON.stringify({ name: "Other Bot" }) }).then(response => response.json()) as { id: string };
    const forbidden = await fetch(`${origin}/bots/${other.id}/messages`, { method: "POST", headers: deviceHeaders,
      body: JSON.stringify({ text: reuseSample, attachments: [{ type: "reference", id: attachment?.id }] }) });
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toMatchObject({ code: "attachment_not_found" });
    expect((await fetch(`${origin}/bots/${other.id}`, { headers: deviceHeaders }).then(response => response.json())).messages).toEqual([]);
    expect((await fetch(`${origin}/bots/${other.id}`, { method: "DELETE", headers: deviceHeaders })).status).toBe(204);

    await page.getByRole("button", { name: "Delete Bot", exact: true }).click();
    await page.getByRole("button", { name: "Delete Bot permanently" }).click();
    await browserExpect(page.getByText("Create a Bot to start a Conversation.")).toBeVisible();
    for (const path of [`/bots/${bot}`, `/bots/${bot}/events`]) {
      expect((await fetch(`${origin}${path}`, { headers })).status).toBe(404);
    }
    expect(await fetch(`${origin}/bots`, { headers }).then(response => response.json())).toEqual([]);
  } finally {
    releaseSample.resolve();
    await browser?.close();
    staticUi?.stop(true);
    daemon.kill();
    provider.stop(true);
    await daemon.exited;
    await rm(profile, { recursive: true, force: true });
  }
}, 45_000);
