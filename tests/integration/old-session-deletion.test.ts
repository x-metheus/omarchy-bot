import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { withFakeRuntimeProvider } from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import { DeleteBotResultDto } from "../../packages/protocol/src/index.ts";
import { apiStatus, makeBot, messages, sendToThread, startDaemon, type Harness } from "./helpers/harness.ts";

const fixture = join(import.meta.dir, "fixtures/old-session-file.jsonl");
const oldTime = new Date("2026-01-01T00:00:00.000Z");

async function withDaemon(check: (h: Harness, botId: string) => Promise<void>) {
  const home = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "old-session-deletion-"));
  const h = await startDaemon(home);
  try {
    await check(h, await makeBot(h, "Old session deletion"));
  } finally {
    try {
      await h.stop();
    } finally {
      await fs.rm(h.home, { recursive: true, force: true });
      await fs.rm(h.svc.cfg.stateDir, { recursive: true, force: true });
    }
  }
}

function recordSession(h: Harness, botId: string, sessionId: string): string {
  const { id } = h.svc.threads.createThread(botId, {});
  h.svc.threads.setNativeSession(id, sessionId);
  return id;
}

async function readSession(path: string) {
  return { bytes: await fs.readFile(path), mtimeMs: (await fs.stat(path)).mtimeMs };
}

async function expectBotDeleted(h: Harness, botId: string, count: number, ...threadIds: string[]) {
  const { status, body } = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
  expect(status).toBe(200);
  expect(body).toMatchObject({ status: "deleted", botId, oldSessionFilesRemoved: count, failures: [] });
  expect(DeleteBotResultDto.parse(body).status).toBe("deleted");
  const response = JSON.stringify(body);
  expect(response).not.toMatch(/"\//);
  expect(response).not.toContain(h.home);
  expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
  for (const threadId of threadIds) {
    expect(h.svc.threads.getThread(threadId)).toBeUndefined();
    expect(h.svc.threads.getNativeSession(threadId)).toBeUndefined();
  }
}

test("the first durable Turn leaves the old Pi session intact until Bot deletion removes only its recorded path", () => {
  const reply = "The durable Turn continued.";
  return withFakeRuntimeProvider([{ segments: [{ type: "text", text: reply }] }], {}, () => withDaemon(async (h, botId) => {
    await h.svc.credentials.add({
      id: "fake",
      name: "Fake",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1",
      apiKey: "fake-key",
      models: [{ id: "fake-model", reasoning: true }],
    });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");

    const directory = await fs.mkdtemp(join(h.home, "old-sessions-"));
    const recorded = join(directory, "recorded.jsonl");
    const sibling = join(directory, "sibling.jsonl");
    const otherBotSession = join(directory, "other-bot.jsonl");
    const unrelated = join(h.home, "unrelated.jsonl");
    for (const path of [recorded, sibling, otherBotSession, unrelated]) {
      await fs.copyFile(fixture, path);
      await fs.utimes(path, oldTime, oldTime);
    }
    const recordedBefore = await readSession(recorded);
    const siblingBefore = await readSession(sibling);
    const otherBotBefore = await readSession(otherBotSession);
    const unrelatedBefore = await readSession(unrelated);
    const threadId = recordSession(h, botId, recorded);
    const otherBotId = await makeBot(h, "Another Bot");
    const otherThreadId = recordSession(h, otherBotId, otherBotSession);

    const { turnId } = await sendToThread(h, threadId, "Continue the old session.");
    expect((await h.svc.turns.waitForTerminal(turnId)).status).toBe("completed");
    expect((await messages(h, threadId)).at(-1)?.text).toBe(reply);
    expect(h.svc.threads.getNativeSession(threadId)).toBe(recorded);
    expect(await readSession(recorded)).toEqual(recordedBefore);

    await expectBotDeleted(h, botId, 1, threadId);
    await expect(fs.lstat(recorded)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readSession(sibling)).toEqual(siblingBefore);
    expect(await readSession(otherBotSession)).toEqual(otherBotBefore);
    expect(h.svc.threads.getNativeSession(otherThreadId)).toBe(otherBotSession);
    expect(await readSession(unrelated)).toEqual(unrelatedBefore);
  }));
});

test("Bot deletion silently skips a missing old session file", () => withDaemon(async (h, botId) => {
  const threadId = recordSession(h, botId, join(h.home, "missing.jsonl"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
}));

test("Bot deletion logs only ENOTDIR when old session metadata lookup fails", () => withDaemon(async (h, botId) => {
  const path = join(h.home, "session.jsonl");
  await fs.copyFile(fixture, path);
  const before = await readSession(path);
  const recorded = path + sep;
  await expect(fs.lstat(recorded)).rejects.toHaveProperty("code", "ENOTDIR");
  const threadId = recordSession(h, botId, recorded);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    expect(await readSession(path)).toEqual(before);
    expect(warn.mock.calls).toEqual([["ENOTDIR"]]);
  } finally {
    warn.mockRestore();
  }
}));

test("Bot deletion silently skips non-absolute and empty session IDs, even when the relative file exists", () => withDaemon(async (h, botId) => {
  const path = join(h.home, "relative-session.jsonl");
  await fs.copyFile(fixture, path);
  const relativePath = relative(process.cwd(), path);
  expect(isAbsolute(relativePath)).toBeFalse();
  const before = await readSession(relativePath);
  const threadIds = ["fake://fail-delete", "mem:old-session", "", relativePath].map((id) => recordSession(h, botId, id));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, ...threadIds);
    expect(await readSession(path)).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
}));

test("Bot deletion warns and preserves a directory recorded as an old session", () => withDaemon(async (h, botId) => {
  const directory = await fs.mkdtemp(join(h.home, "recorded-directory-"));
  const child = join(directory, "session.jsonl");
  await fs.copyFile(fixture, child);
  const threadId = recordSession(h, botId, directory);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    expect((await fs.lstat(directory)).isDirectory()).toBeTrue();
    expect(await fs.readFile(child)).toEqual(await fs.readFile(fixture));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(directory);
  } finally {
    warn.mockRestore();
  }
}));

