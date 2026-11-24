import { expect, mock, spyOn, test } from "bun:test";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { MessageDto } from "@omarchy-bot/protocol";
import {
  formatMigrationLog, legacySessionSeed, readLegacySession, seedFirstTurnConversation, selectLegacyWindow, transcriptBeforeTurn, transcriptSeed,
} from "./sessionMigration.ts";

const fixtures = join(import.meta.dir, "../../../../../tests/integration/fixtures/sessions");
const legacyPath = join(fixtures, "legacy-session.jsonl");
const noCompactionPath = join(fixtures, "legacy-session-no-compaction.jsonl");

async function withSessionFile(contents: string | URL, check: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "legacy-session-test-"));
  try {
    const path = join(directory, "session.jsonl");
    if (typeof contents === "string") await writeFile(path, contents);
    else await copyFile(contents, path);
    await check(path);
  } finally {
    await rm(directory, { recursive: true });
  }
}

test("selectLegacyWindow uses the last compaction and file order, ignoring earlier entries", async () => {
  const session = await readLegacySession(legacyPath);
  const window = selectLegacyWindow(session);
  expect(window.map((entry) => entry.id)).toEqual([
    "00000003", "00000004", "00000005", "00000009", "00000006", "00000007", "00000008", "0000000a", "0000000b",
  ]);
  const lastCompaction = { ...window[0]!, id: "0000000c", summary: "A newer summary" };
  expect(selectLegacyWindow({ ...session, entries: [...session.entries, lastCompaction] })).toEqual([lastCompaction]);
  expect(() => selectLegacyWindow({ ...session, entries: [...session.entries, { ...lastCompaction, summary: null }] })).toThrow();
});

test("readLegacySession retains only the last compaction and later entries", async () => {
  const source = await readFile(legacyPath, "utf8");
  const latest = { type: "compaction", id: "0000000c", parentId: "0000000b", timestamp: "2026-01-01T00:00:12.000Z", summary: "Latest summary", firstKeptEntryId: "00000007", tokensBefore: 39 };
  const after = { type: "message", id: "0000000d", parentId: "0000000c", timestamp: "2026-01-01T00:00:13.000Z", message: { role: "user", content: "Keep going.", timestamp: 1767225613000 } };
  await withSessionFile(`${source}${JSON.stringify(latest)}\n${JSON.stringify(after)}\n`, async (path) => {
    const session = await readLegacySession(path);
    expect(session.entries).toEqual([latest, after]);
    expect(selectLegacyWindow(session)).toEqual([latest, after]);
  });
  const [header, ...entries] = source.split("\n");
  await withSessionFile(`${header}\n{\n${entries.join("\n")}`, async (path) => {
    await expect(readLegacySession(path)).rejects.toThrow(/^Invalid legacy session JSON on line 2$/);
  });
});

test("legacySessionSeed migrates the whole session without a compaction and keeps user blocks", async () => {
  const session = await readLegacySession(noCompactionPath);
  expect(selectLegacyWindow(session)).toEqual(session.entries);
  const { entries, counts } = legacySessionSeed(session);
  expect(entries.map(({ kind, model }) => [kind, model[0]?.role])).toEqual([
    ["legacy.message", "user"], ["legacy.message", "assistant"],
  ]);
  expect(entries[0]?.model[0]).toMatchObject({
    content: [{ type: "text", text: "Here is a blank pixel." }, { type: "image", mimeType: "image/png", data: expect.any(String) }],
  });
  expect(counts).toEqual({ user: 1, assistant: 1, toolResult: 0, labeled: 0, thinkingDropped: 0, dropped: 0, droppedByType: {} });
});

