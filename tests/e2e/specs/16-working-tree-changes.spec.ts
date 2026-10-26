import { expect, test, type Page, type Route } from "../fixtures.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** Intercepts Computer HTTP so this suite stays UI/state coverage, not production desktop startup. */
async function interceptComputerSurface(page: Page): Promise<void> {
  await page.route("**/api/computer/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/computer/snapshot") {
      await route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG });
      return;
    }
    if (url.pathname === "/api/computer/projection") {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      await fulfillJson(route, { error: "projection fixture unavailable" }, 503);
      return;
    }
    await fulfillJson(route, {
      state: "unavailable",
      botId: url.searchParams.get("botId"),
      surfaceId: url.searchParams.get("surfaceId"),
      takeover: "unavailable",
      activity: "Screen unavailable.",
    });
  });
}

async function createBot(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Observe the Computer Surface.");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`Missing selected Bot id for ${name}.`);
  return botId;
}

async function sendMessage(page: Page, text: string): Promise<string> {
  const input = page
    .getByRole("textbox", { name: "Message input", exact: true })
    .or(page.getByRole("combobox", { name: "Message input", exact: true }));
  await input.fill(text);
  await input.press("Enter");
  await page.waitForURL((url) => {
    const threadId = url.searchParams.get("thread");
    return threadId !== null && threadId !== "blank";
  });
  await expect(page.getByTestId("assistant-message").last()).toBeVisible();
  return new URL(page.url()).searchParams.get("thread")!;
}

function trackChangesRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\/api\/bots\/[^/]+\/changes(?:\/|$)/.test(pathname)) requests.push(pathname);
  });
  return requests;
}

async function expectChangesAbsent(page: Page): Promise<void> {
  await expect(page.getByRole("tab", { name: "Changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh changes", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Working tree changes" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Working tree is clean" })).toHaveCount(0);
  await expect(page.getByTestId("working-tree-changes")).toHaveCount(0);
}

/**
 * Simulated Computer projection here is UI/state coverage only. It does not
 * prove that a production Bot Desktop Session starts successfully.
 */
