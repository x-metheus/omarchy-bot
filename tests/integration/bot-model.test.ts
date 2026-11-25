import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { DEFAULT_MODEL_SETTING } from "../../apps/daemon/src/modules/runtime/models.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { ApiClient } from "../../packages/api-client/src/index.ts";
import { BotDto, type ThreadDto } from "../../packages/protocol/src/index.ts";
import { fauxAssistantMessage, type FakeReply } from "../../packages/testkit/src/fake-provider.ts";
import { api, apiStatus, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

async function withDaemon(run: (h: Harness, client: ApiClient) => Promise<void>): Promise<void> {
  // Use this file's two-model fake instead of the suite-wide single-model fixture.
  const durableSuite = process.env.OMARCHY_TEST_DURABLE;
  if (durableSuite === "1") delete process.env.OMARCHY_TEST_DURABLE;
  const h = await startDaemon().finally(() => {
    if (durableSuite === "1") process.env.OMARCHY_TEST_DURABLE = durableSuite;
  });
  try {
    await run(h, new ApiClient({ baseUrl: h.baseUrl, deviceToken: h.token }));
  } finally {
    await h.stop();
    await rm(h.home, { recursive: true, force: true });
    await rm(h.svc.cfg.stateDir, { recursive: true, force: true });
  }
}

test("Bot model PATCH validates, persists, emits, and clears the override for only the target Bot", () => withDaemon(async (h, client) => {
  const bot = await client.createBot({ name: "Bot with model override", instructions: "", agentId: "pi" });
  const other = await client.createBot({ name: "Other Bot", instructions: "", agentId: "pi" });
  const botPath = `/api/bots/${bot.id}`;
  const otherModel = "unconfigured/org/other-model";
  expect(BotDto.parse(bot).model).toBeNull();
  expect((await client.patchBot(other.id, { model: otherModel })).model).toBe(otherModel);

  const patched = await apiStatus(h, "PATCH", botPath, { model: "fake/fake-model" });
  expect(patched.status).toBe(200);
  expect(patched.body).toMatchObject({ id: bot.id, model: "fake/fake-model" });
  expect((await client.getBot(bot.id)).model).toBe("fake/fake-model");
  expect(await client.listBots()).toContainEqual(expect.objectContaining({ id: bot.id, model: "fake/fake-model" }));
  expect((await client.patchBot(bot.id, { name: "Renamed Bot" })).model).toBe("fake/fake-model");

  for (const model of ["no-slash", "", "/model", "provider/"]) {
    const invalid = await apiStatus(h, "PATCH", botPath, { model });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: expect.stringContaining("provider/model") });
  }
  expect((await client.getBot(bot.id)).model).toBe("fake/fake-model");

  const cleared = await apiStatus(h, "PATCH", botPath, { model: null });
  expect(cleared.status).toBe(200);
  expect(cleared.body).toMatchObject({ id: bot.id, model: null });
  expect((await client.getBot(bot.id)).model).toBeNull();
  expect((await client.getBot(other.id)).model).toBe(otherModel);

  const updates = h.svc.events.replay(0, h.svc.events.oldestCursor()).events
    .filter((event) => event.type === "bot.updated" && event.aggregateId === bot.id);
  expect(updates.map(({ payload }) => payload)).toEqual([
    expect.objectContaining({ model: "fake/fake-model" }),
    expect.objectContaining({ name: "Renamed Bot", model: "fake/fake-model" }),
    expect.objectContaining({ model: null }),
  ]);
}));

test("durable Turns select the Bot override and return to the Service model after clearing it", () => {
  const replyWithModel: FakeReply = (_context, _options, _state, model) => fauxAssistantMessage(`${model.provider}/${model.id}`);
  return withFakeRuntimeProvider([replyWithModel, replyWithModel, replyWithModel], { providerId: "fake" }, () => withDaemon(async (h, client) => {
    await h.svc.credentials.add({
      id: "fake",
      name: "Fake",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1",
      apiKey: "fake-key",
      models: [{ id: "fake-model" }, { id: "default-model" }],
    });
    setSetting(h.svc.db, DEFAULT_MODEL_SETTING, "fake/default-model");
    setSetting(h.svc.db, "runtime", "durable");
    const bot = await client.createBot({ name: "Model selection", instructions: "", agentId: "pi" });

    async function expectCompletedWithModel(turn: { threadId: string; turnId: string }, model: string) {
      await waitThreadIdle(h, turn.threadId);
      const thread = await api<ThreadDto>(h, "GET", `/api/threads/${turn.threadId}`);
      expect(thread.latestTurn).toMatchObject({ id: turn.turnId, status: "completed" });
      const response = (await messages(h, turn.threadId)).findLast((message) => message.kind === "response");
      expect(response?.text).toBe(model);
    }

    const first = await sendToBot(h, bot.id, "Use the Service default.");
    await expectCompletedWithModel(first, "fake/default-model");

    await client.patchBot(bot.id, { model: "fake/fake-model" });
    const next = await sendToThread(h, first.threadId, "Use the Bot override.");
    await expectCompletedWithModel(next, "fake/fake-model");

    await client.patchBot(bot.id, { model: null });
    const afterClear = await sendToThread(h, first.threadId, "Use the Service default again.");
    await expectCompletedWithModel(afterClear, "fake/default-model");
  }));
});