test("legacySessionSeed keeps the summary and native messages in order, stripping assistant metadata and thinking", async () => {
  const session = await readLegacySession(legacyPath);
  const assistantIndex = session.entries.findIndex((entry) => entry.id === "00000005");
  expect(session.entries[assistantIndex + 1]).toMatchObject({ id: "00000009", type: "label", parentId: "00000005", targetId: "00000005" });
  expect(session.entries[assistantIndex + 2]).toMatchObject({ id: "00000006", type: "message", parentId: "00000009", message: { role: "toolResult" } });
  const { entries, counts } = legacySessionSeed(session);
  expect(entries.map(({ kind, model }) => [kind, model[0]?.role])).toEqual([
    ["legacy.compaction", "user"], ["legacy.message", "user"], ["legacy.message", "assistant"],
    ["legacy.message", "toolResult"], ["legacy.message", "assistant"], ["legacy.labeled", "user"],
  ]);
  expect(entries[0]).toEqual({
    kind: "legacy.compaction",
    data: { sourceId: "00000003", timestamp: "2026-01-01T00:00:03.000Z" },
    model: [{ role: "user", content: "Previous conversation compaction summary:\nThe user is cataloging imaginary garden plants.", timestamp: 1767225603000 }],
  });
  expect(entries[1]).toEqual({
    kind: "legacy.message",
    data: { sourceId: "00000004", role: "user", timestamp: "2026-01-01T00:00:04.123Z" },
    model: [{ role: "user", content: "Look up the moon daisy.", timestamp: 1767225604123 }],
  });
  expect(entries[2]?.model[0]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "I will check the catalog." }, { type: "toolCall", id: "call_lookup", name: "lookup", arguments: { plant: "moon daisy" } }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1767225605000,
  });
  expect(entries[3]).toEqual({
    kind: "legacy.message",
    data: { sourceId: "00000006", role: "toolResult", timestamp: "2026-01-01T00:00:06.000Z" },
    model: [{ role: "toolResult", toolCallId: "call_lookup", toolName: "lookup", content: [{ type: "text", text: "Moon daisies bloom after sunset." }], isError: false, timestamp: 1767225606000 }],
  });
  expect(counts).toEqual({
    user: 1, assistant: 2, toolResult: 1, labeled: 1, thinkingDropped: 0, dropped: 3,
    droppedByType: { label: 1, model_change: 1, custom: 1 },
  });
});

test("legacySessionSeed labels an orphan tool result with its tool name and text", async () => {
  const { entries } = legacySessionSeed(await readLegacySession(legacyPath));
  expect(entries.at(-1)).toEqual({
    kind: "legacy.labeled",
    data: { sourceId: "0000000b", role: "toolResult", timestamp: "2026-01-01T00:00:11.000Z" },
    model: [{ role: "user", content: "[old tool result: lookup]\nA result without a call.", timestamp: 1767225611000 }],
  });
});

test("legacySessionSeed keeps complete multi-call runs and labels incomplete, misordered, or interrupted runs", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const result = session.entries.find((entry) => entry.id === "00000006")!;
  const user = session.entries.find((entry) => entry.id === "00000004")!;
  const otherAssistant = session.entries.find((entry) => entry.id === "00000007")!;
  const secondCall = { type: "toolCall", id: "call_second", name: "lookup", arguments: {} };
  const assistantMessage = assistant.message as { content: unknown[] };
  const withSecondCall = { ...assistant, message: { ...assistantMessage, content: [...assistantMessage.content, secondCall] } };
  const secondResult = { ...result, id: "0000000c", message: { ...(result.message as object), toolCallId: "call_second" } };
  const orphan = session.entries.at(-1)!;
  const native = legacySessionSeed({ ...session, entries: [withSecondCall, result, secondResult, orphan] });
  expect(native.entries.map(({ model }) => model[0]?.role)).toEqual(["assistant", "toolResult", "toolResult", "user"]);
  expect(native.counts).toMatchObject({ assistant: 1, toolResult: 2, labeled: 1 });

  const invalidResult = { ...secondResult, message: { ...secondResult.message, content: null } };
  for (const results of [[result], [secondResult, result], [result, invalidResult]]) {
    const { entries, counts } = legacySessionSeed({ ...session, entries: [withSecondCall, ...results] });
    expect(entries.map(({ kind }) => kind)).toEqual(Array(results.length + 1).fill("legacy.labeled"));
    expect(entries[0]?.model[0]).toMatchObject({ role: "user", content: expect.stringContaining("I will check the catalog.") });
    expect(JSON.stringify(entries)).not.toContain("Private synthetic reasoning");
    expect(JSON.stringify(entries)).not.toContain("synthetic-thought-signature");
    expect(counts).toMatchObject({ assistant: 0, toolResult: 0, labeled: entries.length });
  }
  for (const interveningMessage of [user, otherAssistant]) {
    const { entries, counts } = legacySessionSeed({ ...session, entries: [withSecondCall, result, interveningMessage, secondResult] });
    expect(entries.map(({ kind }) => kind)).toEqual(["legacy.labeled", "legacy.labeled", "legacy.message", "legacy.labeled"]);
    expect(counts).toMatchObject({ toolResult: 0, labeled: 3 });
  }
});

