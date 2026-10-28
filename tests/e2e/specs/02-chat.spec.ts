import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("E2E chat teammate");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();

  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

function composerInput(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input", exact: true })
    .or(page.getByRole("combobox", { name: "Message input", exact: true }));
}

async function send(page: Page, text: string): Promise<void> {
  const input = composerInput(page);
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press("Enter");
}

async function waitForPersistedThread(page: Page): Promise<string> {
  await page.waitForURL((url) => {
    const threadId = url.searchParams.get("thread");
    return threadId !== null && threadId !== "blank";
  });
  const threadId = new URL(page.url()).searchParams.get("thread");
  if (threadId === null || threadId === "blank") throw new Error("thread URL state was not persisted");
  return threadId;
}

function fakeProbeFile(): string {
  const state = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../.daemon.json"), "utf8"),
  ) as { runDir: string };
  return path.join(state.runDir, "data", "conformance", "pi-fake-pi-1.json");
}

function setFakeProbe(control: Record<string, unknown>): void {
  writeFileSync(fakeProbeFile(), JSON.stringify({ ok: true, ...control }));
}

async function recordAnnouncements(page: Page, testId: string, storageKey: string): Promise<void> {
  await page.getByTestId(testId).waitFor({ state: "attached" });
  await page.evaluate(({ testId, storageKey }) => {
    sessionStorage.setItem(storageKey, "[]");
    const region = document.querySelector(`[data-testid="${testId}"]`);
    if (region === null) throw new Error(`missing ${testId} region`);
    new MutationObserver(() => {
      const text = region.textContent?.trim();
      if (text === undefined || text.length === 0) return;
      const announcements = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]") as string[];
      announcements.push(text);
      sessionStorage.setItem(storageKey, JSON.stringify(announcements));
    }).observe(region, { childList: true, characterData: true, subtree: true });
  }, { testId, storageKey });
}

async function announcementBoundaries(page: Page, storageKey: string): Promise<string[]> {
  return page.evaluate((key) =>
    (JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[])
      .flatMap((announcement) => announcement.split(/\.\s+/))
      .map((announcement) => announcement.trim())
      .filter((announcement) => announcement.length > 0), storageKey);
}

