import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "../fixtures.ts";

const PRIMARY_BOT_ID = "bot_ticket13_primary";
const SECONDARY_BOT_ID = "bot_ticket13_unavailable";
const PRIMARY_SURFACE_ID = "surf_11111111111111111111111111111111";
const SECONDARY_SURFACE_ID = "surf_22222222222222222222222222222222";
const THREAD_ID = "thread_ticket13_release_review";
const FIXED_EARLY = "2026-01-15T09:00:00.000Z";
const FIXED_LATE = "2026-01-15T10:00:00.000Z";
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const desktopViewport = { width: 1440, height: 900 };
const reducedMotionViewport = { width: 1024, height: 768 };
const narrowViewport = { width: 390, height: 780 };

type BotStatus = "inactive" | "active";
type ComputerState = "ready" | "bot-using" | "unavailable";

interface SeedOptions {
  empty?: boolean;
  primaryStatus?: BotStatus;
  computerState?: ComputerState;
  messagesGate?: Promise<void>;
  richTranscript?: boolean;
}

const avatar = (seed: string) => ({
  kind: "generated",
  recipe: {
    rendererVersion: "dicebear-core@10.7.0+styles@10.6.0",
    style: "pixelbot",
    seed,
    options: {},
  },
});

function botFixtures(primaryStatus: BotStatus, richTranscript = false) {
  return [
    {
      id: PRIMARY_BOT_ID,
      surfaceId: PRIMARY_SURFACE_ID,
      name: "Release Partner",
      instructions: "Keep the release review concise and actionable.",
      agentId: "pi",
      avatar: avatar("ticket-13-release-partner"),
      pinned: true,
      showToolCalls: richTranscript,
      showThinking: richTranscript,
      createdAt: FIXED_EARLY,
      updatedAt: FIXED_LATE,
      status: primaryStatus,
      unreadCount: 0,
      previewText: "The release checklist is ready.",
      previewAt: FIXED_LATE,
      lastActivityAt: FIXED_LATE,
      thinkingAvailability: "unavailable",
    },
    {
      id: SECONDARY_BOT_ID,
      surfaceId: SECONDARY_SURFACE_ID,
      name: "Offline Researcher",
      instructions: "Collect primary-source research.",
      agentId: "claude",
      avatar: { kind: "upload", url: `/api/bots/${SECONDARY_BOT_ID}/avatar` },
      pinned: false,
      showToolCalls: false,
      showThinking: false,
      createdAt: FIXED_EARLY,
      updatedAt: FIXED_EARLY,
      status: "active",
      unreadCount: 2,
      previewText: "Waiting for its agent.",
      previewAt: FIXED_EARLY,
      lastActivityAt: FIXED_EARLY,
      thinkingAvailability: "unavailable",
    },
  ];
}

