import { expect, test, SERVICE_ORIGIN, type Page } from "../fixtures.ts";

async function reportProtocol(page: Page, protocol: unknown): Promise<void> {
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.protocol;
    await route.fulfill({ response, json: { ...body, ...(protocol === undefined ? {} : { protocol }) } });
  });
}

function serviceTraffic(page: Page): string[] {
  const traffic: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === SERVICE_ORIGIN && url.pathname !== "/api/health") traffic.push(url.pathname);
  });
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (url.host === new URL(SERVICE_ORIGIN).host) traffic.push(url.pathname);
  });
  return traffic;
}

test("a Service ahead blocks the workspace and every other Service connection", async ({ page }) => {
  const traffic = serviceTraffic(page);
  await reportProtocol(page, 2);
  await page.goto("/?bot=unreachable&thread=unreachable");
  await expect(page.getByRole("heading", { name: "Update Omarchy Bot", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update Omarchy Bot", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  expect(traffic).toEqual([]);
});

for (const protocol of [0, undefined, "1", 1.5, null]) {
  test(`an old or invalid Service protocol (${String(protocol)}) requires updating the Service`, async ({ page }) => {
    const traffic = serviceTraffic(page);
    await reportProtocol(page, protocol);
    await page.goto("/?bot=unreachable&thread=unreachable");
    await expect(page.getByRole("heading", { name: "Update the Service", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update Omarchy Bot", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    expect(traffic).toEqual([]);
  });
}

test("a supported Service opens the workspace only after health confirms compatibility", async ({ page }) => {
  const traffic = serviceTraffic(page);
  const healthRequested = Promise.withResolvers<void>();
  const releaseHealth = Promise.withResolvers<void>();
  await page.route("**/api/health", async (route) => {
    healthRequested.resolve();
    await releaseHealth.promise;
    await route.continue();
  });
  await page.goto("/");
  await healthRequested.promise;
  await expect(page.getByText("Connecting to the Service…", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
  expect(traffic).toEqual([]);
  releaseHealth.resolve();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Update / })).toHaveCount(0);
});

for (const outcome of ["installed", "unavailable", "check failed", "download failed", "restart failed"]) {
  test(`the app update action handles ${outcome} through the shell`, async ({ page }) => {
    const traffic = serviceTraffic(page);
    await reportProtocol(page, 2);
    await page.goto("/");
    const update = page.getByRole("button", { name: "Update Omarchy Bot", exact: true });
    await expect(update).toBeVisible();
    await page.evaluate(async (outcome) => {
      const modulePath = "/src/lib/shell.ts";
      // Browser shell boundary: a Node-side static import cannot install the page's shell instance.
      const { createMemoryShell, installShell } = await import(modulePath);
      const calls: string[] = [];
      Reflect.set(window, "updateCalls", calls);
      installShell({
        ...createMemoryShell(),
        updates: {
          async check() {
            calls.push("check");
            if (outcome === "check failed") throw new Error("Cannot check");
            return { available: outcome !== "unavailable" };
          },
          async download() {
            calls.push("download");
            if (outcome === "download failed") throw new Error("Cannot download");
          },
          async restart() {
            calls.push("restart");
            if (outcome === "restart failed") throw new Error("Cannot restart");
          },
        },
      });
    }, outcome);
    await update.click();
    const expected = outcome === "unavailable" || outcome === "check failed"
      ? ["check"] : outcome === "download failed" ? ["check", "download"] : ["check", "download", "restart"];
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "updateCalls"))).toEqual(expected);
    if (outcome === "unavailable") {
      await expect(page.getByText("No update is available right now.", { exact: true })).toBeVisible();
    } else if (outcome !== "installed") {
      await expect(page.getByText("Omarchy Bot could not update. Try again.", { exact: true })).toBeVisible();
      await expect(update).toBeEnabled();
    }
    await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
    expect(traffic).toEqual([]);
  });
}

test("an unavailable health probe keeps the workspace closed and can be retried", async ({ page }) => {
  const traffic = serviceTraffic(page);
  await page.route("**/api/health", (route) => route.fulfill({ status: 503, body: "Unavailable", headers: { "access-control-allow-origin": "*" } }));
  await page.goto("/");
  await expect(page.getByText("Cannot connect to the Service", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
  expect(traffic).toEqual([]);
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
});

test("a null health envelope blocks safely and recovers after retry", async ({ page }) => {
  const traffic = serviceTraffic(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: "null" });
  });
  await page.goto("/");
  await expect(page.getByText("Cannot connect to the Service", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
  expect(traffic).toEqual([]);
  expect(errors).toEqual([]);
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
});

test("revalidation closes event connections and prevents reconnects", async ({ page }) => {
  let protocol = 1;
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), protocol } });
  });
  const connections: Array<{ closed: boolean }> = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/api/events") return;
    const connection = { closed: false };
    connections.push(connection);
    socket.on("close", () => { connection.closed = true; });
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
  await expect.poll(() => connections.filter((connection) => !connection.closed).length).toBe(1);
  await page.clock.install();
  await page.clock.runFor(5_001);
  const connectionCount = connections.length;
  protocol = 2;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Update Omarchy Bot", exact: true })).toBeVisible();
  await expect.poll(() => connections.every((connection) => connection.closed)).toBe(true);
  await page.clock.runFor(30_000);
  expect(connections).toHaveLength(connectionCount);
  await expect(page.getByRole("navigation", { name: "Bot navigation" })).toHaveCount(0);
});

for (const nextProtocol of [1, 2]) {
  test(`a dropped event connection rechecks compatibility before reconnecting to protocol ${nextProtocol}`, async ({ page }) => {
    let protocol = 1;
    let healthChecks = 0;
    await page.route("**/api/health", async (route) => {
      healthChecks += 1;
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), protocol } });
    });
    const connections: Array<{ close: () => void; closed: boolean }> = [];
    await page.routeWebSocket(/\/api\/events(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      const connection = { close: () => server.close(), closed: false };
      connections.push(connection);
      socket.onClose(() => {
        connection.closed = true;
        server.close();
      });
    });
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
    await expect.poll(() => connections.filter((connection) => !connection.closed).length).toBe(1);
    await page.clock.install();
    await page.clock.runFor(5_001);
    const initialChecks = healthChecks;
    const connectionCount = connections.length;
    protocol = nextProtocol;
    connections.find((connection) => !connection.closed)!.close();
    await page.clock.runFor(2_500);
    await expect.poll(() => healthChecks).toBeGreaterThan(initialChecks);
    if (nextProtocol === 1) {
      await expect.poll(() => connections.length).toBe(connectionCount + 1);
      await expect(page.getByRole("navigation", { name: "Bot navigation" })).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: "Update Omarchy Bot", exact: true })).toBeVisible();
      await page.clock.runFor(30_000);
      expect(connections).toHaveLength(connectionCount);
    }
  });
}
