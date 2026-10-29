import type { WebSocketRoute } from "@playwright/test";
import type { PluginStateDto } from "../../../packages/protocol/src/plugins.ts";
import { expect, test } from "../fixtures.ts";

const providerUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=fixture";

test("Skill instruction links open through the shell", async ({ page }) => {
  const skill = { id: "example/docs/guide", name: "Documentation guide", sourceType: "github", installUrl: "https://github.com/example/docs", description: "Read documentation", source: "example/docs" };
  await page.route("**/api/plugins", route => route.fulfill({ json: { revision: 0, cloudUrl: "https://publisher.example", providers: [], accounts: [], mcp: [], skills: [], nativeSkills: [] } }));
  await page.route("**/api/plugins/catalog?*", route => route.fulfill({ json: { skills: [skill], total: 1, pageSize: 12 } }));
  await page.route("**/api/plugins/catalog/detail?*", route => route.fulfill({ json: { ...skill, content: "Read [Documentation](https://example.com/docs) before continuing.", url: "https://skills.sh/example/docs/guide" } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.evaluate(() => {
    Reflect.set(window, "skillOpened", []);
    globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.browser.open = async (url: string) => { Reflect.get(window, "skillOpened").push(url); };
  });
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("button", { name: `View ${skill.name}`, exact: true }).click();
  const conversation = page.url();
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, "skillOpened"))).toEqual(["https://example.com/docs"]);
  expect(page.url()).toBe(conversation);
});


test("plugin consent uses the shell and events refresh connected accounts and allow retry", async ({ page }) => {
  const state: PluginStateDto = {
    revision: 0, cloudUrl: "https://publisher.example", mcp: [], skills: [], nativeSkills: [],
    providers: [{ id: "google", name: "Google", mode: "mcp", documentationUrl: "https://developers.google.com", services: [{ id: "google-drive", name: "Google Drive", description: "Read files" }] }],
    accounts: [],
  };
  await page.addInitScript(() => { window.open = () => { throw new Error("Plugin consent must use the shell"); }; });
  await page.route("**/api/plugins", route => route.fulfill({ json: state }));
  let authorizations = 0;
  await page.route("**/api/plugins/authorize", async route => {
    expect(route.request().postDataJSON()).toEqual({ providerId: "google", serviceId: "google-drive", ...(authorizations ? { accountId: "account_fixture" } : {}) });
    authorizations++;
    await route.fulfill({ json: authorizations === 3 ? {} : { url: providerUrl } });
  });
  await page.route("**/api/plugins/mcp/mcp_fixture/authorize", async route => {
    const body = route.request().postDataJSON();
    expect(body).toEqual(body.redirectUrl ? { redirectUrl: "https://native.example/callback?code=fixture" } : {});
    await route.fulfill({ json: body.redirectUrl ? { authenticated: true } : { authorizationUrl: "https://native.example/consent" } });
  });
  await page.route("**/api/plugins/accounts/account_fixture/services", route => route.fulfill({ status: 204 }));
  const ready = Promise.withResolvers<WebSocketRoute>();
  await page.routeWebSocket(/\/api\/events(?:\?|$)/, socket => {
    socket.onMessage(message => {
      if (JSON.parse(String(message)).type === "hello") {
        socket.send(JSON.stringify({ type: "hello", cursor: 0 }));
        ready.resolve(socket);
      }
    });
  });
  await page.goto("/");
  await page.evaluate(async () => {
    // Load in the browser's Vite module graph; a Node import would install a different shell.
    const shellModule = "/src/lib/shell.ts";
    const { getShell } = await import(shellModule);
    const opened: string[] = [];
    Object.assign(window, { oauthOpened: opened });
    getShell().browser.open = async (url: string) => { opened.push(url); };
  });
  const socket = await ready.promise;
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByText("Google Drive", { exact: true }).click();
  const conversationUrl = page.url();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "oauthOpened"))).toEqual([providerUrl]);
  // Freeze interval polling: only an authorization event can fetch the new state.
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  state.accounts.push({ id: "account_fixture", providerId: "google", label: "person@example.invalid", identity: "google:person", enabledServices: ["google-drive"], grantedScopes: [], status: "connected", nativeConnectionId: "mcp_fixture" });
  const event = (status: "completed" | "failed", cursor: number) => socket.send(JSON.stringify({ type: "event", envelope: { schemaVersion: 1, eventId: `oauth-${cursor}`, cursor, occurredAt: new Date().toISOString(), aggregateType: "plugin", aggregateId: "account_fixture", type: `plugin.authorization_${status}`, payload: { providerId: "google", accountId: "account_fixture", status } } }));
  event("completed", 1);
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByRole("heading", { name: "person@example.invalid", exact: true }).isVisible();
  }).toBe(true);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "oauthOpened"))).toEqual([providerUrl, providerUrl]);
  event("failed", 2);
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByText("Authorization failed. Try Add account or Reconnect again.", { exact: true }).isVisible();
  }).toBe(true);
  await page.getByRole("switch", { name: "Use for Google Drive", exact: true }).click();
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByText("Saved. File resources are updated immediately; active native sessions may need to reload configuration.", { exact: true }).isVisible();
  }).toBe(true);
  await expect(page.getByText("Authorization failed. Try Add account or Reconnect again.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  expect(authorizations).toBe(3);
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByRole("button", { name: "Reconnect", exact: true }).isEnabled();
  }).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "oauthOpened"))).toEqual([providerUrl, providerUrl]);
  await page.getByRole("button", { name: "Reconnect / Authorize", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "oauthOpened"))).toEqual([providerUrl, providerUrl, "https://native.example/consent"]);
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByRole("button", { name: "Reconnect / Authorize", exact: true }).isEnabled();
  }).toBe(true);
  const nativeEvent = (status: "completed" | "failed", cursor: number, reason?: string) => socket.send(JSON.stringify({ type: "event", envelope: { schemaVersion: 1, eventId: `oauth-${cursor}`, cursor, occurredAt: new Date().toISOString(), aggregateType: "plugin", aggregateId: "account_fixture", type: `plugin.authorization_${status}`, payload: { providerId: "google", accountId: "account_fixture", mcpId: "mcp_fixture", status, ...(reason ? { reason } : {}) } } }));
  nativeEvent("completed", 3);
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByText("Complete consent in your system browser, then return to Omarchy Bot. Authorization is not complete yet.", { exact: true }).count();
  }).toBe(0);
  await page.getByRole("button", { name: "Reconnect / Authorize", exact: true }).click();
  await expect(page.getByText("Complete consent in your system browser, then return to Omarchy Bot. Authorization is not complete yet.", { exact: true })).toBeVisible();
  nativeEvent("failed", 4, "expired");
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByText("Authorization expired. Try again.", { exact: true }).count();
  }).toBeGreaterThan(0);
  await expect(page.getByText("Complete consent in your system browser, then return to Omarchy Bot. Authorization is not complete yet.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reconnect / Authorize", exact: true }).click();
  await expect.poll(async () => {
    await page.clock.runFor(16);
    return page.getByRole("button", { name: "Reconnect / Authorize", exact: true }).isEnabled();
  }).toBe(true);
  await page.getByText("Complete authorization manually", { exact: true }).click();
  await page.getByRole("textbox", { name: /^Full authorization redirect URL/ }).fill("https://native.example/callback?code=fixture");
  await page.getByRole("button", { name: "Complete authorization", exact: true }).click();
  await expect(page.getByText("Authorization completed.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(conversationUrl);
});

