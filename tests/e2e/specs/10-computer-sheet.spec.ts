import { expect, test, type Page, type Route } from "../fixtures.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWMQMgn7D8IAC5MDN627upEAAAAASUVORK5CYII=",
  "base64",
);

type ComputerState = "starting" | "ready" | "bot-using" | "needs-you" | "user-control" | "unavailable";

async function createBot(page: Page, name: string): Promise<string> {
  await page.getByRole("navigation", { name: "Bot navigation" }).getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Job / Instructions" }).fill("Computer E2E teammate");
  await page.getByRole("radio", { name: /^Pi/ }).check();
  await page.getByRole("button", { name: "Create bot" }).click();
  const row = page.getByRole("button", { name, exact: true });
  await expect(row).toBeVisible();
  const botId = new URL(page.url()).searchParams.get("bot");
  if (botId === null) throw new Error(`missing selected bot id for ${name}`);
  return botId;
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function settleCapabilityLayout(page: Page): Promise<void> {
  await page.getByTestId("capability-presence").evaluate(async (shell) => {
    const regions = [shell, ...shell.querySelectorAll(".capability-panel, .capability-tab-content")];
    await Promise.all(regions.flatMap((region) =>
      region.getAnimations().map((animation) => animation.finished)
    ));
  });
}

interface ProjectionFixtureState {
  control: import("@playwright/test").WebSocketRoute | undefined;
  rfb: import("@playwright/test").WebSocketRoute | undefined;
  surfaceId: string;
  sessionId: string;
  runtimeGeneration: number;
  geometryGeneration: number;
  sequence: number;
  controllerEpoch: number;
  mode: "idle" | "preview" | "expanded";
  inputAuthorityAvailable: boolean;
  inputAuthorityActive: boolean;
  frameAvailable: boolean;
}

async function installProjectionPeer(
  page: Page,
  options: { inputAuthorityAvailable?: boolean; frameAvailable?: boolean } = {},
): Promise<void> {
  await page.addInitScript(({ inputAuthorityAvailable }) => {
    const inputMessages: unknown[] = [];
    const controlMessages: unknown[] = [];
    const rfbClientMessages: number[][] = [];
    Object.defineProperty(window, "__screenInputMessages", { configurable: true, value: inputMessages });
    Object.defineProperty(window, "__screenControlMessages", { configurable: true, value: controlMessages });
    Object.defineProperty(window, "__screenRfbClientMessages", { configurable: true, value: rfbClientMessages });
    Object.defineProperty(window, "__screenRfbClosedCount", { configurable: true, writable: true, value: 0 });

    // Playwright's routed socket inherits WebSocket members one prototype deeper
    // than the native browser object. noVNC validates the native property surface.
    // Install after the routing shim, without replacing the real noVNC client.
    const observeSockets = (): void => {
      const prototype = WebSocket.prototype;
      for (const property of ["send", "close", "binaryType", "protocol", "readyState", "onopen", "onclose", "onerror", "onmessage"]) {
        if (Object.prototype.hasOwnProperty.call(prototype, property)) continue;
        let ancestor = Object.getPrototypeOf(prototype);
        while (ancestor !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(ancestor, property);
          if (descriptor !== undefined) {
            Object.defineProperty(prototype, property, descriptor);
            break;
          }
          ancestor = Object.getPrototypeOf(ancestor);
        }
      }
      const nativeSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        const pathname = new URL(this.url).pathname;
        if (pathname.endsWith("/control") && typeof data === "string") {
          try {
            const message = JSON.parse(data) as { type?: string };
            if (message.type === "view" || message.type === "browser-metrics") controlMessages.push(message);
            else inputMessages.push(message);
          } catch {
            // Malformed control messages remain observable at the server route.
          }
        } else if (pathname.endsWith("/rfb")) {
          if (data instanceof ArrayBuffer) rfbClientMessages.push(Array.from(new Uint8Array(data)));
          else if (ArrayBuffer.isView(data)) {
            rfbClientMessages.push(Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
          }
        }
        nativeSend.call(this, data);
      };
    };
    window.addEventListener("DOMContentLoaded", observeSockets, { once: true });

    let authorityAvailable = inputAuthorityAvailable;
    const testControl = {
      inputAuthorityActive: false,
      get inputAuthorityAvailable(): boolean {
        return authorityAvailable;
      },
      set inputAuthorityAvailable(value: boolean) {
        authorityAvailable = value;
        void fetch(`/__e2e/projection-control?action=authority&available=${value ? "1" : "0"}`);
      },
      revokeInput(): void {
        authorityAvailable = false;
        void fetch("/__e2e/projection-control?action=revoke");
      },
      disconnect(): void {
        void fetch("/__e2e/projection-control?action=disconnect");
      },
      disconnectView(): void {
        void fetch("/__e2e/projection-control?action=disconnect-rfb");
      },
      failView(): void {
        void fetch("/__e2e/projection-control?action=fail-view");
      },
    };
    Object.defineProperty(window, "__screenProjectionControl", { configurable: true, value: testControl });
  }, { inputAuthorityAvailable: options.inputAuthorityAvailable ?? true });

  let latest: ProjectionFixtureState | undefined;
  const states = new Map<string, ProjectionFixtureState>();

  const setAuthorityActive = async (active: boolean): Promise<void> => {
    await page.evaluate((value) => {
      (window as typeof window & {
        __screenProjectionControl: { inputAuthorityActive: boolean };
      }).__screenProjectionControl.inputAuthorityActive = value;
    }, active).catch(() => {});
  };

  const identity = (state: ProjectionFixtureState, type: string): Record<string, unknown> => ({
    version: 3,
    type,
    sessionId: state.sessionId,
    surfaceId: state.surfaceId,
    runtimeGeneration: state.runtimeGeneration,
  });

  const sendAuthority = (state: ProjectionFixtureState, active: boolean): void => {
    if (state.control === undefined) return;
    state.inputAuthorityActive = active;
    state.control.send(JSON.stringify({
      ...identity(state, "input-authority"),
      active,
      geometryGeneration: state.geometryGeneration,
      controllerEpoch: state.controllerEpoch,
      logicalWidth: 1000,
      logicalHeight: 500,
      videoWidth: 2000,
      videoHeight: 1000,
      scale: 2,
    }));
    void setAuthorityActive(active);
  };

  await page.route("**/__e2e/projection-control**", async (route) => {
    const actionUrl = new URL(route.request().url());
    const state = latest;
    if (state !== undefined) {
      switch (actionUrl.searchParams.get("action")) {
        case "authority":
          state.inputAuthorityAvailable = actionUrl.searchParams.get("available") === "1";
          if (state.mode === "expanded") sendAuthority(state, state.inputAuthorityAvailable);
          break;
        case "revoke":
          state.inputAuthorityAvailable = false;
          sendAuthority(state, false);
          break;
        case "disconnect":
          await state.control?.close({ code: 1011, reason: "fixture disconnect" });
          break;
        case "disconnect-rfb":
          await state.rfb?.close({ code: 1011, reason: "fixture RFB disconnect" });
          break;
        case "fail-view":
          state.control?.send(JSON.stringify({
            ...identity(state, "projection-failure"),
            reason: "view-client-failed",
            snapshotFallback: true,
          }));
          break;
      }
    }
    await route.fulfill({ status: 204, body: "" });
  });

  await page.routeWebSocket(/\/api\/computer\/projection\/control(?:\?|$)/, (socket) => {
    const url = new URL(socket.url());
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const surfaceId = url.searchParams.get("surfaceId") ?? "";
    const state: ProjectionFixtureState = {
      control: socket,
      rfb: undefined,
      surfaceId,
      sessionId,
      runtimeGeneration: 1,
      geometryGeneration: 1,
      sequence: 0,
      controllerEpoch: 7,
      mode: "idle",
      inputAuthorityAvailable: options.inputAuthorityAvailable ?? true,
      inputAuthorityActive: false,
      frameAvailable: options.frameAvailable ?? true,
    };
    states.set(sessionId, state);
    latest = state;
    socket.send(JSON.stringify({ ...identity(state, "view-state"), mode: "idle" }));
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message) as Record<string, unknown>;
      } catch {
        return;
      }
      if (
        parsed.version !== 3
        || parsed.sessionId !== state.sessionId
        || parsed.surfaceId !== state.surfaceId
        || parsed.runtimeGeneration !== state.runtimeGeneration
      ) return;
      if (parsed.type === "view") {
        const mode = parsed.mode;
        if (mode !== "idle" && mode !== "preview" && mode !== "expanded") return;
        state.mode = mode;
        socket.send(JSON.stringify({ ...identity(state, "view-state"), mode }));
        if (mode === "idle") {
          if (state.inputAuthorityActive) sendAuthority(state, false);
          return;
        }
        if (mode === "expanded") {
          if (state.inputAuthorityAvailable) sendAuthority(state, true);
          return;
        }
        if (!state.frameAvailable) return;
        state.sequence += 1;
        socket.send(JSON.stringify({
          ...identity(state, "preview-frame"),
          geometryGeneration: state.geometryGeneration,
          logicalWidth: 1000,
          logicalHeight: 500,
          videoWidth: 2000,
          videoHeight: 1000,
          scale: 2,
          sequence: state.sequence,
          mediaType: "image/png",
          capturedAt: new Date().toISOString(),
          byteLength: PNG.byteLength,
        }));
        socket.send(PNG);
        return;
      }
      if (parsed.type === "release-control") {
        sendAuthority(state, false);
        state.controllerEpoch += 1;
      }
    });
    socket.onClose(() => {
      if (state.control === socket) state.control = undefined;
      state.inputAuthorityActive = false;
      void setAuthorityActive(false);
    });
  });

  await page.routeWebSocket(/\/api\/computer\/projection\/rfb(?:\?|$)/, (socket) => {
    const url = new URL(socket.url());
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const state = states.get(sessionId);
    if (state === undefined || state.mode !== "expanded") {
      void socket.close({ code: 1008, reason: "expanded mode required" });
      return;
    }
    state.rfb = socket;

    let stage: "version" | "security" | "client-init" | "ready" = "version";
    let pending = Buffer.alloc(0);
    let frameSent = false;
    let redShift = 16;
    let greenShift = 8;
    let bigEndian = false;

    const sendServerInit = (): void => {
      const name = Buffer.from("Omarchy RFB Fixture", "utf8");
      const message = Buffer.alloc(24 + name.byteLength);
      message.writeUInt16BE(2, 0);
      message.writeUInt16BE(1, 2);
      message[4] = 32;
      message[5] = 24;
      message[6] = 0;
      message[7] = 1;
      message.writeUInt16BE(255, 8);
      message.writeUInt16BE(255, 10);
      message.writeUInt16BE(255, 12);
      message[14] = 16;
      message[15] = 8;
      message[16] = 0;
      message.writeUInt32BE(name.byteLength, 20);
      name.copy(message, 24);
      socket.send(message);
    };

    const sendFramebuffer = (): void => {
      const update = Buffer.alloc(24);
      update[0] = 0;
      update.writeUInt16BE(1, 2);
      update.writeUInt16BE(0, 4);
      update.writeUInt16BE(0, 6);
      update.writeUInt16BE(2, 8);
      update.writeUInt16BE(1, 10);
      update.writeInt32BE(0, 12);
      if (bigEndian) {
        update.writeUInt32BE((255 << redShift) >>> 0, 16);
        update.writeUInt32BE((255 << greenShift) >>> 0, 20);
      } else {
        update.writeUInt32LE((255 << redShift) >>> 0, 16);
        update.writeUInt32LE((255 << greenShift) >>> 0, 20);
      }
      socket.send(update);
    };

    const readyMessageLength = (bytes: Buffer): number | undefined => {
      if (bytes.byteLength === 0) return undefined;
      switch (bytes[0]) {
        case 0:
          return 20;
        case 2:
          return bytes.byteLength < 4 ? undefined : 4 + bytes.readUInt16BE(2) * 4;
        case 3:
          return 10;
        case 4:
          return 8;
        case 5:
          return 6;
        case 6:
          return bytes.byteLength < 8 ? undefined : 8 + bytes.readUInt32BE(4);
        case 150:
          return 10;
        case 248:
          return bytes.byteLength < 9 ? undefined : 9 + bytes[8]!;
        case 251:
          return bytes.byteLength < 8 ? undefined : 8 + bytes[6]! * 16;
        default:
          return -1;
      }
    };

    const consume = (): void => {
      while (pending.byteLength > 0) {
        if (stage === "version") {
          if (pending.byteLength < 12) return;
          const version = pending.subarray(0, 12).toString("ascii");
          pending = pending.subarray(12);
          if (version !== "RFB 003.008\n") {
            void socket.close({ code: 1002, reason: "unsupported RFB version" });
            return;
          }
          socket.send(Buffer.from([1, 1]));
          stage = "security";
          continue;
        }
        if (stage === "security") {
          if (pending.byteLength < 1) return;
          const selected = pending[0];
          pending = pending.subarray(1);
          if (selected !== 1) {
            void socket.close({ code: 1002, reason: "unsupported RFB security" });
            return;
          }
          socket.send(Buffer.alloc(4));
          stage = "client-init";
          continue;
        }
        if (stage === "client-init") {
          if (pending.byteLength < 1) return;
          pending = pending.subarray(1);
          sendServerInit();
          stage = "ready";
          continue;
        }
        const length = readyMessageLength(pending);
        if (length === undefined || pending.byteLength < length) return;
        if (length < 0) {
          void socket.close({ code: 1002, reason: "unsupported RFB client message" });
          return;
        }
        const type = pending[0];
        if (type === 0) {
          if (pending[4] !== 32 || pending[7] !== 1) {
            void socket.close({ code: 1003, reason: "fixture supports 32-bit true color" });
            return;
          }
          bigEndian = pending[6] !== 0;
          redShift = pending[14]!;
          greenShift = pending[15]!;
        }
        pending = pending.subarray(length);
        if (type === 3 && !frameSent) {
          frameSent = true;
          sendFramebuffer();
        }
      }
    };

    socket.onMessage((message) => {
      if (typeof message === "string") {
        void socket.close({ code: 1003, reason: "RFB must be binary" });
        return;
      }
      pending = Buffer.concat([pending, message]);
      consume();
    });
    socket.onClose(() => {
      if (state.rfb === socket) state.rfb = undefined;
      void page.evaluate(() => {
        const target = window as typeof window & { __screenRfbClosedCount: number };
        target.__screenRfbClosedCount += 1;
      }).catch(() => {});
    });
    socket.send(Buffer.from("RFB 003.008\n", "ascii"));
  });
}

