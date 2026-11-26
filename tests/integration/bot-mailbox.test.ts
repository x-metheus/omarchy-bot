import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  durableSuiteAgent,
  durableSuiteEntries,
  durableSuiteToolResultEntries,
  durableSuiteToolResults,
} from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import type { AttachmentDto, BotDto, BotViewDto, DeleteBotResultDto, MessageDto, ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  apiStatus,
  authedFetch,
  makeBot,
  messages,
  sendToBot,
  sendToThread,
  startDaemon,
  waitForMailboxStep,
  waitForMailboxWriter,
  waitThreadIdle,
  type Harness,
  type HarnessOptions,
} from "./helpers/harness.ts";

interface DeliveryStateRow {
  state: "queued" | "dispatching" | "delivered" | "failed";
  target_turn_id: string | null;
  failure_reason: string | null;
}

const forgedIdentityError = 'Validation failed for tool "send_bot_message":\n  - botId: unknown field\n  - turnId: unknown field';

function startMailboxDaemon(
  home = mkdtempSync(path.join(tmpdir(), "mailbox-")),
  options?: Pick<HarnessOptions, "onDurableMailReplay" | "pauseMailboxDispatchOnStartup" | "separateWorkspace">,
): Promise<Harness> {
  return startDaemon(home, { ...options, stateDir: `${home}-state` });
}

function deliveryRow(h: Harness, deliveryId: string): DeliveryStateRow {
  const row = h.svc.db.query(
    `SELECT state, target_turn_id, failure_reason FROM bot_mail_deliveries WHERE id = ?`,
  ).get(deliveryId) as DeliveryStateRow | null;
  if (row === null) throw new Error(`delivery ${deliveryId} was not persisted`);
  return row;
}

async function waitForDeliveryState(
  h: Harness,
  deliveryId: string,
  state: "queued" | "dispatching" | "delivered" | "failed",
  timeoutMs = 5_000,
): Promise<DeliveryStateRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = deliveryRow(h, deliveryId);
    if (row.state === state) return row;
    if (Date.now() > deadline) {
      throw new Error(`delivery ${deliveryId} remained ${row.state} instead of becoming ${state}`);
    }
    // Wait for the mailbox dispatcher to persist its next state.
    await Bun.sleep(25);
  }
}

function acknowledgementDeliveryId(transcript: MessageDto[]): string {
  const acknowledgement = transcript.find(
    (message) => message.kind === "response" && message.text?.startsWith("Bot message acknowledgements:"),
  )?.text;
  const deliveryId = /^Bot message acknowledgements: (delivery_[a-f0-9]{32}) queued\.$/.exec(
    acknowledgement ?? "",
  )?.[1];
  if (deliveryId === undefined) throw new Error("source acknowledgement omitted the delivery ID");
  return deliveryId;
}

async function durableAcknowledgement(h: Harness, threadId: string): Promise<string> {
  await waitThreadIdle(h, threadId);
  const deliveryId = acknowledgementDeliveryId(await messages(h, threadId));
  await expectDurableMailResult(h, threadId, { deliveryId });
  return deliveryId;
}

async function expectDurableMailResult(h: Harness, threadId: string, outcome: { deliveryId: string } | { error: string }) {
  const entries = await durableSuiteToolResultEntries(h.svc.db, threadId);
  expect((await messages(h, threadId)).filter(({ kind }) => kind === "tool")).toMatchObject([{
    author: { kind: "bot" }, toolCall: { name: "send_bot_message", status: "error" in outcome ? "error" : "completed" },
  }]);
  const result = "error" in outcome
    ? { isError: true }
    : { isError: false, details: { deliveryId: outcome.deliveryId, queued: true } };
  expect(entries).toMatchObject([{ model: [{ role: "toolResult", toolName: "send_bot_message", ...result }] }]);
  if ("error" in outcome) {
    const diagnostics = entries[0]?.data?.diagnostics.map(({ code, message }) =>
      code === "invalid_arguments" ? message.split("\n\nReceived arguments:\n", 1)[0] : message,
    );
    expect(diagnostics).toEqual([outcome.error]);
  }
}

function targetTurns(h: Harness, threadId: string) {
  return h.svc.db.query<{ id: string }, [string]>(`SELECT id FROM turns WHERE thread_id = ?`).all(threadId);
}

function targetConversations(h: Harness, threadId: string) {
  return h.svc.db.query<{ conversation_id: number; bot_id: string }, [string]>(
    `SELECT conversation_id, bot_id FROM pi_thread_conversations WHERE thread_id = ?`,
  ).all(threadId);
}

async function expectDurableDispatch(
  h: Harness,
  threadId: string,
  turnId: string | null,
  deliveryId: string,
  status: "done" | "unanswered" = "done",
) {
  if (turnId === null) throw new Error(`Delivery ${deliveryId} did not record a target Turn`);
  expect(targetTurns(h, threadId)).toEqual([{ id: turnId }]);
  expect(h.svc.threads.turnRow(turnId)?.status).toBe(status === "done" ? "completed" : "failed");
  expect(targetConversations(h, threadId)).toHaveLength(1);
  expect(h.svc.db.query(`
    SELECT id, thread_id, target_turn_id, state, failure_reason FROM bot_mail_deliveries
    WHERE target_bot_id = (SELECT bot_id FROM threads WHERE id = ?)
  `).all(threadId)).toEqual([{
    id: deliveryId, thread_id: threadId, target_turn_id: turnId, state: "delivered", failure_reason: null,
  }]);
  const entries = await durableSuiteEntries(h.svc.db, threadId);
  const writes = entries.filter((entry) => entry.kind === "write");
  expect(writes).toEqual([expect.objectContaining({ data: expect.objectContaining({ deliveryId }) })]);
  expect(h.svc.db.query(`
    SELECT json_extract(s.record, '$.type') AS type, json_extract(s.record, '$.requestId') AS request_id,
           json_extract(s.record, '$.entry') AS entry_id, s.status, ts.turn_id
    FROM pi_submissions s JOIN pi_thread_conversations c ON s.conversation_id = c.conversation_id
    LEFT JOIN pi_turn_submissions ts ON ts.submission_id = s.id AND ts.kind = 'input'
    WHERE c.thread_id = ?
  `).all(threadId)).toEqual([{ type: "input", request_id: turnId, entry_id: writes[0]!.id, status, turn_id: turnId }]);
  return writes[0]!;
}

