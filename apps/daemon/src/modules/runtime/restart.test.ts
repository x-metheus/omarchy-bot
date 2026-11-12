import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { pairForToken } from "../../../../../tests/integration/helpers/harness.ts";

const root = path.resolve(import.meta.dir, "../../../../..");
const fixture = path.join(root, "tests/integration/fixtures/durable-crash-child.ts");

type Child = ReturnType<typeof Bun.spawn>;
async function boot(home: string, deadline: number, crashMode = false): Promise<{ child: Child; port: number; events: string[] }> {
  const child = Bun.spawn(["bun", fixture], { env: { ...process.env, HOME: home, OMARCHY_BOT_HOME: home, OMARCHY_BOT_STATE: path.join(home, "state"), OMARCHY_BOT_PORT: "0", OMARCHY_BOT_WORKERS_DIR: path.join(root, "tests/integration/fake-workers"), OMARCHY_TEST_SLEEP_AT: String(deadline), OMARCHY_TEST_CRASH_MODE: crashMode ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
  const events: string[] = [];
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let ready!: (port: number) => void;
  const started = new Promise<number>((resolve) => { ready = resolve; });
  void (async () => {
    let pending = "";
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      pending += new TextDecoder().decode(item.value);
      const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) {
        try { const event = JSON.parse(line) as { event?: string; port?: number }; if (event.event) events.push(event.event); if (event.event === "ready" && event.port) ready(event.port); } catch { /* daemon log */ }
      }
    }
  })();
  void new Response(child.stderr as ReadableStream<Uint8Array>).text();
  try { return { child, port: await Promise.race([started, Bun.sleep(10000).then(() => { throw new Error("child did not start"); })]), events }; }
  catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
}
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value !== undefined) return value; await Bun.sleep(50); }
  throw new Error("timed out waiting for restart condition");
}
async function stop(child: Child): Promise<void> { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await child.exited; }
function setup(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "durable-restart-"));
  mkdirSync(path.join(home, "conformance"));
  writeFileSync(path.join(home, "conformance/pi-fake-pi-1.json"), JSON.stringify({ ok: true, image: "verified" }));
  return home;
}
async function send(port: number, home: string, text: string): Promise<{ turnId: string; threadId: string }> {
  const base = `http://127.0.0.1:${port}`;
  const token = await pairForToken(base, path.join(home, "state"));
  await waitFor(async () => {
    const response = await fetch(`${base}/api/agents`, { headers: { authorization: `Bearer ${token}` } });
    const agents = await response.json() as { id: string; status: string }[];
    return agents.some((agent) => agent.id === "pi" && agent.status === "ready") ? true : undefined;
  }, 20000);
  async function post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(base + url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }
  const bot = await post<{ id: string }>("/api/bots", { name: "Crash test", agentId: "pi" });
  return post(`/api/bots/${bot.id}/messages`, { text });
}
function query<T>(home: string, sql: string, ...args: string[]): T | null {
  const db = new Database(path.join(home, "db.sqlite"), { readonly: true });
  try { return db.query<T, string[]>(sql).get(...args); } finally { db.close(); }
}