test("legacySessionSeed pairs tools across dropped entries and counts the drops", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const result = session.entries.find((entry) => entry.id === "00000006")!;
  const metadata = session.entries.filter((entry) => entry.type === "label" || entry.type === "model_change");
  const { entries, counts } = legacySessionSeed({ ...session, entries: [assistant, ...metadata, result] });
  expect(entries.map(({ kind, model }) => [kind, model[0]?.role])).toEqual([["legacy.message", "assistant"], ["legacy.message", "toolResult"]]);
  expect(counts).toMatchObject({ assistant: 1, toolResult: 1, labeled: 0, dropped: 2, droppedByType: { label: 1, model_change: 1 } });
});

test("legacySessionSeed labels a result with a matching call ID and mismatched tool name", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const result = session.entries.find((entry) => entry.id === "00000006")!;
  const mismatched = { ...result, message: { ...(result.message as object), toolName: "different_tool" } };
  const { entries, counts } = legacySessionSeed({ ...session, entries: [assistant, mismatched] });
  expect(entries.map(({ kind, model }) => [kind, model[0]?.role])).toEqual([["legacy.labeled", "user"], ["legacy.labeled", "user"]]);
  expect(entries[1]?.model[0]).toMatchObject({ content: "[old tool result: different_tool]\nMoon daisies bloom after sunset." });
  expect(counts).toMatchObject({ assistant: 0, toolResult: 0, labeled: 2 });
});

test.each(["error", "aborted", "pending", "deferred", "stop", "length"])("legacySessionSeed labels a tool exchange with assistant stop reason %s", async (stopReason) => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const result = session.entries.find((entry) => entry.id === "00000006")!;
  const stopped = { ...assistant, message: { ...(assistant.message as object), stopReason } };
  const { entries, counts } = legacySessionSeed({ ...session, entries: [stopped, result] });
  expect(entries.map(({ kind, model }) => [kind, model[0]?.role])).toEqual([["legacy.labeled", "user"], ["legacy.labeled", "user"]]);
  expect(counts).toMatchObject({ assistant: 0, toolResult: 0, labeled: 2 });
});

test("legacySessionSeed labels a failed assistant even when it contains only thinking", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const message = { ...(assistant.message as object), stopReason: "error", content: [{ type: "thinking", thinking: "private" }] };
  const { entries, counts } = legacySessionSeed({ ...session, entries: [{ ...assistant, message }] });
  expect(entries.map(({ kind, model }) => [kind, model[0]?.content])).toEqual([["legacy.labeled", "[old assistant message: gpt-4o-mini]\n"]]);
  expect(counts).toMatchObject({ labeled: 1, thinkingDropped: 0 });
});

test("legacySessionSeed requires a call for toolUse and accepts text-only length and complete tool-only exchanges", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const result = session.entries.find((entry) => entry.id === "00000006")!;
  const message = assistant.message as { content: { type: string }[] };
  const textOnly = { ...message, content: message.content.filter((block) => block.type === "text") };
  const callOnly = { ...message, content: message.content.filter((block) => block.type === "toolCall") };
  const { entries } = legacySessionSeed({ ...session, entries: [
    { ...assistant, message: textOnly },
    { ...assistant, message: { ...textOnly, stopReason: "length" } },
    { ...assistant, message: callOnly },
    result,
  ] });
  expect(entries.map(({ kind, model }) => [kind, model[0]?.role])).toEqual([
    ["legacy.labeled", "user"], ["legacy.message", "assistant"], ["legacy.message", "assistant"], ["legacy.message", "toolResult"],
  ]);
});

