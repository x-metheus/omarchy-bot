import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Own thread history tests");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();

  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

function composerInput(page: Page): Locator {
  return page
    .getByRole("textbox", { name: "Message input", exact: true })
    .or(page.getByRole("combobox", { name: "Message input", exact: true }));
}

async function send(page: Page, text: string): Promise<string> {
  const input = composerInput(page);
  await input.fill(text);
  await input.press("Enter");
  await page.waitForURL((url) => {
    const threadId = url.searchParams.get("thread");
    return threadId !== null && threadId !== "blank";
  });
  await expect(page.getByTestId("assistant-message").last()).toBeVisible();
  return new URL(page.url()).searchParams.get("thread")!;
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open conversation history" }).click();
  await expect(page.getByRole("dialog", { name: "Conversation history" })).toBeVisible();
}

test.describe("thread history and window drafts", () => {
  test("searches history, opens a blank conversation lazily, and restores isolated drafts", async ({ page }) => {
    await page.goto("/");
    const botId = await createBot(page, "History E2E Bot");
    const firstThreadId = await send(page, "say: First history answer");

    await openHistory(page);
    await page.getByRole("textbox", { name: "Search conversations" }).fill("does not exist");
    await expect(page.getByText("No matching conversations")).toBeVisible();
    await page.getByRole("textbox", { name: "Search conversations" }).fill("First history");
    await expect(page.getByRole("button", { name: /First history answer/ })).toBeVisible();
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page).toHaveURL(new RegExp(`(?:\\?|&)bot=${botId}(?:&|$)`));
    await expect(page).toHaveURL(/(?:\?|&)thread=blank(?:&|$)/);

    await composerInput(page).fill("blank conversation draft");
    await openHistory(page);
    await page.getByRole("button", { name: /First history answer/ }).click();
    await expect(page).toHaveURL(new RegExp(`(?:\\?|&)thread=${firstThreadId}(?:&|$)`));
    await expect(composerInput(page)).toHaveText("");

    await composerInput(page).fill("first thread draft");
    await openHistory(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(composerInput(page)).toHaveText("blank conversation draft");

    await openHistory(page);
    await page.getByRole("button", { name: /First history answer/ }).click();
    await expect(composerInput(page)).toHaveText("first thread draft");
  });

  test("uses a Dialog on desktop and a viewport-contained Bottom Sheet at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await createBot(page, "Responsive History Bot");
    const trigger = page.getByRole("button", { name: "Open conversation history" });
    await openHistory(page);
    const desktopHistory = page.getByRole("dialog", { name: "Conversation history" });
    const desktopBox = await desktopHistory.boundingBox();
    expect(desktopBox?.width).toBeLessThan(640);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();

    await page.setViewportSize({ width: 390, height: 780 });
    await openHistory(page);
    const narrowHistory = page.getByRole("dialog", { name: "Conversation history" });
    const narrowBox = await narrowHistory.boundingBox();
    expect(narrowBox?.width).toBe(390);
    await expect
      .poll(() => narrowHistory.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  });

  test("restores after refresh without sharing a draft with a second page", async ({ page }) => {
    await page.goto("/");
    await createBot(page, "Window Draft E2E Bot");
    await send(page, "say: Window draft thread");
    await composerInput(page).fill("only in the first window");
    const selectedUrl = page.url();

    await page.reload();
    await expect(composerInput(page)).toHaveText("only in the first window");

    const secondPage = await page.context().newPage();
    try {
      await secondPage.goto(selectedUrl);
      await expect(composerInput(secondPage)).toHaveText("");
      await composerInput(secondPage).fill("second window draft");
      await expect(composerInput(page)).toHaveText("only in the first window");
    } finally {
      await secondPage.close();
    }
  });

});
