import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, expect } from "@playwright/test";

export const WEB_ORIGIN = process.env.OMARCHY_BOT_E2E_WEB_URL ?? "http://127.0.0.1:7398";
export const SERVICE_ORIGIN = process.env.OMARCHY_BOT_E2E_SERVICE_URL
  ?? `http://127.0.0.1:${process.env.OMARCHY_BOT_E2E_PORT ?? "7399"}`;

/** globalSetup writes the paired device token here. */
export const AUTH_TOKEN_FILE = path.join(os.tmpdir(), `omarchy-bot-e2e-auth-${new URL(SERVICE_ORIGIN).port || "80"}.json`);

function deviceToken(): string {
  const token: unknown = JSON.parse(readFileSync(AUTH_TOKEN_FILE, "utf8"));
  if (typeof token !== "string" || token.length === 0) throw new Error("e2e auth file has no device token");
  return token;
}

/** Seed the memory shell in each document; API requests authenticate directly to the Service. */
export const test = base.extend({
  context: async ({ context }, use) => {
    const token = deviceToken();
    await context.addInitScript(
      ({ token, serviceUrl, webOrigin }) => {
        if (location.origin !== webOrigin) return;
        localStorage.setItem("omarchy-bot.device-token", token);
        localStorage.setItem("omarchy-bot.service-url", serviceUrl);
      },
      { token, serviceUrl: SERVICE_ORIGIN, webOrigin: new URL(WEB_ORIGIN).origin },
    );
    await use(context);
  },
  request: async ({ playwright }, use) => {
    const api = await playwright.request.newContext({
      baseURL: SERVICE_ORIGIN,
      extraHTTPHeaders: { authorization: `Bearer ${deviceToken()}` },
    });
    await use(api);
    await api.dispose();
  },
});

export { expect };
export type { APIRequestContext, Locator, Page, Route } from "@playwright/test";
