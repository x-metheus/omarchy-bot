import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Sidebar attention E2E bot");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

function composerInput(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

async function sendAndWait(page: Page, text: string): Promise<string> {
  const priorReplies = await page.getByTestId("assistant-message").count();
  const sendResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && /^\/api\/(?:bots|threads)\/[^/]+\/messages$/u.test(new URL(response.url()).pathname)
  );
  await composerInput(page).fill(text);
  await composerInput(page).press("Enter");

  const sendResponse = await sendResponsePromise;
  expect(sendResponse.status()).toBe(202);
  const result = await sendResponse.json() as {
    action: "sent" | "steered";
    threadId: string;
    turnId: string;
  };
  expect(result.action).toBe("sent");
  await expect(page.getByTestId("assistant-message")).toHaveCount(priorReplies + 1, { timeout: 15_000 });
  await expect.poll(async () => {
    const response = await page.request.get(`/api/threads/${result.threadId}`);
    if (!response.ok()) return undefined;
    const thread = await response.json() as { latestTurn?: { id: string; status: string } };
    return thread.latestTurn === undefined
      ? undefined
      : `${thread.latestTurn.id}:${thread.latestTurn.status}`;
  }, { timeout: 15_000 }).toBe(`${result.turnId}:completed`);
  await expect(page.getByTestId("working-avatar")).toHaveCount(0, { timeout: 15_000 });
  return result.threadId;
}

async function currentThreadId(page: Page): Promise<string> {
  await page.waitForURL((url) => {
    const threadId = url.searchParams.get("thread");
    return threadId !== null && threadId !== "blank";
  });
  const threadId = new URL(page.url()).searchParams.get("thread");
  if (threadId === null || threadId === "blank") throw new Error("expected a persisted Thread");
  return threadId;
}

async function postMessage(page: Page, threadId: string, text: string): Promise<void> {
  const response = await page.request.post(`/api/threads/${threadId}/messages`, { data: { text } });
  expect(response.status()).toBe(202);
}