function richTranscriptMessages() {
  const longChecklist = Array.from(
    { length: 18 },
    (_, index) => `${index + 1}. Validate ordered transcript boundary ${index + 1}.`,
  ).join("\n");
  return [
    {
      id: "message_ticket13_rich_user",
      threadId: THREAD_ID,
      seq: 1,
      author: { kind: "user" },
      kind: "text",
      text: "Review the complete ordered transcript.",
      createdAt: FIXED_EARLY,
    },
    {
      id: "message_ticket13_rich_response_1",
      threadId: THREAD_ID,
      seq: 2,
      author: { kind: "bot" },
      kind: "response",
      text: [
        "## Ordered release review",
        "",
        longChecklist,
        "",
        "| Content | Boundary |",
        "| --- | --- |",
        "| Response | merged only when adjacent |",
        "| Thinking and tools | preserved |",
        "",
        "```ts",
        "const expected = [\"response\", \"thinking\", \"tool\"];",
        "```",
      ].join("\n"),
      response: {
        blockId: "response_ticket13_rich_1",
        state: "completed",
        startedAt: FIXED_EARLY,
        completedAt: FIXED_LATE,
      },
      createdAt: FIXED_LATE,
    },
    {
      id: "message_ticket13_rich_response_2",
      threadId: THREAD_ID,
      seq: 3,
      author: { kind: "bot" },
      kind: "response",
      text: "Adjacent Response Block.",
      response: {
        blockId: "response_ticket13_rich_2",
        state: "completed",
        startedAt: FIXED_EARLY,
        completedAt: FIXED_LATE,
      },
      createdAt: FIXED_LATE,
    },
    {
      id: "message_ticket13_rich_thinking",
      threadId: THREAD_ID,
      seq: 4,
      author: { kind: "bot" },
      kind: "thinking",
      text: `**Expanded reasoning summary**\n\n${longChecklist}`,
      thinking: {
        blockId: "thinking_ticket13_rich",
        state: "completed",
        startedAt: FIXED_EARLY,
        completedAt: FIXED_LATE,
      },
      createdAt: FIXED_LATE,
    },
    {
      id: "message_ticket13_rich_tool_1",
      threadId: THREAD_ID,
      seq: 5,
      author: { kind: "bot" },
      kind: "tool",
      toolCall: {
        id: "tool_ticket13_read",
        name: "read",
        status: "completed",
        target: "src/transcript.ts",
        durationMs: 12,
      },
      createdAt: FIXED_LATE,
    },
    {
      id: "message_ticket13_rich_tool_2",
      threadId: THREAD_ID,
      seq: 6,
      author: { kind: "bot" },
      kind: "tool",
      toolCall: {
        id: "tool_ticket13_write",
        name: "write",
        status: "completed",
        target: "src/transcript.ts",
        durationMs: 8,
        additions: 4,
        deletions: 1,
      },
      createdAt: FIXED_LATE,
    },
    {
      id: "message_ticket13_rich_response_3",
      threadId: THREAD_ID,
      seq: 7,
      author: { kind: "bot" },
      kind: "response",
      text: "Final Response after grouped tools.",
      response: {
        blockId: "response_ticket13_rich_3",
        state: "completed",
        startedAt: FIXED_EARLY,
        completedAt: FIXED_LATE,
      },
      createdAt: FIXED_LATE,
    },
  ];
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function seedWorkspaceApi(page: Page, options: SeedOptions = {}): Promise<void> {
  const bots = options.empty ? [] : botFixtures(options.primaryStatus ?? "active", options.richTranscript);

  await page.route(`**/api/bots/${SECONDARY_BOT_ID}/avatar*`, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG }),
  );
  await page.route("**/api/agents", (route) =>
    fulfillJson(route, [
      {
        id: "pi",
        displayName: "Pi",
        version: "fixture",
        status: "ready",
        capabilities: {
          version: 4,
          steering: true,
          abort: true,
          botMail: true,
          plugins: true,
          nativeThreadActions: ["resume", "history", "close"],
          thinking: { supported: true, streaming: true },
          attachments: { text: true, image: false, maxTextBytes: 64 * 1024 },
          nativeEventFamilies: [],
        },
      },
      {
        id: "claude",
        displayName: "Claude",
        version: "fixture",
        status: "offline",
        reason: "Claude worker is disconnected.",
        guidance: "Reconnect Claude before sending a message.",
      },
    ]),
  );
  await page.route("**/api/bots*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/bots" || route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, bots);
  });
  await page.route("**/api/bots/*/threads*", async (route) => {
    const url = new URL(route.request().url());
    const botId = url.pathname.split("/")[3];
    await fulfillJson(
      route,
      botId === PRIMARY_BOT_ID
        ? (() => {
            const turn = {
              id: "turn_ticket13_release_review",
              threadId: THREAD_ID,
              botId: PRIMARY_BOT_ID,
              status: options.primaryStatus === "inactive" ? "completed" : "working",
              steerCount: 0,
              startedAt: FIXED_LATE,
              ...(options.primaryStatus === "inactive" ? { finishedAt: FIXED_LATE } : {}),
            };
            return [{
              id: THREAD_ID,
              botId: PRIMARY_BOT_ID,
              title: "Release readiness review",
              createdAt: FIXED_EARLY,
              updatedAt: FIXED_LATE,
              latestTurn: turn,
              ...(options.primaryStatus === "inactive" ? {} : { activeTurn: turn }),
            }];
          })()
        : [],
    );
  });
  await page.route(`**/api/threads/${THREAD_ID}/messages`, async (route) => {
    await options.messagesGate;
    await fulfillJson(
      route,
      options.richTranscript
        ? richTranscriptMessages()
        : [
            {
              id: "message_ticket13_user",
              threadId: THREAD_ID,
              seq: 1,
              author: { kind: "user" },
              kind: "text",
              text: "Review the release checklist and call out the final risk.",
              createdAt: FIXED_EARLY,
            },
            {
              id: "message_ticket13_bot",
              threadId: THREAD_ID,
              seq: 2,
              author: { kind: "bot" },
              kind: "response",
              text: "The checklist is complete. The final risk is the rollback rehearsal; schedule it before approval.",
              response: {
                blockId: "response_ticket13_release",
                state: "completed",
                startedAt: FIXED_EARLY,
                completedAt: FIXED_LATE,
              },
              createdAt: FIXED_LATE,
            },
          ],
    );
  });
  await page.route("**/api/computer/state**", (route) => {
    const state = options.computerState ?? "ready";
    const url = new URL(route.request().url());
    return fulfillJson(route, {
      state,
      botId: url.searchParams.get("botId"),
      surfaceId: url.searchParams.get("surfaceId"),
      takeover: "unavailable",
      activity:
        state === "unavailable"
          ? "Screen unavailable."
          : state === "bot-using"
            ? "Bot using screen."
            : "Screen ready.",
    });
  });
  await page.route("**/api/computer/snapshot**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG }),
  );
}

