import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import * as fakeProvider from "../../packages/testkit/src/fake-provider.ts";
import { makeBot, sendToBot, startDaemon, type Harness } from "./helpers/harness.ts";

const reply = "The durable turn continued.";
type ProviderMessage = { role: string; content: unknown };

async function withRecordingDaemon(check: (h: Harness, botId: string, requests: (readonly ProviderMessage[])[]) => Promise<void>) {
  const requests: (readonly ProviderMessage[])[] = [];
  const create = fakeProvider.createFakeProvider;
  // Record the model-facing history at the scripted provider boundary.
  const capture = spyOn(fakeProvider, "createFakeProvider").mockImplementation((script, options) => {
    const fake = create(script, options);
    const provider = fake.provider;
    return {
      ...fake,
      provider: {
        ...provider,
        streamSimple(model, transcript, streamOptions) {
          requests.push(structuredClone(transcript.messages));
          return provider.streamSimple(model, transcript, streamOptions);
        },
      },
    };
  });
  try {
    await withFakeRuntimeProvider([{ segments: [{ type: "text", text: reply }] }], {}, async () => {
      const h = await startDaemon();
      try {
        const botId = await makeBot(h, "New durable Thread");
        await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
        setSetting(h.svc.db, "default_model", "fake/fake-model");
        await check(h, botId, requests);
      } finally {
        try { await h.stop(); } finally { await rm(h.home, { recursive: true, force: true }); }
      }
    });
  } finally {
    capture.mockRestore();
  }
}

test("a new durable Thread without a legacy session sends only its first user message", () => withRecordingDaemon(async (h, botId, requests) => {
  setSetting(h.svc.db, "runtime", "durable");
  const current = "Start a new conversation.";
  const { threadId, turnId } = await sendToBot(h, botId, current);
  expect((await h.svc.turns.waitForTerminal(turnId)).status).toBe("completed");
  expect(h.svc.threads.getNativeSession(threadId)).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.filter(({ role }) => role !== "system")).toEqual([expect.objectContaining({ role: "user", content: current })]);
}));
