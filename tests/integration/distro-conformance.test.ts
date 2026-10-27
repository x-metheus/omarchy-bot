import { afterEach, expect, test } from "bun:test";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";
import { createBrowserProbe, exerciseService } from "../../scripts/distro-conformance/smoke.ts";
import { startDaemon, type Harness } from "./helpers/harness.ts";

let harness: Harness | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

test("distribution probe keeps the latest editor value when HTTP input reports arrive out of order", async () => {
  const probe = createBrowserProbe();
  const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: probe.fetch });
  const report = async (sequence: number, text: string) => {
    const query = new URLSearchParams({ sequence: String(sequence), text });
    const response = await fetch(`http://127.0.0.1:${page.port}/typed?${query}`);
    expect(response.ok).toBeTrue();
    await response.text();
  };
  try {
    await report(22, "distribution smoke: 你好");
    await report(21, "distribution smoke: 你");
    expect(probe.typed).toBe("distribution smoke: 你好");
    await report(23, "distribution smoke: ");
    expect(probe.typed).toBe("distribution smoke: ");
  } finally { page.stop(true); }
});

test("distribution smoke pairs and drives capture, URL launch, and text through public Agent turns", async () => {
  const adapter = new FakeBotScreenRuntimeAdapter();
  harness = await startDaemon(undefined, { botScreenAdapter: adapter });
  await exerciseService(harness.baseUrl, process.env.OMARCHY_BOT_STATE!, false);
  expect(adapter.actionsStarted).toBeGreaterThan(0);
  expect(adapter.inputEvents.some(({ event }) => event.type === "paste" && event.text === "distribution smoke: 你好")).toBeTrue();
});

test("distribution smoke fails when URL launch fails after a successful capture", async () => {
  harness = await startDaemon(undefined, {
    botScreenAdapter: new FakeBotScreenRuntimeAdapter(undefined, { actionFailureAt: 2 }),
  });
  await expect(exerciseService(harness.baseUrl, process.env.OMARCHY_BOT_STATE!, false)).rejects.toThrow("computer:open_url:");
});
