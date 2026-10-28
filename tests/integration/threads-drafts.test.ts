import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  ThreadsService,
  ThreadTitleConflict,
  type NativeThreadTitleUpdater,
} from "../../apps/daemon/src/modules/threads/threads.ts";
import {
  clearDraftsByBot,
  draftStorageKey,
  loadDraft,
  saveDraft,
} from "../../apps/web/src/lib/drafts.ts";
import {
  api,
  apiStatus,
  makeBot,
  sendToBot,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

class MemoryStorage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }
}

let h: Harness;

beforeAll(async () => {
  h = await startDaemon();
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

function setNativeThreadActions(actions: string[]): void {
  writeFileSync(
    path.join(h.home, "conformance", "pi-fake-pi-1.json"),
    JSON.stringify({
      ok: true,
      image: "verified",
      fakeCapabilities: {
        nativeThreadActions: actions,
      },
    }),
  );
}

describe("thread history", () => {
  test("keeps a blank conversation unpersisted until first send and derives its title locally", async () => {
    const botId = await makeBot(h, "Lazy Thread Bot");
    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${botId}/threads`)).toEqual([]);

    const sent = await sendToBot(h, botId, "  Plan the release train\nwith details  ");
    await waitThreadIdle(h, sent.threadId);

    const threads = await api<ThreadDto[]>(h, "GET", `/api/bots/${botId}/threads`);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(sent.threadId);
    expect(threads[0]?.title).toBe("Plan the release train");
  });

  test("orders recent threads deterministically and searches titles within one bot", async () => {
    const botId = await makeBot(h, "History Bot");
    const otherBotId = await makeBot(h, "Other History Bot");
    const alpha = await sendToBot(h, botId, "Alpha release notes");
    await waitThreadIdle(h, alpha.threadId);
    const beta = await sendToBot(h, botId, "Beta incident review");
    await waitThreadIdle(h, beta.threadId);
    const otherAlpha = await sendToBot(h, otherBotId, "Alpha private thread");
    await waitThreadIdle(h, otherAlpha.threadId);

    h.svc.db.query(`UPDATE threads SET updated_at = ? WHERE id = ?`).run("2026-09-02T10:00:00.000Z", alpha.threadId);
    h.svc.db.query(`UPDATE threads SET updated_at = ? WHERE id = ?`).run("2026-09-02T11:00:00.000Z", beta.threadId);

    const recent = await api<ThreadDto[]>(h, "GET", `/api/bots/${botId}/threads`);
    expect(recent.map((thread) => thread.id)).toEqual([beta.threadId, alpha.threadId]);

    const alphaMatches = await api<ThreadDto[]>(h, "GET", `/api/bots/${botId}/threads?q=${encodeURIComponent("  ALPHA  ")}`);
    expect(alphaMatches.map((thread) => thread.id)).toEqual([alpha.threadId]);
    expect(alphaMatches.some((thread) => thread.id === otherAlpha.threadId)).toBeFalse();

    const noMatches = await api<ThreadDto[]>(h, "GET", `/api/bots/${botId}/threads?q=gamma`);
    expect(noMatches).toEqual([]);
  });

  test("returns a typed conflict for pi rename support and leaves the derived title unchanged", async () => {
    const botId = await makeBot(h, "Rename Truth Bot");
    const sent = await sendToBot(h, botId, "Keep this title");
    await waitThreadIdle(h, sent.threadId);

    let conflict: unknown;
    try {
      await h.svc.threads.updateTitle(sent.threadId, "Pretend rename");
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(ThreadTitleConflict);
    expect((conflict as ThreadTitleConflict).agentId).toBe("pi");
    expect((conflict as ThreadTitleConflict).status).toBe(409);

    const response = await apiStatus(h, "PATCH", `/api/threads/${sent.threadId}`, { title: "Pretend rename" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "rename not supported by pi" });

    const thread = await api<ThreadDto>(h, "GET", `/api/threads/${sent.threadId}`);
    expect(thread.title).toBe("Keep this title");
  });

  test("capability declarations authorize thread operations while adapters only execute them", async () => {
    const botId = await makeBot(h, "Native Thread Policy Bot");
    const sent = await sendToBot(h, botId, "Original native title");
    await waitThreadIdle(h, sent.threadId);

    const renames: Array<Parameters<NativeThreadTitleUpdater["renameThread"]>[0]> = [];
    const operationService = new ThreadsService(h.svc.db, h.svc.events, h.svc.agents, {
      pi: {
        renameThread: async (input) => {
          renames.push(input);
        },
      },
    });

    await expect(operationService.updateTitle(sent.threadId, "Adapter cannot declare support")).rejects.toBeInstanceOf(
      ThreadTitleConflict,
    );
    expect(renames).toEqual([]);

    setNativeThreadActions(["resume", "history", "close", "rename"]);
    await h.svc.agents.recheck("pi");
    try {
      const renamed = await operationService.updateTitle(sent.threadId, "Declared native rename");
      expect(renamed?.title).toBe("Declared native rename");
      expect(renames).toHaveLength(1);
      expect(renames[0]).toMatchObject({
        agentId: "pi",
        threadId: sent.threadId,
        title: "Declared native rename",
      });
      expect(renames[0]?.nativeSessionId?.startsWith("fake://s")).toBeTrue();
    } finally {
      setNativeThreadActions(["resume", "history", "close"]);
      await h.svc.agents.recheck("pi");
    }
  });

  test("an undeclared native resume is rejected before another message is persisted", async () => {
    const botId = await makeBot(h, "Resume Policy Bot");
    const sent = await sendToBot(h, botId, "First native session");
    await waitThreadIdle(h, sent.threadId);
    const before = await api<Array<{ id: string }>>(h, "GET", `/api/threads/${sent.threadId}/messages`);

    setNativeThreadActions(["history", "close"]);
    await h.svc.agents.recheck("pi");
    try {
      const response = await apiStatus(h, "POST", `/api/threads/${sent.threadId}/messages`, {
        text: "must not persist",
      });
      expect(response).toEqual({
        status: 409,
        body: { error: "session resume is not supported by pi" },
      });
      expect(await api<Array<{ id: string }>>(h, "GET", `/api/threads/${sent.threadId}/messages`)).toEqual(before);
    } finally {
      setNativeThreadActions(["resume", "history", "close"]);
      await h.svc.agents.recheck("pi");
    }
  });
});

describe("window-local draft storage", () => {
  test("isolates bot, thread, blank identity, and browser window storage", () => {
    const firstWindow = new MemoryStorage();
    const secondWindow = new MemoryStorage();
    const attachmentDraftToken = "6b7ffad2-779d-49eb-885a-7f0eb716b5b2";

    saveDraft(
      "bot_a",
      "thread_a",
      { text: "thread draft", cursor: 6, stagedIds: ["att_1"], attachmentDraftToken },
      firstWindow,
    );
    saveDraft("bot_a", null, { text: "blank draft", cursor: 11, stagedIds: [] }, firstWindow);
    saveDraft("bot_b", "thread_a", { text: "other bot", cursor: 9, stagedIds: [] }, firstWindow);

    expect(loadDraft("bot_a", "thread_a", firstWindow)).toEqual({
      text: "thread draft",
      cursor: 6,
      stagedIds: ["att_1"],
      attachmentDraftToken,
    });
    expect(loadDraft("bot_a", "blank", firstWindow).text).toBe("blank draft");
    expect(loadDraft("bot_b", "thread_a", firstWindow).text).toBe("other bot");
    expect(loadDraft("bot_a", "thread_a", secondWindow)).toEqual({ text: "", cursor: 0, stagedIds: [] });
  });

  test("drops a legacy dictation anchor while preserving text and attachments", () => {
    const storage = new MemoryStorage();
    const key = draftStorageKey("bot_a", "thread_a");
    const draft = {
      text: "ordinary draft",
      cursor: 8,
      stagedIds: ["att_keep"],
      attachmentDraftToken: "6b7ffad2-779d-49eb-885a-7f0eb716b5b2",
    };
    storage.setItem(key, JSON.stringify({ ...draft, dictationAnchor: 3 }));

    expect(loadDraft("bot_a", "thread_a", storage)).toEqual(draft);
    saveDraft("bot_a", "thread_a", loadDraft("bot_a", "thread_a", storage), storage);
    expect(JSON.parse(storage.getItem(key)!)).toEqual(draft);
  });

  test("normalizes persisted state, migrates Foundation text, and clears only the owning bot", () => {
    const storage = new MemoryStorage();
    storage.setItem(draftStorageKey("bot_a", "thread_a"), "legacy text");

    expect(loadDraft("bot_a", "thread_a", storage)).toEqual({ text: "legacy text", cursor: 11, stagedIds: [] });
    saveDraft(
      "bot_a",
      "thread_b",
      {
        text: "short",
        cursor: 99,
        stagedIds: ["att_1", "att_1", ""],
        attachmentDraftToken: "not-an-opaque-token",
      },
      storage,
    );
    expect(loadDraft("bot_a", "thread_b", storage)).toEqual({
      text: "short",
      cursor: 5,
      stagedIds: ["att_1"],
    });
    saveDraft("bot_ab", null, { text: "must remain", cursor: 11, stagedIds: [] }, storage);

    clearDraftsByBot("bot_a", storage);
    expect(loadDraft("bot_a", "thread_a", storage).text).toBe("");
    expect(loadDraft("bot_a", "thread_b", storage).text).toBe("");
    expect(loadDraft("bot_ab", null, storage).text).toBe("must remain");
  });
});