test("legacySessionSeed rebuilds native text blocks in user and tool result messages", async () => {
  const session = await readLegacySession(legacyPath);
  const [user, assistant, result] = ["00000004", "00000005", "00000006"].map((id) => session.entries.find((entry) => entry.id === id)!);
  const signed = (text: string) => [{ type: "text", text, textSignature: "signed", thinkingSignature: "thinking", thoughtSignature: "thought", redacted: true }];
  const { entries } = legacySessionSeed({ ...session, entries: [
    { ...user!, message: { role: "user", content: signed("Question") } },
    assistant!,
    { ...result!, message: { ...(result!.message as object), content: signed("Answer") } },
  ] });
  expect(entries.map(({ model }) => model[0]?.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(entries[0]?.model[0]).toMatchObject({ role: "user" });
  expect(entries[0]?.model[0]?.content).toEqual([{ type: "text", text: "Question" }]);
  expect(entries[2]?.model[0]?.content).toEqual([{ type: "text", text: "Answer" }]);
});

test("legacySessionSeed labels standalone thinking and sanitizes unknown fallback blocks", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const thinking = { type: "thinking", thinking: "private" };
  const unknown = { type: "unknown", textSignature: "text", thinkingSignature: "thinking", thoughtSignature: "thought", redacted: true, nested: [{ note: "visible", thoughtSignature: "nested" }, thinking] };
  const { entries, counts } = legacySessionSeed({ ...session, entries: [
    { ...assistant, message: { ...(assistant.message as object), content: thinking } },
    { ...assistant, message: { ...(assistant.message as object), content: [thinking, unknown] } },
  ] });
  expect(entries.map(({ kind, model }) => [kind, model[0]?.content])).toEqual([
    ["legacy.labeled", "[old assistant message: gpt-4o-mini]\n"],
    ["legacy.labeled", '[old assistant message: gpt-4o-mini]\n{"type":"unknown","nested":[{"note":"visible"}]}'],
  ]);
  expect(counts).toMatchObject({ assistant: 0, labeled: 2, thinkingDropped: 0 });
});

test("legacySessionSeed counts thinking-only assistants without replaying them or their metadata", async () => {
  const session = await readLegacySession(legacyPath);
  const assistant = session.entries.find((entry) => entry.id === "00000005")!;
  const { entries, counts } = legacySessionSeed({
    ...session,
    entries: [{ ...assistant, message: { ...(assistant.message as object), content: [{ type: "thinking", thinking: "Private synthetic reasoning" }] } }],
  });
  expect(entries).toEqual([]);
  expect(counts).toMatchObject({ assistant: 0, labeled: 0, thinkingDropped: 1, dropped: 0 });
});

test("legacySessionSeed labels unsupported messages and flattens non-text content", async () => {
  const session = await readLegacySession(legacyPath);
  const base = session.entries.find((entry) => entry.id === "00000004")!;
  const messages = [
    { role: "bashExecution", command: "echo synthetic", output: "synthetic" },
    { role: "custom", customType: "example", content: [{ type: "text", text: "First" }, { type: "image", mimeType: "image/png", data: "aQ==" }] },
    { role: "compactionSummary", summary: "An older summary" },
    { role: "branchSummary", summary: "An older branch" },
    { role: "user", content: null },
    { role: "user", content: [{ type: "unknown", value: 42 }] },
  ];
  const { entries, counts } = legacySessionSeed({ ...session, entries: messages.map((message) => ({ ...base, message })) });
  expect(entries.map(({ model }) => model[0])).toEqual([
    { role: "user", content: "[old bashExecution message: echo synthetic]\nsynthetic", timestamp: 1767225604000 },
    { role: "user", content: '[old custom message: example]\nFirst\n{"type":"image","mimeType":"image/png","data":"aQ=="}', timestamp: 1767225604000 },
    { role: "user", content: "[old compactionSummary message: compactionSummary]\nAn older summary", timestamp: 1767225604000 },
    { role: "user", content: "[old branchSummary message: branchSummary]\nAn older branch", timestamp: 1767225604000 },
    { role: "user", content: "[old user message: user]\nnull", timestamp: 1767225604000 },
    { role: "user", content: '[old user message: user]\n{"type":"unknown","value":42}', timestamp: 1767225604000 },
  ]);
  expect(counts.labeled).toBe(messages.length);
});

test("legacySessionSeed counts every non-message type, including unknown types", async () => {
  const session = await readLegacySession(legacyPath);
  const types = ["model_change", "thinking_level_change", "label", "custom", "custom_message", "session_info", "branch_summary", "model_change", "__proto__"];
  const { entries, counts } = legacySessionSeed({ ...session, entries: types.map((type) => ({ ...session.entries[0]!, type })) });
  expect(entries).toEqual([]);
  expect(counts.dropped).toBe(types.length);
  expect(counts.droppedByType).toEqual({
    model_change: 2, thinking_level_change: 1, label: 1, custom: 1, custom_message: 1, session_info: 1, branch_summary: 1, ["__proto__"]: 1,
  });
});

test("legacySessionSeed falls back from message time to entry time and then the current time", async () => {
  const session = await readLegacySession(noCompactionPath);
  const message = { role: "user", content: "synthetic", timestamp: Infinity };
  const entry = { ...session.entries[0]!, message };
  const before = Date.now();
  const { entries } = legacySessionSeed({ ...session, entries: [entry, { ...entry, timestamp: "invalid" }] });
  expect(entries[0]?.model[0]?.timestamp).toBe(Date.parse("2026-01-02T00:00:01.000Z"));
  const fallback = entries[1]!.model[0]!.timestamp;
  expect(fallback).toBeGreaterThanOrEqual(before);
  expect(fallback).toBeLessThanOrEqual(Date.now());
  expect(entries[1]?.data.timestamp).toBe(new Date(fallback).toISOString());
});

test("legacySessionSeed floors fractional timestamps and falls back from out-of-range timestamps", async () => {
  const session = await readLegacySession(noCompactionPath);
  const base = session.entries[0]!;
  const timestamps = [1767312001000.75, -0.25, 8640000000000001, -8640000000000001];
  const { entries } = legacySessionSeed({ ...session, entries: timestamps.map((timestamp) => ({ ...base, message: { role: "user", content: "synthetic", timestamp } })) });
  const epoch = 1767312001000;
  expect(entries.map(({ model }) => model[0]?.timestamp)).toEqual([epoch, -1, epoch, epoch]);
  expect(entries.map(({ data, model }) => Date.parse(data.timestamp) === model[0]?.timestamp)).toEqual([true, true, true, true]);
});

test("readLegacySession rejects malformed JSON lines and invalid headers", async () => {
  await expect(readLegacySession(join(fixtures, "legacy-session-broken.jsonl"))).rejects.toThrow(/^Invalid legacy session JSON on line 2$/);
  const { header } = await readLegacySession(noCompactionPath);
  for (const fields of [
    { type: "message" }, { version: "3" }, { id: "" },
    { timestamp: "" }, { timestamp: "not a date" }, { timestamp: "January 2, 2026" }, { cwd: "" },
  ]) {
    await withSessionFile(`${JSON.stringify({ ...header, ...fields })}\n`, async (path) => {
      await expect(readLegacySession(path)).rejects.toThrow();
    });
  }
  await withSessionFile("\n\n", async (path) => {
    await expect(readLegacySession(path)).rejects.toThrow();
  });
});

test("readLegacySession accepts only version 3 and identifies unsupported numeric versions", async () => {
  const { header } = await readLegacySession(noCompactionPath);
  expect(header.version).toBe(3);
  for (const version of [
    { value: 1, error: /^Unsupported legacy session version 1$/ },
    { value: 2, error: /^Unsupported legacy session version 2$/ },
    { value: 0, error: /^Unsupported legacy session version 0$/ },
    { value: 4, error: /^Unsupported legacy session version 4$/ },
    { value: 2.5, error: /^Unsupported legacy session version 2\.5$/ },
  ]) {
    await withSessionFile(`${JSON.stringify({ ...header, version: version.value })}\n`, async (path) => {
      await expect(readLegacySession(path)).rejects.toThrow(version.error);
    });
  }
});

test("readLegacySession ignores blank lines", async () => {
  const source = await readFile(noCompactionPath, "utf8");
  await withSessionFile(`\n  \n${source.replaceAll("\n", "\n\n\t\n")}`, async (path) => {
    const session = await readLegacySession(path);
    expect(session.header).toMatchObject({ type: "session", version: 3 });
    expect(legacySessionSeed(session).entries).toHaveLength(2);
  });
});

test("readLegacySession and legacySessionSeed preserve the directory listing, file bytes, and mtime", async () => {
  await withSessionFile(new URL("../../../../../tests/integration/fixtures/sessions/legacy-session.jsonl", import.meta.url), async (path) => {
    const originalTime = new Date("2026-01-02T00:00:00.000Z");
    await utimes(path, originalTime, originalTime);
    const directory = dirname(path);
    const listing = (await readdir(directory)).sort();
    const before = await stat(path);
    const original = await readFile(path);
    const session = await readLegacySession(path);
    expect(session.header).toMatchObject({ type: "session", version: 3 });
    expect(legacySessionSeed(session).entries).toHaveLength(6);
    expect((await readdir(directory)).sort()).toEqual(listing);
    expect(await readFile(path)).toEqual(original);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });
});

test("formatMigrationLog reports exactly the migration counters", async () => {
  const { counts } = legacySessionSeed(await readLegacySession(legacyPath));
  expect(formatMigrationLog({ ...counts, thinkingDropped: 4 })).toBe("user=1 assistant=2 toolResult=1 labeled=1 thinking=4 dropped=3");
});

const context = BACKGROUND_CONTEXT;
const createdAt = "2026-01-01T00:00:01.000Z";
const oldUserMessage: MessageDto = {
  id: "old-user", threadId: "thread", seq: 1, createdAt, author: { kind: "user" }, kind: "text", text: "Prior user text",
};
const fallbackWarning = "Unable to migrate old Pi session for thread thread; seeded from the Service transcript: ";

async function withSeedConversation(check: (conversation: Conversation) => Promise<void>) {
  const storage = await openNodeSqliteStorage(":memory:");
  try {
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    try {
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
      await check(conversation);
    } finally {
      await harness.close(context);
    }
  } finally {
    await storage.close(context);
  }
}

test("transcriptSeed labels visible messages and tool names in order and skips thinking, events, and empty text", () => {
  const block = { blockId: "old-block", state: "completed" as const, startedAt: createdAt, completedAt: createdAt };
  const messages: MessageDto[] = [
    oldUserMessage,
    { ...oldUserMessage, id: "old-thinking", kind: "thinking", author: { kind: "bot" }, text: "Private thinking", thinking: block },
    { ...oldUserMessage, id: "old-tool", kind: "tool", author: { kind: "bot" }, text: undefined, toolCall: { id: "call", name: "lookup", status: "completed", target: "Private tool target" } },
    { ...oldUserMessage, id: "old-response", kind: "response", author: { kind: "bot" }, text: "Prior bot text", response: block },
    { ...oldUserMessage, id: "old-event", kind: "event", author: { kind: "bot" }, text: undefined, payload: { detail: "Private event" } },
    { ...oldUserMessage, id: "old-system", author: { kind: "system" }, text: "Prior system text" },
    { ...oldUserMessage, id: "old-empty", text: "" },
    { ...oldUserMessage, id: "old-whitespace", text: " \n " },
  ];
  const { entries, counts } = transcriptSeed(messages.map((message, index) => ({ ...message, seq: index + 1 })));
  expect(entries.map(({ kind, data, model }) => [kind, data.sourceId, model[0]])).toEqual([
    ["migration.transcript", "old-user", { role: "user", content: "[old user message]\nPrior user text", timestamp: Date.parse(createdAt) }],
    ["migration.transcript", "old-tool", { role: "user", content: "[old tool call: lookup]", timestamp: Date.parse(createdAt) }],
    ["migration.transcript", "old-response", { role: "user", content: "[old bot response]\nPrior bot text", timestamp: Date.parse(createdAt) }],
    ["migration.transcript", "old-system", { role: "user", content: "[old system message]\nPrior system text", timestamp: Date.parse(createdAt) }],
  ]);
  expect(counts).toEqual({
    user: 0, assistant: 0, toolResult: 0, labeled: 4, thinkingDropped: 1, dropped: 3, droppedByType: { event: 1, text: 2 },
  });
});

test("seedFirstTurnConversation without a legacy path appends nothing and logs nothing", () => withSeedConversation(async (conversation) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const commit = spyOn(conversation, "commit");
  const transcript = mock(() => [oldUserMessage]);
  try {
    expect(await seedFirstTurnConversation(conversation, context, { threadId: "thread", transcript })).toBe("none");
    expect(transcript).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    commit.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  }
}));