test("Bot deletion refuses a recorded parent traversal and preserves the file it reaches", () => withDaemon(async (h, botId) => {
  const directory = await fs.mkdtemp(join(h.home, "sessions-"));
  const outside = join(h.home, "outside-session-dir.jsonl");
  await fs.copyFile(fixture, outside);
  // Keep the recorded '..' segment intact when constructing the path.
  const traversal = [directory, "..", "outside-session-dir.jsonl"].join(sep);
  const before = await readSession(traversal);
  const threadId = recordSession(h, botId, traversal);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    expect(await readSession(outside)).toEqual(before);
    expect(warn.mock.calls).toEqual([["OLD_SESSION_PARENT_TRAVERSAL"]]);
  } finally {
    warn.mockRestore();
  }
}));

test("Bot deletion refuses a symlinked ancestor and preserves the file it reaches", () => withDaemon(async (h, botId) => {
  const realDirectory = await fs.mkdtemp(join(h.home, "real-sessions-"));
  await fs.mkdir(join(realDirectory, "nested"));
  const realFile = join(realDirectory, "nested", "session.jsonl");
  await fs.copyFile(fixture, realFile);
  const alias = join(h.home, "session-alias");
  await fs.symlink(realDirectory, alias, "dir");
  const recorded = join(alias, "nested", "session.jsonl");
  const before = await readSession(recorded);
  const threadId = recordSession(h, botId, recorded);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    expect(await readSession(realFile)).toEqual(before);
    expect(warn.mock.calls).toEqual([["OLD_SESSION_PARENT_MISMATCH"]]);
  } finally {
    warn.mockRestore();
  }
}));

test("Bot deletion removes a path recorded by two Threads exactly once", () => withDaemon(async (h, botId) => {
  const path = join(h.home, "shared-session.jsonl");
  await fs.copyFile(fixture, path);
  const first = recordSession(h, botId, path);
  const second = recordSession(h, botId, path);
  const unlink = spyOn(fs, "unlink");
  try {
    await expectBotDeleted(h, botId, 1, first, second);
    await expect(fs.lstat(path)).rejects.toHaveProperty("code", "ENOENT");
    expect(unlink.mock.calls).toEqual([[path]]);
  } finally {
    unlink.mockRestore();
  }
}));

test("Bot deletion preserves a recorded path until the last Bot that records it is deleted", () => withDaemon(async (h, botId) => {
  const path = join(h.home, "shared-between-bots.jsonl");
  await fs.copyFile(fixture, path);
  const before = await readSession(path);
  const threadId = recordSession(h, botId, path);
  const otherBotId = await makeBot(h, "Other Bot sharing the session");
  const otherThreadId = recordSession(h, otherBotId, path);

  await expectBotDeleted(h, botId, 0, threadId);
  expect(await readSession(path)).toEqual(before);
  expect(h.svc.threads.getNativeSession(otherThreadId)).toBe(path);

  await expectBotDeleted(h, otherBotId, 1, otherThreadId);
  await expect(fs.lstat(path)).rejects.toHaveProperty("code", "ENOENT");
}));

test("Bot deletion removes a recorded symlink and preserves its target", () => withDaemon(async (h, botId) => {
  const target = join(h.home, "unrecorded-target.jsonl");
  const link = join(h.home, "recorded-link.jsonl");
  await fs.copyFile(fixture, target);
  await fs.symlink(target, link);
  const before = await readSession(target);
  const threadId = recordSession(h, botId, link);

  await expectBotDeleted(h, botId, 1, threadId);
  await expect(fs.lstat(link)).rejects.toHaveProperty("code", "ENOENT");
  expect(await readSession(target)).toEqual(before);
}));

test("Bot deletion succeeds after a failed old session removal and warns with only the error code", () => withDaemon(async (h, botId) => {
  const path = join(h.home, "protected-session.jsonl");
  await fs.copyFile(fixture, path);
  const before = await readSession(path);
  const threadId = recordSession(h, botId, path);
  const originalUnlink = fs.unlink;
  const unlink = spyOn(fs, "unlink").mockImplementation(async (name) => {
    if (name === path) throw Object.assign(new Error(`permission denied: ${path}`), { code: "EACCES", path });
    await originalUnlink(name);
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    expect(await readSession(path)).toEqual(before);
    expect(unlink.mock.calls).toEqual([[path]]);
    expect(warn.mock.calls).toEqual([["EACCES"]]);
  } finally {
    warn.mockRestore();
    unlink.mockRestore();
  }
}));

test("Bot deletion does not count an old session that disappears before unlink", () => withDaemon(async (h, botId) => {
  const path = join(h.home, "disappearing-session.jsonl");
  await fs.copyFile(fixture, path);
  const threadId = recordSession(h, botId, path);
  const originalUnlink = fs.unlink;
  const unlink = spyOn(fs, "unlink").mockImplementation(async (name) => {
    // Remove this file just before the Service's unlink, which then sees ENOENT.
    if (name === path) await originalUnlink(path);
    await originalUnlink(name);
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expectBotDeleted(h, botId, 0, threadId);
    await expect(fs.lstat(path)).rejects.toHaveProperty("code", "ENOENT");
    expect(unlink.mock.calls).toEqual([[path]]);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    unlink.mockRestore();
  }
}));
