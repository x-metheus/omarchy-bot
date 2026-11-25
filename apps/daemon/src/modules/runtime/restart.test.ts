import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
async function boot(home: string, deadline: number, crashMode = false, extraEnv: Record<string, string> = {}): Promise<{ child: Child; port: number; events: string[]; stderr: () => string }> {
  const child = Bun.spawn(["bun", fixture], {
    env: { ...process.env, HOME: home, OMARCHY_BOT_HOME: home, OMARCHY_BOT_STATE: path.join(home, "state"), OMARCHY_BOT_PORT: "0", OMARCHY_BOT_WORKERS_DIR: path.join(root, "tests/integration/fake-workers"), OMARCHY_TEST_SLEEP_AT: String(deadline), OMARCHY_TEST_CRASH_MODE: crashMode ? "1" : "0", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
    ...(extraEnv.OMARCHY_TEST_PEER_MAIL_HOLD === "queued" ? { ipc() {} } : {}),
  });
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
  let stderr = "";
  void (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(chunk);
  })();
  try { return { child, port: await Promise.race([started, Bun.sleep(10000).then(() => { throw new Error(`child did not start: ${stderr}`); })]), events, stderr: () => stderr }; }
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
async function pairedPost(port: number, home: string) {
  const base = `http://127.0.0.1:${port}`;
  const token = await pairForToken(base, path.join(home, "state"));
  await waitFor(async () => {
    const response = await fetch(`${base}/api/agents`, { headers: { authorization: `Bearer ${token}` } });
    const agents = await response.json() as { id: string; status: string }[];
    return agents.some((agent) => agent.id === "pi" && agent.status === "ready") ? true : undefined;
  }, 20000);
  return async function post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(base + url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
}
async function send(port: number, home: string, text: string): Promise<{ turnId: string; threadId: string }> {
  const post = await pairedPost(port, home);
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

test("hard restart fails a recovered user Turn whose provider exceeds the execution budget", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const first = await boot(home, 0, true); child = first.child;
    const sent = await send(first.port, home, "timeout-recovery");
    await waitFor(() => first.events.includes("before-request") ? true : undefined);
    await stop(child); child = undefined;
    expect(first.child.signalCode).toBe("SIGKILL");
    expect(query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", sent.turnId)).toEqual({ status: "working" });
    const second = await boot(home, 0, false, { OMARCHY_BOT_TURN_TIMEOUT_MS: "1000" }); child = second.child;
    await waitFor(() => second.events.includes("recovered-provider-started") ? true : undefined, 4_000);
    const row = await waitFor(() => {
      const value = query<{ status: string; outcome_reason: string | null }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId);
      return value?.status === "failed" || value?.status === "cancelled" ? value : undefined;
    }, 4_000);
    expect(row).toEqual({ status: "failed", outcome_reason: "timed out after 1s" });
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 20000);

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

test.each(["placed", "done"] as const)("hard restart recovers a %s peer-mail input before Service bookkeeping", async (submissionState) => {
  const home = setup(); let child: Child | undefined;
  try {
    const first = await boot(home, 0, false, { OMARCHY_TEST_PEER_MAIL_HOLD: submissionState }); child = first.child;
    const post = await pairedPost(first.port, home);
    const source = await post<{ id: string }>("/api/bots", { name: "Restart sender", agentId: "pi" });
    const target = await post<{ id: string }>("/api/bots", { name: "Restart recipient", agentId: "pi" });
    const sent = await post<{ turnId: string }>(`/api/bots/${source.id}/messages`, { text: `send-peer-mail:${target.id}` });
    expect(await terminal(home, sent.turnId)).toMatchObject({ status: "completed" });

    type Delivery = { id: string; thread_id: string; target_turn_id: string; state: string };
    const claimed = await waitFor(() => query<Delivery>(home, "SELECT id, thread_id, target_turn_id, state FROM bot_mail_deliveries WHERE target_turn_id IS NOT NULL") ?? undefined);
    const { target_turn_id: turnId, thread_id: threadId } = claimed;
    expect(claimed.state).toBe("dispatching");
    const submitted = () => query<{ id: number; status: string; type: string }>(home, "SELECT id, status, json_extract(record, '$.type') AS type FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?", turnId);
    const admitted = await waitFor(() => {
      const row = submitted();
      return row?.status === submissionState ? row : undefined;
    }, 8_000).catch(() => { throw new Error(`Expected ${submissionState} input, found ${JSON.stringify(submitted())}; target ${JSON.stringify(query(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", turnId))}; stderr ${first.stderr()}`); });
    expect(admitted.type).toBe("input");
    expect(query(home, "SELECT submission_id FROM pi_turn_submissions WHERE turn_id = ?", turnId)).toBeNull();
    expect(query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", turnId)).toEqual({ status: "working" });
    await stop(child); child = undefined;
    expect(first.child.signalCode).toBe("SIGKILL");

    const second = await boot(home, 0); child = second.child;
    expect(await terminal(home, turnId)).toMatchObject({ status: "completed" });
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM bot_mail_deliveries")).toEqual({ n: 1 });
    expect(query<Delivery>(home, "SELECT id, thread_id, target_turn_id, state FROM bot_mail_deliveries")).toEqual({ ...claimed, state: "delivered" });
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM turns WHERE thread_id = ?", threadId)).toEqual({ n: 1 });
    expect(query<{ submission_id: number; kind: string }>(home, "SELECT submission_id, kind FROM pi_turn_submissions WHERE turn_id = ?", turnId)).toEqual({ submission_id: admitted.id, kind: "input" });

    const db = new Database(path.join(home, "db.sqlite"), { readonly: true });
    try {
      const entries = db.query<{ id: number; data: string; content: string }, [string]>(`
        SELECT e.id, json_extract(e.record, '$.data') AS data, json_extract(e.record, '$.model[0].content') AS content
        FROM pi_entries e JOIN pi_thread_conversations c ON c.conversation_id = e.conversation_id
        WHERE c.thread_id = ? AND json_extract(e.record, '$.kind') = 'write'
      `).all(threadId);
      expect(entries).toHaveLength(1);
      const author = `Message from Bot Restart sender (${source.id})`;
      expect(JSON.parse(entries[0]!.data)).toEqual({ author, text: "Check the restart.", deliveryId: claimed.id });
      expect(entries[0]!.content).toBe(`${author}: Check the restart.`);
      const submissions = db.query<{ id: number; request_id: string; type: string; status: string; entry_id: number }, [string]>(`
        SELECT s.id, json_extract(s.record, '$.requestId') AS request_id, s.status,
               json_extract(s.record, '$.type') AS type, json_extract(s.record, '$.entry') AS entry_id
        FROM pi_submissions s JOIN pi_thread_conversations c ON c.conversation_id = s.conversation_id
        WHERE c.thread_id = ? ORDER BY s.id
      `).all(threadId);
      expect(submissions).toEqual([
        { id: admitted.id, request_id: turnId, type: "input", status: "done", entry_id: entries[0]!.id },
      ]);
      expect(db.query(`
        SELECT e.id FROM pi_entries e JOIN pi_thread_conversations c ON c.conversation_id = e.conversation_id
        WHERE c.thread_id = ? AND json_extract(e.record, '$.kind') = 'pi.assistant'
      `).all(threadId)).toHaveLength(1);
      expect(db.query(`
        SELECT kind, text, block_state, json_extract(payload, '$.deliveryId') AS delivery_id
        FROM messages WHERE thread_id = ? ORDER BY seq
      `).all(threadId)).toEqual([
        { kind: "text", text: "Check the restart.", block_state: null, delivery_id: claimed.id },
        { kind: "response", text: "Peer mail survived restart.", block_state: "completed", delivery_id: null },
      ]);
    } finally { db.close(); }
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60_000);

test.each([
  ["answers", false],
  ["fails", true],
] as const)("hard restart recovers queued peer mail using its persisted model and a steer when the predecessor %s", async (_outcome, fails) => {
  const home = setup(); let child: Child | undefined;
  try {
    const first = await boot(home, 0, false, { OMARCHY_TEST_PEER_MAIL_HOLD: "queued" }); child = first.child;
    const post = await pairedPost(first.port, home);
    const source = await post<{ id: string }>("/api/bots", { name: "Sender", agentId: "pi" });
    const target = await post<{ id: string }>("/api/bots", { name: "Recipient", agentId: "pi" });
    const persistedModelId = "uncatalogued-peer-mail";
    const nextModel = "fake/fake-model";
    const setTargetModel = (model: string) => {
      const db = new Database(path.join(home, "db.sqlite"));
      try { db.query("UPDATE bots SET model = ? WHERE id = ?").run(model, target.id); }
      finally { db.close(); }
    };
    setTargetModel(`fake/${persistedModelId}`);
    const sent = await post<{ turnId: string }>(`/api/bots/${source.id}/messages`, { text: `send-peer-mail:${target.id}` });
    expect(await terminal(home, sent.turnId)).toMatchObject({ status: "completed" });
    const delivery = query<{ id: string; thread_id: string; state: string; target_turn_id: string | null }>(home, "SELECT id, thread_id, state, target_turn_id FROM bot_mail_deliveries")!;
    expect(delivery.state).toBe("queued");
    expect(delivery.target_turn_id).toBeNull();
    expect(first.events).not.toContain("before-peer-mail-input");
    child.send("resume-mailbox-dispatch");
    await waitFor(() => first.events.includes("before-peer-mail-input") ? true : undefined);
    const user = await post<{ turnId: string }>(`/api/threads/${delivery.thread_id}/messages`, { text: "Hold the target reply.", whenBusy: "followUp" });
    const queued = await waitFor(() => query<{ id: number; target_turn_id: string }>(home, `
      SELECT s.id, d.target_turn_id FROM bot_mail_deliveries d
      JOIN pi_submissions s ON json_extract(s.record, '$.requestId') = d.target_turn_id
      WHERE d.id = ? AND d.state = 'dispatching' AND s.status = 'queued' AND json_extract(s.record, '$.type') = 'input'
    `, delivery.id) ?? undefined);
    expect(query(home, "SELECT submission_id FROM pi_turn_submissions WHERE turn_id = ?", queued.target_turn_id)).toBeNull();
    expect(query<{ status: string }>(home, "SELECT status FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?", user.turnId)).toEqual({ status: "placed" });
    const steer = await post<{ turnId: string; action: string }>(`/api/threads/${delivery.thread_id}/messages`, { text: "A competing steer." });
    expect(steer).toMatchObject({ turnId: user.turnId, action: "steered" });
    setTargetModel(nextModel);
    await stop(child); child = undefined;

    const second = await boot(home, 0, false, fails ? { OMARCHY_TEST_PEER_MAIL_PREDECESSOR_FAILS: "1" } : {}); child = second.child;
    expect(query<{ model: string }>(home, "SELECT model FROM bots WHERE id = ?", target.id)).toEqual({ model: nextModel });
    const outcomes = await Promise.all([terminal(home, user.turnId), terminal(home, queued.target_turn_id)]);
    expect(outcomes).toEqual([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "completed" })]);
    expect(query<{ status: string }>(home, "SELECT status FROM pi_submissions WHERE json_extract(record, '$.requestId') = ?", user.turnId)).toEqual({ status: fails ? "unanswered" : "done" });
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM bot_mail_deliveries")).toEqual({ n: 1 });
    expect(query<{ state: string; target_turn_id: string }>(home, "SELECT state, target_turn_id FROM bot_mail_deliveries WHERE id = ?", delivery.id)).toEqual({ state: "delivered", target_turn_id: queued.target_turn_id });
    expect(query<{ submission_id: number }>(home, "SELECT submission_id FROM pi_turn_submissions WHERE turn_id = ?", queued.target_turn_id)).toEqual({ submission_id: queued.id });
    const db = new Database(path.join(home, "db.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT id FROM turns WHERE thread_id = ? ORDER BY rowid").all(delivery.thread_id)).toEqual([{ id: queued.target_turn_id }, { id: user.turnId }]);
      expect(db.query(`
        SELECT json_extract(e.record, '$.kind') AS kind, json_extract(e.record, '$.model[0].model') AS model
        FROM pi_entries e JOIN pi_thread_conversations c ON c.conversation_id = e.conversation_id
        WHERE c.thread_id = ? AND json_extract(e.record, '$.kind') IN ('write', 'pi.assistant') ORDER BY e.id
      `).all(delivery.thread_id)).toEqual([
        { kind: "pi.assistant", model: persistedModelId },
        { kind: "write", model: null },
        { kind: "pi.assistant", model: persistedModelId },
      ]);
      expect(db.query(`
        SELECT kind, text, turn_id, json_extract(payload, '$.deliveryId') AS delivery_id
        FROM messages WHERE thread_id = ? ORDER BY seq
      `).all(delivery.thread_id)).toEqual([
        { kind: "text", text: "Check the restart.", turn_id: null, delivery_id: delivery.id },
        { kind: "text", text: "Hold the target reply.", turn_id: null, delivery_id: null },
        { kind: "text", text: "A competing steer.", turn_id: null, delivery_id: null },
        { kind: "response", text: fails ? "Predecessor partial." : "User reply recovered.", turn_id: user.turnId, delivery_id: null },
        { kind: "response", text: "Peer mail survived restart.", turn_id: queued.target_turn_id, delivery_id: null },
      ]);
    } finally { db.close(); }
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60_000);

test("startup projects and settles two concurrent peer-mail Turns during SQLite write contention", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const first = await boot(home, 0, false, { OMARCHY_TEST_PEER_MAIL_HOLD: "placed" }); child = first.child;
    const post = await pairedPost(first.port, home);
    const source = await post<{ id: string }>("/api/bots", { name: "Sender", agentId: "pi" });
    const targets = await Promise.all(["First recipient", "Second recipient"].map((name) => post<{ id: string }>("/api/bots", { name, agentId: "pi" })));
    const deliveries: { id: string; thread_id: string; target_turn_id: string }[] = [];
    for (const target of targets) {
      const sent = await post<{ turnId: string }>(`/api/bots/${source.id}/messages`, { text: `send-peer-mail:${target.id}` });
      expect(await terminal(home, sent.turnId)).toMatchObject({ status: "completed" });
      deliveries.push(await waitFor(() => query(home, `
        SELECT d.id, d.thread_id, d.target_turn_id FROM bot_mail_deliveries d
        JOIN pi_submissions s ON json_extract(s.record, '$.requestId') = d.target_turn_id
        WHERE d.target_bot_id = ? AND d.state = 'dispatching' AND s.status = 'placed'
      `, target.id) ?? undefined));
    }
    await stop(child); child = undefined;
    const second = await boot(home, 0, false, { OMARCHY_TEST_RECOVERY_WRITE_COLLISION: "1" }); child = second.child;
    const outcomes = await Promise.all(deliveries.map((delivery) => terminal(home, delivery.target_turn_id)));
    expect(outcomes).toEqual(deliveries.map(() => expect.objectContaining({ status: "completed" })));
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM bot_mail_deliveries")).toEqual({ n: 2 });
    const db = new Database(path.join(home, "db.sqlite"), { readonly: true });
    try {
      for (const delivery of deliveries) {
        expect(db.query("SELECT state, target_turn_id FROM bot_mail_deliveries WHERE id = ?").get(delivery.id)).toEqual({ state: "delivered", target_turn_id: delivery.target_turn_id });
        expect(db.query("SELECT id FROM turns WHERE thread_id = ?").all(delivery.thread_id)).toEqual([{ id: delivery.target_turn_id }]);
        expect(db.query(`
          SELECT json_extract(e.record, '$.kind') AS kind
          FROM pi_entries e JOIN pi_thread_conversations c ON c.conversation_id = e.conversation_id
          WHERE c.thread_id = ? AND json_extract(e.record, '$.kind') IN ('write', 'pi.assistant') ORDER BY e.id
        `).all(delivery.thread_id)).toEqual([{ kind: "write" }, { kind: "pi.assistant" }]);
        expect(db.query(`
          SELECT kind, text, block_state, json_extract(payload, '$.deliveryId') AS delivery_id
          FROM messages WHERE thread_id = ? ORDER BY seq
        `).all(delivery.thread_id)).toEqual([
          { kind: "text", text: "Check the restart.", block_state: null, delivery_id: delivery.id },
          { kind: "response", text: "Peer mail survived restart.", block_state: "completed", delivery_id: null },
        ]);
      }
    } finally { db.close(); }
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); }
}, 60_000);

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

test("shutdown on SIGTERM fails the running reply with the daemon restart reason", async () => {
  const home = setup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 12000;
    const first = await boot(home, deadline); child = first.child;
    const sent = await send(first.port, home, "schedule");
    await waitFor(() => query<{ text: string }>(home, "SELECT text FROM messages WHERE turn_id = ? AND kind = 'response' AND length(text) > 0", sent.turnId) ?? undefined);
    await stop(child); child = undefined;
    const second = await boot(home, deadline); child = second.child;
    const streamingResponse = await waitFor(() => query<{ block_id: string }>(home, "SELECT block_id FROM messages WHERE turn_id = ? AND kind = 'response' AND block_state = 'streaming' AND length(text) > 0", sent.turnId) ?? undefined);
    expect(streamingResponse).toBeDefined();
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(10000).then(() => { throw new Error("shutdown did not finish"); })]);
    child = undefined;
    expect(query<{ status: string; outcome_reason: string }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", sent.turnId)).toMatchObject({ status: "failed", outcome_reason: "daemon restart" });
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM messages WHERE turn_id = ? AND kind = 'response' AND block_state = 'streaming'", sent.turnId)?.n).toBe(0);
    expect(query(home, "SELECT 1 FROM messages WHERE block_id = ?", streamingResponse.block_id)).toBeNull();
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

async function answerApproval(port: number, home: string, id: string, answer: "allow_once" | "allow_folder" | "deny"): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const token = await pairForToken(base, path.join(home, "state"));
  const response = await fetch(`${base}/api/approvals/${id}/answer`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-id": crypto.randomUUID() }, body: JSON.stringify({ answer }) });
  if (!response.ok) throw new Error(`answer approval: ${response.status} ${await response.text()}`);
}
function approvalSetup() {
  // The default fixture puts the Shared Workspace under the Service data directory, which file tools always refuse.
  const outside = mkdtempSync(path.join(os.tmpdir(), "approval-outside-"));
  const userHome = path.join(outside, "home");
  mkdirSync(userHome);
  const target = path.join(outside, "elsewhere", "approved.txt");
  mkdirSync(path.dirname(target));
  return { outside, target, env: { HOME: userHome, OMARCHY_TEST_APPROVAL_PATH: target } };
}
async function pendingApproval(home: string, turnId: string) {
  return waitFor(() => query<{ id: string; task_id: number; status: string }>(home, "SELECT id, task_id, status FROM approvals WHERE turn_id = ?", turnId) ?? undefined);
}
async function terminal(home: string, turnId: string) {
  return waitFor(() => { const value = query<{ status: string; outcome_reason: string | null }>(home, "SELECT status, outcome_reason FROM turns WHERE id = ?", turnId); return value && ["completed", "failed", "cancelled"].includes(value.status) ? value : undefined; }, 30000);
}

// Prototype check 6: a write outside the allowed folders pauses, survives a crash, and writes once after approval.
test("a pending approval survives a hard kill without asking twice and writes once after approval", async () => {
  const home = setup(); const { outside, target, env } = approvalSetup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 60000;
    const first = await boot(home, deadline, false, env); child = first.child;
    const sent = await send(first.port, home, "approval-write");
    const pending = await pendingApproval(home, sent.turnId);
    expect(pending.status).toBe("pending");
    expect(existsSync(target)).toBe(false);
    await stop(child); child = undefined;
    const second = await boot(home, deadline, false, env); child = second.child;
    await answerApproval(second.port, home, pending.id, "allow_once");
    expect(await terminal(home, sent.turnId)).toMatchObject({ status: "completed" });
    expect(readFileSync(target, "utf8")).toBe("approved content\n");
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM approvals WHERE turn_id = ?", sent.turnId)?.n).toBe(1);
    expect(query<{ n: number }>(home, "SELECT count(*) AS n FROM events WHERE type = 'approval.requested'")?.n).toBe(1);
    expect(query<{ status: string }>(home, "SELECT status FROM approvals WHERE id = ?", pending.id)?.status).toBe("allowed_once");
    // A later start has nothing to replay and leaves the file as written.
    const written = statSync(target);
    await stop(child); child = undefined;
    const third = await boot(home, deadline, false, env); child = third.child;
    await Bun.sleep(500);
    expect(statSync(target)).toMatchObject({ ino: written.ino, size: written.size, mtimeMs: written.mtimeMs });
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
}, 60000);

test("a clean shutdown leaves a reply waiting for approval without using a restart", async () => {
  const home = setup(); const { outside, target, env } = approvalSetup(); let child: Child | undefined;
  try {
    const deadline = Date.now() + 60000;
    const first = await boot(home, deadline, false, env); child = first.child;
    const sent = await send(first.port, home, "approval-write");
    const pending = await pendingApproval(home, sent.turnId);
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(10000).then(() => { throw new Error("shutdown did not finish"); })]);
    child = undefined;
    expect(query<{ status: string }>(home, "SELECT status FROM turns WHERE id = ?", sent.turnId)?.status).toBe("working");
    expect(query<{ status: string }>(home, "SELECT status FROM approvals WHERE id = ?", pending.id)?.status).toBe("pending");
    const restarts = () => query<{ restarts: number | null }>(home, "SELECT json_extract(record, '$.restarts') AS restarts FROM pi_tasks WHERE id = ?", String(pending.task_id))?.restarts ?? 0;
    expect(restarts()).toBe(0);
    const second = await boot(home, deadline, false, env); child = second.child;
    await answerApproval(second.port, home, pending.id, "allow_once");
    expect(await terminal(home, sent.turnId)).toMatchObject({ status: "completed" });
    expect(readFileSync(target, "utf8")).toBe("approved content\n");
    expect(restarts()).toBe(0);
  } finally { if (child) await stop(child); rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
}, 60000);
