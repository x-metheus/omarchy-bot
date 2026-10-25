import { expect, test } from "../fixtures.ts";

test.describe("single Bot lifecycle", () => {
  test("shows the startup-recovered Bot and only permanent removal controls", async ({ page }) => {
    await page.goto("/");

    const response = await page.request.get("/api/bots");
    expect(response.ok()).toBeTruthy();
    const bots = await response.json() as Array<Record<string, unknown>>;
    const recovered = bots.find((bot) => bot.id === "bot_legacy_archived");
    expect(recovered).toMatchObject({
      name: "Restored legacy bot",
      instructions: "Preserved legacy profile",
      previewText: "Recovered during startup",
      avatar: {
        kind: "generated",
        recipe: { style: "shapes", seed: "bot_legacy_archived" },
      },
    });
    expect(recovered).not.toHaveProperty("archived");

    const row = page.getByTestId("sidebar-bot-bot_legacy_archived");
    await expect(row).toBeVisible();
    await expect(page.getByRole("button", { name: "Restored legacy bot", exact: true })).toBeVisible();
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Restored legacy bot actions" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Bot Settings", "Delete"]);

    await page.keyboard.press("Escape");
    await page.getByRole("navigation", { name: "Bot navigation" })
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Bots" }).click();
    await expect(settings.getByTestId("settings-bot-bot_legacy_archived")).toContainText("Restored legacy bot");
    await expect(settings.getByRole("button", { name: "Delete Restored legacy bot" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Archive Restored legacy bot", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Restore Restored legacy bot", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: /Active bots|Archived bots/i })).toHaveCount(0);

    expect((await page.request.post("/api/bots/bot_legacy_archived/archive", { data: {} })).status()).toBe(404);
    expect((await page.request.post("/api/bots/bot_legacy_archived/restore", { data: {} })).status()).toBe(404);
  });
});