test.describe("Changes absent and Computer retained", () => {
  test("opens Computer without a Changes tab and keeps conversation geometry shared", async ({ page }) => {
    await interceptComputerSurface(page);
    const changesRequests = trackChangesRequests(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await createBot(page, "Motion Computer Bot");
    const conversation = page.getByLabel("Conversation workspace");
    const fullWidth = await conversation.evaluate((element) => element.getBoundingClientRect().width);
    const sampleTransition = async (closing: boolean, reverse = false) => page.evaluate(
      async ({ closing, reverse }) => {
        const shell = document.querySelector<HTMLElement>('[data-testid="capability-presence"]')!;
        const chat = document.querySelector<HTMLElement>('[aria-label="Conversation workspace"]')!;
        const trigger = document.querySelector<HTMLButtonElement>('[data-testid="header-computer"]')!;
        const close = document.querySelector<HTMLButtonElement>('[data-testid="capabilities-close"]')!;
        (closing ? close : trigger).click();
        const samples: { panel: number; chat: number }[] = [];
        const start = performance.now();
        let reversed = false;
        await new Promise<void>((resolve) => {
          const frame = (): void => {
            const elapsed = performance.now() - start;
            if (reverse && !reversed && elapsed >= 65) {
              trigger.click();
              reversed = true;
            }
            samples.push({
              panel: shell.getBoundingClientRect().width,
              chat: chat.getBoundingClientRect().width,
            });
            if (elapsed >= 400) resolve();
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        return samples;
      },
      { closing, reverse },
    );
    const opening = await sampleTransition(false);
    expect(opening.some(({ panel }) => panel > 1 && panel < 559)).toBe(true);
    for (const frame of opening) {
      expect(Math.abs(frame.panel + frame.chat - fullWidth)).toBeLessThan(2);
    }
    expect(opening.at(-1)!.panel).toBeCloseTo(560, 0);

    const capabilities = page.getByRole("complementary", { name: "Workspace capabilities" });
    await expect(capabilities).toBeVisible();
    await expect(capabilities.getByRole("heading", { name: "Motion Computer Bot’s screen" })).toBeVisible();
    await expectChangesAbsent(page);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByTestId("composer")).toBeVisible();
    expect(changesRequests).toEqual([]);

    const reversing = await sampleTransition(true, true);
    expect(reversing.some(({ panel }) => panel > 1 && panel < 559)).toBe(true);
    expect(reversing.every(({ panel }) => panel > 0)).toBe(true);
    expect(reversing.at(-1)!.panel).toBeCloseTo(560, 0);
    const closing = await sampleTransition(true);
    expect(closing.some(({ panel }) => panel > 1 && panel < 559)).toBe(true);
    expect(closing.at(-1)!.panel).toBe(0);
    expect(closing.at(-1)!.chat).toBeCloseTo(fullWidth, 0);
    await expect(page.getByRole("heading", { name: "Motion Computer Bot’s screen" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Computer Surface", exact: true })).toBeFocused();
    expect(changesRequests).toEqual([]);
  });

  test("makes reduced-motion geometry immediate and keeps the narrow Computer panel out of chat layout", async ({ page }) => {
    await interceptComputerSurface(page);
    const changesRequests = trackChangesRequests(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await createBot(page, "Reduced Panel Bot");
    const shell = page.getByTestId("capability-presence");
    await page.getByTestId("header-computer").click();
    expect(await shell.evaluate((element) => element.getBoundingClientRect().width)).toBe(560);
    expect(await shell.evaluate((element) => [
      ...element.getAnimations(),
      ...element.querySelector(".capability-panel")!.getAnimations(),
    ].filter((animation) => animation.playState === "running").length)).toBe(0);
    await expect(page.getByRole("heading", { name: "Reduced Panel Bot’s screen" })).toBeVisible();
    await expectChangesAbsent(page);

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page.getByLabel("Conversation workspace")).toHaveCount(0);
    await expect.poll(() => shell.evaluate((element) => element.getBoundingClientRect().width)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByTestId("capabilities-close").click();
    await expect(page.getByLabel("Conversation workspace")).toBeVisible();
    await expect(page.getByRole("tabpanel")).toHaveCount(0);
    await expect(shell).toHaveAttribute("inert", "");
    await expect(shell).toHaveAttribute("aria-hidden", "true");
    expect(changesRequests).toEqual([]);
  });

  test("makes no Changes requests on load, Bot or Thread switch, Computer view, or panel close", async ({ page }) => {
    await interceptComputerSurface(page);
    const changesRequests = trackChangesRequests(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const botAId = await createBot(page, "Isolation Bot A");
    const threadOneId = await sendMessage(page, "say: Thread one workspace");
    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: "New conversation" }).click();
    const threadTwoId = await sendMessage(page, "say: Thread two workspace");
    const botBId = await createBot(page, "Isolation Bot B");
    expect(changesRequests).toEqual([]);

    await page.getByRole("button", { name: "Isolation Bot A", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`bot=${botAId}.*thread=${threadTwoId}`));
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const capabilities = page.getByRole("complementary", { name: "Workspace capabilities" });
    const settings = page.getByRole("complementary", { name: "Bot settings" });
    await expect(capabilities.getByRole("heading", { name: "Isolation Bot A’s screen" })).toBeVisible();
    await expectChangesAbsent(page);
    expect(changesRequests).toEqual([]);

    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: /Thread one workspace/ }).click();
    await expect(page).toHaveURL(new RegExp(`thread=${threadOneId}`));
    await expect(capabilities.getByRole("heading", { name: "Isolation Bot A’s screen" })).toBeVisible();
    await expect(
      page
        .getByRole("textbox", { name: "Message input", exact: true })
        .or(page.getByRole("combobox", { name: "Message input", exact: true }))
    ).toBeVisible();

    await page.getByRole("button", { name: "Isolation Bot B", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`bot=${botBId}`));
    await expect(capabilities.getByRole("heading", { name: "Isolation Bot B’s screen" })).toBeVisible();
    await expectChangesAbsent(page);

    await page.getByRole("button", { name: "Open settings for Isolation Bot B" }).click();
    await expect(capabilities).toHaveCount(0);
    await expect(settings).toBeVisible();
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(capabilities).toBeVisible();
    await expect(capabilities.getByRole("heading", { name: "Isolation Bot B’s screen" })).toBeVisible();

    await capabilities.getByRole("button", { name: "Close capabilities" }).click();
    await expect(page.getByRole("button", { name: "Open Computer Surface", exact: true })).toBeFocused();
    expect(changesRequests).toEqual([]);
  });
});
