import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  clearDraftsByBot,
  draftStorageKey,
  loadDraft,
  saveDraft,
} from "../../apps/omarchy-bot/src/lib/drafts.ts";
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

  test("renames a Thread through the API and persists the title", async () => {
    const botId = await makeBot(h, "Rename Bot");
    const sent = await sendToBot(h, botId, "Original title");
    await waitThreadIdle(h, sent.threadId);

    const url = `/api/threads/${sent.threadId}`;
    expect((await api<ThreadDto>(h, "GET", url)).title).toBe("Original title");
    expect(await apiStatus(h, "PATCH", url, { title: "   " })).toMatchObject({ status: 400 });
    expect(await apiStatus(h, "PATCH", "/api/threads/unknown", { title: "Renamed thread" })).toMatchObject({ status: 404 });

    const renamed = await api<ThreadDto>(h, "PATCH", url, { title: "  Renamed thread  " });
    expect(renamed).toMatchObject({ id: sent.threadId, botId, title: "Renamed thread" });
    expect(await api<ThreadDto>(h, "GET", url)).toEqual(renamed);
    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${botId}/threads?q=renamed`)).toEqual([renamed]);
    const updates = h.svc.events.replay(0, h.svc.events.oldestCursor()).events
      .filter((event) => event.aggregateId === sent.threadId && event.type === "thread.updated");
    expect(updates).toEqual([expect.objectContaining({ payload: { title: "Renamed thread" } })]);
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
