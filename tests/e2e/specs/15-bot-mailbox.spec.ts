import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Durable Bot mailbox E2E fixture");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected Bot ID for ${name}`);
  return botId;
}

function composer(page: Page): Locator {
  return page
    .getByRole("textbox", { name: "Message input", exact: true })
    .or(page.getByRole("combobox", { name: "Message input", exact: true }));
}

test.describe("durable Bot mailbox", () => {
  test("shows the complete visible 1:1 mailbox flow in light and dark themes", async ({ page }) => {
    await page.goto("/");
    const suffix = Date.now();
    const targetName = `Review partner ${suffix}`;
    const sourceName = `Release coordinator ${suffix}`;
    const renamedSourceName = `Renamed ${sourceName}`;
    const targetBotId = await createBot(page, targetName);
    const sourceBotId = await createBot(page, sourceName);
    const body = "mailbox-ordered-output";

    await expect(composer(page)).toBeEnabled();
    await composer(page).fill(`send_bot_message:${targetBotId}:${body}:retry`);
    await composer(page).press("Enter");
    await expect(
      page.getByTestId("assistant-message").getByText(/^Bot message acknowledgements:/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("working-avatar")).toHaveCount(0, { timeout: 15_000 });

    await page.getByRole("button", { name: `Open settings for ${sourceName}` }).click();
    const botSettings = page.getByRole("complementary", { name: "Bot settings" });
    await botSettings.getByRole("textbox", { name: "Name" }).fill(renamedSourceName);
    await botSettings.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByRole("button", { name: renamedSourceName, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close bot settings" }).click();

    const targetRow = page.getByTestId(`sidebar-bot-${targetBotId}`);
    await expect(targetRow.getByLabel(/\d+ unread messages?$/)).toBeVisible();
    await targetRow.getByRole("button", { name: targetName, exact: true }).click();

    const peerMail = page.getByTestId("peer-mail-message");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(peerMail.getByText(`From ${sourceName}`, { exact: true })).toBeVisible();
      await expect(peerMail.getByText(body, { exact: true })).toBeVisible();
      await expect(page.getByTestId("assistant-message").getByText("Peer mail handled.", { exact: true })).toBeVisible();
      expect(await page.evaluate((scheme) => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme)).toBe(true);
    }

    await expect(page).toHaveURL(new RegExp(`(?:\\?|&)bot=${targetBotId}(?:&|$)`));
    await expect(targetRow.getByLabel(/\d+ unread messages?$/)).toHaveCount(0);
    const targetThreadId = new URL(page.url()).searchParams.get("thread");
    if (targetThreadId === null) throw new Error("unread navigation omitted the target Thread");

    const sourceRow = page.getByTestId(`sidebar-bot-${sourceBotId}`);
    await sourceRow.click({ button: "right" });
    await page.getByRole("menu", { name: `${renamedSourceName} actions` })
      .getByRole("menuitem", { name: "Delete" })
      .click();
    await page.getByRole("alertdialog", { name: `Delete ${renamedSourceName}?` })
      .getByRole("button", { name: "Delete permanently" })
      .click();
    await expect(sourceRow).toHaveCount(0);
    await expect(peerMail.getByText(`From ${sourceName}`, { exact: true })).toBeVisible();

    await composer(page).fill("send_bot_message:../../private:key");
    await composer(page).press("Enter");
    const errorCard = page.getByTestId("composer-error-card");
    await expect(errorCard).toContainText("target Bot ID is invalid", { timeout: 15_000 });
    await expect(errorCard).not.toContainText("../../private");
    await errorCard.getByRole("button", { name: "Close" }).click();
    await expect(errorCard).toHaveCount(0);
    await page.getByRole("button", { name: "Open conversation history" }).click();
    await expect(page.getByRole("dialog", { name: "Conversation history" })).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Conversation history" }).getByRole(
        "button",
        { name: `From ${sourceName} Conversation`, exact: true },
      ),
    ).toBeVisible();
  });
});
