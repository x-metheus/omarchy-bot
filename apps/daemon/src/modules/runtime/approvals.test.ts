import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../../persistence/db.ts";
import { readSettingsAllowedFolders } from "../workspace/allowedFolders.ts";
import { APPROVAL_TTL_MS, ApprovalStore, type ApprovalRequest } from "./approvals.ts";

function setup(start = Date.parse("2026-11-24T00:00:00.000Z")) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL)");
  const migration = MIGRATIONS.find((item) => item.name === "0026-durable-approvals");
  if (!migration || !("sql" in migration)) throw new Error("approvals migration missing");
  db.exec(migration.sql);
  db.run("INSERT INTO turns VALUES ('old-turn', 'thread-1', 'bot-1', 'completed', '2026-11-23T00:00:00.000Z'), ('turn-1', 'thread-1', 'bot-1', 'working', '2026-11-24T00:00:00.000Z')");
  const clock = { now: start };
  const events: { type: string; aggregateId: string; payload: unknown }[] = [];
  const store = new ApprovalStore(db, { append: (_type, aggregateId, type, payload) => { events.push({ type, aggregateId, payload }); return undefined as never; } }, () => clock.now);
  return { db, store, clock, events };
}

const request: ApprovalRequest = { taskId: 7, callId: "call-1", conversationId: 3, threadId: "thread-1", botId: "bot-1", tool: "write", path: "/home/user/Documents/report.txt", folder: "/home/user/Documents" };

test("records one pending request per tool task and announces it once", () => {
  const { store, events } = setup();
  const first = store.request(request);
  expect(first).toMatchObject({ threadId: "thread-1", botId: "bot-1", turnId: "turn-1", tool: "write", path: request.path, folder: request.folder, status: "pending", answeredAt: null });
  expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(APPROVAL_TTL_MS);
  // A replayed task finds the same request instead of asking twice.
  expect(store.request(request)).toEqual(first);
  expect(events.map((event) => event.type)).toEqual(["approval.requested"]);
  expect(store.listPending()).toEqual([first]);
  expect(store.listPending({ threadId: "other" })).toEqual([]);
  expect(store.hasPending("thread-1", "bot-1")).toBe(true);
  expect(() => store.request({ ...request, path: "/elsewhere" })).toThrow("does not match");
});

test("answers once, adds the folder for always allow, and refuses a second answer", () => {
  const { db, store, events } = setup();
  const once = store.request(request);
  expect(store.answer(once.id, "allow_once").status).toBe("allowed_once");
  expect(() => store.answer(once.id, "deny")).toThrow("already allowed_once");
  expect(readSettingsAllowedFolders(db)).toEqual([]);

  const folder = store.request({ ...request, taskId: 8, callId: "call-2" });
  expect(store.answer(folder.id, "allow_folder")).toMatchObject({ status: "allowed_folder", answeredAt: expect.any(String) });
  expect(readSettingsAllowedFolders(db)).toEqual([request.folder]);

  const denied = store.request({ ...request, taskId: 9, callId: "call-3" });
  expect(store.answer(denied.id, "deny").status).toBe("denied");
  expect(() => store.answer("missing", "deny")).toThrow("not found");
  expect(store.hasPending("thread-1", "bot-1")).toBe(false);
  expect(events.filter((event) => event.type === "approval.resolved").map((event) => (event.payload as { status: string }).status)).toEqual(["allowed_once", "allowed_folder", "denied"]);
});

test("a waiter wakes on the answer, on expiry, and on abort", async () => {
  const { store, clock } = setup();
  const answered = store.request(request);
  const waiting = store.waitForAnswer(answered.id, undefined);
  store.answer(answered.id, "deny");
  expect((await waiting).status).toBe("denied");

  const expiring = store.request({ ...request, taskId: 8, callId: "call-2" });
  clock.now += APPROVAL_TTL_MS - 5;
  const expired = store.waitForAnswer(expiring.id, undefined, 10_000);
  clock.now += 10;
  expect((await expired).status).toBe("expired");
  expect(() => store.answer(expiring.id, "allow_once")).toThrow("already expired");

  const aborted = store.request({ ...request, taskId: 9, callId: "call-3" });
  const controller = new AbortController();
  const wait = store.waitForAnswer(aborted.id, controller.signal);
  controller.abort(new Error("turn aborted"));
  await expect(wait).rejects.toThrow("turn aborted");
  store.cancelTask(9);
  expect(store.get(aborted.id)?.status).toBe("cancelled");
});

test("an answer after the expiry time is refused and the request is expired", () => {
  const { store, clock, events } = setup();
  const pending = store.request(request);
  clock.now += APPROVAL_TTL_MS;
  expect(store.listPending()).toEqual([]);
  expect(() => store.answer(pending.id, "allow_once")).toThrow("already expired");
  expect(events.at(-1)).toMatchObject({ type: "approval.resolved", aggregateId: "thread-1", payload: { status: "expired" } });
});