async function gotoSeededWorkspace(
  page: Page,
  empty = false,
  expectedResponse = "rollback rehearsal",
): Promise<void> {
  const initialResponses = [
    page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agents"),
    page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/bots" && url.search === "";
    }),
  ];
  if (!empty) {
    initialResponses.push(
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/bots/${PRIMARY_BOT_ID}/threads`),
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/threads/${THREAD_ID}/messages`),
    );
  }

  await Promise.all([page.goto("/", { waitUntil: "domcontentloaded" }), ...initialResponses]);
  if (empty) {
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { level: 1, name: "Release Partner" })).toBeVisible();
    await expect(page.getByTestId("assistant-message").last()).toContainText(expectedResponse);
  }
  await page.evaluate(async () => document.fonts.ready);
}

async function expectNoSeriousOrCriticalViolations(page: Page, state: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  const detail = violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help}\n${violation.nodes
          .map((node) => `  ${JSON.stringify(node.target)} — ${node.failureSummary ?? "No failure summary"}`)
          .join("\n")}\n  ${violation.helpUrl}`,
    )
    .join("\n\n");

  expect(violations, `${state} has serious/critical axe violations${detail.length > 0 ? `:\n${detail}` : ""}`).toEqual([]);
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  // This checks resting geometry; motion-specific tests sample intermediate frames.
  await locator.evaluate(async (element) => {
    const transitions: Animation[] = [];
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      transitions.push(...current.getAnimations().filter(
        (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
      ));
    }
    await Promise.all(transitions.map((animation) => animation.finished.catch(() => undefined)));
  });
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, "visible surface must have a bounding box").not.toBeNull();
  expect(viewport, "test must use a fixed viewport").not.toBeNull();
  if (box === null || viewport === null) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function expectWorkspaceContract(page: Page): Promise<void> {
  await expect(page.getByRole("navigation", { name: "Bot navigation", includeHidden: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
  await expect(page.getByLabel("Choose files to attach")).toBeHidden();
  await expect(page.getByRole("button", { name: "Attach files" })).toHaveCount(1);

  const composerInput = page
    .getByRole("textbox", { name: "Message input", exact: true })
    .or(page.getByRole("combobox", { name: "Message input", exact: true }));
  await expect(composerInput).toBeEnabled();
  await composerInput.fill("A keyboard-ready draft");
  await expect(composerInput).toHaveText("A keyboard-ready draft");
  await composerInput.fill("");
  const selectedBotButton = page.getByRole("button", { name: "Release Partner", exact: true });
  await expect(selectedBotButton).toHaveCount((await page.getByRole("navigation", { name: "Bot navigation" }).isVisible()) ? 1 : 0);
}

async function prepareVisualCapture(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
      time { visibility: hidden !important; }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Page screenshot animation controls do not reach SVG image documents.
    await Promise.all([...document.images].map(async (image) => {
      if (!image.src.startsWith("data:image/svg+xml")) return;
      const svg = decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1));
      if (svg.includes("@keyframes")) {
        const pausedSvg = svg.replace("</svg>", "<style>*, *::before, *::after { animation-play-state: paused !important; animation-delay: 0s !important; }</style></svg>");
        image.src = `data:image/svg+xml,${encodeURIComponent(pausedSvg)}`;
      }
      await image.decode();
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function captureWorkspace(page: Page, name: string): Promise<void> {
  await prepareVisualCapture(page);
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
  });
}

test.describe("ticket 13 responsive, accessible, and visual QA", () => {
  test("has no serious or critical axe violations in the empty workspace", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await seedWorkspaceApi(page, { empty: true });
    await gotoSeededWorkspace(page, true);

    await expect(page.getByRole("navigation", { name: "Bot navigation", includeHidden: true })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expectNoSeriousOrCriticalViolations(page, "Empty workspace");
  });

  test("has no serious or critical axe violations in a populated workspace", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    await expectWorkspaceContract(page);
    await expectNoSeriousOrCriticalViolations(page, "Populated workspace");
  });
  test("renders independent Sidebar, Header, history, and current-Turn avatar treatments", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    const selectedRow = page.getByTestId(`sidebar-bot-${PRIMARY_BOT_ID}`);
    const selectedButton = selectedRow.getByRole("button", { name: "Release Partner", exact: true });
    const selectedPreview = selectedButton.getByText("The release checklist is ready.", { exact: true });
    await expect(selectedPreview).toBeVisible();

    const selectedAvatar = selectedRow.getByTestId("avatar-view");
    const selectedRowBox = await selectedRow.boundingBox();
    const selectedAvatarBox = await selectedAvatar.boundingBox();
    const selectedName = selectedButton.getByText("Release Partner", { exact: true });
    const selectedNameBox = await selectedName.boundingBox();
    const selectedPreviewBox = await selectedPreview.boundingBox();
    if (!selectedRowBox || !selectedAvatarBox || !selectedNameBox || !selectedPreviewBox) {
      throw new Error("Sidebar Bot summary geometry is unavailable");
    }
    expect(selectedRowBox.height).toBe(56);
    expect(selectedAvatarBox.width).toBe(42);
    expect(Number(await selectedName.evaluate((element) => getComputedStyle(element).fontWeight))).toBeGreaterThanOrEqual(600);
    expect(selectedPreviewBox.y).toBeGreaterThan(selectedNameBox.y);

    await expect(selectedAvatar).toHaveAttribute("data-avatar-presentation", "ambient");
    const selectedImage = selectedAvatar.getByTestId("avatar-pixelbot").locator("img");
    const selectedSrc = await selectedImage.getAttribute("src");
    expect(selectedSrc).toMatch(/^data:image\/svg\+xml/);
    const selectedSvg = decodeURIComponent(selectedSrc!.slice(selectedSrc!.indexOf(",") + 1));
    expect(selectedSvg).toContain("@keyframes");
    expect(selectedSvg).toContain("prefers-reduced-motion");
    await expect(selectedRow.getByTestId("sidebar-activity-point")).toBeVisible();

    const uploadedRow = page.getByTestId(`sidebar-bot-${SECONDARY_BOT_ID}`);
    await expect.poll(async () => new URL((await uploadedRow.getByTestId("avatar-upload").locator("img").getAttribute("src")) ?? "http://invalid/", page.url()).pathname)
      .toBe(`/api/bots/${SECONDARY_BOT_ID}/avatar`);
    await expect(uploadedRow.getByTestId("avatar-upload")).toHaveCSS("animation-name", "none");
    await expect(uploadedRow.getByTestId("sidebar-activity-point")).toBeVisible();
    await expect(uploadedRow.getByTestId(`sidebar-unread-${SECONDARY_BOT_ID}`)).toBeVisible();

    const headerAvatar = page.getByTestId("bot-settings-open").getByTestId("avatar-view");
    await expect(headerAvatar).toHaveAttribute("data-avatar-presentation", "static");
    const headerSvg = await headerAvatar.getByTestId("avatar-pixelbot").locator("img").getAttribute("src");
    expect(decodeURIComponent(headerSvg!.slice(headerSvg!.indexOf(",") + 1))).not.toContain("@keyframes");

    const historicalMessage = page.getByTestId("assistant-message").last();
    await expect(historicalMessage.getByTestId("avatar-view")).toHaveCount(0);
    const workingAvatar = page.getByTestId("working-avatar");
    const [historicalBox, workingBox] = await Promise.all([historicalMessage.boundingBox(), workingAvatar.boundingBox()]);
    expect(historicalBox).not.toBeNull();
    expect(workingBox).not.toBeNull();
    expect(workingBox!.y).toBeGreaterThanOrEqual(historicalBox!.y + historicalBox!.height);
  });


  test("keeps core workspace surfaces unclipped at desktop and narrow breakpoints", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    await expectInsideViewport(page, page.getByRole("navigation", { name: "Bot navigation" }));
    await expectInsideViewport(page, page.getByTestId("conversation-header"));
    await expectInsideViewport(page, page.getByRole("log"));
    await expectInsideViewport(page, page.getByTestId("composer"));

    await page.setViewportSize(narrowViewport);
    await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeHidden();
    await expectInsideViewport(page, page.getByTestId("conversation-header"));
    await expectInsideViewport(page, page.getByRole("log"));
    await expectInsideViewport(page, page.getByTestId("composer"));
    await expectWorkspaceContract(page);

    await page.getByRole("button", { name: "Open conversation history" }).click();
    const history = page.getByRole("dialog", { name: "Conversation history" });
    await expectInsideViewport(page, history);
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();

    await page.getByRole("button", { name: "Open settings for Release Partner" }).click();
    const botSettingsPanel = page.getByRole("complementary", { name: "Bot settings" });
    await expectInsideViewport(page, botSettingsPanel);
    await page.keyboard.press("Escape");
    await expect(botSettingsPanel).toBeHidden();

    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const computer = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expectInsideViewport(page, computer);
    await page.keyboard.press("Escape");
    await expect(computer).toBeHidden();

    await page.getByRole("button", { name: "Open bot navigation" }).click();
    await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
    const createBot = page.getByRole("dialog", { name: "Create a bot" });
    await expectInsideViewport(page, createBot);
    await expect.poll(() => createBot.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(createBot).toBeHidden();

    await page.getByRole("button", { name: "Open bot navigation" }).click();
    await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expectInsideViewport(page, settings);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  });

  test("keeps the Computer rail compact, themed, focusable, and responsive beside the Composer", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    const conversation = page.getByLabel("Conversation workspace");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const capabilities = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(capabilities.getByRole("heading", { name: "Release Partner’s screen" })).toBeVisible();
    await expect(capabilities.getByRole("tab", { name: "Changes" })).toHaveCount(0);
    await expect(capabilities.getByRole("button", { name: "Refresh changes", exact: true })).toHaveCount(0);
    await expectInsideViewport(page, capabilities);
    await expect(conversation).toBeVisible();
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Attach files" })).toBeVisible();
    await expect(page.getByRole("button", { name: /voice recording|voice dictation|Transcribing voice/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    const desktopBox = await capabilities.boundingBox();
    expect(desktopBox).not.toBeNull();
    expect(desktopBox!.width).toBeLessThanOrEqual(560);
    await expect(page.getByRole("complementary")).toHaveCount(1);

    const close = capabilities.getByRole("button", { name: "Close capabilities" });
    await close.focus();
    await expect(close).toBeFocused();
    const capabilityHeading = capabilities.getByRole("heading", { name: "Capabilities", exact: true });
    const lightText = await capabilityHeading.evaluate((element) => getComputedStyle(element).color);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect.poll(
      () => capabilityHeading.evaluate((element) => getComputedStyle(element).color),
    ).not.toBe(lightText);
    await expectNoSeriousOrCriticalViolations(page, "Desktop Computer capability");

    await page.setViewportSize(narrowViewport);
    await expect(conversation).toHaveCount(0);
    await expectInsideViewport(page, capabilities);
    const narrowBox = await capabilities.boundingBox();
    expect(narrowBox?.width).toBe(narrowViewport.width);
    await expect(close).toBeVisible();
    await expectNoSeriousOrCriticalViolations(page, "Narrow dark reduced-motion Computer capability");
    await close.click();
    await expect(conversation).toBeVisible();
    await expect(page.getByTestId("composer")).toBeVisible();
  });

  test("shows contextual loading and unavailable states", async ({ page }) => {
    const messages = Promise.withResolvers<void>();
    await page.setViewportSize(desktopViewport);
    await seedWorkspaceApi(page, { computerState: "unavailable", messagesGate: messages.promise });

    const initialResponses = [
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/agents"),
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bots"),
      page.waitForResponse((response) => new URL(response.url()).pathname === `/api/bots/${PRIMARY_BOT_ID}/threads`),
    ];
    await Promise.all([page.goto("/", { waitUntil: "domcontentloaded" }), ...initialResponses]);
    await expect(page.getByText("Loading conversation", { exact: true })).toBeVisible();

    messages.resolve();
    await expect(page.getByTestId("assistant-message").last()).toContainText("rollback rehearsal");

    await page.getByRole("button", { name: "Offline Researcher", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Offline Researcher" })).toBeVisible();
    await expect(page.getByText("Claude isn’t ready", { exact: true })).toBeVisible();
    const conversationWorkspace = page.getByLabel("Conversation workspace");
    const unavailableNotice = conversationWorkspace.getByTestId("composer-error-card");
    await expect(unavailableNotice).toContainText("Claude worker is disconnected.");
    await expect(unavailableNotice).toContainText("Reconnect Claude before sending a message.");
    await expect(conversationWorkspace.getByRole("alert")).toHaveCount(1);
    await expect(
      page
        .getByRole("textbox", { name: "Message input", exact: true })
        .or(page.getByRole("combobox", { name: "Message input", exact: true }))
    ).toHaveAttribute("contenteditable", "false");

    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const computer = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(computer.getByRole("heading", { name: "Screen unavailable", exact: true })).toBeVisible();
    await expect(computer.getByAltText("Computer Preview for Offline Researcher")).toHaveCount(0);
  });

  test("opens and closes narrow bot navigation by keyboard and closes it after bot selection", async ({ page }) => {
    await page.setViewportSize(narrowViewport);
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    const trigger = page.getByRole("button", { name: "Open bot navigation" });
    await trigger.focus();
    await trigger.press("Enter");
    const navigation = page.getByRole("navigation", { name: "Bot navigation" });
    await expect(navigation).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Escape");
    await expect(navigation).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.press("Enter");
    const secondaryBot = navigation.getByRole("button", { name: "Offline Researcher", exact: true });
    await secondaryBot.focus();
    await secondaryBot.press("Enter");
    await expect(navigation).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`bot=${SECONDARY_BOT_ID}`));
    await expect(page.getByRole("heading", { level: 1, name: "Offline Researcher" })).toBeVisible();
  });

  test("returns focus after Bot Settings and computer drawer dismissal", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    const botSettingsTrigger = page.getByTestId("bot-settings-open");
    await expect(page.getByRole("button", { name: "Edit bot profile" })).toHaveCount(0);
    await expect(botSettingsTrigger.getByTestId("avatar-view")).toBeVisible();
    await expect(botSettingsTrigger.getByRole("heading", { level: 1, name: "Release Partner" })).toBeVisible();
    const identityBox = await botSettingsTrigger.boundingBox();
    const sessionBox = await page.getByRole("button", { name: "Open conversation history" }).boundingBox();
    expect(identityBox).not.toBeNull();
    expect(sessionBox).not.toBeNull();
    expect(Math.abs(identityBox!.y + identityBox!.height / 2 - (sessionBox!.y + sessionBox!.height / 2))).toBeLessThan(2);
    const headerPadding = await page.getByTestId("conversation-header").evaluate((element) => {
      const container = element.parentElement?.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      if (container === undefined) throw new Error("Conversation header padding container is missing");
      return {
        top: row.top - container.top,
        bottom: container.bottom - row.bottom,
      };
    });
    expect(headerPadding).toEqual({ top: 8, bottom: 8 });
    await botSettingsTrigger.hover();
    const identityPadding = await botSettingsTrigger.evaluate((element) => {
      const avatar = element.querySelector<HTMLElement>('[data-testid="avatar-view"]');
      if (avatar === null) throw new Error("Conversation header avatar is missing");
      const buttonBox = element.getBoundingClientRect();
      const buttonStyle = getComputedStyle(element);
      const avatarStyle = getComputedStyle(avatar);
      return {
        blockStart: buttonStyle.paddingBlockStart,
        blockEnd: buttonStyle.paddingBlockEnd,
        inlineStart: buttonStyle.paddingInlineStart,
        inlineEnd: buttonStyle.paddingInlineEnd,
        verticalSpace: buttonBox.height - Number.parseFloat(avatarStyle.height),
      };
    });
    expect(identityPadding).toEqual({
      blockStart: "4px",
      blockEnd: "4px",
      inlineStart: "6px",
      inlineEnd: "6px",
      verticalSpace: 8,
    });
    await expect(botSettingsTrigger).toHaveAccessibleName("Open settings for Release Partner");
    await expect(botSettingsTrigger).toHaveAttribute("aria-expanded", "false");
    await botSettingsTrigger.focus();
    await botSettingsTrigger.press("Enter");
    const botSettingsPanel = page.getByRole("complementary", { name: "Bot settings" });
    await expect(botSettingsPanel.getByTestId("bot-settings-panel")).toBeVisible();
    await expect(botSettingsTrigger).toHaveAccessibleName("Close settings for Release Partner");
    await expect(botSettingsTrigger).toHaveAttribute("aria-expanded", "true");
    await botSettingsTrigger.click();
    await expect(botSettingsPanel).toBeHidden();
    await expect(botSettingsTrigger).toHaveAccessibleName("Open settings for Release Partner");
    await expect(botSettingsTrigger).toHaveAttribute("aria-expanded", "false");
    await botSettingsTrigger.press("Enter");
    await expect(botSettingsPanel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(botSettingsPanel).toBeHidden();
    await expect(botSettingsTrigger).toBeFocused();

    await page.setViewportSize(narrowViewport);
    const computerTrigger = page.getByRole("button", { name: "Open Computer Surface", exact: true });
    await computerTrigger.focus();
    await computerTrigger.press("Enter");
    await expect(page.getByRole("complementary", { name: "Workspace capabilities", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "Workspace capabilities", exact: true })).toBeHidden();
    await expect(computerTrigger).toBeFocused();

    const mobileNavigationTrigger = page.getByRole("button", { name: "Open bot navigation" });
    await mobileNavigationTrigger.press("Enter");
    const settingsTrigger = page
      .getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "Settings", exact: true });
    await settingsTrigger.press("Enter");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(mobileNavigationTrigger).toBeFocused();
  });

  test("shows immutable Agent identity, system-following appearance state, and setup guidance", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => localStorage.setItem("settings:v1:appearance", "light"));
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "Notification", {
        configurable: true,
        value: {
          permission: "default",
          requestPermission: async () => "granted",
        },
      });
    });
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);

    await page.getByRole("button", { name: "Open settings for Release Partner" }).click();
    const botSettingsPanel = page.getByRole("complementary", { name: "Bot settings" });
    await expect(botSettingsPanel.getByText("Backing Agent", { exact: true })).toBeVisible();
    await expect(botSettingsPanel.getByText("Pi", { exact: true })).toBeVisible();
    await expect(botSettingsPanel.getByText("Fixed for this bot.", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByText("Follows your current Omarchy and system appearance.", { exact: true })).toBeVisible();
    await expect(settings.getByRole("radio")).toHaveCount(0);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBeNull();
    await expect(settings.getByTestId("settings-nav-voice")).toHaveCount(0);
    await expect(settings.getByText("Voice", { exact: true })).toHaveCount(0);
    await settings.getByTestId("settings-nav-notifications").click();
    await expect(settings.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
    await expect(settings.getByText("Desktop notifications", { exact: true })).toBeVisible();
    await expect(settings.getByRole("switch", { name: /voice/i })).toHaveCount(0);
    await settings.getByRole("button", { name: "Enable desktop notifications" }).click();
    await expect(settings.getByText("Enabled for background Bot completions and requests for your attention.", { exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Enable desktop notifications" })).toHaveCount(0);
  });

  test("keeps a long ordered transcript accessible, responsive, focusable, scrollable, and motion-safe", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page, { richTranscript: true, primaryStatus: "active" });
    await gotoSeededWorkspace(page, false, "Final Response after grouped tools.");

    const responses = page.getByTestId("assistant-message");
    await expect(responses).toHaveCount(2);
    await expect(responses.first()).toHaveAttribute("data-response-block-count", "2");
    await expect(responses.first().getByRole("heading", { name: "Ordered release review" })).toBeVisible();
    await expect(responses.first().locator("table")).toBeVisible();
    await expect(responses.first().locator("pre")).toContainText("const expected");

    const thinking = page.getByTestId("thinking-message");
    const thinkingTrigger = thinking.getByRole("button");
    await expect(thinkingTrigger).toHaveAccessibleName("Thinking complete · 3600s");
    await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "false");
    await thinkingTrigger.focus();
    await thinkingTrigger.press("Enter");
    await expect(thinkingTrigger).toBeFocused();
    await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(thinking.locator("strong")).toHaveText("Expanded reasoning summary");

    const groupedTools = page.getByTestId("tool-calls");
    const toolTrigger = groupedTools.getByRole("button");
    await expect(toolTrigger).toHaveAttribute("aria-expanded", "false");
    await toolTrigger.focus();
    await toolTrigger.press("Enter");
    await expect(toolTrigger).toBeFocused();
    await expect(toolTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(groupedTools).toContainText("read");
    await expect(groupedTools).toContainText("write");

    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
    await expectNoSeriousOrCriticalViolations(page, "Expanded ordered transcript in light mode");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expect(page.getByTestId("working-avatar").getByTestId("avatar-pixelbot")).toHaveCSS("animation-name", "none");
    await expect(page.getByTestId("working-avatar").getByRole("img", { name: "Release Partner is working" })).toBeVisible();
    await expect(page.getByTestId(`sidebar-bot-${PRIMARY_BOT_ID}`).getByTestId("sidebar-activity-point")).toBeVisible();
    await expectNoSeriousOrCriticalViolations(page, "Expanded ordered transcript in dark reduced-motion mode");

    const scrollState = await page.getByRole("log").evaluate(async (root) => {
      const candidates = [root, ...root.querySelectorAll("*")]
        .filter((element): element is HTMLElement => element instanceof HTMLElement);
      let ancestor = root.parentElement;
      while (ancestor !== null) {
        if (ancestor instanceof HTMLElement) candidates.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      const viewport = candidates.find((candidate) => candidate.scrollHeight > candidate.clientHeight + 8);
      if (viewport === undefined) throw new Error("long ordered transcript did not overflow");
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      };
    });
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
    expect(scrollState.scrollTop).toBeGreaterThanOrEqual(
      scrollState.scrollHeight - scrollState.clientHeight - 2,
    );
    await expect(responses.last()).toBeVisible();

    await page.setViewportSize(narrowViewport);
    await responses.last().scrollIntoViewIfNeeded();
    await expectInsideViewport(page, responses.last());
    await expect.poll(() => page.getByRole("log").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(thinkingTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(toolTrigger).toHaveAttribute("aria-expanded", "true");
    await expectNoSeriousOrCriticalViolations(page, "Expanded ordered transcript at narrow breakpoint");
  });

  test("matches the fixed light desktop workspace", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);
    await captureWorkspace(page, "ticket-13-workspace-desktop-light.png");
  });

  test("matches the fixed dark desktop workspace", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);
    await captureWorkspace(page, "ticket-13-workspace-desktop-dark.png");
  });
  test("matches the desktop Computer Surface", async ({ page }) => {
    await page.setViewportSize(desktopViewport);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page, { computerState: "bot-using" });
    await gotoSeededWorkspace(page);

    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const computer = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(computer).toBeVisible();
    await expect(computer.getByText("Bot using screen", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Computer Surface" })).toHaveCount(0);
    await captureWorkspace(page, "ticket-13-computer-drawer-dark.png");
  });


  test("matches the fixed narrow workspace", async ({ page }) => {
    await page.setViewportSize(narrowViewport);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await seedWorkspaceApi(page);
    await gotoSeededWorkspace(page);
    await captureWorkspace(page, "ticket-13-workspace-narrow-light.png");
  });

  test("matches the fixed reduced-motion workspace", async ({ page }) => {
    await page.setViewportSize(reducedMotionViewport);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await seedWorkspaceApi(page, { primaryStatus: "active" });
    await gotoSeededWorkspace(page);

    const workingAvatar = page.getByTestId("working-avatar");
    await expect(workingAvatar.getByTestId("avatar-pixelbot")).toHaveCSS("animation-name", "none");
    await expect(workingAvatar.getByRole("img", { name: "Release Partner is working" })).toBeVisible();
    await expect(workingAvatar).toBeVisible();
    await captureWorkspace(page, "ticket-13-workspace-reduced-motion-dark.png");
  });
});