test("actual Service callback updates the app through its WebSocket", async ({ page, request }) => {
  test.skip(process.env.OMARCHY_BOT_E2E_OAUTH !== "1", "Run with OMARCHY_BOT_E2E_OAUTH=1 for the isolated publisher fixture");
  expect((await request.put("/api/plugins/settings", { data: { cloudUrl: "https://oauth-e2e.invalid" } })).ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(async () => {
    // Reach the running Vite browser module graph, which cannot be imported into Node.
    const shellModule = "/src/lib/shell.ts";
    const { getShell } = await import(shellModule);
    getShell().browser.open = async (url: string) => { Object.assign(window, { actualOAuthUrl: url }); };
  });
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByText("GitHub", { exact: true }).click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "actualOAuthUrl"))).toBeTruthy();
  const providerUrl = new URL(await page.evaluate(() => Reflect.get(window, "actualOAuthUrl")));
  expect(providerUrl.origin).toBe("https://github.com");
  const brokerState = providerUrl.searchParams.get("state")!;
  const transaction = JSON.parse(Buffer.from(brokerState.split(".")[1]!, "base64url").toString()) as { callbackUrl: string; localState: string };
  const callback = new URL(transaction.callbackUrl);
  callback.search = new URLSearchParams({ state: transaction.localState, brokerState, code: "e2e-code" }).toString();
  const completed = await request.get(callback.href);
  expect(completed.ok()).toBe(true);
  expect(await completed.text()).toContain('<a href="omarchy-bot://">Return to Omarchy Bot</a>');
  await expect(page.getByRole("heading", { name: "e2e-github-person", exact: true })).toBeVisible();
  await expect(page.getByText("Account connected.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "actualOAuthUrl"))).not.toBe(providerUrl.href);
  const retryUrl = new URL(await page.evaluate(() => Reflect.get(window, "actualOAuthUrl")));
  const retryState = retryUrl.searchParams.get("state")!;
  const retry = JSON.parse(Buffer.from(retryState.split(".")[1]!, "base64url").toString()) as { callbackUrl: string; localState: string };
  const cancelled = new URL(retry.callbackUrl);
  cancelled.search = new URLSearchParams({ state: retry.localState, error: "access_denied" }).toString();
  expect((await request.get(cancelled.href)).status()).toBe(400);
  await expect(page.getByText("Authorization failed. Try Add account or Reconnect again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();
});