async function scrollTranscriptToTop(page: Page): Promise<void> {
  await page.getByRole("log").evaluate((root) => {
    const container = root as HTMLElement;
    const candidates: HTMLElement[] = [container, ...container.querySelectorAll<HTMLElement>("*")];
    let ancestor = container.parentElement;
    while (ancestor !== null) {
      candidates.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    const viewport = candidates.find((candidate) => candidate.scrollHeight > candidate.clientHeight + 8);
    if (viewport === undefined) throw new Error("transcript did not overflow");
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
}

test.describe("Sidebar attention", () => {
  test("orders by recency and startup opens the most recently active Bot", async ({ page }) => {
    await page.goto("/");
    const olderBotName = `Older ${Date.now()}`;
    const olderBotId = await createBot(page, olderBotName);
    await sendAndWait(page, "say: older useful preview");
    const olderThreadId = await currentThreadId(page);

    const navigation = page.getByRole("navigation", { name: "Bot navigation" });
    const olderBotRow = navigation.getByTestId(`sidebar-bot-${olderBotId}`);
    await expect(olderBotRow).not.toHaveAttribute("draggable", "true");
    await expect(navigation.getByTestId("sidebar-pinned-zone")).toHaveCount(0);

    const recentBotName = `Recent ${Date.now()}`;
    const recentBotId = await createBot(page, recentBotName);
    await sendAndWait(page, "say: newest useful preview");
    const orderedBots = navigation
      .getByRole("button", { name: new RegExp(`^(?:${olderBotName}|${recentBotName})$`) });
    await expect(orderedBots.first()).toHaveAccessibleName(recentBotName);

    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`(?:\\?|&)bot=${recentBotId}(?:&|$)`));
    const olderThreads = await page.request.get(`/api/bots/${olderBotId}/threads`);
    const threads = await olderThreads.json() as Array<{ id: string }>;
    expect(threads[0]?.id).toBe(olderThreadId);
  });

  test("keeps unread above the latest output and clears it through the native latest control", async ({ page }) => {
    await page.goto("/");
    const botId = await createBot(page, `Unread boundary ${Date.now()}`);
    let selectedThreadId: string | undefined;
    for (let index = 0; index < 5; index += 1) {
      const completedThreadId = await sendAndWait(
        page,
        `say: ${index} ${"long transcript output ".repeat(20)}`,
      );
      selectedThreadId ??= completedThreadId;
      expect(completedThreadId).toBe(selectedThreadId);
      expect(new URL(page.url()).searchParams.get("thread")).toBe(selectedThreadId);
    }
    const threadId = await currentThreadId(page);
    await scrollTranscriptToTop(page);

    await postMessage(page, threadId, "say: background output at the precise read boundary");
    await expect(page.getByRole("navigation", { name: "Bot navigation" }).getByLabel("1 unread message")).toBeVisible({ timeout: 15_000 });
    const scrollToLatest = page.getByRole("button", { name: "New messages" });
    await expect(scrollToLatest).toBeVisible();

    await scrollToLatest.click();
    await expect(page.getByRole("navigation", { name: "Bot navigation" }).getByLabel("1 unread message")).toHaveCount(0, { timeout: 15_000 });
    await expect(scrollToLatest).toBeHidden();
  });

  test("keeps completion notifications state-driven while process-only output leaves Sidebar attention unchanged", async ({ page }) => {
    await page.addInitScript(() => {
      const state = globalThis as typeof globalThis & {
        __notificationCalls: Array<{ title: string; body?: string }>;
        __notificationPermissionRequests: number;
      };
      state.__notificationCalls = [];
      state.__notificationPermissionRequests = 0;
      class NotificationStub {
        static permission: NotificationPermission = "granted";
        static async requestPermission(): Promise<NotificationPermission> {
          state.__notificationPermissionRequests += 1;
          return "granted";
        }
        constructor(title: string, options?: NotificationOptions) {
          state.__notificationCalls.push({ title, ...(options?.body !== undefined ? { body: options.body } : {}) });
        }
      }
      Object.defineProperty(globalThis, "Notification", { configurable: true, value: NotificationStub });
    });
    await page.goto("/");

    const affectedBotId = await createBot(page, `Notification target ${Date.now()}`);
    await sendAndWait(page, "say: focused completion is quiet");
    const affectedThreadId = await currentThreadId(page);
    const markedRead = await page.request.post(`/api/bots/${affectedBotId}/read`, {
      data: { threadId: affectedThreadId },
    });
    expect(markedRead.ok()).toBe(true);
    const affectedRow = page.getByTestId(`sidebar-bot-${affectedBotId}`);
    await expect(affectedRow.getByLabel("1 unread message")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __notificationCalls: unknown[] }).__notificationCalls.length)).toBe(0);

    await createBot(page, `Other selected ${Date.now()}`);
    await expect(affectedRow).toContainText("focused completion is quiet");

    await postMessage(page, affectedThreadId, "process-only");
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __notificationCalls: unknown[] }).__notificationCalls.length), { timeout: 15_000 }).toBe(1);
    await expect(affectedRow).toContainText("focused completion is quiet");
    await expect(affectedRow.getByLabel("1 unread message")).toHaveCount(0);

    await postMessage(page, affectedThreadId, "say: background completion notifies");
    await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __notificationCalls: unknown[] }).__notificationCalls.length), { timeout: 15_000 }).toBe(2);
    const notifications = await page.evaluate(() => (globalThis as typeof globalThis & { __notificationCalls: Array<{ title: string }> }).__notificationCalls);
    expect(notifications.every((notification) => notification.title.includes("finished working"))).toBe(true);
    expect(notifications.every((notification) => notification.title.includes("Notification target"))).toBe(true);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __notificationPermissionRequests: number }).__notificationPermissionRequests)).toBe(0);
    await expect(affectedRow.getByLabel("1 unread message")).toBeVisible();
    await expect(affectedRow).toContainText("background completion notifies");
  });
});