test("seedFirstTurnConversation commits the legacy seed once and logs exact counts without reading the transcript", () => withSeedConversation(async (conversation) => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  const commit = spyOn(conversation, "commit");
  const transcript = mock(() => [oldUserMessage]);
  try {
    expect(await seedFirstTurnConversation(conversation, context, { threadId: "thread", legacySessionPath: legacyPath, transcript })).toBe("session");
    expect(transcript).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await conversation.context(context)).entries.map(({ kind }) => kind)).toEqual([
      "legacy.compaction", "legacy.message", "legacy.message", "legacy.message", "legacy.message", "legacy.labeled",
    ]);
    expect(log.mock.calls).toEqual([["Migrated old Pi session for thread thread: user=1 assistant=2 toolResult=1 labeled=1 thinking=0 dropped=3"]]);
  } finally {
    commit.mockRestore();
    log.mockRestore();
  }
}));

test.each([
  ["legacy-session-broken.jsonl", "Invalid legacy session JSON on line 2"],
  ["missing.jsonl", "Legacy session file not found (ENOENT)"],
  [join("legacy-session.jsonl", "private-path-segment.jsonl"), "Legacy session file not readable (ENOTDIR)"],
])("seedFirstTurnConversation falls back to the transcript for %s and logs the reason", (file, reason) => withSeedConversation(async (conversation) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await seedFirstTurnConversation(conversation, context, { threadId: "thread", legacySessionPath: join(fixtures, file), transcript: () => [oldUserMessage] })).toBe("transcript");
    expect(warn.mock.calls).toEqual([[`${fallbackWarning}${reason}`]]);
    for (const part of file.split(sep)) expect(warn.mock.calls[0]?.[0]).not.toContain(part);
    expect(warn.mock.calls[0]?.[0]).not.toContain(fixtures);
    expect((await conversation.context(context)).entries).toEqual([
      expect.objectContaining({ kind: "migration.transcript", model: [{ role: "user", content: "[old user message]\nPrior user text", timestamp: Date.parse(createdAt) }] }),
    ]);
  } finally {
    warn.mockRestore();
  }
}));

