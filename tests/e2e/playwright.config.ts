import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { WEB_ORIGIN } from "./fixtures.ts";

/**
 * One Service (workers: 1) booted by globalSetup with fake workers and isolated
 * storage; Vite serves the web bundle from a separate origin.
 */
export default defineConfig({
  testDir: "./specs",
  outputDir: path.join(os.tmpdir(), "omarchy-bot-playwright-results"),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_ORIGIN,
    headless: true,
    actionTimeout: 10_000,
  },
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  webServer: {
    command: `bun run --filter=@omarchy-bot/web dev -- --host 127.0.0.1 --port ${new URL(WEB_ORIGIN).port || "80"} --strictPort --force`,
    cwd: path.resolve(import.meta.dirname, "../.."),
    url: WEB_ORIGIN,
    timeout: 120_000,
  },
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
