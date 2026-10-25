import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, expect } from "@playwright/test";

/** globalSetup writes the paired device token here. */
export const AUTH_STORAGE_STATE = path.join(os.tmpdir(), "omarchy-bot-e2e-auth.json");

function deviceToken(): string {
  const state: unknown = JSON.parse(readFileSync(AUTH_STORAGE_STATE, "utf8"));
  if (typeof state !== "object" || state === null || !("origins" in state) || !Array.isArray(state.origins)) {
    throw new Error("e2e auth storage state is malformed");
  }
  for (const origin of state.origins) {
    if (typeof origin !== "object" || origin === null || !("localStorage" in origin) || !Array.isArray(origin.localStorage)) continue;
    for (const entry of origin.localStorage) {
      if (
        typeof entry === "object" && entry !== null
        && "name" in entry && entry.name === "omarchy-bot.device-token"
        && "value" in entry && typeof entry.value === "string"
      ) return entry.value;
    }
  }
  throw new Error("e2e auth storage state has no omarchy-bot.device-token");
}

/**
 * Every daemon route except `/api/health` needs the paired device token. The web
 * client reads it from localStorage, and Playwright's `request` fixture sends no
 * browser storage, so both need seeding here rather than in each spec.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    const token = deviceToken();
    await context.addInitScript(
      (stored) => localStorage.setItem("omarchy-bot.device-token", stored),
      token,
    );
    await context.setExtraHTTPHeaders({ authorization: `Bearer ${token}` });
    await use(context);
  },
  request: async ({ playwright, baseURL }, use) => {
    const api = await playwright.request.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      extraHTTPHeaders: { authorization: `Bearer ${deviceToken()}` },
    });
    await use(api);
    await api.dispose();
  },
});

export { expect };
export type { Locator, Page, Route } from "@playwright/test";
