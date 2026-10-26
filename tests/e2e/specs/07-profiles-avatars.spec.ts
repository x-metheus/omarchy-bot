import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Original instructions");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  const row = page.getByRole("button", { name, exact: true });
  await expect(row).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

async function openBotSettings(page: Page, botName: string): Promise<void> {
  await page.getByRole("button", { name: `Open settings for ${botName}` }).click();
  const botSettings = page.getByRole("complementary", { name: "Bot settings" });
  await expect(botSettings.getByTestId("bot-settings-panel")).toBeVisible();
}

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
async function avatarSvg(avatar: Locator): Promise<string> {
  const dataUri = await avatar.locator("img").getAttribute("src");
  if (dataUri === null || !dataUri.startsWith("data:image/svg+xml")) {
    throw new Error("avatar did not render a local SVG data URI");
  }
  return decodeURIComponent(dataUri.slice(dataUri.indexOf(",") + 1));
}

async function expectStatusFits(status: Locator, boundary: Locator): Promise<void> {
  await expect(status).toHaveCSS("opacity", "1");
  const [statusBox, boundaryBox] = await Promise.all([status.boundingBox(), boundary.boundingBox()]);
  expect(statusBox).not.toBeNull();
  expect(boundaryBox).not.toBeNull();
  expect(statusBox!.x).toBeGreaterThanOrEqual(boundaryBox!.x);
  expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(boundaryBox!.x + boundaryBox!.width + 1);
  const clippingAncestors = await status.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const textBox = range.getBoundingClientRect();
    const clipped: string[] = [];
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (!["hidden", "clip", "auto", "scroll"].includes(getComputedStyle(parent).overflowX)) continue;
      const parentBox = parent.getBoundingClientRect();
      const left = parentBox.left + parent.clientLeft;
      if (textBox.left < left - 1 || textBox.right > left + parent.clientWidth + 1) {
        clipped.push(parent.tagName);
      }
    }
    return clipped;
  });
  expect(clippingAncestors).toEqual([]);
}

async function sampleStatusMotion(
  status: Locator,
  direction: "reveal" | "dismiss",
  settle = true,
): Promise<{ opacity: number; width: number }> {
  const sample = await status.evaluate((element, { finish, direction }) => {
    const transitions = element.getAnimations().filter((animation) => animation instanceof CSSTransition);
    const opacity = transitions.find((animation) => animation.transitionProperty === "opacity");
    const layout = transitions.find((animation) => animation.transitionProperty === "grid-template-columns");
    if (opacity === undefined || layout === undefined) throw new Error("working status must animate text and intrinsic width");
    const timing = opacity.effect!.getTiming();
    for (const animation of transitions) {
      const { delay, duration } = animation.effect!.getTiming();
      animation.pause();
      animation.currentTime = (delay ?? 0) + Number(duration) / 2;
    }
    const halfwayLayoutTime = layout.currentTime;
    const layoutTiming = layout.effect!.getTiming();
    layout.currentTime = direction === "reveal" ? (layoutTiming.delay ?? 0) + Number(layoutTiming.duration) : 0;
    const contentWidth = element.getBoundingClientRect().width;
    layout.currentTime = halfwayLayoutTime;
    const style = getComputedStyle(element);
    const result = {
      duration: timing.duration,
      delay: timing.delay,
      opacity: Number(style.opacity),
      width: element.getBoundingClientRect().width,
      contentWidth,
      translation: new DOMMatrixReadOnly(style.transform).m41,
      pointerEvents: style.pointerEvents,
    };
    if (finish) for (const animation of transitions) animation.finish();
    return result;
  }, { finish: settle, direction });
  expect(sample.duration).toBe(direction === "reveal" ? 160 : 100);
  expect(sample.delay).toBe(direction === "reveal" ? 80 : 0);
  expect(sample.opacity).toBeGreaterThan(0);
  expect(sample.opacity).toBeLessThan(1);
  expect(sample.width).toBeGreaterThan(0);
  expect(sample.width).toBeLessThan(sample.contentWidth);
  expect(sample.translation).toBeGreaterThan(-4);
  expect(sample.translation).toBeLessThan(0);
  expect(sample.pointerEvents).toBe("none");
  return sample;
}

