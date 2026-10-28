import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Local deletion E2E bot");
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

function deletionConfirmation(page: Page, botName: string): Locator {
  return page.getByRole("alertdialog", { name: `Delete ${botName}?` });
}

test.describe("direct local Bot deletion", () => {
  test("opens the pointer-only Sidebar menu, keeps Bot Settings reachable, cancels unchanged, then deletes and falls back", async ({ page, context, request }) => {
    await page.goto("/");
    const otherSelectedBotId = await createBot(page, "Other window selection");
    const otherPage = await context.newPage();
    await otherPage.goto(`/?bot=${otherSelectedBotId}&thread=blank`);
    await expect(otherPage.getByRole("button", { name: "Other window selection", exact: true })).toBeVisible();

    const fallbackBotId = await createBot(page, "Deletion fallback");
    await expect(otherPage.getByRole("button", { name: "Deletion fallback", exact: true })).toBeVisible();
    const botName = "Delete from Sidebar";
    const botId = await createBot(page, botName);
    await expect(otherPage.getByRole("button", { name: botName, exact: true })).toBeVisible();
    await composerInput(page).fill("known draft before deletion");
    const draftKey = `draft:v1:${botId}:blank`;
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).not.toBeNull();
    const otherTargetDraftKey = `draft:v1:${botId}:unselected`;
    const siblingDraftKey = `draft:v1:${fallbackBotId}:blank`;
    await otherPage.evaluate(
      ({ targetKey, siblingKey }) => {
        const draft = JSON.stringify({ text: "other-window draft", cursor: 18, stagedIds: [] });
        sessionStorage.setItem(targetKey, draft);
        sessionStorage.setItem(siblingKey, draft);
      },
      { targetKey: otherTargetDraftKey, siblingKey: siblingDraftKey },
    );

    const botRow = page.getByTestId(`sidebar-bot-${botId}`);
    const menu = page.getByRole("menu", { name: `${botName} actions` });
    const botButton = page.getByRole("navigation", { name: "Bot navigation" })
      .getByRole("button", { name: botName, exact: true });
    await botButton.focus();
    await botButton.press("Shift+F10");
    await expect(menu).toHaveCount(0);

    await botRow.click({ button: "right" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText(["Bot Settings", "Delete"]);
    await menu.getByRole("menuitem", { name: "Bot Settings" }).click();
    await expect(page.getByRole("complementary", { name: "Bot settings" })).toBeVisible();
    await page.getByRole("button", { name: "Close bot settings" }).click();

    await botRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const confirmation = deletionConfirmation(page, botName);
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(botName);
    await expect(confirmation).toContainText("conversations");
    await expect(confirmation).toContainText("managed attachments");
    await expect(confirmation).toContainText("Agent-owned Native Sessions may remain");

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(botRow).toBeVisible();
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).not.toBeNull();

    await botRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete permanently" }).click();

    await expect(botRow).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`(?:\\?|&)bot=${fallbackBotId}(?:&|$)`));
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
    await expect.poll(() => otherPage.evaluate((key) => sessionStorage.getItem(key), otherTargetDraftKey)).toBeNull();
    await expect.poll(() => otherPage.evaluate((key) => sessionStorage.getItem(key), siblingDraftKey)).not.toBeNull();
    expect((await request.get(`/api/bots/${botId}`)).status()).toBe(404);
  });

  test("warns before stopping active work from the Sidebar, cancels without effects, then deletes after the Turn stops", async ({ page, request }) => {
    await page.goto("/");
    const fallbackBotId = await createBot(page, "Active deletion fallback");
    const botName = "Delete active from Sidebar";
    const botId = await createBot(page, botName);
    await composerInput(page).fill("hang");
    await composerInput(page).press("Enter");
    await page.waitForURL((url) => {
      const threadId = url.searchParams.get("thread");
      return threadId !== null && threadId !== "blank";
    });
    const threadId = new URL(page.url()).searchParams.get("thread")!;
    const draftKey = `draft:v1:${botId}:${threadId}`;
    await composerInput(page).fill("draft remains when active deletion is cancelled");
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).not.toBeNull();
    const botRow = page.getByTestId(`sidebar-bot-${botId}`);
    await expect(botRow.getByTestId("sidebar-activity-point")).toBeVisible();

    await botRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const confirmation = deletionConfirmation(page, botName);
    await expect(confirmation).toContainText(`${botName} has active work`);
    await expect(confirmation).toContainText("stop all of this Bot’s current work");
    await confirmation.getByRole("button", { name: "Cancel" }).click();

    await expect(confirmation).not.toBeVisible();
    await expect(botRow.getByTestId("sidebar-activity-point")).toBeVisible();
    const unchangedThread = await request.get(`/api/threads/${threadId}`);
    expect(unchangedThread.ok()).toBeTruthy();
    expect((await unchangedThread.json() as { activeTurn?: { id: string } }).activeTurn?.id).toBeTruthy();
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).not.toBeNull();

    await botRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete permanently" }).click();

    await expect(botRow).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`(?:\\?|&)bot=${fallbackBotId}(?:&|$)`));
    expect((await request.get(`/api/bots/${botId}`)).status()).toBe(404);
    expect((await request.get(`/api/threads/${threadId}`)).status()).toBe(404);
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
  });

  test("deletes from Settings and recovers a stale selected URL to the empty workspace", async ({ page, request }) => {
    const existing = await request.get("/api/bots");
    const bots = await existing.json() as Array<{ id: string; status: string }>;
    for (const bot of bots) {
      const response = await request.delete(`/api/bots/${bot.id}`, { data: {} });
      expect(response.ok()).toBeTruthy();
    }

    await page.goto("/");
    const botName = "Delete from Settings";
    const botId = await createBot(page, botName);
    await composerInput(page).fill("hang");
    await composerInput(page).press("Enter");
    await page.waitForURL((url) => {
      const threadId = url.searchParams.get("thread");
      return threadId !== null && threadId !== "blank";
    });
    await expect(page.getByTestId(`sidebar-bot-${botId}`).getByTestId("sidebar-activity-point")).toBeVisible();
    let failCleanup = true;
    await page.route(`**/api/bots/${botId}`, async (route) => {
      if (route.request().method() !== "DELETE" || !failCleanup) {
        await route.continue();
        return;
      }
      failCleanup = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          status: "failed",
          botId,
          botName,
          removed: {
            threads: 0,
            messages: 0,
            turns: 0,
            attachments: 0,
            avatar: false,
            computerArtifacts: 0,
            surface: false,
          },
          failures: [{ stage: "database", resource: botId, message: "simulated local cleanup failure" }],
        }),
      });
    });
    await page.getByRole("navigation", { name: "Bot navigation" })
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Bots" }).click();
    await settings.getByRole("button", { name: `Delete ${botName}` }).click();
    await expect(deletionConfirmation(page, botName)).toBeVisible();
    await expect(deletionConfirmation(page, botName)).toContainText("stop all of this Bot’s current work");
    await page.getByRole("button", { name: "Delete permanently" }).click();
    const retryConfirmation = page.getByRole("alertdialog", { name: `Couldn’t delete ${botName}` });
    await expect(retryConfirmation).toContainText(`${botName} remains available`);
    await expect(retryConfirmation).toContainText("simulated local cleanup failure");
    await expect(settings.getByRole("button", { name: `Delete ${botName}` })).toBeVisible();
    await retryConfirmation.getByRole("button", { name: "Try again" }).click();

    await expect(settings.getByRole("button", { name: `Delete ${botName}` })).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
    expect((await request.get(`/api/bots/${botId}`)).status()).toBe(404);
  });
});
