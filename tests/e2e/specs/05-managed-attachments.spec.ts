import { expect, test, type Locator, type Page } from "../fixtures.ts";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Inspect local attachments");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();

  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

function stagedAttachments(page: Page): Locator {
  return page.getByLabel("Staged attachments");
}

function composerInput(page: Page): Locator {
  return page
    .getByRole("textbox", { name: "Message input", exact: true })
    .or(page.getByRole("combobox", { name: "Message input", exact: true }));
}

async function dropFile(page: Page, file: { name: string; mediaType: string; bytes: number[] }): Promise<void> {
  await composerInput(page).evaluate((element, dropped) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(dropped.bytes)], dropped.name, { type: dropped.mediaType }));
    element.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, file);
}

async function openHistory(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open conversation history" }).click();
  await expect(page.getByRole("dialog", { name: "Conversation history" })).toBeVisible();
}
async function sendAndWait(page: Page, text: string): Promise<void> {
  const priorReplies = await page.getByTestId("assistant-message").count();
  await composerInput(page).fill(text);
  await composerInput(page).press("Enter");
  await page.waitForURL((url) => {
    const threadId = url.searchParams.get("thread");
    return threadId !== null && threadId !== "blank";
  });
  await expect(page.getByTestId("assistant-message")).toHaveCount(priorReplies + 1, { timeout: 15_000 });
}

async function sampleDrawerTransition(drawer: Locator, present: boolean): Promise<number[]> {
  return drawer.evaluate(async (element, expected) => {
    const heights = [element.getBoundingClientRect().height];
    if (element.getAttribute("data-present") !== String(expected)) {
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (element.getAttribute("data-present") !== String(expected)) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(element, { attributes: true, attributeFilter: ["data-present"] });
      });
    }
    const started = performance.now();
    while (performance.now() - started < 300) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      heights.push(element.getBoundingClientRect().height);
    }
    return heights;
  }, present);
}