async function expectInstantStatus(status: Locator): Promise<void> {
  await expect(status).toHaveCSS("transition-duration", "0s");
  await expect(status).toHaveCSS("transition-delay", "0s");
  await expect(status).toHaveCSS("transform", "none");
  expect(await status.evaluate((element) => element.getAnimations().length)).toBe(0);
}

test.describe("Bot profiles and avatars", () => {
  test("edits profile fields, creates a variation, and uploads a local image", async ({ page }) => {
    const botId = await createBot(page, "Profile Bot");
    await openBotSettings(page, "Profile Bot");

    const botSettings = page.getByRole("complementary", { name: "Bot settings" });
    await expect(botSettings.getByText("Backing Agent", { exact: true })).toBeVisible();
    await expect(botSettings.getByText("Pi", { exact: true })).toBeVisible();
    await expect(botSettings.getByText("Fixed for this bot.", { exact: true })).toBeVisible();
    await botSettings.getByRole("textbox", { name: "Name" }).fill("Renamed Profile Bot");
    await botSettings.getByRole("textbox", { name: "Job / Instructions" }).fill("Use the latest profile instructions");
    await botSettings.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByRole("button", { name: "Renamed Profile Bot", exact: true })).toBeVisible();

    const profileAvatar = botSettings.getByRole("img", { name: "Renamed Profile Bot" }).locator("img");
    const beforeSrc = await profileAvatar.getAttribute("src");
    await botSettings.getByRole("button", { name: "New variation" }).click();
    await expect.poll(() => profileAvatar.getAttribute("src")).not.toBe(beforeSrc);

    await page.getByLabel("Choose an avatar image").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: onePixelPng });
    await expect
      .poll(async () => new URL((await profileAvatar.getAttribute("src")) ?? "http://invalid/", page.url()).pathname)
      .toBe(`/api/bots/${botId}/avatar`);
  });

  test("applies a validated prompt recipe through the profile UI", async ({ page, request }) => {
    const botId = await createBot(page, "Recipe UI Bot");
    const currentResponse = await request.get(`/api/bots/${botId}`);
    const current: unknown = await currentResponse.json();
    if (current === null || typeof current !== "object") throw new Error("Bot API returned an invalid profile");
    await page.route(`**/api/bots/${botId}/avatar/recipe`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...current,
          avatar: {
            kind: "recipe",
            recipe: {
              rendererVersion: "dicebear-core@10.7.0+styles@10.6.0",
              style: "thumbs",
              seed: "e2e-recipe",
              options: {},
            },
          },
        }),
      });
    });

    await openBotSettings(page, "Recipe UI Bot");
    await page.getByRole("textbox", { name: "Describe avatar" }).fill("A friendly teammate with round glasses");
    await page.getByRole("button", { name: "Create from description" }).click();
    await expect(page.getByRole("complementary", { name: "Bot settings" }).getByTestId("avatar-thumbs")).toBeVisible();
  });


  test("keeps Sidebar activity independent while one generated working avatar follows the selected Thread", async ({ page }) => {
    const botId = await createBot(page, "Activity Avatar Bot");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const sidebarRow = page.getByTestId(`sidebar-bot-${botId}`);
    const sidebarAvatar = sidebarRow.getByTestId("avatar-view");
    await expect(sidebarAvatar).toHaveAttribute("data-avatar-presentation", "ambient");
    expect(await avatarSvg(sidebarAvatar)).toContain("@keyframes");
    const ambientSrc = await sidebarAvatar.locator("img").getAttribute("src");
    await expect(sidebarRow.getByTestId("sidebar-activity-point")).toHaveCount(0);

    const headerAvatar = page.getByTestId("bot-settings-open").getByTestId("avatar-view");
    await expect(headerAvatar).toHaveAttribute("data-avatar-presentation", "static");
    expect(await avatarSvg(headerAvatar)).not.toContain("@keyframes");
    await sidebarAvatar.hover();
    await expect(sidebarRow.getByTestId("sidebar-working-status")).toHaveCount(0);
    await headerAvatar.hover();
    await expect(page.getByTestId("header-working-status")).toHaveCount(0);

    const composer = page
      .getByRole("textbox", { name: "Message input", exact: true })
      .or(page.getByRole("combobox", { name: "Message input", exact: true }));
    await composer.fill("steer-echo");
    await composer.press("Enter");
    await expect(sidebarRow.getByTestId("sidebar-activity-point")).toBeVisible();
    await expect(sidebarAvatar.locator("img")).toHaveAttribute("src", ambientSrc!);

    const workingAvatar = page.getByTestId("working-avatar");
    const workingAvatarImage = workingAvatar.getByRole("img", { name: "Activity Avatar Bot is working" });
    await expect(workingAvatarImage).toBeVisible();
    await expect(workingAvatar.getByTestId("avatar-pixelbot")).toHaveAttribute("data-avatar-presentation", "working");
    await expect(workingAvatar.getByTestId("avatar-pixelbot")).toHaveCSS("animation-name", "none");
    expect(await avatarSvg(workingAvatar)).toContain("@keyframes");
    await expect(page.getByTestId("working-announcement")).toHaveText("Activity Avatar Bot is working");
    await expect(workingAvatar.getByRole("img", { name: "Active" })).toHaveCount(0);
    const workingStatus = page.getByTestId("working-avatar-status");
    await expect(workingStatus).not.toBeVisible();
    await expect(workingStatus).toHaveCSS("width", "0px");
    const workingPosition = await workingAvatarImage.boundingBox();
    await workingAvatarImage.hover();
    await sampleStatusMotion(workingStatus, "reveal");
    expect(await workingAvatarImage.boundingBox()).toEqual(workingPosition);
    await expect(workingStatus).toHaveText("Activity Avatar Bot is working");
    await expect(workingStatus).toBeVisible();
    await expect(page.getByRole("tooltip", { name: "Activity Avatar Bot is working" })).toHaveCount(0);
    const avatarBox = await workingAvatarImage.boundingBox();
    const statusBox = await workingStatus.boundingBox();
    expect(avatarBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.x).toBeGreaterThanOrEqual(avatarBox!.x + avatarBox!.width);
    expect(statusBox!.y).toBeLessThan(avatarBox!.y + avatarBox!.height);
    expect(statusBox!.y + statusBox!.height).toBeGreaterThan(avatarBox!.y);
    await page.mouse.move(0, 0);
    await sampleStatusMotion(workingStatus, "dismiss");
    expect(await workingAvatarImage.boundingBox()).toEqual(workingPosition);
    await expect(workingStatus).not.toBeVisible();
    await workingAvatarImage.focus();
    await expect(workingStatus).toHaveCSS("transition-delay", "0s");
    await expect(workingStatus).toBeVisible();
    await expect(page.getByRole("tooltip", { name: "Activity Avatar Bot is working" })).toHaveCount(0);
    await composer.focus();
    await expect(workingStatus).not.toBeVisible();

    const sidebarStatus = sidebarRow.getByTestId("sidebar-working-status");
    const headerStatus = page.getByTestId("header-working-status");
    await expect(sidebarStatus).not.toBeVisible();
    await expect(headerStatus).not.toBeVisible();
    await expect(sidebarStatus).toHaveCSS("width", "0px");
    await expect(headerStatus).toHaveCSS("width", "0px");
    await sidebarAvatar.hover();
    await sampleStatusMotion(sidebarStatus, "reveal");
    await expect(sidebarStatus).toBeVisible();
    await expect(sidebarRow.locator("strong")).toHaveText("Activity Avatar Bot is working");
    await expectStatusFits(sidebarStatus, sidebarRow.locator("strong").locator(".."));
    await expect(headerStatus).not.toBeVisible();
    await page.mouse.move(0, 0);
    await sampleStatusMotion(sidebarStatus, "dismiss");
    await expect(sidebarStatus).not.toBeVisible();
    await sidebarRow.getByRole("button", { name: "Activity Avatar Bot", exact: true }).focus();
    await expect(sidebarStatus).toBeVisible();
    await composer.focus();
    await headerAvatar.hover();
    await sampleStatusMotion(headerStatus, "reveal");
    await expect(headerStatus).toBeVisible();
    await expect(page.getByTestId("bot-settings-open").getByRole("heading")).toHaveText("Activity Avatar Bot is working");
    await expectStatusFits(headerStatus, page.getByTestId("bot-settings-open").getByRole("heading"));
    await page.mouse.move(0, 0);
    await sampleStatusMotion(headerStatus, "dismiss");
    await expect(headerStatus).not.toBeVisible();
    await page.getByTestId("bot-settings-open").focus();
    await expect(headerStatus).toBeVisible();
    await composer.focus();
    await expect(headerStatus).not.toBeVisible();
    await headerAvatar.hover();
    const interrupted = await sampleStatusMotion(headerStatus, "reveal", false);
    await page.mouse.move(0, 0);
    const reversal = await headerStatus.evaluate((element) => {
      const transitions = element.getAnimations().filter((animation) => animation instanceof CSSTransition);
      const opacity = transitions.find((animation) => animation.transitionProperty === "opacity");
      if (opacity === undefined) throw new Error("hover reversal must retain a transition");
      const { duration, delay } = opacity.effect!.getTiming();
      for (const animation of transitions) {
        animation.pause();
        animation.currentTime = 0;
      }
      const startOpacity = Number(getComputedStyle(element).opacity);
      const startWidth = element.getBoundingClientRect().width;
      for (const animation of transitions) {
        const timing = animation.effect!.getTiming();
        animation.currentTime = (timing.delay ?? 0) + Number(timing.duration) / 2;
      }
      const halfwayOpacity = Number(getComputedStyle(element).opacity);
      for (const animation of transitions) animation.finish();
      return { duration, delay, startOpacity, startWidth, halfwayOpacity };
    });
    expect(reversal.delay).toBe(0);
    expect(Number(reversal.duration)).toBeGreaterThan(0);
    expect(Number(reversal.duration)).toBeLessThanOrEqual(100);
    expect(reversal.startOpacity).toBeCloseTo(interrupted.opacity, 2);
    expect(reversal.startWidth).toBeCloseTo(interrupted.width, 1);
    expect(reversal.halfwayOpacity).toBeGreaterThan(0);
    expect(reversal.halfwayOpacity).toBeLessThan(interrupted.opacity);
    await expect(headerStatus).not.toBeVisible();
    await expect(headerStatus).toHaveCSS("width", "0px");
    await headerAvatar.hover();
    await sampleStatusMotion(headerStatus, "reveal");
    await page.mouse.move(0, 0);
    await expect(headerStatus).not.toBeVisible();

    const desktopViewport = page.viewportSize();
    if (desktopViewport === null) throw new Error("missing desktop viewport");
    await page.setViewportSize({ width: 390, height: 780 });
    await headerAvatar.hover();
    await expect(headerStatus).toBeVisible();
    await expectStatusFits(headerStatus, page.getByTestId("bot-settings-open").getByRole("heading"));
    await expectStatusFits(headerStatus, page.getByTestId("bot-settings-open"));
    await expect(page.getByTestId("bot-settings-open").getByRole("heading").locator("span").first()).not.toHaveCSS("width", "0px");
    await page.setViewportSize(desktopViewport);

    await expect(page.getByTestId("tool-calls")).toHaveCount(0);

    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
    await expect(sidebarRow.getByTestId("sidebar-activity-point")).toBeVisible();
    await sidebarAvatar.hover();
    await expect(sidebarStatus).toBeVisible();
    await headerAvatar.hover();
    await expect(headerStatus).toBeVisible();

    await page.getByRole("button", { name: "Open conversation history" }).click();
    await page.getByRole("button", { name: /steer-echo/ }).click();
    await expect(page.getByTestId("working-avatar")).toBeVisible();
    await composer.fill("finish activity");
    await composer.press("Enter");
    await expect(page.getByTestId("assistant-message").last()).toContainText("steered: finish activity", { timeout: 15_000 });
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
    await expect(page.getByTestId("working-announcement")).toHaveText("Activity Avatar Bot is no longer working");
    await expect(page.getByTestId("assistant-message").last().getByTestId("avatar-view")).toHaveCount(0);
    await expect(sidebarRow.getByTestId("sidebar-activity-point")).toHaveCount(0);
    await sidebarAvatar.hover();
    await expect(sidebarStatus).toHaveCount(0);
    await headerAvatar.hover();
    await expect(headerStatus).toHaveCount(0);
  });

  test("ellipsizes only a maximum-length working Bot name at narrow widths", async ({ page }) => {
    const name = "Working Avatar ".padEnd(80, "W");
    await createBot(page, name);
    const composer = page
      .getByRole("textbox", { name: "Message input", exact: true })
      .or(page.getByRole("combobox", { name: "Message input", exact: true }));
    await composer.fill("steer-echo");
    await composer.press("Enter");
    const workingAvatar = page.getByTestId("working-avatar");
    const avatar = workingAvatar.getByRole("img", { name: `${name} is working` });
    await expect(avatar).toBeVisible();
    await page.setViewportSize({ width: 390, height: 780 });
    const status = workingAvatar.getByTestId("working-avatar-status");
    const visibleName = workingAvatar.getByTestId("working-avatar-name");
    const suffix = workingAvatar.getByTestId("working-avatar-suffix");
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      await page.emulateMedia({ reducedMotion });
      await composer.focus();
      await page.mouse.move(0, 0);
      await expect(status).not.toBeVisible();
      await expect(status).toHaveCSS("width", "0px");
      const avatarPosition = await avatar.boundingBox();
      await avatar.hover();
      await expect(status).toHaveCSS("opacity", "1");
      await expect(status).toHaveText(`${name} is working`);
      await expectStatusFits(suffix, workingAvatar);
      await expect(visibleName).toHaveCSS("text-overflow", "ellipsis");
      expect(await visibleName.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(await avatar.boundingBox()).toEqual(avatarPosition);
      const [avatarBox, statusBox] = await Promise.all([avatar.boundingBox(), status.boundingBox()]);
      expect(statusBox!.x).toBeGreaterThanOrEqual(avatarBox!.x + avatarBox!.width);
      expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(390);
      if (reducedMotion === "reduce") await expectInstantStatus(status);
      await page.mouse.move(0, 0);
      await expect(status).not.toBeVisible();
      await avatar.focus();
      await expect(status).toHaveCSS("opacity", "1");
      await expectStatusFits(suffix, workingAvatar);
      await expect(page.getByRole("tooltip", { name: `${name} is working` })).toHaveCount(0);
    }
    await composer.fill("finish maximum name activity");
    await composer.press("Enter");
    await expect(workingAvatar).toHaveCount(0);
  });

  test("uses whole-avatar pulse for uploads and preserves the working cue under reduced motion", async ({ page }) => {
    const botId = await createBot(page, "Uploaded Activity Bot");
    await openBotSettings(page, "Uploaded Activity Bot");
    await page.getByLabel("Choose an avatar image").setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: onePixelPng,
    });
    await page.getByRole("button", { name: "Close bot settings" }).click();

    const composer = page
      .getByRole("textbox", { name: "Message input", exact: true })
      .or(page.getByRole("combobox", { name: "Message input", exact: true }));
    await composer.fill("steer-echo");
    await composer.press("Enter");
    const workingAvatar = page.getByTestId("working-avatar");
    const uploadedAvatar = workingAvatar.getByTestId("avatar-upload");
    await expect.poll(async () => new URL((await uploadedAvatar.locator("img").getAttribute("src")) ?? "http://invalid/", page.url()).pathname).toBe(`/api/bots/${botId}/avatar`);
    await expect(uploadedAvatar).not.toHaveCSS("animation-name", "none");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(uploadedAvatar).toHaveCSS("animation-name", "none");
    await expect(workingAvatar.getByRole("img", { name: "Uploaded Activity Bot is working" })).toBeVisible();
    await expect(workingAvatar).toBeVisible();
    const status = workingAvatar.getByTestId("working-avatar-status");
    const workingImage = workingAvatar.getByRole("img", { name: "Uploaded Activity Bot is working" });
    const beforeReveal = await workingImage.boundingBox();
    await expect(status).not.toBeVisible();
    await expect(status).toHaveCSS("width", "0px");
    await workingImage.hover();
    await expect(status).toBeVisible();
    await expectInstantStatus(status);
    expect(await workingImage.boundingBox()).toEqual(beforeReveal);
    await page.mouse.move(0, 0);
    await expect(status).not.toBeVisible();
    await expect(status).toHaveCSS("width", "0px");
    await expectInstantStatus(status);
    await workingImage.focus();
    await expect(status).toBeVisible();
    await expectInstantStatus(status);

    const sidebarAvatar = page.getByTestId(`sidebar-bot-${botId}`).getByTestId("avatar-view");
    const sidebarStatus = page.getByTestId(`sidebar-bot-${botId}`).getByTestId("sidebar-working-status");
    const headerAvatar = page.getByTestId("bot-settings-open").getByTestId("avatar-view");
    const headerStatus = page.getByTestId("header-working-status");
    await composer.focus();
    for (const [avatar, inlineStatus] of [[sidebarAvatar, sidebarStatus], [headerAvatar, headerStatus]] as const) {
      await avatar.hover();
      await expect(inlineStatus).toBeVisible();
      await expectInstantStatus(inlineStatus);
      await page.mouse.move(0, 0);
      await expect(inlineStatus).not.toBeVisible();
      await expect(inlineStatus).toHaveCSS("width", "0px");
      await expectInstantStatus(inlineStatus);
    }

    await composer.fill("finish upload activity");
    await composer.press("Enter");
    await expect(page.getByTestId("working-avatar")).toHaveCount(0);
  });

  test("keeps both waiting states active and removes the working avatar for every terminal state", async ({ page, request }) => {
    const botId = await createBot(page, "Turn State Avatar Bot");
    const composer = page
      .getByRole("textbox", { name: "Message input", exact: true })
      .or(page.getByRole("combobox", { name: "Message input", exact: true }));
    await composer.fill("say: completed history");
    await composer.press("Enter");
    await expect(page.getByTestId("assistant-message").last()).toContainText("completed history", { timeout: 15_000 });

    const response = await request.get(`/api/bots/${botId}/threads`);
    const [persistedThread] = await response.json() as Array<Record<string, unknown>>;
    if (persistedThread === undefined || typeof persistedThread.id !== "string") throw new Error("missing persisted Thread");
    let status: "waiting_for_input" | "waiting_for_computer" | "completed" | "cancelled" | "failed" = "waiting_for_input";
    await page.route(`/api/bots/${botId}/threads`, async (route) => {
      const turn = {
        id: "turn_avatar_state",
        threadId: persistedThread.id,
        botId,
        status,
        steerCount: 0,
        startedAt: "2026-01-15T09:00:00.000Z",
        ...(["completed", "cancelled", "failed"].includes(status)
          ? { finishedAt: "2026-01-15T09:01:00.000Z" }
          : {}),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          ...persistedThread,
          latestTurn: turn,
          ...(["waiting_for_input", "waiting_for_computer"].includes(status) ? { activeTurn: turn } : {}),
        }]),
      });
    });

    for (const waiting of ["waiting_for_input", "waiting_for_computer"] as const) {
      status = waiting;
      await page.reload();
      await expect(page.getByTestId("working-avatar")).toBeVisible();
      await expect(page.getByTestId("assistant-message").last()).toContainText("completed history");
      await expect(page.getByTestId("assistant-message").last().getByTestId("avatar-view")).toHaveCount(0);
    }

    for (const terminal of ["completed", "cancelled", "failed"] as const) {
      status = terminal;
      await page.reload();
      await expect(page.getByTestId("working-avatar")).toHaveCount(0);
      await expect(page.getByTestId("assistant-message").last()).toContainText("completed history");
      await expect(page.getByTestId("assistant-message").last().getByTestId("avatar-view")).toHaveCount(0);
    }
  });
});