async function fulfillProjection(route: Route): Promise<boolean> {
  const url = new URL(route.request().url());
  if (url.pathname !== "/api/computer/projection") return false;
  if (route.request().method() === "DELETE") {
    await route.fulfill({ status: 204, body: "" });
    return true;
  }
  expect(route.request().postDataJSON()).toEqual({ version: 3 });
  const botId = url.searchParams.get("botId") ?? "";
  const surfaceId = url.searchParams.get("surfaceId") ?? "";
  const sessionId = `session-${surfaceId}`;
  await route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      version: 3,
      sessionId,
      surfaceId,
      runtimeGeneration: 1,
      geometryGeneration: 1,
      logicalWidth: 1000,
      logicalHeight: 500,
      videoWidth: 2000,
      videoHeight: 1000,
      scale: 2,
      state: "connecting",
      controlUrl: `/api/computer/projection/control?botId=${encodeURIComponent(botId)}&surfaceId=${encodeURIComponent(surfaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
      rfbUrl: `/api/computer/projection/rfb?botId=${encodeURIComponent(botId)}&surfaceId=${encodeURIComponent(surfaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
      snapshotUrl: `/api/computer/snapshot?botId=${encodeURIComponent(botId)}&surfaceId=${encodeURIComponent(surfaceId)}`,
      security: { authentication: "none", httpsRequired: false },
    }),
  });
  return true;
}
test.describe("contextual computer sheet", () => {
  test("unifies Browser, Bot Settings, responsive navigation, and projection cleanup in one right region", async ({ page }) => {
    await installProjectionPeer(page);
    let closedProjectionCount = 0;
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/projection" && route.request().method() === "DELETE") {
        closedProjectionCount += 1;
      }
      if (await fulfillProjection(route)) return;
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "bot-using",
        takeover: "unavailable",
        activity: "Bot using screen.",
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await createBot(page, "Capability Browser Bot");
    await createBot(page, "Capability Other Bot");
    await page.getByRole("button", { name: "Capability Browser Bot", exact: true }).click();

    const conversation = page.getByLabel("Conversation workspace");
    const capabilities = page.getByRole("complementary", { name: "Workspace capabilities" });
    const settings = page.getByRole("complementary", { name: "Bot settings" });
    const computerTrigger = page.getByRole("button", { name: "Open Computer Surface", exact: true });
    await expect(conversation).toBeVisible();
    await expect(capabilities).toHaveCount(0);
    await expect(settings).toHaveCount(0);
    const fullConversation = await conversation.boundingBox();
    if (fullConversation === null) throw new Error("closed conversation has no rendered box");

    await page.getByRole("button", { name: "Open settings for Capability Browser Bot" }).click();
    await expect(settings).toBeVisible();
    await expect(capabilities).toHaveCount(0);
    await computerTrigger.click();
    await expect(settings).toHaveCount(0);
    await expect(capabilities).toBeVisible();
    await expect(capabilities.getByRole("tab", { name: "Changes" })).toHaveCount(0);
    await expect(capabilities.getByRole("tab", { name: "Browser" })).toHaveCount(0);
    await expect(capabilities.getByRole("heading", { name: "Capability Browser Bot’s screen" })).toBeVisible();
    await expect(capabilities.getByAltText("Capability Browser Bot screen")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Computer Surface" })).toHaveCount(0);

    await page.getByRole("button", { name: "Open settings for Capability Browser Bot" }).click();
    await expect(capabilities).toHaveCount(0);
    await expect(settings).toBeVisible();
    await computerTrigger.click();
    await expect(settings).toHaveCount(0);
    await expect(capabilities).toBeVisible();
    await expect(capabilities.getByAltText("Capability Browser Bot screen")).toBeVisible();

    await settleCapabilityLayout(page);
    const [splitConversation, capabilityBox] = await Promise.all([
      conversation.boundingBox(),
      capabilities.boundingBox(),
    ]);
    if (splitConversation === null || capabilityBox === null) {
      throw new Error("desktop workspace regions have no rendered boxes");
    }
    expect(splitConversation.width).toBeLessThan(fullConversation.width);
    expect(splitConversation.x + splitConversation.width).toBeLessThanOrEqual(capabilityBox.x + 1);

    const closeCapabilities = capabilities.getByRole("button", { name: "Close capabilities" });
    await closeCapabilities.click();
    await expect(capabilities).toHaveCount(0);
    await expect(conversation).toBeVisible();
    await expect(computerTrigger).toBeFocused();
    await expect.poll(() => conversation.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(splitConversation.width);
    await expect.poll(() => closedProjectionCount).toBeGreaterThan(0);

    await page.setViewportSize({ width: 390, height: 780 });
    await computerTrigger.click();
    await expect(capabilities).toBeVisible();
    await expect(conversation).toHaveCount(0);
    await closeCapabilities.click();
    await expect(capabilities).toHaveCount(0);
    await expect(conversation).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await computerTrigger.click();
    await expect(capabilities.getByAltText("Capability Browser Bot screen")).toBeVisible();
    const closedBeforeSwitch = closedProjectionCount;
    await page.getByRole("button", { name: "Capability Other Bot", exact: true }).click();
    await expect.poll(() => closedProjectionCount).toBeGreaterThan(closedBeforeSwitch);
    await expect(capabilities.getByAltText("Capability Browser Bot screen")).toHaveCount(0);
    await expect(capabilities.getByAltText("Capability Other Bot screen")).toBeVisible();
  });

  test("offers tool-scoped Takeover while close and reconnect leave the same tool pending", async ({ page }) => {
    await installProjectionPeer(page);
    let state: ComputerState = "ready";
    let takeover: "unavailable" | "available" | "active" = "available";
    const takeoverReason = 'Complete login <img src=x onerror="alert(1)">';
    let returnCalls = 0;
    let takeoverCalls = 0;
    let activeBotId: string | undefined;
    await page.route("**/api/computer/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (await fulfillProjection(route)) return;
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      if (url.pathname === "/api/computer/take-control") {
        takeoverCalls += 1;
        state = "user-control";
        takeover = "active";
      }
      if (url.pathname === "/api/computer/return-to-bot") {
        returnCalls += 1;
        state = "ready";
        takeover = "unavailable";
      }
      const selectedBotId = url.searchParams.get("botId") ?? undefined;
      const surfaceId = url.searchParams.get("surfaceId") ?? undefined;
      const selectedState: ComputerState =
        (state === "bot-using" || state === "needs-you") && selectedBotId !== activeBotId ? "ready" : state;
      await fulfillJson(route, {
        state: selectedState,
        botId: selectedBotId,
        takeover,
        surfaceId,
        takeoverReason: takeover === "unavailable" ? undefined : takeoverReason,
        activity:
          selectedState === "bot-using"
            ? "Bot using screen."
            : selectedState === "user-control"
              ? "You have control."
              : "Screen ready.",
        previewAt: "2026-09-02T12:00:00.000Z",
      });
    });

    await page.goto("/");
    activeBotId = await createBot(page, "Computer Bot");
    state = "needs-you";
    await page.reload();

    const trigger = page.getByRole("button", { name: "Open Computer Surface", exact: true });
    await expect(trigger).toHaveAttribute("data-state", "needs-you");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger.locator("svg.lucide-monitor")).toBeVisible();
    await trigger.click();
    const drawer = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(page.getByRole("complementary", { name: "Workspace capabilities", exact: true })).toHaveCount(1);
    await expect(
      drawer.getByRole("heading", { name: "Computer Bot’s screen", exact: true }),
    ).toHaveCount(1);
    const closeTrigger = page.getByTestId("header-computer");
    await expect(closeTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toBeVisible();
    await closeTrigger.click();
    await expect(drawer).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Computer Surface" })).toHaveCount(0);

    const sheet = drawer;
    await expect(sheet.getByAltText("Computer Bot screen")).toBeVisible();
    await expect(sheet).toContainText("Needs you");
    await expect(sheet.getByText(takeoverReason, { exact: true })).toBeVisible();
    await expect(sheet.locator("img[onerror]")).toHaveCount(0);
    await expect(sheet).not.toContainText("Screen Projection");
    await expect(sheet).not.toContainText("WebRTC");
    await expect(sheet).not.toContainText(/lease|TTL|token|queue depth/i);
    await expect(sheet.getByRole("button", { name: "Take control" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Continue takeover" })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Open Web Control" }).click();
    const expandedControl = page.getByTestId("expanded-web-control");
    await expect(expandedControl).toBeVisible();
    await expect(expandedControl.getByText(takeoverReason, { exact: true })).toBeVisible();
    await expect(expandedControl.locator("img[onerror]")).toHaveCount(0);
    await expect(closeTrigger).toHaveAttribute("data-state", "user-control");
    const expandedView = page.getByTestId("computer-expanded-view");
    await expect(expandedView).toBeVisible();
    const rfbCanvas = expandedView.locator("canvas");
    await expect(rfbCanvas).toBeVisible();
    await expect.poll(() => rfbCanvas.evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      return context === null ? [] : Array.from(context.getImageData(0, 0, 2, 1).data);
    })).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    expect(await page.evaluate(() => {
      const messages = (window as typeof window & {
        __screenRfbClientMessages: number[][];
      }).__screenRfbClientMessages;
      return new TextDecoder().decode(Uint8Array.from(messages[0] ?? []));
    })).toBe("RFB 003.008\n");
    expect(takeoverCalls).toBe(1);
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & {
        __screenProjectionControl: { inputAuthorityActive: boolean };
      }).__screenProjectionControl.inputAuthorityActive,
    )).toBe(true);
    await expandedControl.focus();
    await page.keyboard.press("a");
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & {
        __screenInputMessages: Array<{ type?: string }>;
      }).__screenInputMessages.filter(({ type }) => type === "key").length,
    )).toBe(2);
    expect(await page.evaluate(() => {
      const messages = (window as typeof window & {
        __screenRfbClientMessages: number[][];
      }).__screenRfbClientMessages;
      return messages.filter((message) => message.length > 1).map((message) => message[0]);
    })).not.toContain(4);
    expect(await page.evaluate(() => {
      const messages = (window as typeof window & {
        __screenRfbClientMessages: number[][];
      }).__screenRfbClientMessages;
      return messages.filter((message) => message.length > 1).map((message) => message[0]);
    })).not.toContain(5);
    await expect(page.getByTestId("expanded-web-control")).toBeVisible();
    await expect(page.getByRole("button", { name: "I'm done" })).toBeVisible();
    await page.getByTestId("expanded-web-control").getByRole("button", { name: "Close Web Control" }).click();
    await expect(page.getByTestId("expanded-web-control")).toBeHidden();
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & { __screenRfbClosedCount: number }).__screenRfbClosedCount,
    )).toBeGreaterThan(0);
    expect(returnCalls).toBe(0);
    await expect(sheet.getByRole("button", { name: "Continue takeover" })).toBeVisible();
    await page.reload();
    expect(returnCalls).toBe(0);
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    await expect(sheet.getByRole("button", { name: "Continue takeover" })).toBeVisible();

    await sheet.getByRole("button", { name: "Continue takeover" }).click();
    await expect(page.getByRole("button", { name: "I'm done" })).toBeVisible();
    await page.getByRole("button", { name: "I'm done" }).click();
    await expect(sheet).not.toContainText("Screen ready");
    expect(returnCalls).toBe(1);
    await expect(sheet.getByRole("button", { name: "Continue takeover" })).toHaveCount(0);
    await expect(sheet.getByText(takeoverReason, { exact: true })).toHaveCount(0);
    await page.getByTestId("header-computer").click();
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("switching Bots during a pending Takeover does not complete the sensitive step (simulated peers)", async ({ page }) => {
    await installProjectionPeer(page);
    const takeoverByBot = new Map<string, "unavailable" | "available" | "active">();
    let returnCalls = 0;
    let takeoverCalls = 0;
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      const botId = url.searchParams.get("botId") ?? "";
      if (await fulfillProjection(route)) return;
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      if (url.pathname === "/api/computer/take-control") {
        takeoverCalls += 1;
        takeoverByBot.set(botId, "active");
      }
      if (url.pathname === "/api/computer/return-to-bot") {
        returnCalls += 1;
        takeoverByBot.set(botId, "unavailable");
      }
      const takeover = takeoverByBot.get(botId) ?? "unavailable";
      await fulfillJson(route, {
        botId,
        surfaceId: url.searchParams.get("surfaceId"),
        state: takeover === "active" ? "user-control" : "ready",
        takeover,
        activity: takeover === "active" ? "You have control." : "Screen ready.",
      });
    });

    await page.goto("/");
    const firstBotId = await createBot(page, "Takeover Source Bot");
    await createBot(page, "Takeover Other Bot");
    takeoverByBot.set(firstBotId, "available");
    await page.getByRole("button", { name: "Takeover Source Bot", exact: true }).click();
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const computer = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await computer.getByRole("button", { name: "Take control" }).click();
    await expect(page.getByTestId("expanded-web-control")).toBeVisible();
    expect(takeoverCalls).toBe(1);

    await page.getByRole("button", { name: "Takeover Other Bot", exact: true }).dispatchEvent("click");
    await expect(page.getByTestId("expanded-web-control")).toHaveCount(0);
    await expect(computer.getByAltText("Takeover Other Bot screen")).toBeVisible();
    await expect(computer.getByRole("button", { name: "I'm done" })).toHaveCount(0);
    await expect(computer.getByRole("button", { name: "Continue takeover" })).toHaveCount(0);
    expect(returnCalls).toBe(0);

    await page.getByRole("button", { name: "Takeover Source Bot", exact: true }).click();
    await expect(computer.getByRole("button", { name: "Continue takeover" })).toBeVisible();
    expect(returnCalls).toBe(0);
    await expect(computer.getByRole("button", { name: "I'm done" })).toHaveCount(0);
  });

  test("switching Bots clears the previous Bot Screen projection and preserves scoped requests (simulated peers)", async ({ page }) => {
    await installProjectionPeer(page);
    let closedProjectionCount = 0;
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("botId")).not.toBeNull();
      expect(url.searchParams.get("surfaceId")).not.toBeNull();
      if (url.pathname === "/api/computer/projection" && route.request().method() === "DELETE") {
        closedProjectionCount += 1;
      }
      if (await fulfillProjection(route)) return;
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      await fulfillJson(route, {
        state: "bot-using",
        takeover: "unavailable",
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        activity: "Bot using screen.",
      });
    });

    await page.goto("/");
    await createBot(page, "First Screen Bot");
    await createBot(page, "Other Bot");

    await page.getByRole("button", { name: "First Screen Bot", exact: true }).click();
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const computer = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(computer.getByAltText("First Screen Bot screen")).toBeVisible();
    await computer.getByRole("button", { name: "Open Web Control" }).click();
    await expect(page.getByTestId("computer-expanded-view")).toBeVisible();

    await page.getByRole("button", { name: "Other Bot", exact: true }).dispatchEvent("click");
    await expect.poll(() => closedProjectionCount).toBeGreaterThan(0);
    await expect(computer.getByAltText("First Screen Bot screen")).toHaveCount(0);
    await expect(page.getByTestId("expanded-web-control")).toHaveCount(0);
    await expect(page.getByTestId("computer-expanded-view")).toHaveCount(0);
    await expect(computer.getByAltText("Other Bot screen")).toBeVisible();
  });

  test("maps expanded pointer input through resized letterboxed content while compact preview stays inert", async ({ page }) => {
    await installProjectionPeer(page);
    await page.route("**/api/computer/**", async (route) => {
      if (await fulfillProjection(route)) return;
      const url = new URL(route.request().url());
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto("/");
    await createBot(page, "Pointer Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const preview = page.getByAltText("Pointer Bot screen");
    const expandPreview = page.getByRole("button", { name: "Open Web Control" });
    await expect(preview).toBeVisible();
    await expect(expandPreview).toContainText("Open Web Control");
    await settleCapabilityLayout(page);
    const previewBox = await preview.boundingBox();
    const expandBox = await expandPreview.boundingBox();
    if (previewBox === null || expandBox === null) throw new Error("preview has no rendered box");
    expect(expandBox.width).toBeGreaterThanOrEqual(previewBox.width - 2);
    expect(expandBox.height).toBeGreaterThanOrEqual(previewBox.height - 2);
    await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
    await page.mouse.wheel(0, 30);
    expect(await page.evaluate(() => (window as typeof window & { __screenInputMessages: unknown[] }).__screenInputMessages)).toEqual([]);

    await expandPreview.click();
    const expandedControl = page.getByTestId("expanded-web-control");
    const expanded = page.getByTestId("computer-expanded-view");
    await expect(expanded).toBeVisible();
    await expect(expandedControl).toContainText("Click, scroll, or type to control");
    await expandedControl.evaluate((dialog) => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect(expandedControl).toBeVisible();

    await page.setViewportSize({ width: 900, height: 760 });
    await expanded.evaluate((view) => {
      view.style.width = "600px";
      view.style.height = "500px";
    });
    const viewBox = await expanded.boundingBox();
    if (viewBox === null) throw new Error("expanded view has no rendered box");
    const fittedWidth = Math.min(viewBox.width, viewBox.height * 2);
    const fittedHeight = fittedWidth / 2;
    const left = viewBox.x + (viewBox.width - fittedWidth) / 2;
    const top = viewBox.y + (viewBox.height - fittedHeight) / 2;
    await expanded.dispatchEvent("pointermove", {
      pointerId: 40,
      pointerType: "mouse",
      clientX: viewBox.x + viewBox.width / 2,
      clientY: viewBox.y + 1,
      bubbles: true,
    });
    expect(await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: unknown[] }).__screenInputMessages,
    )).toEqual([]);
    await expanded.dispatchEvent("pointermove", {
      pointerId: 41,
      pointerType: "mouse",
      clientX: left + 1,
      clientY: top + 1,
      bubbles: true,
    });
    await expanded.dispatchEvent("pointermove", {
      pointerId: 42,
      pointerType: "mouse",
      clientX: left + fittedWidth - 1,
      clientY: top + fittedHeight - 1,
      bubbles: true,
    });
    await expanded.dispatchEvent("wheel", {
      clientX: left + fittedWidth - 1,
      clientY: top + fittedHeight - 1,
      deltaX: -24,
      deltaY: 120,
      bubbles: true,
      cancelable: true,
    });
    await page.mouse.move(left + fittedWidth * 0.4, top + fittedHeight * 0.4);
    await page.mouse.down();
    await page.mouse.move(left + fittedWidth * 0.6, top + fittedHeight * 0.7, { steps: 30 });
    await page.mouse.up();

    const messages = await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: Array<Record<string, unknown>> }).__screenInputMessages,
    );
    expect(messages.length).toBeGreaterThan(5);
    expect(messages.map((message) => message.sequence)).toEqual(messages.map((_, index) => index + 1));
    expect(messages.every((message) =>
      message.surfaceId !== undefined
      && message.runtimeGeneration === 1
      && message.geometryGeneration === 1
      && message.controllerEpoch === 7
    )).toBe(true);
    expect(messages.some((message) =>
      message.type === "pointer-motion"
      && Number(message.x) <= 2
      && Number(message.y) <= 2
    )).toBe(true);
    expect(messages.some((message) =>
      message.type === "pointer-motion"
      && Number(message.x) >= 995
      && Number(message.y) >= 495
    )).toBe(true);
    expect(messages.filter((message) => message.type === "pointer-button").map((message) => message.state)).toEqual([
      "pressed",
      "released",
    ]);
    expect(messages.some((message) =>
      message.type === "pointer-scroll"
      && message.deltaX === -24
      && message.deltaY === 120
    )).toBe(true);
  });

  test("re-arms an already-expanded takeover and drops pointer transitions outside its authority", async ({ page }) => {
    await installProjectionPeer(page, { inputAuthorityAvailable: false });
    let state: ComputerState = "bot-using";
    let takeover: "available" | "active" = "available";
    await page.route("**/api/computer/**", async (route) => {
      if (await fulfillProjection(route)) return;
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/take-control") {
        state = "user-control";
        takeover = "active";
      }
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state,
        takeover,
        activity: state === "user-control" ? "You have control." : "Bot using screen.",
      });
    });
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto("/");
    await createBot(page, "Authority Boundary Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const sheet = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await sheet.getByRole("button", { name: "Open Web Control" }).click();
    const expanded = page.getByTestId("computer-expanded-view");
    await expect(expanded).toBeVisible();
    await settleCapabilityLayout(page);
    const viewBox = await expanded.boundingBox();
    if (viewBox === null) throw new Error("expanded view has no rendered box");
    let x = viewBox.x + viewBox.width / 2;
    let y = viewBox.y + viewBox.height / 2;

    await expanded.dispatchEvent("pointerdown", {
      pointerId: 99,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    expect(await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: unknown[] }).__screenInputMessages,
    )).toEqual([]);
    await expect(expanded).toBeVisible();
    await page.getByTestId("expanded-web-control").getByRole("button", { name: "Close Web Control" }).click();
    await expect(expanded).toBeHidden();
    await expect(sheet.getByRole("button", { name: "Continue takeover" })).toBeVisible();

    const controlCount = await page.evaluate(
      () => (window as typeof window & { __screenControlMessages: unknown[] }).__screenControlMessages.length,
    );
    await page.evaluate(() => {
      const control = (window as typeof window & {
        __screenProjectionControl: { inputAuthorityAvailable: boolean };
      }).__screenProjectionControl;
      control.inputAuthorityAvailable = true;
    });
    await sheet.getByRole("button", { name: "Continue takeover" }).click();
    await expect.poll(() => page.evaluate(
      (before) => (window as typeof window & {
        __screenControlMessages: Array<{ mode?: string }>;
      }).__screenControlMessages.slice(before).filter(({ mode }) => mode === "expanded").length,
      controlCount,
    )).toBeGreaterThan(0);
    expect(await page.evaluate(
      (before) => (window as typeof window & {
        __screenControlMessages: Array<{ mode?: string }>;
      }).__screenControlMessages.slice(before).map(({ mode }) => mode),
      controlCount,
    )).not.toContain("preview");
    await expanded.dispatchEvent("pointerup", {
      pointerId: 99,
      pointerType: "mouse",
      button: 0,
      buttons: 0,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    expect(await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: unknown[] }).__screenInputMessages,
    )).toEqual([]);
    await expect(page.getByTestId("expanded-web-control"))
      .toContainText("Click, scroll, or type to control");
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & {
        __screenProjectionControl: { inputAuthorityActive: boolean };
      }).__screenProjectionControl.inputAuthorityActive,
    )).toBe(true);
    const controlledBox = await expanded.boundingBox();
    if (controlledBox === null) throw new Error("expanded control has no rendered box");
    x = controlledBox.x + controlledBox.width / 2;
    y = controlledBox.y + controlledBox.height / 2;
    await page.mouse.move(x, y);

    await page.mouse.down();
    await page.mouse.move(x + 8, y + 8);
    await page.mouse.up();
    expect(await page.evaluate(
      () => (window as typeof window & {
        __screenInputMessages: Array<{ type?: string; state?: string }>;
      }).__screenInputMessages
        .filter(({ type }) => type === "pointer-button")
        .map(({ type, state }) => ({ type, state })),
    )).toEqual([
      { type: "pointer-button", state: "pressed" },
      { type: "pointer-button", state: "released" },
    ]);

    if (!await expanded.isVisible()) {
      await sheet.getByRole("button", { name: "Continue takeover" }).click();
      await expect(expanded).toBeVisible();
    }
    const heldBox = await expanded.boundingBox();
    if (heldBox === null) throw new Error("expanded control has no held-input box");
    await page.mouse.move(heldBox.x + heldBox.width / 2, heldBox.y + heldBox.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & {
        __screenInputMessages: Array<{ type?: string }>;
      }).__screenInputMessages.filter(({ type }) => type === "pointer-button").length,
    )).toBe(3);
    await page.evaluate(() => {
      (window as typeof window & {
        __screenProjectionControl: { revokeInput(): void };
      }).__screenProjectionControl.revokeInput();
    });
    await expect(page.getByTestId("expanded-web-control"))
      .not.toContainText("Click, scroll, or type to control");
    await page.mouse.up();
    expect(await page.evaluate(
      () => (window as typeof window & {
        __screenInputMessages: Array<{ type?: string; state?: string }>;
      }).__screenInputMessages.filter(({ type }) => type === "pointer-button").map(({ state }) => state),
    )).toEqual(["pressed", "released", "pressed"]);
  });

  test("shows a pointer and directs typing to the expanded screen after a click", async ({ page }) => {
    await installProjectionPeer(page);
    await page.route("**/api/computer/**", async (route) => {
      if (await fulfillProjection(route)) return;
      const url = new URL(route.request().url());
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto("/");
    await createBot(page, "Focused Input Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    await page.getByRole("button", { name: "Open Web Control" }).click();

    const control = page.getByTestId("expanded-web-control");
    const expanded = page.getByTestId("computer-expanded-view");
    await expect(control).toContainText("Click, scroll, or type to control");
    const canvas = expanded.locator("canvas");
    await expect(canvas).toBeVisible();
    await expect(canvas).not.toHaveCSS("cursor", "none");

    const close = control.getByRole("button", { name: "Close Web Control" });
    await close.focus();
    await expect(close).toBeFocused();
    const box = await expanded.boundingBox();
    if (box === null) throw new Error("expanded view has no rendered box");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(control).toBeFocused();
    await page.keyboard.press("a");
    await expect.poll(() => page.evaluate(
      () => (window as typeof window & {
        __screenInputMessages: Array<{ type?: string }>;
      }).__screenInputMessages.filter(({ type }) => type === "key").length,
    )).toBe(2);
  });

  test("sends shortcuts and plain-text paste only from expanded desktop control and releases on blur", async ({ page }) => {
    await installProjectionPeer(page);
    await page.route("**/api/computer/**", async (route) => {
      if (await fulfillProjection(route)) return;
      const url = new URL(route.request().url());
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto("/");
    await createBot(page, "Keyboard Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    await page.keyboard.press("Control+L");
    expect(await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: unknown[] }).__screenInputMessages,
    )).toEqual([]);

    await page.getByRole("button", { name: "Open Web Control" }).click();
    const control = page.getByTestId("expanded-web-control");
    await expect(control).toBeVisible();
    await expect(control).toContainText("Click, scroll, or type to control");
    await control.focus();
    await page.keyboard.down("Control");
    await page.keyboard.press("l");
    await page.keyboard.up("Control");
    await control.evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "pasted λ text");
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }));
    });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(control).not.toContainText("Click, scroll, or type to control");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(control).toContainText("Click, scroll, or type to control");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => page.evaluate(() => (window as typeof window & {
      __screenInputMessages: Array<{ type?: string }>;
    }).__screenInputMessages.filter((message) => message.type === "release-control").length)).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));

    const messages = await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: Array<Record<string, unknown>> }).__screenInputMessages,
    );
    expect(messages.map(({ type }) => type)).toEqual([
      "key",
      "key",
      "key",
      "key",
      "paste",
      "release-control",
      "release-control",
    ]);
    expect(messages.slice(0, 4).map(({ code, state }) => ({ code, state }))).toEqual([
      { code: "ControlLeft", state: "pressed" },
      { code: "KeyL", state: "pressed" },
      { code: "KeyL", state: "released" },
      { code: "ControlLeft", state: "released" },
    ]);
    expect(messages[1]?.modifiers).toEqual({ control: true, alt: false, shift: false, meta: false });
    expect(messages[4]).toMatchObject({ type: "paste", text: "pasted λ text" });
    expect(messages.slice(5).map(({ reason }) => reason)).toEqual([
      "blur",
      "visibility-loss",
    ]);
    expect(messages.slice(0, 6).map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(messages.slice(6).map(({ sequence }) => sequence)).toEqual([1]);
    const rfbMessageTypes = await page.evaluate(() => {
      const rfbMessages = (window as typeof window & {
        __screenRfbClientMessages: number[][];
      }).__screenRfbClientMessages;
      return rfbMessages.filter((message) => message.length > 1).map((message) => message[0]);
    });
    expect(rfbMessageTypes).not.toContain(4);
    expect(rfbMessageTypes).not.toContain(5);
    expect(rfbMessageTypes).not.toContain(6);
  });


  test("keeps the narrow-screen preview usable without exposing Takeover", async ({ page }) => {
    let takeover: "available" | "active" = "available";
    let takeoverCalls = 0;
    await installProjectionPeer(page);
    await page.route("**/api/computer/projection**", async (route) => {
      await fulfillProjection(route);
    });
    await page.route("**/api/computer/state**", (route) => {
      const url = new URL(route.request().url());
      return fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: takeover === "active" ? "user-control" : "ready",
        takeover,
        activity: takeover === "active" ? "You have control." : "Screen ready.",
      });
    });
    await page.route("**/api/computer/take-control**", async (route) => {
      takeoverCalls += 1;
      await fulfillJson(route, {
        botId: new URL(route.request().url()).searchParams.get("botId"),
        surfaceId: new URL(route.request().url()).searchParams.get("surfaceId"),
        state: "user-control",
        takeover: "active",
        activity: "You have control.",
      });
    });
    await page.route("**/api/computer/snapshot**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.goto("/");
    await createBot(page, "Mobile Computer Bot");
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const mobilePanel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(mobilePanel).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Computer Surface" })).toHaveCount(0);
    await expect.poll(() => mobilePanel.evaluate((element) => element.getBoundingClientRect().right)).toBe(390);
    await expect(mobilePanel.getByAltText("Mobile Computer Bot screen")).toBeVisible();
    await expect(mobilePanel.getByRole("button", { name: "Open Web Control" })).toHaveCount(0);
    await expect(mobilePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
    await expect(mobilePanel.getByRole("button", { name: "Continue takeover" })).toHaveCount(0);
    await page.keyboard.press("Control+L");
    await mobilePanel.evaluate((element) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "mobile paste");
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }));
    });
    expect(await page.evaluate(
      () => (window as typeof window & { __screenInputMessages: unknown[] }).__screenInputMessages,
    )).toEqual([]);
    takeover = "active";
    await page.reload();
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const activeMobilePanel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(activeMobilePanel.getByAltText("Mobile Computer Bot screen")).toBeVisible();
    await expect(activeMobilePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
    await expect(activeMobilePanel.getByRole("button", { name: "Continue takeover" })).toHaveCount(0);
    expect(takeoverCalls).toBe(0);
  });

  test("falls back to an explicit read-only snapshot when live projection has no frame", async ({ page }) => {
    await installProjectionPeer(page, { frameAvailable: false });
    await page.route("**/api/computer/**", async (route) => {
      if (await fulfillProjection(route)) return;
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });

    await page.goto("/");
    await createBot(page, "No Frame Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(panel.getByAltText("No Frame Bot screen")).toBeVisible({ timeout: 7_000 });
    await expect(panel).toContainText("Read-only snapshot");
    await expect(panel).toContainText("No image arrived from the Bot Screen.");
    await expect(panel.getByRole("button", { name: "Open Web Control" })).toHaveCount(0);
    await expect(panel).not.toContainText("WebRTC");
  });
  test("labels an RFB view failure as a read-only Surface snapshot", async ({ page }) => {
    await installProjectionPeer(page);
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/projection") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "The Bot Screen view connection failed.",
            failure: "view-client-failed",
            snapshotFallback: true,
            surfaceId: url.searchParams.get("surfaceId"),
          }),
        });
        return;
      }
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "available",
        activity: "Screen ready.",
      });
    });

    await page.goto("/");
    await createBot(page, "Unsupported View Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(panel.getByAltText("Unsupported View Bot screen")).toBeVisible();
    await expect(panel).toContainText("Read-only snapshot");
    await expect(panel.getByRole("button", { name: "Open Web Control" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  });

  test("uses a read-only snapshot after the RFB view fails", async ({ page }) => {
    await installProjectionPeer(page);
    await page.route("**/api/computer/**", async (route) => {
      if (await fulfillProjection(route)) return;
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/snapshot") {
        await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
        return;
      }
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });

    await page.goto("/");
    await createBot(page, "Decode Failure Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await panel.getByRole("button", { name: "Open Web Control" }).click();
    await expect(page.getByTestId("expanded-web-control")).toBeVisible();
    await page.evaluate(() => {
      (window as typeof window & {
        __screenProjectionControl: { failView(): void };
      }).__screenProjectionControl.failView();
    });

    await expect(panel.getByAltText("Decode Failure Bot screen")).toBeVisible();
    await expect(panel).toContainText("Read-only snapshot");
    await expect(panel.getByRole("button", { name: "Open Web Control" })).toHaveCount(0);
    await expect(page.getByTestId("expanded-web-control")).toHaveCount(0);
  });

  test("reconnects Web Control after the RFB socket drops", async ({ page }) => {
    await installProjectionPeer(page);
    let projectionAttempts = 0;
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/projection" && route.request().method() === "POST") {
        projectionAttempts += 1;
      }
      if (await fulfillProjection(route)) return;
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });

    await page.goto("/");
    await createBot(page, "RFB Reconnect Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await panel.getByRole("button", { name: "Open Web Control" }).click();
    await expect(page.getByTestId("expanded-web-control")).toBeVisible();

    await page.evaluate(() => {
      (window as typeof window & {
        __screenProjectionControl: { disconnectView(): void };
      }).__screenProjectionControl.disconnectView();
    });

    await expect.poll(() => projectionAttempts).toBe(2);
    await expect(page.getByTestId("expanded-web-control")).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Web Control" })).toBeVisible();
    await expect(panel).not.toContainText("Read-only snapshot");
  });

  test("reconnects the selected Surface with fresh media and controller state", async ({ page }) => {
    await installProjectionPeer(page);
    let projectionAttempts = 0;
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/projection" && route.request().method() === "POST") {
        projectionAttempts += 1;
      }
      if (await fulfillProjection(route)) return;
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state: "ready",
        takeover: "unavailable",
        activity: "Screen ready.",
      });
    });

    await page.goto("/");
    await createBot(page, "Reconnect Media Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await panel.getByRole("button", { name: "Open Web Control" }).click();
    await expect(page.getByTestId("expanded-web-control")).toContainText("Click, scroll, or type to control");
    await page.evaluate(() => {
      (window as typeof window & {
        __screenProjectionControl: { disconnect(): void };
      }).__screenProjectionControl.disconnect();
    });

    await expect.poll(() => projectionAttempts).toBe(2);
    await expect(page.getByTestId("expanded-web-control")).toContainText("Click, scroll, or type to control");
    expect(await page.evaluate(
      () => new URL(location.href).searchParams.get("bot"),
    )).not.toBeNull();
  });


  test("retries an interrupted Bot Screen through projection activation", async ({ page }) => {
    await installProjectionPeer(page);
    const firstProjection = Promise.withResolvers<void>();
    let projectionAttempts = 0;
    let state: ComputerState = "unavailable";
    await page.route("**/api/computer/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/computer/projection") {
        projectionAttempts += 1;
        if (projectionAttempts === 1) {
          await firstProjection.promise;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Bot Screen start was interrupted" }),
          });
          return;
        }
        await fulfillProjection(route);
        return;
      }
      await fulfillJson(route, {
        botId: url.searchParams.get("botId"),
        surfaceId: url.searchParams.get("surfaceId"),
        state,
        takeover: "unavailable",
        activity: state === "ready" ? "Screen ready." : "Screen unavailable.",
      });
    });

    await page.goto("/");
    await createBot(page, "Retry Screen Bot");
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    const retry = panel.getByRole("button", { name: "Retry", exact: true });
    await expect(panel.getByRole("heading", { name: "Screen unavailable", exact: true })).toBeVisible();

    await retry.click();
    await expect(panel.getByRole("heading", { name: "Opening screen", exact: true })).toBeVisible();
    expect(projectionAttempts).toBe(1);
    firstProjection.resolve();
    await expect(panel.getByRole("heading", { name: "Screen unavailable", exact: true })).toBeVisible();
    await expect(retry).toBeVisible();

    state = "ready";
    await retry.click();
    await expect.poll(() => projectionAttempts).toBe(2);
    await page.reload();
    await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
    await expect(panel).not.toContainText("Screen ready");
    await expect(panel.getByAltText("Retry Screen Bot screen")).toBeVisible();
  });

  test("renders capacity-full state returned with an expected unavailable response", async ({ page }) => {
    await page.route("**/api/computer/state**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          botId: url.searchParams.get("botId"),
          surfaceId: url.searchParams.get("surfaceId"),
          state: "unavailable",
          takeover: "unavailable",
          activity: "Bot Screen capacity is full (4/4).",
          unavailableReason: "capacity",
          capacity: { active: 4, limit: 4 },
        }),
      });
    });
    await page.goto("/");
    await createBot(page, "Capacity Computer Bot");

    const trigger = page.getByRole("button", { name: "Open Computer Surface", exact: true });
    await expect(trigger).toHaveAttribute("data-state", "unavailable");
    await trigger.click();
    const panel = page.getByRole("complementary", { name: "Workspace capabilities", exact: true });
    await expect(panel).toContainText("Bot Screen capacity is full (4/4).");
    await expect(panel).not.toContainText("Bot Screen status could not be loaded.");
    await expect(panel.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  });
});
