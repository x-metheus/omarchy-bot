import { expect, test, type Page } from "../fixtures.ts";

function botNavigation(page: Page) {
  return page.getByRole("navigation", { name: "Bot navigation" });
}

async function openCreateDialog(page: Page): Promise<void> {
  await botNavigation(page).getByRole("button", { name: "New bot" }).click();
  await expect(page.getByRole("dialog", { name: "Create a bot" })).toBeVisible();
}

async function createBot(page: Page, name: string, instructions = ""): Promise<string> {
  await openCreateDialog(page);
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill(instructions);
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

test.describe("create bot flow", () => {
  test("repairs incompatible current avatar recipes before the browser renders", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.getByText("Something went wrong!")).toHaveCount(0);
    const recoveredBot = page.getByTestId("sidebar-bot-bot_00000000000000000000000000000001");
    await expect(recoveredBot).toBeVisible();
    await expect(recoveredBot.getByTestId("avatar-pixelbot").locator("img")).toHaveAttribute("src", /^data:image\/svg\+xml/);

    const deleted = await request.delete("/api/bots/bot_00000000000000000000000000000001", {
      data: {},
    });
    expect(deleted.ok()).toBe(true);
  });

  test("lists agent readiness and selects a newly created bot on a blank conversation", async ({ page }) => {
    await page.goto("/");
    await expect(botNavigation(page).getByRole("button", { name: /^Actions for / })).toHaveCount(0);
    const navigation = botNavigation(page);
    await expect(navigation.getByText("omarchy-bot", { exact: true })).toHaveCount(0);
    await expect(navigation.getByText("AI teammate workspace", { exact: true })).toHaveCount(0);
    const navigationBox = await navigation.boundingBox();
    const createBox = await navigation.getByRole("button", { name: "New bot" }).boundingBox();
    if (navigationBox === null || createBox === null) throw new Error("sidebar create action has no layout box");
    expect(navigationBox.x + navigationBox.width - (createBox.x + createBox.width)).toBeLessThanOrEqual(24);
    const settingsBox = await navigation.getByRole("button", { name: "Settings" }).boundingBox();
    if (settingsBox === null) throw new Error("sidebar settings action has no layout box");
    expect(settingsBox.width).toBeGreaterThanOrEqual(navigationBox.width - 32);

    await openCreateDialog(page);
    await expect(page.getByRole("radiogroup", { name: "Agent" }).getByRole("radio")).toHaveCount(9);

    const claude = page.getByRole("radio", { name: "Claude" });
    await expect(claude).toBeDisabled();
    await expect(claude).toHaveAccessibleDescription(/Not available in this installation/);
    await expect(page.getByRole("radio", { name: /^Pi/ })).toBeEnabled();

    await page.getByRole("button", { name: "Create bot" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Give this bot a name." })).toBeVisible();

    await page.getByRole("textbox", { name: "Name" }).fill("E2E Bot");
    await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Own release notes");
    await page.getByRole("radio", { name: /^Pi/ }).check();
    await page.getByRole("button", { name: "Create bot" }).click();

    await expect(page.getByRole("button", { name: "E2E Bot", exact: true })).toBeVisible();
    await expect(botNavigation(page).getByRole("button", { name: /^Actions for E2E Bot$/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "E2E Bot" })).toBeVisible();
    await expect(page).toHaveURL(/(?:\?|&)bot=bot_[0-9a-f]{32}(?:&|$)/);
    await expect(page).toHaveURL(/(?:\?|&)thread=blank(?:&|$)/);
    await expect(page.getByRole("textbox", { name: "Message input" })).toHaveText("");
    await expect(page.getByRole("log").getByRole("heading")).toHaveCount(0);
  });

  test("keeps two bots on the same agent as independent sidebar rows", async ({ page }) => {
    await page.goto("/");
    const firstId = await createBot(page, "Release Bot", "Prepare releases");
    const secondId = await createBot(page, "Support Bot", "Triage support");

    expect(firstId).not.toBe(secondId);
    await expect(page.getByRole("button", { name: "Release Bot", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Support Bot", exact: true })).toBeVisible();
  });

  test("uses the native Dialog lifecycle on desktop and restores mobile Bottom Sheet focus at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const desktopTrigger = botNavigation(page).getByRole("button", { name: "New bot" });
    await desktopTrigger.click();
    const desktopSurface = page.getByRole("dialog", { name: "Create a bot" });
    await expect(desktopSurface).toBeVisible();
    const desktopBox = await desktopSurface.boundingBox();
    expect(desktopBox?.width).toBeLessThan(600);
    await page.keyboard.press("Escape");
    await expect(desktopTrigger).toBeFocused();

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(botNavigation(page)).toBeHidden();
    const mobileNavTrigger = page.getByRole("button", { name: "Open bot navigation" });
    await mobileNavTrigger.click();
    const narrowTrigger = botNavigation(page).getByRole("button", { name: "New bot" });
    await expect(narrowTrigger).toBeVisible();
    await narrowTrigger.click();
    await expect(botNavigation(page)).toBeHidden();
    const narrowSurface = page.getByRole("dialog", { name: "Create a bot" });
    await expect(narrowSurface).toBeVisible();
    const narrowBox = await narrowSurface.boundingBox();
    expect(narrowBox?.width).toBe(390);
    await expect
      .poll(() => narrowSurface.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(mobileNavTrigger).toBeFocused();
  });
});