async function expectCardAboveComposer(page: Page): Promise<void> {
  const card = page.getByTestId("composer-error-card");
  const composer = page.getByTestId("composer");
  await expect(card).toBeVisible();
  const [cardBox, composerBox] = await Promise.all([card.boundingBox(), composer.boundingBox()]);
  expect(cardBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(composerBox!.y);
}

test.describe("chat through a bot", () => {
  test("owns the Skill commands popup and sends a multiword draft across input roles", async ({ page }) => {
    await page.goto("/");
    await createBot(page, "Composer Roles Bot");

    const input = composerInput(page);
    const combobox = page.getByRole("combobox", { name: "Message input", exact: true });
    const textbox = page.getByRole("textbox", { name: "Message input", exact: true });
    const skills = page.getByRole("listbox", { name: "Skill commands", exact: true });
    await expect(combobox).toHaveAttribute("aria-haspopup", "listbox");
    await expect(combobox).toHaveAttribute("aria-expanded", "false");

    await input.fill("/");
    await expect(skills).toBeVisible();
    await expect(combobox).toHaveAttribute("aria-expanded", "true");
    const popupId = await skills.getAttribute("id");
    expect(popupId).not.toBeNull();
    await expect(combobox).toHaveAttribute("aria-controls", popupId!);
    await input.press("Escape");
    await expect(skills).toHaveCount(0);
    await expect(combobox).toHaveAttribute("aria-expanded", "false");

    await input.fill("say: multiple words");
    await expect(textbox).toHaveText("say: multiple words");
    await expect(textbox).not.toHaveAttribute("aria-haspopup");
    await input.press("Enter");
    await expect(page.getByTestId("assistant-message").last()).toContainText("multiple words");
    await expect(combobox).toHaveText("");
  });

  test("abandons a blank draft without creating a thread", async ({ page, request }) => {
    await page.goto("/");
    const botId = await createBot(page, "Blank Conversation Bot");
    await expect(page).toHaveURL(/(?:\?|&)thread=blank(?:&|$)/);

    await composerInput(page).fill("never sent");
    await page.waitForTimeout(200);

    const response = await request.get(`/api/bots/${botId}/threads`);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toEqual([]);
  });

  test("keeps the Composer compact with accessible circular footer actions", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await page.goto("/");
    await createBot(page, "Composer Dock Bot");

    const composer = page.getByTestId("composer");
    const input = composerInput(page);
    const attach = composer.getByRole("button", { name: "Attach files" });
    const microphone = composer.getByRole("button", { name: /voice recording|voice dictation|Transcribing voice/i });
    const sendButton = composer.getByRole("button", { name: "Send", exact: true });
    await expect(composer).toHaveAttribute("data-density", "compact");
    await expect(attach).toHaveAttribute("data-size", "md");
    await expect(microphone).toHaveCount(0);
    await expect(sendButton).toHaveAttribute("data-size", "md");

    const dockPresentation = async (): Promise<{
      actionBoxes: Array<{
        x: number;
        width: number;
        height: number;
        centerY: number;
        radius: number;
        transitionDuration: string;
      }>;
      backgroundColor: string;
      borderWidth: string;
      boxShadow: string;
    }> => {
      const actions = await Promise.all([attach, sendButton].map((action) => action.elementHandle()));
      return input.evaluate((editable, actions) => {
        if (actions.some((action) => action === null)) {
          throw new Error("Composer controls are incomplete");
        }
        let surface: HTMLElement | null = editable.parentElement;
        while (surface !== null && !actions.every((action) => action !== null && surface?.contains(action))) {
          surface = surface.parentElement;
        }
        if (surface === null) throw new Error("Composer controls do not share one dock surface");
        const style = getComputedStyle(surface);
        return {
          actionBoxes: actions.map((action) => {
            const box = action!.getBoundingClientRect();
            const actionStyle = getComputedStyle(action!);
            return {
              x: box.x,
              width: box.width,
              height: box.height,
              centerY: box.y + box.height / 2,
              radius: Number.parseFloat(actionStyle.borderTopLeftRadius),
              transitionDuration: actionStyle.transitionDuration,
            };
          }),
          backgroundColor: style.backgroundColor,
          borderWidth: style.borderTopWidth,
          boxShadow: style.boxShadow,
        };
      }, actions);
    };

    const lightDock = await dockPresentation();
    expect(lightDock.borderWidth).toBe("0px");
    expect(lightDock.boxShadow).not.toBe("none");
    expect(lightDock.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    for (const action of lightDock.actionBoxes) {
      expect(action.width).toBe(action.height);
      expect(action.radius).toBeGreaterThanOrEqual(action.height / 2);
    }
    expect(lightDock.actionBoxes[0]!.centerY).toBeCloseTo(lightDock.actionBoxes[1]!.centerY, 0);
    expect(lightDock.actionBoxes[0]!.x).toBeLessThan(lightDock.actionBoxes[1]!.x);

    const fileChooserPromise = page.waitForEvent("filechooser");
    await attach.click();
    expect((await fileChooserPromise).isMultiple()).toBe(true);

    await input.fill("say: first line");
    await input.focus();
    await page.keyboard.press("Tab");
    await expect(attach).toBeFocused();
    const attachFocusStyle = await attach.evaluate((button) => {
      const style = getComputedStyle(button);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(attachFocusStyle.outlineStyle).not.toBe("none");
    expect(attachFocusStyle.outlineWidth).not.toBe("0px");
    await page.keyboard.press("Tab");
    await expect(sendButton).toBeFocused();

    const userMessagesBeforeNewline = await page.getByTestId("user-message").count();
    await input.press("Shift+Enter");
    await expect(page.getByTestId("user-message")).toHaveCount(userMessagesBeforeNewline);
    await input.pressSequentially("second line");
    await input.press("Enter");
    await expect(page.getByTestId("user-message").last()).toContainText("first line");
    await expect(page.getByTestId("user-message").last()).toContainText("second line");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const darkNarrowDock = await dockPresentation();
    expect(darkNarrowDock.borderWidth).toBe("0px");
    expect(darkNarrowDock.boxShadow).not.toBe("none");
    expect(darkNarrowDock.backgroundColor).not.toBe(lightDock.backgroundColor);
    for (const action of darkNarrowDock.actionBoxes) {
      expect(action.width).toBe(action.height);
      expect(action.radius).toBeGreaterThanOrEqual(action.height / 2);
      expect(action.transitionDuration).toBe("0s");
    }
  });

  test("lazily creates a thread, streams, completes, restores URL state, and reopens the recent thread", async ({ page }) => {
    await page.goto("/");
    const botId = await createBot(page, "Streaming Bot");

    await send(page, "say: hello streaming");
    const threadId = await waitForPersistedThread(page);
    await expect(page.getByTestId("streaming-markdown")).toContainText(/hel|hello streaming/);
    const streamingMessage = page.getByTestId("assistant-message").last();
    const workingAvatar = page.getByTestId("working-avatar");
    await expect(workingAvatar).toBeVisible();
    const [streamingBox, workingBox] = await Promise.all([streamingMessage.boundingBox(), workingAvatar.boundingBox()]);
    expect(streamingBox).not.toBeNull();
    expect(workingBox).not.toBeNull();
    expect(workingBox!.y).toBeGreaterThanOrEqual(streamingBox!.y + streamingBox!.height);
    await expect(page.getByTestId("assistant-message").last()).toContainText("hello streaming", { timeout: 15_000 });
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message").last().getByTestId("avatar-view")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open conversation history" })).toHaveText("say: hello streaming");

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`bot=${botId}.*thread=${threadId}`));
    await expect(page.getByTestId("assistant-message").last()).toContainText("hello streaming");

    await createBot(page, "Newer Blank Bot");
    await page.getByRole("button", { name: "Streaming Bot", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`bot=${botId}.*thread=${threadId}`));
    await expect(page.getByTestId("assistant-message").last()).toContainText("hello streaming");
  });

  test("renders user and streamed Response Markdown with safe external navigation and direct no-referrer images", async ({ page }) => {
    const seenImages: Array<{ url: string; referer?: string }> = [];
    await page.route(/https?:\/\/(?:example\.test|127\.0\.0\.1|192\.168\.1\.8|169\.254\.1\.2)\/markdown-image\.png/, async (route) => {
      seenImages.push({
        url: route.request().url(),
        ...(route.request().headers().referer === undefined ? {} : { referer: route.request().headers().referer }),
      });
      await route.abort();
    });

    await page.goto("/");
    await createBot(page, "Markdown Bot");
    const markdown = [
      "**bold** and `code`",
      "[external](https://example.com/docs)",
      "[unsafe](javascript:alert(1))",
      "![public](https://example.test/markdown-image.png)",
      "![loopback](http://127.0.0.1/markdown-image.png)",
      "![private](http://192.168.1.8/markdown-image.png)",
      "![link-local](http://169.254.1.2/markdown-image.png)",
      "![unsafe-image](javascript:alert(2))",
      "<strong data-owned-html=\"true\">raw html</strong>",
    ].join("\n\n");
    await send(page, `say: ${markdown}`);
    await waitForPersistedThread(page);

    const user = page.getByTestId("user-message").last();
    const response = page.getByTestId("assistant-message").last();
    await expect(user.locator("strong")).toContainText("bold");
    await expect(response.locator("strong")).toContainText("bold", { timeout: 15_000 });
    const link = response.getByRole("link", { name: "external" });
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(response.getByRole("link", { name: "unsafe" })).toHaveCount(0);
    await expect(response.locator("[data-owned-html]")).toHaveCount(0);

    for (const alt of ["public", "loopback", "private", "link-local"]) {
      const image = response.getByRole("img", { name: alt });
      await expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    }
    await expect(response.getByRole("img", { name: "unsafe-image" })).toHaveCount(0);
    const expectedImageUrls = [
      "http://127.0.0.1/markdown-image.png",
      "http://169.254.1.2/markdown-image.png",
      "http://192.168.1.8/markdown-image.png",
      "https://example.test/markdown-image.png",
    ];
    await expect.poll(() => [...new Set(seenImages.map((request) => request.url))].sort())
      .toEqual(expectedImageUrls);
    expect(seenImages.every((request) => request.referer === undefined)).toBe(true);
  });

  test("visually merges only adjacent Response records without merging their identities", async ({ page, request }) => {
    await page.goto("/");
    await createBot(page, "Response Group Bot");
    await send(page, "adjacent-responses");
    const threadId = await waitForPersistedThread(page);

    const assistant = page.getByTestId("assistant-message").last();
    await expect(assistant).toHaveAttribute("data-response-block-count", "2");
    await expect(assistant.getByTestId("message-markdown")).toHaveCount(2);
    await expect(assistant).toContainText("First block.Second block.");

    const records = await request.get(`/api/threads/${threadId}/messages`).then((response) => response.json()) as Array<{
      kind: string;
      response?: { blockId: string };
    }>;
    const responseIds = records.filter((record) => record.kind === "response").map((record) => record.response?.blockId);
    expect(responseIds).toHaveLength(2);
    expect(responseIds[0]).not.toBe(responseIds[1]);
  });

  test("renders filtered Thinking as an accessible collapsed disclosure with stable live expansion and duration", async ({ page, request }) => {
    await page.goto("/");
    const botId = await createBot(page, "Thinking Bot");
    const enabled = await request.patch(`/api/bots/${botId}`, { data: { showThinking: true } });
    expect(enabled.ok()).toBe(true);
    await page.reload();
    await recordAnnouncements(page, "thinking-announcement", "thinking-announcements");

    await send(page, "thinking-stream");
    await waitForPersistedThread(page);

    const disclosure = page.getByTestId("thinking-message");
    const trigger = disclosure.getByRole("button");
    await expect(disclosure).toHaveAttribute("data-thinking-state", "streaming");
    await expect(trigger).toHaveAccessibleName("Thinking…");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("thinking-announcement")).toHaveText("Thinking started");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(disclosure.getByTestId("streaming-markdown")).toContainText("Inspect");
    await expect(
      page.getByRole("log").getByTestId("assistant-message").filter({ hasText: "Thinking complete." }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(disclosure).toHaveAttribute("data-thinking-state", "completed");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAccessibleName(/Thinking complete · \d+(?:\.\d)?s/);
    await expect(disclosure.getByTestId("message-markdown").locator("strong")).toHaveText("Inspect inputs.");
    await expect(page.getByTestId("thinking-announcement")).toHaveText("Thinking completed");
    await expect(page.getByTestId("thinking-announcement")).not.toContainText("Inspect");
    await expect.poll(() => announcementBoundaries(page, "thinking-announcements")).toEqual([
      "Thinking started",
      "Thinking completed",
    ]);
    expect((await announcementBoundaries(page, "thinking-announcements")).join(" ")).not.toMatch(
      /inspect|progress|updated|delta/i,
    );

    // Reverse before the close finishes: geometry must continue from its
    // current value, without resetting the streaming disclosure's open state.
    const reversal = await trigger.evaluate(async (button) => {
      const content = document.getElementById(button.getAttribute("aria-controls") ?? "");
      if (content === null) throw new Error("Thinking content is missing");
      const expandedHeight = content.getBoundingClientRect().height;
      (button as HTMLButtonElement).click();
      const closing: number[] = [];
      const started = performance.now();
      while (performance.now() - started < 60) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        closing.push(content.getBoundingClientRect().height);
      }
      const beforeReversal = content.getBoundingClientRect().height;
      (button as HTMLButtonElement).click();
      const afterReversal = content.getBoundingClientRect().height;
      const reopened = performance.now();
      while (performance.now() - reopened < 280) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return { expandedHeight, closing, beforeReversal, afterReversal, finalHeight: content.getBoundingClientRect().height };
    });
    expect(reversal.closing.some((height) => height > 0 && height < reversal.expandedHeight - 0.5)).toBe(true);
    expect(Math.abs(reversal.afterReversal - reversal.beforeReversal)).toBeLessThan(1);
    expect(reversal.finalHeight).toBeCloseTo(reversal.expandedHeight, 0);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await trigger.evaluate(async (button) => {
      const content = document.getElementById(button.getAttribute("aria-controls") ?? "");
      if (content === null) throw new Error("Thinking content is missing");
      (button as HTMLButtonElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const closedHeight = content.getBoundingClientRect().height;
      const isInert = content.firstElementChild?.hasAttribute("inert");
      (button as HTMLButtonElement).click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { closedHeight, isInert, openHeight: content.getBoundingClientRect().height };
    });
    expect(reduced.closedHeight).toBe(0);
    expect(reduced.isInert).toBe(true);
    expect(reduced.openHeight).toBeCloseTo(reversal.expandedHeight, 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const hidden = await request.patch(`/api/bots/${botId}`, { data: { showThinking: false } });
    expect(hidden.ok()).toBe(true);
    await expect(disclosure).toHaveCount(0);
    const restored = await request.patch(`/api/bots/${botId}`, { data: { showThinking: true } });
    expect(restored.ok()).toBe(true);
    await expect(page.getByTestId("thinking-message")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("thinking-message").getByRole("button")).toHaveAttribute("aria-expanded", "false");

    setFakeProbe({ fakeCapabilities: { thinking: { supported: false, streaming: false } } });
    try {
      expect((await request.post("/api/agents/pi/recheck")).ok()).toBe(true);
      await page.reload();
      await expect(page.getByTestId("thinking-message")).toBeVisible();
      await page.getByRole("button", { name: "Open settings for Thinking Bot" }).click();
      const settings = page.getByRole("complementary", { name: "Bot settings" });
      await expect(settings.getByRole("switch", { name: "Show Thinking" })).toBeEnabled();
      await expect(settings).toContainText("no longer provides Thinking");
      await expect(settings).toContainText("retained Thinking remains available");
    } finally {
      setFakeProbe({});
      await request.post("/api/agents/pi/recheck");
    }
  });

  test("announces unseen start boundaries before terminal Tool Call and Thinking boundaries", async ({ page, request }) => {
    await page.goto("/");
    const botId = await createBot(page, "Short Process Bot");
    const enabled = await request.patch(`/api/bots/${botId}`, {
      data: { showThinking: true, showToolCalls: true },
    });
    expect(enabled.ok()).toBe(true);
    await page.reload();
    await recordAnnouncements(page, "thinking-announcement", "short-thinking-announcements");
    await recordAnnouncements(page, "tool-call-announcement", "short-tool-announcements");

    await send(page, "thinking-order");
    await expect(page.getByRole("log").getByText("After Thinking.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await expect.poll(() => announcementBoundaries(page, "short-thinking-announcements")).toEqual([
      "Thinking started",
      "Thinking completed",
      "Thinking started",
      "Thinking completed",
    ]);
    await expect.poll(() => announcementBoundaries(page, "short-tool-announcements")).toEqual([
      "read started",
      "read completed",
    ]);
    expect([
      ...(await announcementBoundaries(page, "short-thinking-announcements")),
      ...(await announcementBoundaries(page, "short-tool-announcements")),
    ].join(" ")).not.toMatch(/inspect|progress|updated|delta/i);
  });

  test("renders safe native Tool Calls with grouping, filtering, keyboard access, and boundary announcements", async ({ page, request }) => {
    await page.goto("/");
    const botId = await createBot(page, "Tool Call Bot");
    await send(page, "tool please");
    const threadId = await waitForPersistedThread(page);
    await expect(page.getByTestId("assistant-message").last()).toContainText("tool finished", { timeout: 15_000 });
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);

    await expect(page.getByTestId("tool-calls")).toHaveCount(0);
    await expect(page.getByText("fake.progress", { exact: true })).toHaveCount(0);
    const hiddenHistory = await request.get(`/api/threads/${threadId}/messages`).then((response) => response.json()) as Array<{
      kind: string;
      payload?: unknown;
      toolCall?: { name: string; status: string; target?: string };
    }>;
    const hiddenTool = hiddenHistory.find((message) => message.kind === "tool");
    expect(hiddenTool).toMatchObject({
      toolCall: { name: "bash", status: "completed", target: "echo fake" },
    });
    expect(hiddenTool === undefined || "payload" in hiddenTool).toBe(false);

    await page.getByRole("button", { name: "Open settings for Tool Call Bot" }).click();
    const toolSwitch = page.getByRole("complementary", { name: "Bot settings" })
      .getByRole("switch", { name: "Show tool calls" });
    await toolSwitch.click();
    await expect(page.getByTestId("tool-calls")).toHaveCount(1);
    await expect(page.getByTestId("tool-call-message")).toHaveAttribute("data-sender", "assistant");
    await expect(page.getByTestId("tool-calls").getByRole("button")).toHaveCount(0);
    await expect(page.getByText("fake.progress", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Close settings for Tool Call Bot" }).click();

    await recordAnnouncements(page, "tool-call-announcement", "tool-call-announcements");

    await send(page, "tool adjacent");
    await expect(page.getByTestId("assistant-message").last()).toContainText("tool finished", { timeout: 15_000 });
    await expect(page.getByTestId("tool-calls")).toHaveCount(2);
    const adjacentGroup = page.getByTestId("tool-calls").last();
    const groupToggle = adjacentGroup.getByRole("button");
    await expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    await groupToggle.focus();
    await groupToggle.press("Enter");
    await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    await expect(adjacentGroup).toContainText("bash");
    await expect(adjacentGroup).toContainText("write");

    await expect.poll(() => announcementBoundaries(page, "tool-call-announcements")).toEqual([
      "bash started",
      "bash completed",
      "write started",
      "write completed",
    ]);
    expect((await announcementBoundaries(page, "tool-call-announcements")).join(" ")).not.toMatch(
      /progress|updated|delta/i,
    );

    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
    await send(page, "tool separated");
    await expect(page.getByTestId("assistant-message").last()).toContainText("tool finished", { timeout: 15_000 });
    await expect(page.getByTestId("tool-calls")).toHaveCount(4);
    const separatedFirst = page.getByTestId("tool-call-message").nth(2);
    const separatedResponse = page.getByTestId("assistant-message").filter({ hasText: "Between tools." });
    const separatedSecond = page.getByTestId("tool-call-message").nth(3);
    const [firstBox, responseBox, secondBox] = await Promise.all([
      separatedFirst.boundingBox(),
      separatedResponse.boundingBox(),
      separatedSecond.boundingBox(),
    ]);
    expect(firstBox).not.toBeNull();
    expect(responseBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(firstBox!.y).toBeLessThan(responseBox!.y);
    expect(responseBox!.y).toBeLessThan(secondBox!.y);
    await expect(separatedFirst.getByRole("button")).toHaveCount(0);
    await expect(separatedSecond.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
    await send(page, "tool-fail");
    await expect(page.getByTestId("composer-error-card")).toBeVisible();
    await expect(page.getByTestId("tool-calls")).toHaveCount(5);
    await expect(page.getByTestId("tool-calls").last()).toContainText(
      "Interrupted before completion.",
    );


    await page.reload();
    await expect(page.getByTestId("tool-calls")).toHaveCount(5);
    await expect(page.getByText("fake.progress", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Open settings for Tool Call Bot" }).click();
    await page.getByRole("complementary", { name: "Bot settings" })
      .getByRole("switch", { name: "Show tool calls" })
      .click();
    await expect(page.getByTestId("tool-calls")).toHaveCount(0);
    const retainedHistory = await request.get(`/api/threads/${threadId}/messages`).then((response) => response.json()) as Array<{ kind: string }>;
    expect(retainedHistory.filter((message) => message.kind === "tool")).toHaveLength(6);
  });

  test("renders the integrated ordered transcript with real Steering boundaries before and after refresh", async ({ page, request }) => {
    await page.goto("/");
    const botId = await createBot(page, "Ordered Transcript Bot");
    const enabled = await request.patch(`/api/bots/${botId}`, {
      data: { showThinking: true, showToolCalls: true },
    });
    expect(enabled.ok()).toBe(true);
    await page.reload();

    await send(page, "ordered-transcript");
    const threadId = await waitForPersistedThread(page);
    const firstTool = page.getByTestId("tool-call-message").filter({ hasText: "src/transcript.ts" }).first();
    await expect(firstTool).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("working-avatar")).toBeVisible();
    await expect(page.getByTestId(`sidebar-bot-${botId}`).getByTestId("sidebar-activity-point")).toBeVisible();
    await page.getByRole("button", { name: "Open settings for Ordered Transcript Bot" }).click();
    const liveSettings = page.getByRole("complementary", { name: "Bot settings" });
    const liveToolSwitch = liveSettings.getByRole("switch", { name: "Show tool calls" });
    const liveThinkingSwitch = liveSettings.getByRole("switch", { name: "Show Thinking" });
    await expect(liveToolSwitch).toBeChecked();
    await expect(liveThinkingSwitch).toBeChecked();
    await liveToolSwitch.click();
    await liveThinkingSwitch.click();
    await expect(page.getByTestId("tool-call-message")).toHaveCount(0);
    await expect(page.getByTestId("thinking-message")).toHaveCount(0);
    await expect(page.getByTestId("working-avatar")).toBeVisible();
    await expect(page.getByTestId(`sidebar-bot-${botId}`).getByTestId("sidebar-activity-point")).toBeVisible();
    await liveToolSwitch.click();
    await liveThinkingSwitch.click();
    await expect(firstTool).toBeVisible();
    await expect(page.getByTestId("thinking-message")).toBeVisible();
    await page.getByRole("button", { name: "Close settings for Ordered Transcript Bot" }).click();

    await send(page, "Keep the browser boundary");
    await expect(page.getByRole("log").getByText("Response after an unrendered Native Event boundary.", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
    await expect(page.getByTestId(`sidebar-bot-${botId}`).getByTestId("sidebar-activity-point")).toHaveCount(0);
    await expect(page.getByText("fake.progress", { exact: true })).toHaveCount(0);

    const transcriptRows = page.getByRole("log").locator(
      '[data-testid="user-message"], [data-testid="assistant-message"], [data-testid="thinking-message"], [data-testid="tool-call-message"]',
    );
    await expect(transcriptRows).toHaveCount(10);
    expect(await transcriptRows.evaluateAll((rows) =>
      rows.map((row) => ({
        testId: row.getAttribute("data-testid"),
        text: row.textContent?.replace(/\s+/g, " ").trim(),
      }))
    )).toEqual([
      { testId: "user-message", text: "ordered-transcript" },
      { testId: "assistant-message", text: expect.stringContaining("Release notes") },
      { testId: "thinking-message", text: expect.stringContaining("Thinking complete") },
      { testId: "tool-call-message", text: expect.stringContaining("read") },
      { testId: "user-message", text: "Keep the browser boundary" },
      {
        testId: "assistant-message",
        text: "Steering received: Keep the browser boundaryAdjacent response remains in the same visual reply.",
      },
      { testId: "thinking-message", text: expect.stringContaining("Thinking complete") },
      { testId: "tool-call-message", text: expect.stringContaining("write") },
      { testId: "assistant-message", text: "Final response after the second tool." },
      { testId: "assistant-message", text: "Response after an unrendered Native Event boundary." },
    ]);

    const responses = page.getByTestId("assistant-message");
    await expect(responses).toHaveCount(4);
    await expect(responses.nth(0)).toHaveAttribute("data-response-block-count", "1");
    await expect(responses.nth(1)).toHaveAttribute("data-response-block-count", "2");
    await expect(responses.nth(2)).toHaveAttribute("data-response-block-count", "1");
    await expect(responses.nth(3)).toHaveAttribute("data-response-block-count", "1");
    await expect(responses.nth(0).getByRole("heading", { name: "Release notes" })).toBeVisible();
    await expect(responses.nth(0).locator("table")).toBeVisible();
    await expect(responses.nth(0).locator("pre")).toContainText("const order");

    const thinking = page.getByTestId("thinking-message").first().getByRole("button");
    await thinking.focus();
    await thinking.press("Enter");
    await expect(thinking).toBeFocused();
    await expect(thinking).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("thinking-message").first().locator("strong")).toHaveText("Inspect");

    await page.reload();
    await expect(transcriptRows).toHaveCount(10);
    expect(await transcriptRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-testid"))
    )).toEqual([
      "user-message",
      "assistant-message",
      "thinking-message",
      "tool-call-message",
      "user-message",
      "assistant-message",
      "thinking-message",
      "tool-call-message",
      "assistant-message",
      "assistant-message",
    ]);
    await expect(responses.nth(1)).toHaveAttribute("data-response-block-count", "2");
    await expect(page.getByTestId("thinking-message").first().getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await page.getByRole("button", { name: "Open settings for Ordered Transcript Bot" }).click();
    const settings = page.getByRole("complementary", { name: "Bot settings" });
    await settings.getByRole("switch", { name: "Show tool calls" }).click();
    await settings.getByRole("switch", { name: "Show Thinking" }).click();
    await expect(page.getByTestId("tool-call-message")).toHaveCount(0);
    await expect(page.getByTestId("thinking-message")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message")).toHaveCount(4);
    await page.getByRole("button", { name: "Close settings for Ordered Transcript Bot" }).click();

    const retained = await request.get(`/api/threads/${threadId}/messages`).then((response) => response.json()) as Array<{ kind: string }>;
    expect(retained.map((message) => message.kind)).toEqual([
      "text",
      "response",
      "thinking",
      "tool",
      "text",
      "response",
      "response",
      "thinking",
      "tool",
      "response",
      "event",
      "response",
    ]);

    await page.reload();
    await expect(page.getByTestId("thinking-message")).toHaveCount(0);
    await expect(page.getByTestId("tool-call-message")).toHaveCount(0);
    await expect(page.getByTestId("assistant-message")).toHaveCount(4);
    await expect(page.getByRole("log").getByText("Response after an unrendered Native Event boundary.", { exact: true })).toBeVisible();
  });

  test("renders a hidden process-only Turn without inventing a reply before or after refresh", async ({ page, request }) => {
    await page.goto("/");
    await createBot(page, "Quiet Process Bot");
    await recordAnnouncements(page, "thinking-announcement", "hidden-thinking-announcements");
    await recordAnnouncements(page, "tool-call-announcement", "hidden-tool-announcements");
    await send(page, "process-only");
    const threadId = await waitForPersistedThread(page);

    await expect.poll(async () => {
      const thread = await request.get(`/api/threads/${threadId}`).then((response) => response.json()) as {
        latestTurn?: { status?: string };
      };
      return thread.latestTurn?.status;
    }, { timeout: 15_000 }).toBe("completed");

    await expect(page.getByTestId("assistant-message")).toHaveCount(0);
    await expect(page.getByTestId("thinking-message")).toHaveCount(0);
    await expect(page.getByTestId("tool-call-message")).toHaveCount(0);
    await expect(page.getByText("Hidden process reasoning.", { exact: true })).toHaveCount(0);
    expect(await announcementBoundaries(page, "hidden-thinking-announcements")).toEqual([]);
    expect(await announcementBoundaries(page, "hidden-tool-announcements")).toEqual([]);
    const retained = await request.get(`/api/threads/${threadId}/messages`).then((response) => response.json()) as Array<{
      kind: string;
      author: { kind: string };
    }>;
    expect(retained.map((message) => message.kind)).toEqual(["text", "thinking", "tool", "event"]);
    expect(retained.some((message) => message.author.kind === "system")).toBe(false);

    await page.reload();
    await expect(page.getByTestId("assistant-message")).toHaveCount(0);
    await expect(page.getByTestId("thinking-message")).toHaveCount(0);
    await expect(page.getByTestId("tool-call-message")).toHaveCount(0);
  });

  test("shows failed Turns once above the Composer and supports retry and close", async ({ page, request }) => {
    await page.goto("/");
    await createBot(page, "Failure Bot");
    await send(page, "fail-once");
    const threadId = await waitForPersistedThread(page);

    await expectCardAboveComposer(page);
    const card = page.getByTestId("composer-error-card");
    await expect(card).toContainText("fake failure");
    await expect(page.getByText("error: fake failure")).toHaveCount(0);
    const messages = await request.get(`/api/threads/${threadId}/messages`);
    expect((await messages.json()) as Array<{ author: { kind: string }; text?: string }>).not.toContainEqual(
      expect.objectContaining({ author: { kind: "system" }, text: expect.stringContaining("fake failure") }),
    );

    await card.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("assistant-message").last()).toContainText("recovered", { timeout: 15_000 });
    await expect(card).toHaveCount(0);

    await send(page, "fail");
    await expectCardAboveComposer(page);
    await page.getByTestId("composer-error-card").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("composer-error-card")).toHaveCount(0);

    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: "New conversation" }).click();
    await send(page, "timeout-failure");
    const timeoutThreadId = await waitForPersistedThread(page);
    await expectCardAboveComposer(page);
    const timeoutCard = page.getByTestId("composer-error-card");
    await expect(timeoutCard).toContainText("timed out after 30s");
    await expect(timeoutCard.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(timeoutCard.getByRole("button", { name: "Close" })).toBeVisible();
    const timeoutMessages = await request.get(`/api/threads/${timeoutThreadId}/messages`);
    expect((await timeoutMessages.json()) as Array<{ author: { kind: string }; text?: string }>).not.toContainEqual(
      expect.objectContaining({ author: { kind: "system" }, text: expect.stringContaining("timed out after") }),
    );
    setFakeProbe({ fakeProbe: "offline" });
    try {
      expect((await request.post("/api/agents/pi/recheck")).ok()).toBe(true);
      await expect(timeoutCard).toContainText("fake probe offline");
      await timeoutCard.getByRole("button", { name: "Close" }).click();
      await expect(timeoutCard).toContainText("Turn failed");
      await expect(timeoutCard).toContainText("timed out after 30s");
      await timeoutCard.getByRole("button", { name: "Close" }).click();
      await expect(timeoutCard).toHaveCount(0);
    } finally {
      setFakeProbe({});
      await request.post("/api/agents/pi/recheck");
    }

    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: /fail-once/ }).click();
    await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));
    await expect(page.getByTestId("composer-error-card")).toHaveCount(0);

    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: /timeout-failure/ }).click();
    await expect(page).toHaveURL(new RegExp(`thread=${timeoutThreadId}`));
    await expect(page.getByTestId("composer-error-card")).toHaveCount(0);
  });

  test("disables sending and shows readiness reason and recovery above the Composer", async ({ page, request }) => {
    await page.goto("/");
    await createBot(page, "Readiness Bot");
    setFakeProbe({ fakeProbe: "offline" });
    try {
      expect((await request.post("/api/agents/pi/recheck")).ok()).toBe(true);
      await expectCardAboveComposer(page);
      const card = page.getByTestId("composer-error-card");
      await expect(card).toContainText("fake probe offline");
      await expect(card).toContainText("Restart the daemon or check the worker logs.");
      await expect(composerInput(page)).toHaveAttribute("aria-disabled", "true");
      await expect(composerInput(page)).toHaveAttribute("contenteditable", "false");
      await expect(page.getByRole("textbox", { name: "Message input", exact: true })).toBeVisible();

      await card.getByRole("button", { name: "Close" }).click();
      await expect(card).toHaveCount(0);
      await expect(composerInput(page)).toHaveAttribute("aria-disabled", "true");

      setFakeProbe({});
      expect((await request.post("/api/agents/pi/recheck")).ok()).toBe(true);
      await expect(composerInput(page)).not.toHaveAttribute("aria-disabled");
      await expect(page.getByRole("combobox", { name: "Message input", exact: true })).toBeVisible();

      setFakeProbe({ fakeProbe: "offline" });
      expect((await request.post("/api/agents/pi/recheck")).ok()).toBe(true);
      await expectCardAboveComposer(page);
      await expect(card).toContainText("fake probe offline");

      setFakeProbe({});
      await card.getByRole("button", { name: "Retry" }).click();
      await expect(composerInput(page)).not.toHaveAttribute("aria-disabled");
      await expect(composerInput(page)).toHaveAttribute("contenteditable", "true");
      await expect(card).toHaveCount(0);
    } finally {
      setFakeProbe({});
      await request.post("/api/agents/pi/recheck");
    }
  });

  test("keeps the composer enabled for steering and has no global TopNav or Stop control", async ({ page }) => {
    await page.goto("/");
    await createBot(page, "Steering Bot");

    await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Steering Bot" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Bot navigation", includeHidden: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Stop$/i })).toHaveCount(0);

    await send(page, "steer-echo");
    await waitForPersistedThread(page);
    await expect(page.getByTestId("working-avatar")).toBeVisible();
    await expect(composerInput(page)).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Message input", exact: true })).toBeVisible();

    await send(page, "redirect e2e");
    await expect(page.getByTestId("assistant-message").last()).toContainText("steered: redirect e2e", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Stop$/i })).toHaveCount(0);
  });
});
