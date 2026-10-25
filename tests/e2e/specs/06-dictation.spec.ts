import { expect, test, type Locator, type Page, type Route } from "../fixtures.ts";

type DictationOutcome = "success" | "empty" | "timeout" | "failure" | "unavailable" | "cancelled";

interface StubController {
  result: { outcome: DictationOutcome; text?: string };
  stopGate?: Promise<void>;
  initialState?: "idle" | "unavailable";
  cancelCount: number;
}

async function createBot(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Own voice tests");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

function composerInput(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function dictationButton(page: Page): Locator {
  return page.getByRole("button", {
    name: /^(?:Start|Stop) voice recording$|^Transcribing voice$|^Voice dictation unavailable$/,
  });
}

async function setCursor(input: Locator, offset: number): Promise<void> {
  await input.evaluate((element, cursor) => {
    const node = element.firstChild;
    if (node === null) throw new Error("composer has no text node");
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, cursor);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, offset);
}

async function stubDictation(page: Page, controller: StubController): Promise<void> {
  let state: "idle" | "recording" | "unavailable" = controller.initialState ?? "idle";
  await page.route(/\/api\/dictation(?:\/(?:start|stop|cancel))?$/, async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/dictation" && route.request().method() === "GET") {
      await route.fulfill({ json: { state, ...(state === "unavailable" ? { error: "Voxtype is unavailable." } : {}) } });
      return;
    }
    if (pathname === "/api/dictation/start") {
      state = "recording";
      await route.fulfill({ json: { state, recordingId: "rec_11111111111111111111111111111111" } });
      return;
    }
    if (pathname === "/api/dictation/stop") {
      if (controller.stopGate !== undefined) await controller.stopGate;
      state = "idle";
      await route.fulfill({ json: controller.result });
      return;
    }
    controller.cancelCount += 1;
    state = "idle";
    await route.fulfill({ json: { state } });
  });
}

test.describe("Voxtype composer dictation", () => {
  test("disables the microphone with plain-language unavailable state", async ({ page }) => {
    const controller: StubController = {
      initialState: "unavailable",
      result: { outcome: "unavailable" },
      cancelCount: 0,
    };
    await stubDictation(page, controller);
    await page.goto("/");
    await createBot(page, "Voice Unavailable Bot");

    const microphone = page.getByRole("button", { name: "Voice dictation unavailable" });
    await expect(microphone).toHaveAttribute("data-state", "unavailable");
    await expect(microphone).toBeDisabled();
    await expect(page.getByRole("status").getByText("Voxtype is unavailable.", { exact: true })).toBeVisible();
  });

  test("shows recording and transcribing states, then inserts at the original cursor", async ({ page }) => {
    const gate = Promise.withResolvers<void>();
    const controller: StubController = {
      result: { outcome: "success", text: "dictated" },
      stopGate: gate.promise,
      cancelCount: 0,
    };
    await stubDictation(page, controller);
    await page.goto("/");
    await createBot(page, "Voice Insert Bot");

    const input = composerInput(page);
    await input.fill("hello world");
    await setCursor(input, 5);
    const microphone = dictationButton(page);
    await microphone.click();
    await expect(microphone).toHaveAttribute("data-state", "recording");
    await expect(page.getByText("Listening… Press Escape to cancel.")).toBeVisible();

    await microphone.click();
    await expect(microphone).toHaveAttribute("data-state", "transcribing");
    await expect(page.getByText("Transcribing voice…")).toBeVisible();
    gate.resolve();

    await expect(input).toHaveText("hello dictated world");
    await expect(microphone).toHaveAttribute("data-state", "idle");
  });

  test("keeps a late transcript with the Bot and draft that started it", async ({ page }) => {
    const controller: StubController = { result: { outcome: "success", text: "origin voice" }, cancelCount: 0 };
    await stubDictation(page, controller);
    await page.goto("/");
    await createBot(page, "Voice Origin Bot");
    await createBot(page, "Voice Other Bot");

    await page.getByRole("button", { name: "Voice Origin Bot", exact: true }).click();
    const input = composerInput(page);
    await input.fill("origin draft");
    await setCursor(input, 6);
    await dictationButton(page).click();
    await expect(dictationButton(page)).toHaveAttribute("data-state", "recording");

    await page.getByRole("button", { name: "Voice Other Bot", exact: true }).click();
    await expect(input).toHaveText("");
    await input.fill("other draft");
    await dictationButton(page).click();
    await expect(input).toHaveText("other draft");

    await page.getByRole("button", { name: "Voice Origin Bot", exact: true }).click();
    await expect(input).toHaveText("origin origin voice draft");
  });

  test("Escape cancels and every non-success outcome leaves the draft unsent", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("settings:v1:auto-send-voice", "true"));
    const controller: StubController = { result: { outcome: "empty" }, cancelCount: 0 };
    await stubDictation(page, controller);
    const sentRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && /\/api\/(?:bots|threads)\/.+\/messages$/u.test(new URL(request.url()).pathname)) {
        sentRequests.push(request.url());
      }
    });
    await page.goto("/");
    await createBot(page, "Voice Failure Bot");
    const input = composerInput(page);
    await input.fill("keep this draft");

    await dictationButton(page).click();
    await expect(dictationButton(page)).toHaveAttribute("data-state", "recording");
    await input.press("Escape");
    await expect(dictationButton(page)).toHaveAttribute("data-state", "idle");
    expect(controller.cancelCount).toBe(1);
    await expect(input).toHaveText("keep this draft");

    for (const outcome of ["empty", "timeout", "failure"] as const) {
      controller.result = { outcome };
      await dictationButton(page).click();
      await expect(dictationButton(page)).toHaveAttribute("data-state", "recording");
      await dictationButton(page).click();
      await expect(dictationButton(page)).toHaveAttribute("data-state", "idle");
      await expect(input).toHaveText("keep this draft");
    }
    expect(sentRequests).toEqual([]);
  });

  test("voice auto-send is visible, off by default, and stored explicitly in the browser", async ({ page }) => {
    const controller: StubController = { result: { outcome: "empty" }, cancelCount: 0 };
    await stubDictation(page, controller);
    await page.goto("/");
    await createBot(page, "Voice Settings Bot");

    await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Voice" }).click();
    const setting = page.getByRole("switch", { name: "Auto-send voice transcriptions" });
    await expect(setting).not.toBeChecked();
    await setting.check();
    await expect(setting).toBeChecked();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("settings:v1:auto-send-voice"))).toBe("true");

    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Voice" }).click();
    await expect(page.getByRole("switch", { name: "Auto-send voice transcriptions" })).toBeChecked();
  });

  test("auto-send submits the owning draft only after successful insertion", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("settings:v1:auto-send-voice", "true"));
    const controller: StubController = { result: { outcome: "success", text: "voice words" }, cancelCount: 0 };
    await stubDictation(page, controller);
    await page.goto("/");
    await createBot(page, "Voice Auto Send Bot");
    const input = composerInput(page);
    await input.fill("say:");

    await dictationButton(page).click();
    await expect(dictationButton(page)).toHaveAttribute("data-state", "recording");
    const sent = page.waitForRequest((request) =>
      request.method() === "POST" && /\/api\/(?:bots|threads)\/.+\/messages$/u.test(new URL(request.url()).pathname),
    );
    await dictationButton(page).click();
    expect((await sent).postDataJSON()).toMatchObject({ text: "say: voice words" });
    await expect(input).toHaveText("");
  });
});
