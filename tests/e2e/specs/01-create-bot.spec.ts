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

  test("requires a name and selects the newly created bot on a blank conversation", async ({ page }) => {
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
    const dialog = page.getByRole("dialog", { name: "Create a bot" });
    const name = dialog.getByRole("textbox", { name: "Name" });
    const instructions = dialog.getByRole("textbox", { name: "Job / Instructions" });
    const submit = dialog.getByRole("button", { name: "Create bot" });
    await expect(dialog.getByRole("radiogroup", { name: "Agent" })).toHaveCount(0);
    await expect(name).toHaveAttribute("aria-required", "true");
    await expect(instructions).not.toHaveAttribute("aria-required", "true");

    await submit.click();
    await expect(dialog.getByRole("alert").filter({ hasText: "Give this bot a name." })).toBeVisible();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription("Enter a name.");
    await expect(name).toBeFocused();

    await name.fill("E2E Bot");
    await instructions.fill("Own release notes");
    const [created] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/bots"),
      submit.click(),
    ]);
    expect(created.request().postDataJSON()).toEqual({ name: "E2E Bot", instructions: "Own release notes" });
    expect(created.ok()).toBe(true);
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("button", { name: "E2E Bot", exact: true })).toBeVisible();
    await expect(botNavigation(page).getByRole("button", { name: /^Actions for E2E Bot$/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "E2E Bot" })).toBeVisible();
    await expect(page).toHaveURL(/(?:\?|&)bot=bot_[0-9a-f]{32}(?:&|$)/);
    await expect(page).toHaveURL(/(?:\?|&)thread=blank(?:&|$)/);
    await expect(
      page
        .getByRole("textbox", { name: "Message input", exact: true })
        .or(page.getByRole("combobox", { name: "Message input", exact: true }))
    ).toHaveText("");
    await expect(page.getByRole("log").getByRole("heading")).toHaveCount(0);
  });

  test("discards a failed create request after the dialog is dismissed", async ({ page }) => {
    const createRequested = Promise.withResolvers<void>();
    const releaseFailure = Promise.withResolvers<void>();
    await page.route("**/api/bots", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      createRequested.resolve();
      await releaseFailure.promise;
      await route.fulfill({ status: 500, json: { error: "Test create failure" } });
    });

    await page.goto("/");
    await openCreateDialog(page);
    const dialog = page.getByRole("dialog", { name: "Create a bot" });
    const name = dialog.getByRole("textbox", { name: "Name" });
    const submit = dialog.getByTestId("create-bot-submit");
    await name.fill("Dismissed Bot");
    await submit.click();
    await createRequested.promise;

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const response = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/bots");
    releaseFailure.resolve();
    expect((await response).status()).toBe(500);

    await botNavigation(page).getByRole("button", { name: "New bot" }).press("Enter");
    await expect(dialog).toBeVisible();
    await expect(submit).toBeEnabled();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  test("creates a bot with blank instructions", async ({ page }) => {
    await page.goto("/");
    const [created] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/bots"),
      createBot(page, "Name Only Bot"),
    ]);
    expect(created.request().postDataJSON()).toEqual({ name: "Name Only Bot", instructions: "" });
    expect(created.ok()).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: "Name Only Bot" })).toBeVisible();
  });

  test("keeps two created bots as independent sidebar rows", async ({ page }) => {
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
