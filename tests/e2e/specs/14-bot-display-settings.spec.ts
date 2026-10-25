import { expect, test, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Display settings teammate");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

async function openSettings(page: Page, botName: string): Promise<void> {
  await page.getByRole("button", { name: `Open settings for ${botName}` }).click();
  await expect(page.getByRole("complementary", { name: "Bot settings" })).toBeVisible();
}

test.describe("Bot Display Settings", () => {
  test("separates Profile and Display, defaults off, and explains unavailable Thinking", async ({ page }) => {
    await page.route("**/api/bots", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const bots = await response.json() as Array<Record<string, unknown>>;
      await route.fulfill({
        response,
        json: bots.map((bot) => ({ ...bot, thinkingAvailability: "unavailable" })),
      });
    });
    await createBot(page, "Quiet Display Bot");
    await openSettings(page, "Quiet Display Bot");

    const settings = page.getByRole("complementary", { name: "Bot settings" });
    await expect(settings.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Display" })).toBeVisible();
    await expect(settings.getByRole("switch", { name: "Show tool calls" })).not.toBeChecked();
    await expect(settings.getByRole("switch", { name: "Show Thinking" })).not.toBeChecked();
    await expect(settings.getByRole("switch", { name: "Show Thinking" })).toBeDisabled();
    await expect(settings).toContainText("does not provide Thinking and there is no retained Thinking history");
    await expect(settings).toContainText("Hidden content is still retained");
  });

  test("updates optimistically and restores the previous value with a non-blocking error", async ({ page }) => {
    const botId = await createBot(page, "Rollback Display Bot");
    await openSettings(page, "Rollback Display Bot");

    let releaseFailure: (() => void) | undefined;
    const failureReleased = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    await page.route(`**/api/bots/${botId}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await failureReleased;
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    const settings = page.getByRole("complementary", { name: "Bot settings" });
    const toolCalls = settings.getByRole("switch", { name: "Show tool calls" });
    await toolCalls.click();
    try {
      await expect(toolCalls).toBeChecked();
    } finally {
      releaseFailure?.();
    }

    await expect(toolCalls).not.toBeChecked();
    await expect(settings.getByText(/previous setting has been restored/i)).toBeVisible();
    await expect(settings).toBeVisible();
  });

  test("synchronizes the Bot preference to another application window", async ({ page, context }) => {
    await createBot(page, "Shared Display Bot");
    const secondWindow = await context.newPage();
    await secondWindow.goto("/");
    await expect(secondWindow.getByRole("button", { name: "Shared Display Bot", exact: true })).toBeVisible();

    await openSettings(page, "Shared Display Bot");
    await openSettings(secondWindow, "Shared Display Bot");
    const firstSwitch = page.getByRole("complementary", { name: "Bot settings" }).getByRole("switch", { name: "Show tool calls" });
    const secondSwitch = secondWindow.getByRole("complementary", { name: "Bot settings" }).getByRole("switch", { name: "Show tool calls" });
    await firstSwitch.click();

    await expect(firstSwitch).toBeChecked();
    await expect(secondSwitch).toBeChecked();
  });

  test("keeps retained Thinking available after current capability loss", async ({ page }) => {
    await createBot(page, "Historical Thinking Bot");
    await page.route("**/api/bots", async (route) => {
      const response = await route.fetch();
      const bots = await response.json() as Array<Record<string, unknown>>;
      await route.fulfill({ response, json: bots.map((bot) => ({ ...bot, thinkingAvailability: "history" })) });
    });
    await page.reload();
    await openSettings(page, "Historical Thinking Bot");

    const settings = page.getByRole("complementary", { name: "Bot settings" });
    await expect(settings.getByRole("switch", { name: "Show Thinking" })).toBeEnabled();
    await expect(settings).toContainText("no longer provides Thinking");
    await expect(settings).toContainText("retained Thinking remains available");
  });
});