function expectNoDurableDispatch(h: Harness, threadId: string, existingTurnId?: string) {
  expect(targetTurns(h, threadId)).toEqual(existingTurnId ? [{ id: existingTurnId }] : []);
  expect(targetConversations(h, threadId)).toEqual([]);
}

async function enqueueWhileDispatchPaused(
  h: Harness,
  sourceBotId: string,
  targetBotId: string,
  body: string,
): Promise<{ deliveryId: string; threadId: string }> {
  h.mailbox.pauseDispatch();
  const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:${body}`);
  await h.svc.turns.waitForTerminal(source.turnId);
  const deliveryId = acknowledgementDeliveryId(await messages(h, source.threadId));
  expect(deliveryRow(h, deliveryId)).toEqual({
    state: "queued",
    target_turn_id: null,
    failure_reason: null,
  });
  const threads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
  expect(threads).toHaveLength(1);
  const threadId = threads[0]!.id;
  expect((await messages(h, threadId))[0]?.peerMail?.deliveryId).toBe(deliveryId);
  await expectDurableMailResult(h, source.threadId, { deliveryId });
  expectNoDurableDispatch(h, threadId);
  return { deliveryId, threadId };
}

/** Hold the idle writer and observe the next mailbox claim entering its queue. */
function holdMailboxClaim(h: Harness) {
  const runtime = h.svc.turns["runtime"];
  const writeService = runtime.writeService;
  const releaseWriter = Promise.withResolvers<void>();
  const submitted = Promise.withResolvers<{ finished: Promise<unknown> }>();
  const held = writeService(() => releaseWriter.promise);
  runtime.writeService = (write) => {
    const finished = writeService(write);
    runtime.writeService = writeService;
    submitted.resolve({ finished });
    return finished;
  };
  return {
    waitForSubmission: () => waitForMailboxStep(submitted.promise, "a mailbox claim to enter the writer queue"),
    async release() {
      runtime.writeService = writeService;
      releaseWriter.resolve();
      await held;
    },
  };
}

describe("durable Bot mailbox", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  test("enqueue dispatches Bot mail to a target Turn", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Agentless source");
    const targetBotId = await makeBot(h, "Agentless target");

    const body = "deliver without an Agent";
    const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:${body}`);
    const deliveryId = await durableAcknowledgement(h, source.threadId);
    const delivered = await waitForDeliveryState(h, deliveryId, "delivered");
    const threads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(threads).toHaveLength(1);
    await waitThreadIdle(h, threads[0]!.id);
    const notice = await expectDurableDispatch(h, threads[0]!.id, delivered.target_turn_id, deliveryId);
    const author = `Message from Bot Agentless source (${sourceBotId})`;
    expect(notice.data).toEqual({ author, text: body, deliveryId });
    expect(notice.model).toMatchObject([{ role: "user", content: `${author}: ${body}` }]);
  });

  // Checking replay persistence requires two real daemon boots against the same on-disk state.
  test("enqueue wakes an idle dispatcher and a replayed Bot mail tool call creates one visible target exchange", async () => {
    const replays: Array<{ first: unknown; replayed: unknown }> = [];
    h = await startMailboxDaemon(undefined, {
      onDurableMailReplay: (first, replayed) => { replays.push({ first, replayed }); },
    });
    const sourceBotId = await makeBot(h, "Release coordinator");
    const targetBotId = await makeBot(h, "Verification partner");
    const targetPrivateFolder = path.join(h.svc.cfg.sharedWorkspaceDir, "bots", targetBotId);
    expect(existsSync(targetPrivateFolder)).toBeFalse();
    const body = "Review the release checklist before handoff.";
    expect(h.svc.db.query(`SELECT id FROM bot_mail_deliveries`).all()).toEqual([]);

    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:${body}:retry`,
    );
    await waitThreadIdle(h, source.threadId);

    const sourceTranscript = await messages(h, source.threadId);
    const acknowledgements = sourceTranscript.filter(
      (message) => message.kind === "response" && message.text?.startsWith("Bot message acknowledgements:"),
    ).map((message) => message.text);
    const acknowledgement = acknowledgements[0];
    expect(acknowledgement).toMatch(
      /^Bot message acknowledgements: (delivery_[a-f0-9]{32}) queued\.$/,
    );
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({ count: 1 });
    const deliveryId = /^Bot message acknowledgements: (delivery_[a-f0-9]{32})/.exec(acknowledgement ?? "")?.[1];
    if (deliveryId === undefined) throw new Error("source acknowledgement omitted the delivery ID");
    const delivered = await waitForDeliveryState(h, deliveryId, "delivered");
    await expectDurableMailResult(h, source.threadId, { deliveryId });
    expect(acknowledgements).toEqual([`Bot message acknowledgements: ${deliveryId} queued.`]);
    expect(replays).toHaveLength(1);
    expect(replays[0]?.first).toMatchObject({ details: { deliveryId, queued: true } });
    expect(replays[0]?.replayed).toEqual(replays[0]?.first);
    expect(h.svc.db.query(`
      SELECT d.source_turn_id, d.source_tool_call_id, json_extract(t.record, '$.state.outcome.status') AS status
      FROM pi_tasks t JOIN pi_thread_conversations c ON c.conversation_id = t.conversation_id
      LEFT JOIN bot_mail_deliveries d ON d.source_tool_call_id = 'pi-task:' || t.id AND d.id = ?
      WHERE c.thread_id = ? AND json_extract(t.record, '$.kind') = 'pi.tool'
    `).all(deliveryId, source.threadId)).toEqual([{
      source_turn_id: source.turnId,
      source_tool_call_id: expect.stringMatching(/^pi-task:\d+$/),
      status: "completed",
    }]);

    let targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads).toHaveLength(1);
    expect(targetThreads[0]).toMatchObject({ botId: targetBotId, title: "From Release coordinator" });
    await waitThreadIdle(h, targetThreads[0]!.id);
    targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads[0]!.activeTurn).toBeUndefined();
    expect(targetThreads[0]!.latestTurn).toMatchObject({ botId: targetBotId, status: "completed" });
    expect(existsSync(targetPrivateFolder)).toBeTrue();

    const targetMessages = await api<MessageDto[]>(
      h,
      "GET",
      `/api/threads/${targetThreads[0]!.id}/messages`,
    );
    await expectDurableDispatch(h, targetThreads[0]!.id, delivered.target_turn_id, deliveryId);
    expect(targetMessages).toEqual([
      expect.objectContaining({
        threadId: targetThreads[0]!.id,
        seq: 1,
        author: { kind: "system" },
        kind: "text",
        text: body,
        peerMail: {
          deliveryId,
          sourceBotId,
          sourceName: "Release coordinator",
        },
      }),
    ]);

    await api(h, "PATCH", `/api/bots/${sourceBotId}`, { name: "Renamed coordinator" });
    const attributedMessages = await api<MessageDto[]>(
      h,
      "GET",
      `/api/threads/${targetThreads[0]!.id}/messages`,
    );
    expect(attributedMessages[0]?.peerMail).toEqual({
      deliveryId,
      sourceBotId,
      sourceName: "Release coordinator",
    });

    const sourceDeletion = await api<{ status: string }>(
      h,
      "DELETE",
      `/api/bots/${sourceBotId}`,
      {},
    );
    expect(sourceDeletion.status).toBe("deleted");
    const deletedSourceMessages = await api<MessageDto[]>(
      h,
      "GET",
      `/api/threads/${targetThreads[0]!.id}/messages`,
    );
    expect(deletedSourceMessages[0]?.peerMail).toEqual({
      deliveryId,
      sourceName: "Release coordinator",
    });

    const target = await api<BotViewDto>(h, "GET", `/api/bots/${targetBotId}`);
    expect(target).toMatchObject({
      unreadCount: 1,
      unreadThreadId: targetThreads[0]!.id,
      previewText: `From Release coordinator: ${body}`,
    });

    const home = h.home;
    await h.disconnectForRestart();
    h = await startMailboxDaemon(home);

    const durableThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    const durableMessages = await api<MessageDto[]>(
      h,
      "GET",
      `/api/threads/${targetThreads[0]!.id}/messages`,
    );
    const durableTarget = await api<BotViewDto>(h, "GET", `/api/bots/${targetBotId}`);
    expect(durableThreads).toHaveLength(1);
    expect(durableMessages).toHaveLength(1);
    expect(durableMessages[0]?.peerMail?.deliveryId).toBe(deliveryId);
    expect(durableTarget.unreadCount).toBe(1);
    expect(deliveryRow(h, deliveryId)).toEqual(delivered);
    await expectDurableDispatch(h, targetThreads[0]!.id, delivered.target_turn_id, deliveryId);
  }, { timeout: 8_000 });

  test("rejects forged Bot or Turn identity in a mail tool call", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Bound source");
    const targetBotId = await makeBot(h, "Unmodified target");

    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:Attempt impersonation.:forge-source`,
    );
    await waitThreadIdle(h, source.threadId);

    await expectDurableMailResult(h, source.threadId, { error: forgedIdentityError });
    expect(h.svc.db.query(`SELECT id FROM bot_mail_deliveries`).all()).toEqual([]);
    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${targetBotId}`)).toMatchObject({
      unreadCount: 0,
    });
    const accepted = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:Use the active Turn.`);
    const deliveryId = await durableAcknowledgement(h, accepted.threadId);
    expect(h.svc.db.query(`
      SELECT id, source_bot_id, source_turn_id, target_bot_id FROM bot_mail_deliveries
    `).all()).toEqual([{
      id: deliveryId, source_bot_id: sourceBotId, source_turn_id: accepted.turnId, target_bot_id: targetBotId,
    }]);
  });

  test("uses the active Turn for mail authorization", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Capability-bound source");
    const targetBotId = await makeBot(h, "Capability-bound target");

    const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:durable authority`);
    const deliveryId = await durableAcknowledgement(h, source.threadId);
    const delivered = await waitForDeliveryState(h, deliveryId, "delivered");
    const threads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(threads).toHaveLength(1);
    await waitThreadIdle(h, threads[0]!.id);
    await expectDurableDispatch(h, threads[0]!.id, delivered.target_turn_id, deliveryId);

    const forged = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:unauthorized:forge-source`);
    await waitThreadIdle(h, forged.threadId);
    await expectDurableMailResult(h, forged.threadId, { error: forgedIdentityError });
    expect(h.svc.db.query(`SELECT id FROM bot_mail_deliveries`).all()).toEqual([{ id: deliveryId }]);
  });

  test("rejects self, missing, raw-path, and oversized addressing without delivery artifacts", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Validation source");
    const targetBotId = await makeBot(h, "Untouched validation target");
    const cases = [
      {
        command: `send_bot_message:${sourceBotId}:self work`,
        error: "a Bot cannot send a message to itself",
      },
      {
        command: `send_bot_message:bot_${"0".repeat(32)}:missing work`,
        error: "target Bot does not exist",
      },
      {
        command: "send_bot_message:../../private/key:raw path",
        error: "target Bot ID is invalid",
      },
      {
        command: `send_bot_message:${targetBotId}:${"x".repeat(32_001)}`,
        error: 'Validation failed for tool "send_bot_message":\n  - text: expected at most 32000 characters',
      },
    ];

    for (const testCase of cases) {
      const source = await sendToBot(h, sourceBotId, testCase.command);
      await waitThreadIdle(h, source.threadId);
      await expectDurableMailResult(h, source.threadId, {
        error: testCase.error,
      });
    }

    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
      count: 0,
    });
  }, 20_000);

  test("dispatches one accepted delivery through a fresh private target conversation without disturbing unrelated target work", async () => {
    h = await startMailboxDaemon(undefined, { separateWorkspace: true });
    const sourceBotId = await makeBot(h, "Source coordinator", "SOURCE-ONLY-INSTRUCTIONS");
    const targetInstructions = "TARGET-CURRENT-INSTRUCTIONS";
    const targetBotId = await makeBot(h, "Target reviewer", targetInstructions);
    const sourceBot = await api<BotDto>(h, "GET", `/api/bots/${sourceBotId}`);
    const targetBot = await api<BotDto>(h, "GET", `/api/bots/${targetBotId}`);
    const sourceSecret = "SOURCE-THREAD-SECRET";
    expect(h.svc.db.query("SELECT agent_id FROM bots WHERE id IN (?, ?)").all(sourceBot.id, targetBot.id)).toEqual([
      { agent_id: "pi" }, { agent_id: "pi" },
    ]);
    expect(targetBot.id).not.toBe(sourceBot.id);

    const sourceConversation = await sendToBot(h, sourceBotId, `say: ${sourceSecret}`);
    await waitThreadIdle(h, sourceConversation.threadId);
    const sourcePrivateCwd = "/tmp/source-private-workspace";
    writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "mailbox-input"), "Target workspace fixture");
    h.svc.db.query(`UPDATE threads SET cwd = ? WHERE id = ?`).run(
      sourcePrivateCwd,
      sourceConversation.threadId,
    );
    const unrelatedTarget = await sendToBot(h, targetBotId, "hang");
    expect((await api<ThreadDto>(h, "GET", `/api/threads/${unrelatedTarget.threadId}`)).activeTurn).toMatchObject({
      id: unrelatedTarget.turnId, status: "working",
    });

    const body = "mailbox-ordered-output";
    const attachmentName = "source-only-attachment.txt";
    const attachmentContents = "SOURCE-ATTACHMENT-SECRET";
    const draftToken = crypto.randomUUID();
    const form = new FormData();
    form.set("file", new Blob([attachmentContents], { type: "text/plain" }), attachmentName);
    const staged = await authedFetch(h, `${h.baseUrl}/api/attachments/stage`, {
      method: "POST",
      headers: { "x-bot-id": sourceBotId, "x-attachment-draft-token": draftToken, "x-command-id": crypto.randomUUID() },
      body: form,
    });
    expect(staged.ok).toBeTrue();
    const attachment = await staged.json() as AttachmentDto;
    const sourceMailTurn = await api<{ threadId: string; turnId: string }>(
      h,
      "POST",
      `/api/threads/${sourceConversation.threadId}/messages`,
      { text: `send_bot_message:${targetBotId}:${body}`, attachmentIds: [attachment.id], attachmentDraftToken: draftToken },
    );
    await waitThreadIdle(h, sourceMailTurn.threadId);

    const sourceTranscript = await messages(h, sourceMailTurn.threadId);
    const acknowledgement = sourceTranscript.find(
      (message) => message.kind === "response" && message.text?.startsWith("Bot message acknowledgements:"),
    )?.text;
    const deliveryId = /^Bot message acknowledgements: (delivery_[a-f0-9]{32}) queued\.$/.exec(
      acknowledgement ?? "",
    )?.[1];
    if (deliveryId === undefined) throw new Error("source acknowledgement omitted the delivery ID");
    const delivery = await waitForDeliveryState(h, deliveryId, "delivered");
    if (delivery.target_turn_id === null) throw new Error("delivery was not linked to its target Turn");

    const targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    const mailboxThread = targetThreads.find((thread) => thread.id !== unrelatedTarget.threadId);
    if (mailboxThread === undefined) throw new Error("target mailbox Thread was not created");
    await waitThreadIdle(h, mailboxThread.id);

    const targetTranscript = await messages(h, mailboxThread.id);
    await expectDurableMailResult(h, sourceMailTurn.threadId, { deliveryId });
    const notice = await expectDurableDispatch(h, mailboxThread.id, delivery.target_turn_id, deliveryId);
    const author = `Message from Bot Source coordinator (${sourceBotId})`;
    expect(notice.data).toEqual({ author, text: body, deliveryId });
    expect(notice.model).toMatchObject([{ role: "user", content: `${author}: ${body}` }]);
    expect(targetThreads).toHaveLength(2);
    expect(targetConversations(h, mailboxThread.id)[0]?.bot_id).toBe(targetBotId);
    expect(targetConversations(h, mailboxThread.id)[0]?.conversation_id).not.toBe(targetConversations(h, sourceConversation.threadId)[0]?.conversation_id);
    expect(h.svc.db.query(`SELECT native_session_id FROM turns WHERE id = ?`).get(delivery.target_turn_id)).toEqual({ native_session_id: "" });
    const agent = await durableSuiteAgent(h.svc.db, mailboxThread.id);
    expect(agent.cwd).toBe(h.svc.cfg.sharedWorkspaceDir);
    const entries = await durableSuiteEntries(h.svc.db, mailboxThread.id);
    const system = entries.flatMap((entry) => entry.model ?? []).findLast((message) => message.role === "system");
    expect(system?.sections?.instructions).toContain(targetInstructions);
    expect(system?.sections?.instructions).toContain(path.join(h.svc.cfg.sharedWorkspaceDir, "bots", targetBotId));
    expect(entries.map(({ kind }) => kind).filter((kind) => kind !== "pi.system")).toEqual([
      "write", "pi.assistant", "pi.tool-result", "pi.assistant",
    ]);
    const sourceEntries = await durableSuiteEntries(h.svc.db, sourceConversation.threadId);
    expect(JSON.stringify(sourceEntries)).toContain(attachmentContents);
    const targetContext = JSON.stringify({ entries, agent });
    for (const sourceContext of [sourceConversation.threadId, sourceSecret, "SOURCE-ONLY-INSTRUCTIONS", sourcePrivateCwd, attachmentName, attachmentContents]) {
      expect(targetContext).not.toContain(sourceContext);
    }
    expect(h.svc.db.query(`
      SELECT json_extract(s.record, '$.requestId') AS request_id FROM pi_submissions s
      JOIN pi_thread_conversations c ON s.conversation_id = c.conversation_id
      WHERE c.thread_id = ? ORDER BY s.id
    `).all(sourceConversation.threadId)).toEqual([
      { request_id: sourceConversation.turnId }, { request_id: sourceMailTurn.turnId },
    ]);
    expect(await durableSuiteToolResults(h.svc.db, mailboxThread.id)).toMatchObject([{
      toolName: "read", isError: false, content: [{ type: "text", text: expect.stringContaining("Target workspace fixture") }],
    }]);
    expect(targetTranscript).toEqual([
      expect.objectContaining({ author: { kind: "system" }, kind: "text", text: body, peerMail: { deliveryId, sourceBotId, sourceName: "Source coordinator" } }),
      expect.objectContaining({ author: { kind: "bot" }, kind: "thinking", text: "Review the isolated peer mail.", thinking: expect.objectContaining({ state: "completed" }) }),
      expect.objectContaining({ author: { kind: "bot" }, kind: "tool", toolCall: expect.objectContaining({ name: "read", status: "completed", target: "mailbox-input" }) }),
      expect.objectContaining({ author: { kind: "bot" }, kind: "response", text: "Peer mail handled.", response: expect.objectContaining({ state: "completed" }) }),
    ]);
    const unrelatedAfter = await api<ThreadDto>(h, "GET", `/api/threads/${unrelatedTarget.threadId}`);
    expect(unrelatedAfter.activeTurn).toMatchObject({ id: unrelatedTarget.turnId, status: "working" });
    expect(h.svc.db.query(`
      SELECT json_extract(s.record, '$.type') AS type, json_extract(s.record, '$.requestId') AS request_id
      FROM pi_submissions s JOIN pi_thread_conversations c ON s.conversation_id = c.conversation_id
      WHERE c.thread_id = ?
    `).all(unrelatedTarget.threadId)).toEqual([{ type: "input", request_id: unrelatedTarget.turnId }]);
  });

  test("a private-folder failure uses the same bounded reason for the target Turn and delivery", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Mail source");
    const targetBotId = await makeBot(h, "Mail target");
    const botsDir = path.join(h.svc.cfg.sharedWorkspaceDir, "bots");
    mkdirSync(botsDir, { recursive: true });
    writeFileSync(path.join(botsDir, targetBotId), "Block directory creation");

    const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:check the private folder`);
    await waitThreadIdle(h, source.threadId);
    const deliveryId = acknowledgementDeliveryId(await messages(h, source.threadId));
    const failed = await waitForDeliveryState(h, deliveryId, "failed");
    const reason = "Target Agent could not accept this message.";
    expect(failed.failure_reason).toBe(reason);
    expect(failed.target_turn_id).not.toBeNull();
    const targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads).toHaveLength(1);
    expect(targetThreads[0]?.latestTurn).toMatchObject({ id: failed.target_turn_id, status: "failed", reason });
    await expectDurableMailResult(h, source.threadId, { deliveryId });
    expectNoDurableDispatch(h, targetThreads[0]!.id, failed.target_turn_id!);
  });

  test("marks delivery on runtime admission while a later target failure remains only an ordinary failed target Turn", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Failure source");
    const targetBotId = await makeBot(h, "Failure target");

    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:mailbox-fail-after-acceptance`,
    );
    await waitThreadIdle(h, source.threadId);
    const sourceTranscript = await messages(h, source.threadId);
    const acknowledgement = sourceTranscript.find(
      (message) => message.kind === "response" && message.text?.startsWith("Bot message acknowledgements:"),
    )?.text;
    const deliveryId = /^Bot message acknowledgements: (delivery_[a-f0-9]{32}) queued\.$/.exec(
      acknowledgement ?? "",
    )?.[1];
    if (deliveryId === undefined) throw new Error("source acknowledgement omitted the delivery ID");

    const accepted = await waitForDeliveryState(h, deliveryId, "delivered");
    if (accepted.target_turn_id === null) throw new Error("delivery was not linked to its target Turn");
    const targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads).toHaveLength(1);
    expect(targetThreads[0]?.activeTurn).toMatchObject({
      id: accepted.target_turn_id,
      status: "working",
    });
    writeFileSync(path.join(h.home, "fake-peer-mail-failure.release"), "");

    await waitThreadIdle(h, targetThreads[0]!.id);
    const failedThread = await api<ThreadDto>(h, "GET", `/api/threads/${targetThreads[0]!.id}`);
    expect(failedThread.latestTurn).toMatchObject({
      id: accepted.target_turn_id,
      botId: targetBotId,
      status: "failed",
      reason: "fake peer-mail failure",
    });
    expect(deliveryRow(h, deliveryId)).toEqual({
      state: "delivered",
      target_turn_id: accepted.target_turn_id,
      failure_reason: null,
    });
    expect(
      sourceTranscript.some((message) => message.text?.includes("fake peer-mail failure")),
    ).toBeFalse();
    await expectDurableMailResult(h, source.threadId, { deliveryId });
    await expectDurableDispatch(h, failedThread.id, accepted.target_turn_id, deliveryId, "unanswered");
    expect(await messages(h, source.threadId)).toEqual(sourceTranscript);
  });

  test("direct target deletion cascades queued mail and its visible target-owned Thread", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Deletion cascade source");
    const targetBotId = await makeBot(h, "Deletion cascade target");
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      "remove this queued exchange",
    );

    const peerMailStarts = spyOn(h.svc.turns, "startPeerMailTurn");
    try {
      const deletion = await api<{ status: string }>(h, "DELETE", `/api/bots/${targetBotId}`, {});

      expect(deletion.status).toBe("deleted");
      expect(await apiStatus(h, "GET", `/api/threads/${queued.threadId}`)).toEqual({
        status: 404,
        body: { error: `unknown thread ${queued.threadId}` },
      });
      expect(
        h.svc.db.query(`SELECT id FROM bot_mail_deliveries WHERE id = ?`).get(queued.deliveryId),
      ).toBeNull();
      expect(peerMailStarts.mock.calls.filter(([input]) => input.botId === targetBotId)).toEqual([]);
    } finally {
      peerMailStarts.mockRestore();
    }
  });


  test("rejects enqueue after direct target deletion begins without acknowledging hidden work", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Deletion race source");
    const targetBotId = await makeBot(h, "Deletion race target");
    const activeTarget = await sendToBot(h, targetBotId, "hang");
    const releaseAbort = Promise.withResolvers<void>();
    const turns = h.svc.turns;
    const abortTurn = turns.abortTurn;
    expect((await api<ThreadDto>(h, "GET", `/api/threads/${activeTarget.threadId}`)).activeTurn).toMatchObject({
      id: activeTarget.turnId, status: "working",
    });
    turns.abortTurn = async function (turnId, reason) {
      if (turnId === activeTarget.turnId) await releaseAbort.promise;
      return abortTurn.call(this, turnId, reason);
    };

    const deletion = authedFetch(h, `${h.baseUrl}/api/bots/${targetBotId}`, {
      method: "DELETE",
      body: "{}",
      headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID() },
    });
    let deletionResponse: Response;
    try {
      const claimDeadline = Date.now() + 5_000;
      for (;;) {
        const claim = h.svc.db.query(
          `SELECT state FROM bot_deletions WHERE bot_id = ?`,
        ).get(targetBotId) as { state: string } | null;
        if (claim?.state === "cleaning") break;
        if (Date.now() > claimDeadline) throw new Error("target deletion was not claimed");
        await Bun.sleep(20);
      }

      const source = await sendToBot(
        h,
        sourceBotId,
        `send_bot_message:${targetBotId}:must not cross deletion`,
      );
      await waitThreadIdle(h, source.threadId);
      await expectDurableMailResult(h, source.threadId, { error: "target Bot deletion is in progress" });
      expect((await messages(h, source.threadId)).some((message) => message.text?.startsWith("Bot message acknowledgements:"))).toBeFalse();
      expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toMatchObject([{ id: activeTarget.threadId }]);
      expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
        count: 0,
      });

    } finally {
      releaseAbort.resolve();
      turns.abortTurn = abortTurn;
      deletionResponse = await deletion;
    }
    expect(deletionResponse.ok).toBeTrue();
  });

  test("a queued delivery cannot claim a target while its direct deletion claim exists", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Dispatch deletion source");
    const targetBotId = await makeBot(h, "Dispatch deletion target");
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      "do not dispatch during deletion",
    );
    const now = new Date().toISOString();
    h.svc.db.query(
      `INSERT INTO bot_deletions (bot_id, state, failure_json, started_at, updated_at)
       VALUES (?, 'cleaning', NULL, ?, ?)`,
    ).run(targetBotId, now, now);

    h.mailbox.resumeDispatch();
    await waitForMailboxWriter(h);
    expect(deliveryRow(h, queued.deliveryId)).toEqual({
      state: "queued",
      target_turn_id: null,
      failure_reason: null,
    });
    expectNoDurableDispatch(h, queued.threadId);

    h.svc.db.query(`DELETE FROM bot_deletions WHERE bot_id = ?`).run(targetBotId);
    expect((await api<{ status: string }>(h, "DELETE", `/api/bots/${targetBotId}`, {})).status).toBe(
      "deleted",
    );
    expect(
      h.svc.db.query(`SELECT id FROM bot_mail_deliveries WHERE id = ?`).get(queued.deliveryId),
    ).toBeNull();
  });

  test("failed target deletion wakes the original queued delivery exactly once", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Deletion failure source");
    const targetBotId = await makeBot(h, "Deletion failure target");
    const { botDeletions, db, events, screens } = h.svc;
    const releaseCleanup = Promise.withResolvers<void>();
    const destroy = screens.destroy;
    screens.destroy = async () => {
      await releaseCleanup.promise;
      throw new Error("Target cleanup failed");
    };
    let deletion: Promise<DeleteBotResultDto> | undefined;
    const unsubscribe = events.subscribe(({ type, payload }) => {
      if (type === "thread.created" && payload && typeof payload === "object" && "deliveryId" in payload) {
        // The accepted mail is durable, and its scheduled drain has yet to run.
        deletion = botDeletions.delete(targetBotId);
        return deletion;
      }
    });
    try {
      const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:deliver after failed cleanup`);
      const deliveryId = await durableAcknowledgement(h, source.threadId);
      const threads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
      expect(threads).toHaveLength(1);
      const threadId = threads[0]!.id;
      const deletionState = db.query("SELECT state FROM bot_deletions WHERE bot_id = ?");
      await waitForMailboxWriter(h);
      expect(deletionState.get(targetBotId)).toEqual({ state: "cleaning" });
      expect(deliveryRow(h, deliveryId)).toEqual({ state: "queued", target_turn_id: null, failure_reason: null });
      expectNoDurableDispatch(h, threadId);

      releaseCleanup.resolve();
      expect(await deletion).toMatchObject({ status: "failed", failures: [{ stage: "surface", message: "Target cleanup failed" }] });
      expect(deletionState.get(targetBotId)).toEqual({ state: "failed" });
      const delivered = await waitForDeliveryState(h, deliveryId, "delivered");
      await waitThreadIdle(h, threadId);
      await expectDurableDispatch(h, threadId, delivered.target_turn_id, deliveryId);
    } finally {
      unsubscribe();
      releaseCleanup.resolve();
      screens.destroy = destroy;
      await deletion;
    }
  });

  test("keeps accepted mail visible while dispatch is paused and delivers it on resume", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Readiness source");
    const targetBotId = await makeBot(h, "Readiness target");
    const body = "dispatch after the queue resumes";
    const queued = await enqueueWhileDispatchPaused(h, sourceBotId, targetBotId, body);

    expect(deliveryRow(h, queued.deliveryId)).toEqual({
      state: "queued",
      target_turn_id: null,
      failure_reason: null,
    });
    expect(await messages(h, queued.threadId)).toEqual([
      expect.objectContaining({
        kind: "text",
        text: body,
        peerMail: expect.objectContaining({ deliveryId: queued.deliveryId, sourceBotId }),
      }),
    ]);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${targetBotId}`)).toMatchObject({
      unreadCount: 1,
      unreadThreadId: queued.threadId,
      previewText: `From Readiness source: ${body}`,
    });
    expectNoDurableDispatch(h, queued.threadId);

    h.mailbox.resumeDispatch();
    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    expect(delivered.target_turn_id).not.toBeNull();
    await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
  });

  test("dispatches queued peer mail on a Thread with a historical session and reuses its conversation for a user Turn", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Queued mail source");
    const targetBotId = await makeBot(h, "Queued mail target");
    const body = "mailbox-ordered-output";
    writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "mailbox-input"), "Target workspace fixture");

    // Hold dispatch while the source enqueues mail, then seed a historical target Turn.
    h.mailbox.pauseDispatch();
    const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:${body}`);
    const deliveryId = await durableAcknowledgement(h, source.threadId);
    expect(deliveryRow(h, deliveryId).state).toBe("queued");
    const [thread] = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    if (!thread) throw new Error("Expected a target mailbox Thread");
    const threadId = thread.id;

    const historicalTurnId = `turn_${crypto.randomUUID().replace(/-/g, "")}`;
    const nativeSessionId = "fake://s1";
    h.svc.threads.setNativeSession(threadId, nativeSessionId);
    h.svc.threads.insertTurnRow({ id: historicalTurnId, threadId, botId: targetBotId, nativeSessionId });
    h.svc.db.query("UPDATE turns SET status = 'completed', finished_at = started_at WHERE id = ?").run(historicalTurnId);
    expect((await h.svc.turns.waitForTerminal(historicalTurnId)).status).toBe("completed");
    expect(h.svc.threads.getNativeSession(threadId)).toBe(nativeSessionId);
    expectNoDurableDispatch(h, threadId, historicalTurnId);
    expect(deliveryRow(h, deliveryId).state).toBe("queued");
    h.mailbox.resumeDispatch();

    const delivery = await waitForDeliveryState(h, deliveryId, "delivered");
    if (!delivery.target_turn_id) throw new Error("Expected a target Turn for the delivery");
    expect((await h.svc.turns.waitForTerminal(delivery.target_turn_id)).status).toBe("completed");
    expect((await durableSuiteEntries(h.svc.db, threadId)).filter(({ kind }) => kind === "write")).toMatchObject([
      { data: { deliveryId, text: body } },
    ]);
    expect((await messages(h, threadId)).at(-1)).toMatchObject({ kind: "response", text: "Peer mail handled." });

    const conversations = targetConversations(h, threadId);
    expect(conversations).toHaveLength(1);
    const followUp = await sendToThread(h, threadId, "say:Continue after peer mail.");
    expect((await h.svc.turns.waitForTerminal(followUp.turnId)).status).toBe("completed");
    expect(targetConversations(h, threadId)).toEqual(conversations);
    expect(h.svc.threads.getNativeSession(threadId)).toBe(nativeSessionId);
  });

  test("dispatches queued mail after source deletion without inventing a live source ID", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Deleted queue source");
    const targetBotId = await makeBot(h, "Deleted queue target");
    const body = "dispatch after source deletion";
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      body,
    );

    expect(
      (await api<{ status: string }>(h, "DELETE", `/api/bots/${sourceBotId}`, {})).status,
    ).toBe("deleted");
    expect((await messages(h, queued.threadId))[0]?.peerMail).toEqual({
      deliveryId: queued.deliveryId,
      sourceName: "Deleted queue source",
    });

    h.mailbox.resumeDispatch();
    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    expect(delivered.target_turn_id).not.toBeNull();
    const notice = await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
    const author = "Message from Bot Deleted queue source";
    expect(notice.data).toEqual({ author, text: body, deliveryId: queued.deliveryId });
    expect(notice.model).toMatchObject([{ role: "user", content: `${author}: ${body}` }]);
  });

  // Checking recovery across shutdown requires two real daemon boots against the same on-disk state.
  test("recovers an acknowledged delivery when the daemon restarts before queue claim", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Restart source");
    const targetBotId = await makeBot(h, "Restart target");
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      "survive restart before claim",
    );
    const daemon = h;
    const home = daemon.home;
    const claim = holdMailboxClaim(daemon);
    const shutdownTurns = daemon.svc.turns.shutdown;
    try {
      daemon.mailbox.resumeDispatch();
      const { finished } = await claim.waitForSubmission();
      expect(deliveryRow(daemon, queued.deliveryId)).toEqual({
        state: "queued", target_turn_id: null, failure_reason: null,
      });

      async function observeShutdown() {
        daemon.mailbox.resumeDispatch();
        await claim.release();
        await Promise.all([finished, waitForMailboxWriter(daemon)]);
        return {
          delivery: deliveryRow(daemon, queued.deliveryId),
          turns: targetTurns(daemon, queued.threadId),
        };
      }
      let atShutdown: ReturnType<typeof observeShutdown> | undefined;
      daemon.svc.turns.shutdown = async (options) => {
        atShutdown = observeShutdown();
        // Complete daemon teardown before surfacing an observation failure.
        await atShutdown.catch(() => {});
        await shutdownTurns.call(daemon.svc.turns, options);
      };
      await daemon.disconnectForRestart();
      const snapshot = await atShutdown;
      expect(snapshot?.delivery).toEqual({ state: "queued", target_turn_id: null, failure_reason: null });
      expect(snapshot?.turns).toEqual([]);
    } finally {
      daemon.svc.turns.shutdown = shutdownTurns;
      await claim.release();
    }
    h = await startMailboxDaemon(home);

    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    expect(delivered.target_turn_id).not.toBeNull();
    await h.svc.turns.waitForTerminal(delivered.target_turn_id!);
    await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
  }, { timeout: 8_000 });

  test("atomically claims once when startup and concurrent dispatch schedules converge", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Concurrent source");
    const targetBotId = await makeBot(h, "Concurrent target");
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      "claim only once",
    );
    const home = h.home;

    await h.disconnectForRestart();
    h = await startMailboxDaemon(home, { pauseMailboxDispatchOnStartup: true });
    expect(deliveryRow(h, queued.deliveryId).state).toBe("queued");
    const claim = holdMailboxClaim(h);
    try {
      h.mailbox.resumeDispatch();
      await claim.waitForSubmission();
      expect(deliveryRow(h, queued.deliveryId).state).toBe("queued");
      h.mailbox.resumeDispatch();
      h.mailbox.resumeDispatch();
    } finally {
      await claim.release();
    }

    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    if (delivered.target_turn_id === null) throw new Error("Expected a target Turn for the delivery");
    await h.svc.turns.waitForTerminal(delivered.target_turn_id);
    await waitForMailboxWriter(h);
    const turns = h.svc.db.query(`SELECT id FROM turns WHERE thread_id = ?`).all(queued.threadId);
    expect(turns).toEqual([{ id: delivered.target_turn_id }]);
    await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
  });

  test("startup resets an orphaned dispatch claim and dispatches it exactly once", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Orphan source");
    const targetBotId = await makeBot(h, "Orphan target");
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      "recover orphaned claim",
    );
    h.svc.db.query(
      `UPDATE bot_mail_deliveries SET state = 'dispatching' WHERE id = ?`,
    ).run(queued.deliveryId);
    const home = h.home;

    await h.disconnectForRestart();
    h = await startMailboxDaemon(home);

    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    expect(delivered.target_turn_id).not.toBeNull();
    await h.svc.turns.waitForTerminal(delivered.target_turn_id!);
    await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
  });

  test("startup fails an uncertain external dispatch without creating another target Turn", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Uncertain source");
    const targetBotId = await makeBot(h, "Uncertain target");
    const queued = await enqueueWhileDispatchPaused(
      h,
      sourceBotId,
      targetBotId,
      "do not replay uncertain dispatch",
    );
    const targetTurnId = `turn_${crypto.randomUUID().replace(/-/g, "")}`;
    h.svc.threads.insertTurnRow({
      id: targetTurnId,
      threadId: queued.threadId,
      botId: targetBotId,
      nativeSessionId: "",
    });
    h.svc.db.query(
      `UPDATE bot_mail_deliveries
       SET state = 'dispatching', target_turn_id = ?
       WHERE id = ?`,
    ).run(targetTurnId, queued.deliveryId);
    const home = h.home;

    await h.disconnectForRestart();
    h = await startMailboxDaemon(home);

    expect(deliveryRow(h, queued.deliveryId)).toEqual({
      state: "failed",
      target_turn_id: targetTurnId,
      failure_reason: "Delivery acceptance could not be confirmed after daemon restart.",
    });
    const thread = await api<ThreadDto>(h, "GET", `/api/threads/${queued.threadId}`);
    expect(thread.latestTurn).toMatchObject({
      id: targetTurnId,
      status: "failed",
      reason: "Delivery acceptance could not be confirmed after daemon restart.",
    });
    expect(
      h.svc.db.query(`SELECT id FROM turns WHERE thread_id = ?`).all(queued.threadId),
    ).toEqual([{ id: targetTurnId }]);
    expectNoDurableDispatch(h, queued.threadId, targetTurnId);
  });

  test("runtime configuration rejection becomes one bounded visible failure without replay", async () => {
    h = await startMailboxDaemon();
    const sourceBotId = await makeBot(h, "Rejected source");
    const targetBotId = await makeBot(h, "Rejected target");
    // Fail durable conversation configuration before any model input can be admitted.
    h.svc.db.query(`UPDATE bots SET model = ? WHERE id = ?`).run("missing-provider/private-model-selection", targetBotId);
    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:reject target conversation configuration`,
    );
    await waitThreadIdle(h, source.threadId);
    const deliveryId = acknowledgementDeliveryId(await messages(h, source.threadId));

    const failed = await waitForDeliveryState(h, deliveryId, "failed");
    if (failed.target_turn_id === null) throw new Error("failed delivery omitted its target Turn");
    const targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads).toHaveLength(1);
    expect(targetThreads[0]?.latestTurn).toMatchObject({
      id: failed.target_turn_id,
      status: "failed",
      reason: "Target Agent could not accept this message.",
    });
    expect(failed.failure_reason).toBe("Target Agent could not accept this message.");
    expect(failed.failure_reason).not.toContain("fake worker secret");

    h.mailbox.pauseDispatch();
    h.mailbox.resumeDispatch();
    await waitForMailboxWriter(h);
    expect(
      h.svc.db.query(`SELECT id FROM turns WHERE thread_id = ?`).all(targetThreads[0]!.id),
    ).toEqual([{ id: failed.target_turn_id }]);
    await expectDurableMailResult(h, source.threadId, { deliveryId });
    expect(failed.failure_reason).not.toContain("private-model-selection");
    expect(deliveryRow(h, deliveryId)).toEqual(failed);
    expectNoDurableDispatch(h, targetThreads[0]!.id, failed.target_turn_id);
  });
});
