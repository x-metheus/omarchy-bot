import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chromium } from "@playwright/test";
import path from "node:path";
import { AVATAR_RENDERER_ID } from "../../packages/protocol/src/api.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const webRoot = path.join(repoRoot, "apps/web");

let devServer: Subprocess<"ignore", "pipe", "inherit"> | undefined;
let devUrl = "";

beforeAll(async () => {
  const portProbe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = portProbe.port;
  portProbe.stop(true);
  devUrl = `http://127.0.0.1:${port}`;

  devServer = Bun.spawn(
    ["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort", "--force"],
    {
      cwd: webRoot,
      stdout: "pipe",
      stderr: "inherit",
    },
  );

  const reader = devServer.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Vite exited before becoming ready:\n${output}`);
    output += decoder.decode(chunk.value, { stream: true });
    if (output.includes(devUrl)) break;
  }
  void (async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      /* process closed */
    }
  })();
}, 60_000);

afterAll(async () => {
  if (devServer === undefined || devServer.exitCode !== null) return;
  devServer.kill("SIGTERM");
  await devServer.exited;
});

test("the Vite development runtime loads the sole pinned DiceBear renderer", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    await page.goto(devUrl);
    // Vite may navigate once while optimizing newly discovered dependencies.
    // The browser waiter survives that navigation; real import/decode failures still fail.
    const rendered = await page.waitForFunction(async ({ modulePath, recipe }) => {
      const renderer = await import(modulePath);
      const uri = renderer.renderAvatarRecipe(recipe, "static");
      const image = new Image();
      image.src = uri;
      await image.decode();
      return uri;
    }, {
      modulePath: "/src/components/avatarRenderer.ts",
      recipe: { rendererVersion: AVATAR_RENDERER_ID, style: "pixelbot", seed: "development-runtime", options: {} },
    });
    expect(await rendered.jsonValue()).toStartWith("data:image/svg+xml");
    await page.locator("#root > *").first().waitFor({ state: "attached", timeout: 5_000 });
  } finally {
    await browser.close();
  }
}, 60_000);