test.describe("managed attachments", () => {
  test("animates first and final attachments without retaining hidden draft controls", async ({ page }) => {
    await page.goto("/");
    await createBot(page, "Attachment Motion Bot");
    await sendAndWait(page, "say: ready");
    const drawer = page.getByTestId("attachment-drawer");
    const file = { name: "motion.txt", mimeType: "text/plain", buffer: Buffer.from("motion draft") };
    await expect(drawer).toHaveAttribute("data-present", "false");
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
    const [opening] = await Promise.all([
      sampleDrawerTransition(drawer, true),
      page.getByLabel("Choose files to attach").setInputFiles(file),
    ]);
    const expanded = opening.at(-1)!;
    expect(opening[0]).toBe(0);
    expect(expanded).toBeGreaterThan(0);
    expect(opening.some((height) => height > 0.5 && height < expanded - 0.5)).toBe(true);

    const remove = page.getByRole("button", { name: "Remove motion.txt" });
    const restingBox = await remove.boundingBox();
    await page.getByTestId("staged-attachment").hover();
    await expect(remove).toHaveCSS("opacity", "1");
    expect(await remove.boundingBox()).toEqual(restingBox);
    await remove.focus();
    await expect(remove).toBeFocused();

    const toggle = drawer.getByRole("button", { name: "Collapse Attachments" });
    await toggle.focus();
    await toggle.press("Enter");
    await expect(drawer.getByRole("button", { name: "Expand Attachments" })).toHaveAttribute("aria-expanded", "false");
    await expect(stagedAttachments(page)).toHaveAttribute("inert", "");
    await drawer.getByRole("button", { name: "Expand Attachments" }).press("Enter");
    await expect(stagedAttachments(page)).not.toHaveAttribute("inert");
    await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(expanded, 0);

    const [closing] = await Promise.all([
      sampleDrawerTransition(drawer, false),
      remove.click(),
    ]);
    expect(closing.some((height) => height > 0.5 && height < expanded - 0.5)).toBe(true);
    expect(closing.at(-1)).toBe(0);
    await expect(drawer).toHaveAttribute("inert", "");
    await expect(page.getByTestId("staged-attachment")).toHaveCount(0);
    await expect(remove).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const [reducedOpening] = await Promise.all([
      sampleDrawerTransition(drawer, true),
      page.getByLabel("Choose files to attach").setInputFiles(file),
    ]);
    const reducedExpanded = reducedOpening.at(-1)!;
    expect(reducedOpening.slice(1).every((height) => Math.abs(height - reducedExpanded) < 0.5)).toBe(true);
    const [reducedClosing] = await Promise.all([
      sampleDrawerTransition(drawer, false),
      page.getByRole("button", { name: "Remove motion.txt" }).click(),
    ]);
    expect(reducedClosing.slice(1).every((height) => height === 0)).toBe(true);
    await expect(page.getByTestId("staged-attachment")).toHaveCount(0);
  });

  test("stages with picker, restores in the same window, and stays bound to its original draft", async ({ page, request }) => {
    await page.goto("/");
    await createBot(page, "Attachment Draft Bot");
    await sendAndWait(page, "say: ready");
    const threadId = new URL(page.url()).searchParams.get("thread");
    if (threadId === null || threadId === "blank") throw new Error("active thread id missing");
    await page.getByLabel("Choose files to attach").setInputFiles({
      name: "notes.txt",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("window-local notes"),
    });
    const staged = stagedAttachments(page);
    const row = staged.getByText("notes.txt", { exact: true });
    const attachmentId = await page.getByTestId("staged-attachment").getAttribute("data-attachment-id");
    if (attachmentId === null) throw new Error("staged attachment id missing");
    await expect(staged.getByText("text/plain", { exact: true })).toBeVisible();
    await expect(staged.getByText("18 B", { exact: true })).toBeVisible();

    await composerInput(page).fill("attachment-echo");
    await openHistory(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(stagedAttachments(page)).toHaveCount(0);
    await expect(composerInput(page)).toHaveText("");

    await page.goBack();
    await expect(row).toBeVisible();
    await expect(composerInput(page)).toHaveText("attachment-echo");
    await page.reload();
    await expect(row).toBeVisible();

    const secondPage = await page.context().newPage();
    try {
      await secondPage.goto(page.url());
      await expect(stagedAttachments(secondPage)).toHaveCount(0);
      await expect(composerInput(secondPage)).toHaveText("");
      const otherDraftToken = await secondPage.evaluate(() => crypto.randomUUID());
      const headers = { "x-attachment-draft-token": otherDraftToken };
      expect((await request.get(`/api/attachments/staged/${attachmentId}`, { headers })).status()).toBe(404);
      expect((await request.delete(`/api/attachments/staged/${attachmentId}`, { headers })).status()).toBe(404);
      expect(
        (
          await request.post(`/api/threads/${threadId}/messages`, {
            data: {
              text: "attachment-echo",
              attachmentIds: [attachmentId],
              attachmentDraftToken: otherDraftToken,
            },
          })
        ).status(),
      ).toBe(400);
    } finally {
      await secondPage.close();
    }

    await page.reload();
    await expect(row).toBeVisible();
    await expect(composerInput(page)).toHaveText("attachment-echo");
    const priorReplies = await page.getByTestId("assistant-message").count();
    await composerInput(page).press("Enter");
    await expect(page.getByTestId("assistant-message")).toHaveCount(priorReplies + 1, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: /notes\.txt/ })).toBeVisible();
  });

  test("rejects unsupported attachments without losing the supported draft", async ({ page }) => {
    await page.goto("/");
    await createBot(page, "Attachment Failure Bot");

    await page.getByLabel("Choose files to attach").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep this complete draft"),
    });
    await composerInput(page).fill("attachment-echo");
    const supportedRow = stagedAttachments(page).getByText("notes.txt", { exact: true });
    await expect(supportedRow).toBeVisible();

    await dropFile(page, {
      name: "pixel.png",
      mediaType: "application/octet-stream",
      bytes: [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13],
    });
    await expect(page.getByText("This bot can’t use pixel.png. Remove it or choose a supported file.", { exact: true })).toBeVisible();
    await expect(composerInput(page)).toHaveText("attachment-echo");
    await expect(supportedRow).toBeVisible();
    await expect(page.getByRole("img", { name: "pixel.png" })).toHaveCount(0);

    await page.getByLabel("Choose files to attach").setInputFiles({
      name: "unsupported.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\nnot consumable by pi"),
    });
    await expect(page.getByText("This bot can’t use unsupported.pdf. Remove it or choose a supported file.", { exact: true })).toBeVisible();
    await expect(composerInput(page)).toHaveText("attachment-echo");
    await expect(supportedRow).toBeVisible();
    await expect(stagedAttachments(page).getByText("unsupported.pdf", { exact: true })).toHaveCount(0);

    await composerInput(page).press("Enter");
    await page.waitForURL((url) => {
      const threadId = url.searchParams.get("thread");
      return threadId !== null && threadId !== "blank";
    });
    await expect(stagedAttachments(page)).toHaveCount(0);
    await expect(composerInput(page)).toHaveText("");
    await expect(page.getByRole("link", { name: /notes\.txt/ })).toBeVisible();
  });

  test("drops missing staged references on reload with a contextual notice", async ({ page, request }) => {
    await page.goto("/");
    const botId = await createBot(page, "Attachment Restore Bot");
    await page.getByLabel("Choose files to attach").setInputFiles({
      name: "temporary.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("temporary"),
    });
    const attachmentId = await page.getByTestId("staged-attachment").getAttribute("data-attachment-id");
    if (attachmentId === null) throw new Error("staged attachment id missing");
    const draftToken = await page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      if (raw === null) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || !("attachmentDraftToken" in parsed)) return undefined;
      return parsed.attachmentDraftToken;
    }, `draft:v1:${botId}:blank`);
    if (typeof draftToken !== "string") throw new Error("attachment draft token missing");
    const deleted = await request.delete(`/api/attachments/staged/${attachmentId}`, {
      headers: { "x-attachment-draft-token": draftToken },
    });
    expect(deleted.status()).toBe(204);

    await page.reload();
    await expect(stagedAttachments(page)).toHaveCount(0);
    await expect(page.getByText("A staged attachment is no longer available and was removed from this draft.", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), `draft:v1:${botId}:blank`)).toBeNull();
  });
});