test("hard kill resumes a reply and its sleeping task posts once in the same conversation", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 7000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    await stop(child); child = undefined;
    const second = await boot(home, deadline); child = second.child;
    const row = await waitFor(() => { const value = query<{ status: string; outcome_reason: string | null }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId); return value && ["completed", "failed"].includes(value.status) ? value : undefined; }, 30000);
    expect(row.status).toBe("completed");
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM messages WHERE turn_id = ? AND kind = 'response' AND block_state = 'completed'", sent.turnId)?.n).toBeGreaterThan(0);
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM (SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' GROUP BY text HAVING count(*) > 1)", sent.turnId)?.n).toBe(0);
    await Bun.sleep(Math.max(0, deadline - Date.now()) + 800);
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM pi_turn_submissions WHERE turn_id = ?", sent.turnId)?.n).toBe(1);
    const indexed = query<{ conversation_id: number }>(home, "SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?", sent.threadId)!;
    await stop(child); child = undefined;
    const storage = await openNodeSqliteStorage(path.join(home, "db.sqlite"), { prefix: "pi_" });
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
    try {
      const conversation = await harness.conversation(indexed.conversation_id as ConversationId, BACKGROUND_CONTEXT);
      expect(conversation).toBeDefined();
      const entries = await conversation!.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.filter((entry) => entry.kind === "write" && (entry.data as { text?: string }).text === "scheduled post")).toHaveLength(1);
    } finally { await harness.close(BACKGROUND_CONTEXT); await storage.close(BACKGROUND_CONTEXT); }
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("recovery preserves the first request partial before the continued answer", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 20000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "first-request");
    const before = await waitFor(() => {
      const response = query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) >= 15", sent.turnId);
      return response ?? undefined;
    });
    await Bun.sleep(1200);
    await stop(child); child = undefined;
    const second = await boot(home, deadline); child = second.child;
    const terminal = await waitFor(() => {
      const row = query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", sent.turnId);
      return row?.status === "completed" || row?.status === "failed" ? row : undefined;
    }, 30000);
    expect(terminal.status).toBe("completed");
    const db = new Database(path.join(home, "db.sqlite"), { readonly: true });
    try {
      const responses = db.query<{ text: string; block_state: string }, [string]>("SELECT text, block_state FROM messages WHERE turn_id = ? AND kind = 'response' ORDER BY seq").all(sent.turnId);
      expect(responses).toHaveLength(2);
      expect(responses[0]!.text).toContain(before.text);
      expect(responses[0]!.block_state).toBe("completed");
      expect(responses[1]!.text).toBe("First request streaming text stays visible after interruption and the continuation completes.");
      expect(responses[1]!.block_state).toBe("completed");
    } finally { db.close(); }
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("recovery finds an admitted submission whose association was lost", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 12000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    await stop(child); child = undefined;
    const db = new Database(path.join(home, "db.sqlite"));
    try {
      db.query("DELETE FROM pi_turn_submissions WHERE turn_id = ?").run(sent.turnId);
      db.query("INSERT INTO turns (id, thread_id, bot_id, status, native_session_id, started_at) SELECT 'turn_missing_submission', thread_id, bot_id, 'working', '', started_at FROM turns WHERE id = ?").run(sent.turnId);
    } finally { db.close(); }
    const second = await boot(home, deadline); child = second.child;
    const row = await waitFor(() => { const value = query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", sent.turnId); return value?.status === "completed" || value?.status === "failed" ? value : undefined; }, 30000);
    expect(row.status).toBe("completed");
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM pi_turn_submissions WHERE turn_id = ?", sent.turnId)?.n).toBe(1);
    const missing = await waitFor(() => { const value = query<{ status: string; outcome_reason: string }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", "turn_missing_submission"); return value?.status === "failed" ? value : undefined; });
    expect(missing.outcome_reason).toBe("durable submission not found");
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("recovery reconnects a Turn and its admitted steer", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 12000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    const token = await pairForToken(`http://127.0.0.1:${first.port}`, path.join(home, "state"));
    const response = await fetch(`http://127.0.0.1:${first.port}/api/threads/${sent.threadId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() }, body: JSON.stringify({ text: "redirect" }) });
    expect(response.ok).toBeTrue();
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM pi_turn_submissions WHERE turn_id = ?", sent.turnId)?.n).toBe(2);
    await stop(child); child = undefined;
    const second = await boot(home, deadline); child = second.child;
    const row = await waitFor(() => { const value = query<{ status: string; outcome_reason: string | null }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId); return value?.status === "completed" || value?.status === "failed" ? value : undefined; }, 30000);
    expect(row.status).toBe("completed");
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM pi_turn_submissions WHERE turn_id = ?", sent.turnId)?.n).toBe(2);
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("recovery finds a steer whose association write was lost", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 12000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    const token = await pairForToken(`http://127.0.0.1:${first.port}`, path.join(home, "state"));
    const response = await fetch(`http://127.0.0.1:${first.port}/api/threads/${sent.threadId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() }, body: JSON.stringify({ text: "redirect" }) });
    expect(response.ok).toBeTrue();
    await stop(child); child = undefined;
    const db = new Database(path.join(home, "db.sqlite"));
    try { db.query("DELETE FROM pi_turn_submissions WHERE turn_id = ? AND kind = 'steer'").run(sent.turnId); } finally { db.close(); }
    const second = await boot(home, deadline); child = second.child;
    const row = await waitFor(() => { const value = query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", sent.turnId); return value?.status === "completed" || value?.status === "failed" ? value : undefined; }, 30000);
    expect(row.status).toBe("completed");
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM pi_turn_submissions WHERE turn_id = ? AND kind = 'steer'", sent.turnId)?.n).toBe(1);
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("recovery keeps a queued follow-up in its own Turn", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 15000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    const token = await pairForToken(`http://127.0.0.1:${first.port}`, path.join(home, "state"));
    const response = await fetch(`http://127.0.0.1:${first.port}/api/threads/${sent.threadId}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() }, body: JSON.stringify({ text: "follow-up", whenBusy: "followUp" }) });
    expect(response.ok).toBeTrue();
    const follow = await response.json() as { turnId: string };
    expect(follow.turnId).not.toBe(sent.turnId);
    await stop(child); child = undefined;
    const second = await boot(home, deadline); child = second.child;
    for (const turnId of [sent.turnId, follow.turnId]) {
      const row = await waitFor(() => { const value = query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", turnId); return value?.status === "completed" || value?.status === "failed" ? value : undefined; }, 30000);
      expect(row.status).toBe("completed");
      expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM messages WHERE turn_id = ? AND kind = 'response'", turnId)?.n).toBeGreaterThan(0);
    }
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("shutdown aborts and awaits a recovered running reply", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 12000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    await stop(child); child = undefined;
    const second = await boot(home, deadline); child = second.child;
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND block_state = 'streaming' AND length(text) > 0", sent.turnId) ?? undefined);
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(10000).then(() => { throw new Error("shutdown did not finish"); })]);
    child = undefined;
    expect(query<{ status: string; outcome_reason: string }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId)).toMatchObject({ status: "cancelled", outcome_reason: "aborted" });
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60000);

test("repeated hard kills stop a crashing reply at the restart limit", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 60000;
    let first = await boot(home, deadline, true); child = first.child;
    const sent = await send(first.port, home, "hang");
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await waitFor(() => first.events.includes("before-request") ? true : undefined, 6000); }
      catch { throw new Error(`attempt ${attempt + 1}: events=${JSON.stringify(first.events)} turn=${JSON.stringify(query(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId))}`); }
      expect(query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", sent.turnId)?.status).toBe("working");
      expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM messages WHERE turn_id = ? AND kind IN ('response', 'thinking')", sent.turnId)?.n).toBe(0);
      await stop(child); child = undefined;
      expect(first.child.signalCode).toBe("SIGKILL");
      first = await boot(home, deadline, true); child = first.child;
    }
    const row = await waitFor(() => { const value = query<{ status: string; outcome_reason: string | null }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId); return value?.status === "failed" ? value : undefined; }, 30000);
    expect(row.outcome_reason).toContain("interrupted 5 times");
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM messages WHERE turn_id = ? AND kind = 'response'", sent.turnId)?.n).toBe(0);
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 90000);
