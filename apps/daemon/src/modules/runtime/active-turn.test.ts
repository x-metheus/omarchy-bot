import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, LiveState, SubmissionId, SubmissionRecord, TaskId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { resolveActiveTurnIdentity } from "./active-turn.ts";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT, bot_id TEXT, status TEXT, started_at TEXT);
    CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER);
    INSERT INTO turns VALUES ('turn-current', 'thread', 'bot', 'working', '2026-01-01T00:00:00Z');
    INSERT INTO turns VALUES ('turn-follow-up', 'thread', 'bot', 'working', '2026-01-01T00:00:01Z');
    INSERT INTO pi_thread_conversations VALUES ('thread', 'bot', 1);
  `);
  const conversationId = 1 as ConversationId;
  const taskId = 10 as TaskId;
  const runId = 9 as TaskId;
  const primary = 1 as SubmissionId;
  const followUp = 2 as SubmissionId;
  const live: LiveState = { run: { taskId: runId, inputs: [primary], turns: 1 } };
  const submissions = new Map<SubmissionId, SubmissionRecord>([
    [primary, { id: primary, conversationId, requestId: "turn-current", type: "input", status: "placed", entry: 1 as EntryId }],
    [followUp, { id: followUp, conversationId, requestId: "turn-follow-up", type: "input", status: "queued" }],
  ]);
  const turnInputs = new Map<string, { inputs: Set<number> }>();
  const tx = {
    doc: async () => live,
    submission: async (id: SubmissionId) => submissions.get(id),
  } as unknown as Tx;
  let owner = runId;
  const api: Pick<ToolExecutionApi, "taskId" | "conversationId" | "getTask" | "commit"> = {
    taskId,
    conversationId,
    async getTask(id) {
      return { id, owner, conversationId, kind: "pi.tool", version: 1, input: null, background: false, abortRequested: false, state: { status: "running", checkpoint: null } };
    },
    async commit(change) { return await change(tx); },
  };
  return {
    db,
    resolve: () => resolveActiveTurnIdentity(api, BACKGROUND_CONTEXT, db, turnInputs),
    setOwner: (id: TaskId) => { owner = id; },
    setPrimary: (id: SubmissionId) => { live.run!.inputs = [id]; },
    setPlacedSteer: () => {
      submissions.set(followUp, { id: followUp, conversationId, requestId: "turn-current:steer:message-id", type: "input", status: "placed", entry: 2 as EntryId });
    },
    turnInputs,
    followUp,
  };
}

test("active Turn identity comes from the owning run with a later working follow-up queued", async () => {
  const input = fixture();
  try {
    await expect(input.resolve()).resolves.toEqual({ threadId: "thread", botId: "bot", turnId: "turn-current" });
  } finally { input.db.close(); }
});

test("active Turn identity falls back to the steer request ID before the input is associated", async () => {
  const input = fixture();
  try {
    input.setPlacedSteer();
    input.setPrimary(input.followUp);
    await expect(input.resolve()).resolves.toEqual({ threadId: "thread", botId: "bot", turnId: "turn-current" });
  } finally { input.db.close(); }
});

test("active Turn identity prefers the runtime's input association to the request ID", async () => {
  const input = fixture();
  try {
    input.setPlacedSteer();
    input.setPrimary(input.followUp);
    input.turnInputs.set("turn-follow-up", { inputs: new Set([input.followUp]) });
    await expect(input.resolve()).resolves.toEqual({ threadId: "thread", botId: "bot", turnId: "turn-follow-up" });
  } finally { input.db.close(); }
});

test("active Turn identity rejects a tool owned by a different run", async () => {
  const input = fixture();
  try {
    input.setOwner(8 as TaskId);
    await expect(input.resolve()).rejects.toThrow("tool task is not owned by the live run");
  } finally { input.db.close(); }
});

test("active Turn identity rejects a primary submission that is still queued", async () => {
  const input = fixture();
  try {
    input.setPrimary(input.followUp);
    await expect(input.resolve()).rejects.toThrow("live run has no placed Turn input");
  } finally { input.db.close(); }
});

test("active Turn identity rejects a Turn that is no longer working", async () => {
  const input = fixture();
  try {
    input.db.run("UPDATE turns SET status = 'completed' WHERE id = 'turn-current'");
    await expect(input.resolve()).rejects.toThrow("Service Turn is not working");
  } finally { input.db.close(); }
});

test.each([
  ["conversation", "conversation_id", 2, "conversation has no unique Thread and Bot binding"],
  ["thread", "thread_id", "other-thread", "Service Turn does not match the conversation's Thread and Bot"],
  ["bot", "bot_id", "other-bot", "Service Turn does not match the conversation's Thread and Bot"],
] as const)("active Turn identity rejects a %s mismatch", async (_name, column, value, message) => {
  const input = fixture();
  try {
    input.db.run(`UPDATE pi_thread_conversations SET ${column} = ?`, [value]);
    await expect(input.resolve()).rejects.toThrow(message);
  } finally { input.db.close(); }
});
