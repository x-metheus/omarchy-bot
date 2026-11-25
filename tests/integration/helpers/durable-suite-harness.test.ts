import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { abortDurableSuiteGeneration, durableSuiteProviderCallCount } from "../../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { apiStatus, makeBot, messages, sendToBot, sendToThread, startDaemon, waitThreadIdle } from "./harness.ts";

test("durable steer boundary stays open until a steer is accepted", async () => {
  const h = await startDaemon();
  try {
    expect(h.svc.credentials.getForRuntime("fake")?.models?.map(({ id }) => id)).toEqual(["fake-model"]);
    const callsBeforeTurn = durableSuiteProviderCallCount();
    const bot = await makeBot(h);
    const sent = await sendToBot(h, bot, "steer-echo");
    await Bun.sleep(1500);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
    expect(durableSuiteProviderCallCount()).toBeGreaterThan(callsBeforeTurn);
    expect((await sendToThread(h, sent.threadId, "change direction")).action).toBe("steered");
    await waitThreadIdle(h, sent.threadId);
    expect((await messages(h, sent.threadId)).some((message) => message.kind === "response" && message.text === "steered: change direction")).toBeTrue();
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}, 20000);

test("durable hang rejects steering and can be aborted", async () => {
  const h = await startDaemon();
  try {
    const sent = await sendToBot(h, await makeBot(h), "hang");
    await Bun.sleep(500);
    const response = await apiStatus(h, "POST", `/api/threads/${sent.threadId}/messages`, { text: "redirect" });
    expect(response.status).toBe(409);
    await h.svc.turns.abortTurn(sent.turnId, "test cleanup");
    await waitThreadIdle(h, sent.threadId);
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}, 20000);

test("ordered transcript waits for steering and resumes with the text and thinking sequence", async () => {
  const h = await startDaemon();
  try {
    const sent = await sendToBot(h, await makeBot(h), "ordered-transcript");
    const deadline = Date.now() + 15000;
    while (!(await messages(h, sent.threadId)).some((message) => message.text === "**Inspect** every ordered boundary.")) {
      if (Date.now() > deadline) throw new Error("ordered thinking did not arrive");
      await Bun.sleep(100);
    }
    await Bun.sleep(1200);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("working");
    expect((await sendToThread(h, sent.threadId, "continue")).action).toBe("steered");
    await waitThreadIdle(h, sent.threadId);
    const parts = (await messages(h, sent.threadId)).filter((message) => message.author.kind === "bot" && (message.kind === "thinking" || message.kind === "response"));
    expect(parts.map((message) => message.text)).toEqual([
      expect.stringContaining("## Release notes"), "**Inspect** every ordered boundary.", "Steering received: continue",
      "Adjacent response remains in the same visual reply.", "Check the final interleaving.",
      "Final response after the second tool.", "Response after an unrendered Native Event boundary.",
    ]);
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}, 30000);

test("durable partial failures settle the turn and remove unfinished output", async () => {
  const h = await startDaemon();
  try {
    const bot = await makeBot(h);
    for (const script of ["partial-fail", "partial-crash", "thinking-fail", "thinking-crash"]) {
      const sent = await sendToBot(h, bot, script);
      await waitThreadIdle(h, sent.threadId);
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("failed");
      const rows = h.svc.db.query<{ text: string; block_state: string | null }, [string]>("SELECT text, block_state FROM messages WHERE turn_id = ? AND kind IN ('response', 'thinking')").all(sent.turnId);
      expect(rows.filter((row) => row.block_state === "streaming" || "discard me inputs.".startsWith(row.text) || row.text.startsWith("discard me"))).toEqual([]);
    }
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}, 20000);


test("durable daemon scripts settle with worker-compatible output", async () => {
  const h = await startDaemon();
  try {
    const bot = await makeBot(h);
    for (const [script, status, texts] of [
      ["say:  hello  ", "completed", ["hello"]],
      ["parity-stream", "completed", ["T", "R"]],
      ["fail", "failed", []],
      ["timeout-failure", "failed", []],
      ["ordinary prompt", "completed", []],
    ] as const) {
      const before = durableSuiteProviderCallCount();
      const sent = await sendToBot(h, bot, script);
      await waitThreadIdle(h, sent.threadId, 5000);
      expect(durableSuiteProviderCallCount() - before).toBe(1);
      expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe(status);
      expect((await messages(h, sent.threadId)).filter((message) => message.author.kind === "bot" && (message.kind === "response" || message.kind === "thinking")).map((message) => message.text)).toEqual([...texts]);
    }
    for (let i = 0; i < 2; i++) {
      const first = await sendToBot(h, bot, "fail-once");
      await waitThreadIdle(h, first.threadId);
      expect(h.svc.threads.turnRow(first.turnId)?.status).toBe("failed");
      const second = await sendToThread(h, first.threadId, "fail-once");
      await waitThreadIdle(h, first.threadId);
      expect(h.svc.threads.turnRow(second.turnId)?.status).toBe("completed");
      expect((await messages(h, first.threadId)).some((message) => message.text === "recovered")).toBeTrue();
    }
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}, 30000);


test("aborting only the generation signal settles a hanging turn", async () => {
  const h = await startDaemon();
  try {
    const sent = await sendToBot(h, await makeBot(h), "hang");
    const deadline = Date.now() + 5000;
    while (!(await messages(h, sent.threadId)).some((message) => message.kind === "response" && message.text)) {
      if (Date.now() > deadline) throw new Error("generation did not emit a delta");
      await Bun.sleep(50);
    }
    await abortDurableSuiteGeneration();
    await waitThreadIdle(h, sent.threadId, 5000);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).not.toBe("working");
  } finally {
    await h.stop();
    rmSync(h.home, { recursive: true, force: true });
  }
}, 15000);