test("fallback seeding excludes the current user message and a queued follow-up", () => withSeedConversation(async (conversation) => {
  const current = { ...oldUserMessage, id: "current-user", seq: 2, text: "Current request" };
  const followUp = { ...oldUserMessage, id: "queued-user", seq: 3, text: "Queued follow-up" };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const original = conversation.commit.bind(conversation);
  const commit = spyOn(conversation, "commit").mockImplementationOnce(async (change, ctx) => {
    const result = await original(change, ctx);
    expect(warn).not.toHaveBeenCalled();
    return result;
  });
  try {
    const transcript = mock(() => transcriptBeforeTurn(() => [oldUserMessage, current, followUp], current.seq));
    expect(await seedFirstTurnConversation(conversation, context, {
      threadId: "thread", legacySessionPath: join(fixtures, "legacy-session-broken.jsonl"), transcript,
    })).toBe("transcript");
    expect(transcript).toHaveBeenCalledTimes(1);
    expect((await conversation.context(context)).entries.map(({ data }) => data)).toEqual([
      expect.objectContaining({ sourceId: oldUserMessage.id }),
    ]);
    expect(warn.mock.calls).toEqual([[`${fallbackWarning}Invalid legacy session JSON on line 2`]]);
  } finally {
    commit.mockRestore();
    warn.mockRestore();
  }
}));

