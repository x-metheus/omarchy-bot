import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ApprovalDto } from "@omarchy-bot/protocol";
import { MIGRATIONS } from "../persistence/db.ts";
import { ApprovalStore } from "../modules/runtime/approvals.ts";
import { handleApprovalRequest } from "./approvalRoutes.ts";

function store() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL)");
  const migration = MIGRATIONS.find((item) => item.name === "0026-durable-approvals");
  if (!migration || !("sql" in migration)) throw new Error("approvals migration missing");
  db.exec(migration.sql);
  return new ApprovalStore(db, { append: () => undefined as never });
}

const base = "http://127.0.0.1/api/approvals";
const call = (approvals: ApprovalStore | undefined, url: string, init?: RequestInit) => handleApprovalRequest(new Request(url, init), approvals, new URL(url));
const answer = (approvals: ApprovalStore | undefined, id: string, body: unknown) =>
  call(approvals, `${base}/${id}/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("lists pending requests, filtered by Thread, in the protocol shape", async () => {
  const approvals = store();
  const request = { callId: "call", conversationId: 1, botId: "bot", tool: "write" as const, path: "/outside/a.txt", folder: "/outside" };
  const first = approvals.request({ ...request, taskId: 1, threadId: "thread-1" });
  const second = approvals.request({ ...request, taskId: 2, threadId: "thread-2" });
  const all = await (await call(approvals, base))!.json();
  expect(ApprovalDto.array().parse(all)).toEqual([first, second]);
  expect(await (await call(approvals, `${base}?threadId=thread-2`))!.json()).toEqual([second]);
  expect(await (await call(undefined, base))!.json()).toEqual([]);
  expect(await call(approvals, `${base}/other`)).toBeUndefined();
});

test("answers a request once and rejects bad bodies and unknown ids", async () => {
  const approvals = store();
  const pending = approvals.request({ taskId: 1, callId: "call", conversationId: 1, threadId: "thread", botId: "bot", tool: "edit", path: "/outside/a.txt", folder: "/outside" });
  await expect(answer(approvals, pending.id, { answer: "maybe" })).rejects.toMatchObject({ status: 400 });
  await expect(answer(approvals, pending.id, { answer: "deny", extra: true })).rejects.toMatchObject({ status: 400 });
  await expect(answer(approvals, "missing", { answer: "deny" })).rejects.toMatchObject({ status: 404 });
  const answered = await (await answer(approvals, pending.id, { answer: "allow_once" }))!.json();
  expect(answered).toMatchObject({ id: pending.id, status: "allowed_once" });
  await expect(answer(approvals, pending.id, { answer: "deny" })).rejects.toMatchObject({ status: 409 });
  await expect(answer(undefined, pending.id, { answer: "deny" })).rejects.toMatchObject({ status: 404 });
});
