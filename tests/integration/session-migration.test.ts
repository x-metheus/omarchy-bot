import { expect, spyOn, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { CredentialStore } from "../../apps/daemon/src/modules/runtime/credentials.ts";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import * as fakeProvider from "../../packages/testkit/src/fake-provider.ts";
import { makeBot, messages, sendToBot, sendToThread, startDaemon, type Harness } from "./helpers/harness.ts";

const reply = "The durable turn continued.";
type ProviderMessage = { role: string; content: unknown };

async function withMigrationDaemon(check: (h: Harness, botId: string, requests: (readonly ProviderMessage[])[]) => Promise<void>) {
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
        const botId = await makeBot(h, "Session migration");
        new CredentialStore(h.svc.cfg.stateDir).add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
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

async function recordSession(h: Harness, threadId: string, fixture: string): Promise<string> {
  const directory = await mkdtemp(join(h.home, "old-session-"));
  const path = join(directory, fixture);
  await copyFile(join(import.meta.dir, "fixtures/sessions", fixture), path);
  h.svc.threads.setNativeSession(threadId, path);
  return path;
}

function userContents(request: readonly ProviderMessage[] | undefined): unknown[] | undefined {
  return request?.filter(({ role }) => role === "user").map(({ content }) => content);
}

test("a Thread continues its old Pi session in the first durable model request", () => withMigrationDaemon(async (h, botId, requests) => {
  const { id: threadId } = h.svc.threads.createThread(botId, { title: "Old garden catalog" });
  const prior = "Prior Service transcript text";
  h.svc.threads.appendMessage(threadId, { author: { kind: "user" }, kind: "text", text: prior });
  const path = await recordSession(h, threadId, "legacy-session.jsonl");
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  await utimes(path, oldTime, oldTime);
  const [original, before] = await Promise.all([readFile(path), stat(path)]);
  setSetting(h.svc.db, "runtime", "durable");
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const current = "What does the catalog say?";
    const { turnId } = await sendToThread(h, threadId, current);
    expect((await h.svc.turns.waitForTerminal(turnId)).status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.filter(({ role }) => role !== "system")).toEqual([
      expect.objectContaining({ role: "user", content: "Previous conversation compaction summary:\nThe user is cataloging imaginary garden plants." }),
      expect.objectContaining({ role: "user", content: "Look up the moon daisy." }),
      expect.objectContaining({ role: "assistant", content: [
        { type: "text", text: "I will check the catalog." },
        { type: "toolCall", id: "call_lookup", name: "lookup", arguments: { plant: "moon daisy" } },
      ] }),
      expect.objectContaining({ role: "toolResult", toolCallId: "call_lookup", content: [{ type: "text", text: "Moon daisies bloom after sunset." }] }),
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Moon daisies bloom after sunset." }] }),
      expect.objectContaining({ role: "user", content: "[old tool result: lookup]\nA result without a call." }),
      expect.objectContaining({ role: "user", content: current }),
    ]);
    const request = JSON.stringify(requests[0]);
    for (const omitted of ["Start the imaginary garden catalog.", "The imaginary catalog is ready.", "Private synthetic reasoning", "synthetic-text-signature", "synthetic-thinking-block-signature", "synthetic-thought-signature", prior]) {
      expect(request).not.toContain(omitted);
    }
    expect((await messages(h, threadId)).map(({ text }) => text)).toEqual([prior, current, reply]);
    expect(log).toHaveBeenCalledWith(`Migrated old Pi session for thread ${threadId}: user=1 assistant=2 toolResult=1 labeled=1 thinking=0 dropped=3`);
    expect(await readFile(path)).toEqual(original);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    log.mockRestore();
  }
}));

test("a broken old Pi session seeds prior Service transcript messages and warns", () => withMigrationDaemon(async (h, botId, requests) => {
  const { id: threadId } = h.svc.threads.createThread(botId, { title: "Broken session" });
  const prior = "This user text lives in the Service transcript.";
  const current = "Please continue.";
  for (const text of [prior, current]) {
    h.svc.threads.appendMessage(threadId, { author: { kind: "user" }, kind: "text", text });
  }
  await recordSession(h, threadId, "legacy-session-broken.jsonl");
  setSetting(h.svc.db, "runtime", "durable");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { turnId } = await sendToThread(h, threadId, current);
    expect((await h.svc.turns.waitForTerminal(turnId)).status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(userContents(requests[0])).toEqual([`[old user message]\n${prior}`, `[old user message]\n${current}`, current]);
    expect(warn).toHaveBeenCalledWith(`Unable to migrate old Pi session for thread ${threadId}; seeded from the Service transcript: Invalid legacy session JSON on line 2`);
    expect((await messages(h, threadId)).at(-1)?.text).toBe(reply);
  } finally {
    warn.mockRestore();
  }
}));

test("a new durable Thread without a legacy session sends only its first user message and logs no migration", () => withMigrationDaemon(async (h, botId, requests) => {
  setSetting(h.svc.db, "runtime", "durable");
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const current = "Start a new conversation.";
    const { threadId, turnId } = await sendToBot(h, botId, current);
    expect((await h.svc.turns.waitForTerminal(turnId)).status).toBe("completed");
    expect(h.svc.threads.getNativeSession(threadId)).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.filter(({ role }) => role !== "system")).toEqual([expect.objectContaining({ role: "user", content: current })]);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
}));
