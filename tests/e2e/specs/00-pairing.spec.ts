import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { AUTH_TOKEN_FILE, SERVICE_ORIGIN } from "../fixtures.ts";
import { test as pairedTest } from "../fixtures.ts";


async function issueCode(): Promise<{ code: string; url: string }> {
  const response = await fetch(`${SERVICE_ORIGIN}/api/pairing/codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${JSON.parse(readFileSync(AUTH_TOKEN_FILE, "utf8"))}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Pairing UI" }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

for (const state of ["missing", "broken", "service.status", "service.certificateUntrusted", "attachments.save", "localSidecar.start"] as const) {
  test(`${state} native shell blocks startup without storing a token`, async ({ page }) => {
    const exchanges: string[] = [];
    await page.route("**/src/dev-shell.ts", route => route.fulfill({
      contentType: "application/javascript",
      body: state === "missing" ? "" : state === "broken" ? "globalThis.__OMARCHY_BOT_SHELL__ = { service: null };" : `
        import { createMemoryShell, installShell } from "/src/lib/shell.ts";
        const shell = createMemoryShell({ storage: null });
        const [capability, method] = ${JSON.stringify(state)}.split(".");
        delete shell[capability][method];
        installShell(shell);
      `,
    }));
    await page.route("**/api/pairing/exchange", route => {
      exchanges.push(route.request().url());
      return route.fulfill({ status: 201, contentType: "application/json", body: '{"token":"must-not-be-stored"}' });
    });
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("Omarchy Bot could not start");
    await expect(page.getByRole("alert")).toContainText("native shell");
    await expect(page.getByRole("heading", { name: "Add Service" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Pair", exact: true })).toBeHidden();
    expect(await page.evaluate(() => ({
      memory: globalThis.__OMARCHY_BOT_MEMORY_SHELL__ !== undefined,
      token: localStorage.getItem("omarchy-bot.device-token"),
    }))).toEqual({ memory: false, token: null });
    expect(exchanges).toEqual([]);
  });
}

test("Add Service pairs by address and code and keeps the connection on reload", async ({ page }) => {
  const issued = await issueCode();
  const controlRequests: string[] = [];
  page.on("request", request => {
    if (/\/api\/(agents|bots|events)/.test(request.url())) controlRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  expect(controlRequests).toEqual([]);
  await page.getByLabel("Service address").fill(SERVICE_ORIGIN);
  await page.getByLabel("Pairing code").fill(issued.code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeHidden();
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
});

test("wrong code and unreachable Service explain how to retry", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Service address").fill(SERVICE_ORIGIN);
  await page.getByLabel("Pairing code").fill("WRONG234");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("invalid or has expired");
  await page.getByLabel("Service address").fill("http://127.0.0.1:1");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not reach the Service");
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
});

test("remote plaintext Service addresses are refused before exchanging a code", async ({ page }) => {
  const exchanges: string[] = [];
  await page.route("http://service.example/api/pairing/exchange", route => {
    exchanges.push(route.request().url());
    return route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");
  await page.getByLabel("Service address").fill("http://service.example");
  await page.getByLabel("Pairing code").fill("PRIVATE234");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTPS or a loopback HTTP address");
  expect(exchanges).toEqual([]);
});

test("native keychain failures explain recovery after the code is exchanged", async ({ page }) => {
  const issued = await issueCode();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  await page.evaluate(() => {
    const shell = globalThis.__OMARCHY_BOT_MEMORY_SHELL__!;
    globalThis.__OMARCHY_BOT_SHELL__ = {
      ...shell,
      service: { ...shell.service, async store() { throw new Error("Could not access the OS keychain. Unlock your Secret Service keyring and try again."); } },
    };
  });
  await page.getByLabel("Service address").fill(SERVICE_ORIGIN);
  await page.getByLabel("Pairing code").fill(issued.code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unlock your Secret Service keyring");
  await expect(page.getByRole("alert")).toContainText("Ask the Service Host for a new code");
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  expect(await page.evaluate(() => globalThis.__OMARCHY_BOT_SHELL__!.service.deviceToken())).toBeUndefined();
});

test("startup keychain failure blocks exchange without consuming the pairing code", async ({ page }) => {
  const issued = await issueCode();
  const exchanges: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/pairing/exchange")) exchanges.push(request.url()); });
  await page.goto("/");
  await page.getByRole("heading", { name: "Add Service" }).waitFor();
  await page.evaluate(() => {
    const shell = globalThis.__OMARCHY_BOT_MEMORY_SHELL__!;
    globalThis.__OMARCHY_BOT_SHELL__ = { ...shell, service: { ...shell.service, status: () => ({ error: "Unlock your OS keychain and reopen Omarchy Bot.", revoked: false }) } };
  });
  await page.getByLabel("Service address").fill(SERVICE_ORIGIN);
  await page.getByLabel("Pairing code").fill(issued.code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unlock your OS keychain");
  expect(exchanges).toEqual([]);
  await page.reload();
  await page.getByLabel("Service address").fill(SERVICE_ORIGIN);
  await page.getByLabel("Pairing code").fill(issued.code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
});

test("pairing diagnoses an untrusted certificate through the shell", async ({ page }) => {
  await page.route("https://untrusted.example/**", route => route.abort("failed"));
  await page.goto("/");
  await page.getByRole("heading", { name: "Add Service" }).waitFor();
  await page.evaluate(() => {
    const shell = globalThis.__OMARCHY_BOT_MEMORY_SHELL__!;
    globalThis.__OMARCHY_BOT_SHELL__ = { ...shell, service: { ...shell.service, async certificateUntrusted() { return true; } } };
  });
  await page.getByLabel("Service address").fill("https://untrusted.example");
  await page.getByLabel("Pairing code").fill("TLSCODE1");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("TLS certificate is not trusted");
  await expect(page.getByRole("alert")).toContainText("SSH tunnel");
});

test("shell pairing intake pairs without entering an address or code", async ({ page }) => {
  const issued = await issueCode();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  await page.evaluate(link => {
    const linkUrl = new URL(link);
    globalThis.__OMARCHY_BOT_MEMORY_SHELL__!.receivePairingRequest({
      serviceUrl: linkUrl.searchParams.get("service")!,
      code: linkUrl.searchParams.get("code")!,
    });
  }, issued.url);
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeHidden();
});

test("a revoked device returns to Add Service, stops events, and can pair again", async ({ page }) => {
  const issued = await issueCode();
  const pairedResponse = await fetch(`${SERVICE_ORIGIN}/api/pairing/exchange`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: issued.code }),
  });
  expect(pairedResponse.status).toBe(201);
  const paired: { token: string; device: { id: string } } = await pairedResponse.json();
  await page.addInitScript(({ token, serviceUrl }) => {
    localStorage.setItem("omarchy-bot.device-token", token);
    localStorage.setItem("omarchy-bot.service-url", serviceUrl);
  }, { token: paired.token, serviceUrl: SERVICE_ORIGIN });
  let eventSockets = 0;
  let eventClosed = false;
  page.on("websocket", socket => {
    if (!socket.url().includes("/api/events")) return;
    eventSockets++;
    socket.on("close", () => { eventClosed = true; });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  await expect.poll(() => eventSockets).toBeGreaterThan(0);
  const revoked = await fetch(`${SERVICE_ORIGIN}/api/devices/paired/${paired.device.id}/revoke`, {
    method: "POST", headers: { authorization: `Bearer ${JSON.parse(readFileSync(AUTH_TOKEN_FILE, "utf8"))}` },
  });
  expect(revoked.status).toBe(204);
  await page.clock.runFor(30_100);
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("This app's pairing was revoked");
  await expect.poll(() => eventClosed).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("omarchy-bot.device-token"))).toBeNull();
  const stoppedSockets = eventSockets;
  await expect(page.getByLabel("Service address")).toHaveValue(SERVICE_ORIGIN);
  await page.clock.runFor(60_000);
  expect(eventSockets).toBe(stoppedSockets);
  const replacement = await issueCode();
  await page.getByLabel("Pairing code").fill(replacement.code);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("button", { name: "New bot", exact: true }).first()).toBeVisible();
  await expect.poll(() => eventSockets).toBe(stoppedSockets + 1);
});

pairedTest("projection HTTP 401 immediately returns the shell to Add Service", async ({ page }) => {
  await page.route("**/api/computer/projection?**", route => route.fulfill({
    status: 401, contentType: "application/json", body: '{"error":"unauthorized"}',
  }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open Computer Surface", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Computer Surface", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add Service" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("This app's pairing was revoked");
});
