import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ApprovalDto, BotDto, SendResultDto } from "../../../packages/protocol/src/api.ts";
import { expect, test, type Page, type Route } from "../fixtures.ts";

const run = promisify(execFile);

async function seedApproval(threadId: string, botId: string, tool: ApprovalDto["tool"], filePath: string): Promise<string> {
  const script = path.resolve(import.meta.dirname, "../seed-approval.ts");
  const { stdout } = await run("bun", [script, threadId, botId, tool, filePath]);
  return stdout.trim();
}

async function selectThread(page: Page, title: string): Promise<void> {
  const history = page.getByRole("button", { name: "Open conversation history", exact: true });
  const dialog = page.getByRole("dialog", { name: "Conversation history" });
  await history.click();
  await dialog.getByRole("button", { name: title }).click();
  await expect(dialog).toBeHidden();
  await expect(history).toBeFocused();
}

test("shows approvals on their own Threads and handles keyboard and external answers", async ({ page, request }) => {
  const botName = "File Approval Bot";
  const botResponse = await request.post("/api/bots", { data: { name: botName } });
  expect(botResponse.status()).toBe(201);
  const { id: botId } = await botResponse.json() as BotDto;
  const firstTitle = "Quarterly report approval";
  const firstSend = await request.post(`/api/bots/${botId}/messages`, { data: { text: `say: ${firstTitle}` } });
  expect(firstSend.status()).toBe(202);
  const { threadId: firstThreadId } = await firstSend.json() as SendResultDto;
  const secondTitle = "Summary approval";
  const secondSend = await request.post(`/api/bots/${botId}/messages`, { data: { text: `say: ${secondTitle}` } });
  expect(secondSend.status()).toBe(202);
  const { threadId: secondThreadId } = await secondSend.json() as SendResultDto;
  expect(secondThreadId).not.toBe(firstThreadId);

  const firstPath = `/projects/reports/${"quarterly-report-".repeat(12)}draft\u202Etxt.pdf`;
  const firstId = await seedApproval(firstThreadId, botId, "edit", firstPath);
  const followingId = await seedApproval(firstThreadId, botId, "write", "/projects/reports/appendix.txt");
  const secondPath = "/projects/reports/summary.txt";
  const secondId = await seedApproval(secondThreadId, botId, "write", secondPath);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.clock.install();
  await page.goto(`/?${new URLSearchParams({ bot: botId, thread: secondThreadId })}`, { waitUntil: "domcontentloaded" });
  const cards = page.getByTestId("pending-approval-card");
  const first = cards.and(page.locator(`[data-approval-id="${firstId}"]`));
  const following = cards.and(page.locator(`[data-approval-id="${followingId}"]`));
  const second = cards.and(page.locator(`[data-approval-id="${secondId}"]`));
  await expect(second.getByText(secondPath, { exact: true })).toBeVisible();
  await expect(second.getByText(`${botName} wants to write a file`, { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(first).toHaveCount(0);

  const secondApprovalsUrl = `**/api/approvals?threadId=${secondThreadId}`;
  const failApprovals = async (route: Route): Promise<void> => {
    await route.fulfill({ status: 503, json: { error: "Approvals temporarily unavailable" } });
  };
  await page.route(secondApprovalsUrl, failApprovals);
  await page.clock.fastForward(15_001);
  const approvalsError = page.getByRole("alert").filter({ hasText: "Approvals could not be loaded" });
  await expect(approvalsError).toContainText("Approvals temporarily unavailable");
  await expect(second).toBeVisible();
  await page.unroute(secondApprovalsUrl, failApprovals);
  await approvalsError.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(approvalsError).toHaveCount(0);
  await expect(second).toBeVisible();

  await selectThread(page, firstTitle);
  await expect(first).toBeVisible();
  await expect(cards).toHaveCount(2);
  await expect(second).toHaveCount(0);
  await expect(first).toHaveRole("alert");
  await expect(first.getByText(`${botName} wants to edit a file`, { exact: true })).toBeVisible();
  await expect(first.getByText(`escaped: ${firstPath.replace("\u202E", "\\u202e")}`, { exact: true })).toBeVisible();
  expect(await first.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(first.getByRole("button")).toHaveCount(3);
  const allowOnce = first.getByRole("button", { name: "Allow once", exact: true });
  const allowFolder = first.getByRole("button", { name: "Always allow this folder", exact: true });
  const deny = first.getByRole("button", { name: "Deny", exact: true });
  await allowOnce.focus();
  await expect(allowOnce).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(allowFolder).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(deny).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(allowOnce).toBeFocused();

  const firstAnswerUrl = `**/api/approvals/${firstId}/answer`;
  await page.route(firstAnswerUrl, (route) =>
    route.fulfill({ status: 503, json: { error: "Answer temporarily unavailable" } }), { times: 1 });
  await page.keyboard.press("Enter");
  await expect(first).toContainText("Answer temporarily unavailable");
  await expect(allowOnce).toBeEnabled();
  await expect(allowOnce).toBeFocused();

  const firstAnswer = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/approvals/${firstId}/answer` && response.request().method() === "POST"
  );
  const proceed = Promise.withResolvers<void>();
  await page.route(firstAnswerUrl, async (route) => {
    await proceed.promise;
    await route.continue();
  }, { times: 1 });
  try {
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("aria-busy", "true");
    for (const button of [allowOnce, allowFolder, deny]) await expect(button).toBeDisabled();
  } finally {
    proceed.resolve();
  }
  const resolved = await firstAnswer;
  expect(resolved.ok()).toBe(true);
  expect(await resolved.json()).toMatchObject({ id: firstId, path: firstPath, status: "allowed_once" });
  await expect(first).toHaveCount(0);
  await expect(following.getByRole("button", { name: "Allow once", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(following).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  const pending = await request.get("/api/approvals");
  expect(pending.ok()).toBe(true);
  expect((await pending.json() as ApprovalDto[]).map(({ id }) => id)).not.toContain(firstId);

  // Age the cached query so reselecting the Thread triggers a GET before the answer starts.
  await page.clock.fastForward(5_001);
  // Start the deadline before reselecting the Thread so its 15-second poll cannot explain the removal.
  const deadline = performance.now() + 8_000;
  const remaining = (): number => {
    const ms = Math.ceil(deadline - performance.now());
    expect(ms, "external answer and removal deadline").toBeGreaterThan(0);
    return ms;
  };
  const reloadSecond = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.ok() && response.request().method() === "GET"
      && url.pathname === "/api/approvals" && url.searchParams.get("threadId") === secondThreadId;
  }, { timeout: remaining() });
  await selectThread(page, secondTitle);
  await (await reloadSecond).finished();
  await expect(second).toBeVisible({ timeout: remaining() });
  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  await test.step("External answer and removal within the 8-second budget", async () => {
    const answer = await request.post(`/api/approvals/${secondId}/answer`, {
      data: { answer: "deny" },
      timeout: remaining(),
    });
    expect(answer.ok()).toBe(true);
    expect(await answer.json()).toMatchObject({ id: secondId, status: "denied" });
    await expect(second).toHaveCount(0, { timeout: remaining() });
    remaining();
  });
  expect(mainFrameNavigations).toBe(0);
  const afterExternalAnswer = await request.get("/api/approvals");
  expect(afterExternalAnswer.ok()).toBe(true);
  expect((await afterExternalAnswer.json() as ApprovalDto[]).map(({ id }) => id)).not.toContain(secondId);
});