test("fallback seeding warns and skips the transcript when the current message position is unknown", () => withSeedConversation(async (conversation) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const listMessages = mock(() => [oldUserMessage]);
    const transcript = () => transcriptBeforeTurn(listMessages, undefined);
    expect(await seedFirstTurnConversation(conversation, context, {
      threadId: "thread", legacySessionPath: join(fixtures, "legacy-session-broken.jsonl"), transcript,
    })).toBe("transcript");
    expect(listMessages).not.toHaveBeenCalled();
    expect((await conversation.context(context)).entries).toEqual([]);
    expect(warn.mock.calls).toEqual([[
      "Unable to migrate old Pi session for thread thread; the Service transcript seed failed: Invalid legacy session JSON on line 2 (transcript error: current message position unknown)",
    ]]);
  } finally {
    warn.mockRestore();
  }
}));

test("seedFirstTurnConversation returns transcript for a broken session with no visible fallback messages", () => withSeedConversation(async (conversation) => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const commit = spyOn(conversation, "commit");
  try {
    expect(await seedFirstTurnConversation(conversation, context, { threadId: "thread", legacySessionPath: join(fixtures, "legacy-session-broken.jsonl") })).toBe("transcript");
    expect(commit).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["Unable to migrate old Pi session for thread thread; the Service transcript had nothing to seed: Invalid legacy session JSON on line 2"]]);
  } finally {
    commit.mockRestore();
    warn.mockRestore();
  }
}));

test("seedFirstTurnConversation commits only the transcript after a failed legacy transaction", () => withSeedConversation(async (conversation) => {
  const original = conversation.commit.bind(conversation);
  const commit = spyOn(conversation, "commit").mockImplementationOnce((change, ctx) => original(async (tx) => {
    await change(tx);
    throw new Error("Legacy seed transaction failed");
  }, ctx));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await seedFirstTurnConversation(conversation, context, { threadId: "thread", legacySessionPath: legacyPath, transcript: () => [oldUserMessage] })).toBe("transcript");
    expect((await conversation.context(context)).entries).toEqual([
      expect.objectContaining({ kind: "migration.transcript", data: expect.objectContaining({ sourceId: oldUserMessage.id }) }),
    ]);
    expect(warn.mock.calls).toEqual([[`${fallbackWarning}Legacy seed transaction failed`]]);
  } finally {
    warn.mockRestore();
    commit.mockRestore();
  }
}));

test("seedFirstTurnConversation warns and continues when both appends fail", () => withSeedConversation(async (conversation) => {
  const detail = `append failed\r\n${"x".repeat(200)}`;
  const commit = spyOn(conversation, "commit")
    .mockRejectedValueOnce(new Error(detail))
    .mockRejectedValueOnce(new Error("fallback\u2028append failed"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await seedFirstTurnConversation(conversation, context, { threadId: "thread", legacySessionPath: legacyPath, transcript: () => [oldUserMessage] })).toBe("transcript");
    expect(commit).toHaveBeenCalledTimes(2);
    expect((await conversation.context(context)).entries).toEqual([]);
    expect(warn.mock.calls).toEqual([
      [`Unable to migrate old Pi session for thread thread; the Service transcript seed failed: append failed ${"x".repeat(186)} (transcript error: fallback append failed)`],
    ]);
  } finally {
    warn.mockRestore();
    commit.mockRestore();
  }
}));
