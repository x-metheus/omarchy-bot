import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  durableSuiteAgent,
  durableSuiteEntries,
  durableSuiteToolResultEntries,
  durableSuiteToolResults,
} from "../../apps/daemon/src/modules/runtime/harness-test-support.ts";
import { setSetting } from "../../apps/daemon/src/persistence/settings.ts";
import type { BotDto, BotViewDto, MessageDto, ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  apiStatus,
  authedFetch,
  makeBot,
  messages,
  sendToBot,
  sendToThread,
  startDaemon,
  waitThreadIdle,
  type Harness,
} from "./helpers/harness.ts";

interface FakeWorkerObservation {
  type: "session.open" | "session.resume" | "message.send";
  requestId: string;
  botId?: string;
  threadId?: string;
  sessionId?: string;
  nativeSessionId?: string;
  turnId?: string;
  options?: { cwd?: string; instructions?: string; model?: string };
  message?: { text?: string; attachments?: unknown[] };
  computer?: { botId?: string; turnId?: string; workerSessionId?: string; surfaceId?: string };
  botMessage?: { botId?: string; turnId?: string; workerSessionId?: string };
}

interface DeliveryStateRow {
  state: "queued" | "dispatching" | "delivered" | "failed";
  target_turn_id: string | null;
  failure_reason: string | null;
}

const PI_CONFORMANCE_FILE = "pi-fake-pi-1.json";
const durable = process.env.OMARCHY_TEST_DURABLE === "1";
const forgedIdentityError = 'Validation failed for tool "send_bot_message":\n  - botId: unknown field\n  - turnId: unknown field';

function setPiProbeCapabilities(
  h: Harness,
  capabilities: { botMail: boolean },
): void {
  writeFileSync(
    path.join(h.home, "conformance", PI_CONFORMANCE_FILE),
    JSON.stringify({
      ok: true,
      image: "verified",
      fakeCapabilities: capabilities,
    }),
  );
}

function workerObservations(h: Harness): FakeWorkerObservation[] {
  const log = path.join(h.home, "fake-agent-observations.ndjson");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeWorkerObservation);
}

async function waitForWorkerObservation(
  h: Harness,
  predicate: (observation: FakeWorkerObservation) => boolean,
  timeoutMs = 5_000,
): Promise<FakeWorkerObservation> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observation = workerObservations(h).find(predicate);
    if (observation !== undefined) return observation;
    if (Date.now() > deadline) throw new Error("fake Agent never observed the expected command");
    // The worker is a subprocess, so no in-process fake clock can drive its I/O.
    await Bun.sleep(25);
  }
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
    // Delivery persistence is produced by daemon/worker subprocess I/O, not a local timer.
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

async function makeReadyMailboxSource(h: Harness, name: string): Promise<string> {
  writeFileSync(
    path.join(h.home, "conformance", "omp-fake-omp-1.json"),
    JSON.stringify({ ok: true, image: "verified" }),
  );
  await h.svc.agents.recheck("omp");
  const bot = await api<BotDto>(h, "POST", "/api/bots", { name, instructions: "", agentId: "omp" });
  return bot.id;
}

async function enqueueWhileAgentUnavailable(
  h: Harness,
  sourceBotId: string,
  targetBotId: string,
  body: string,
): Promise<{ deliveryId: string; threadId: string }> {
  // Keep the source's independently probed capability inventory available while
  // interrupting only the target Agent, including its ability to claim new mail.
  if (!durable) expect(h.svc.agents.capabilityInventory("omp")?.botMail).toBeTrue();
  h.svc.agents.markOffline("pi", "test target readiness interruption");
  const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:${body}`);
  await waitThreadIdle(h, source.threadId);
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
  if (durable) {
    await expectDurableMailResult(h, source.threadId, { deliveryId });
    expectNoDurableDispatch(h, threadId);
  }
  return { deliveryId, threadId };
}

describe("durable Bot mailbox", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  test("a Turn-bound fake worker receives one durable acknowledgement, refuses a repeated send, and creates one visible target exchange", async () => {
    const replays: Array<{ first: unknown; replayed: unknown }> = [];
    h = await startDaemon(undefined, {
      onDurableMailReplay: (first, replayed) => { replays.push({ first, replayed }); },
    });
    const sourceBotId = await makeBot(h, "Release coordinator");
    const targetBotId = await makeBot(h, "Verification partner");
    const targetPrivateFolder = path.join(h.svc.cfg.sharedWorkspaceDir, "bots", targetBotId);
    expect(existsSync(targetPrivateFolder)).toBeFalse();
    const body = "Review the release checklist before handoff.";

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
    const delivered = durable ? await waitForDeliveryState(h, deliveryId, "delivered") : undefined;
    if (durable) {
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
    } else {
      // The repeated Tool Call is refused before the mailbox, so the retry adds no delivery.
      expect(sourceTranscript).toContainEqual(
        expect.objectContaining({
          author: { kind: "bot" },
          kind: "tool",
          toolCall: expect.objectContaining({ name: "send_bot_message", status: "completed" }),
        }),
      );
    }

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
    if (delivered) await expectDurableDispatch(h, targetThreads[0]!.id, delivered.target_turn_id, deliveryId);
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
    h = await startDaemon(home);

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
    if (delivered) {
      expect(deliveryRow(h, deliveryId)).toEqual(delivered);
      await expectDurableDispatch(h, targetThreads[0]!.id, delivered.target_turn_id, deliveryId);
    }
  });

  test("rejects a worker request whose claimed source Bot does not match the active Turn", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Bound source");
    const targetBotId = await makeBot(h, "Unmodified target");

    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:Attempt impersonation.:forge-source`,
    );
    await waitThreadIdle(h, source.threadId);

    if (durable) {
      await expectDurableMailResult(h, source.threadId, { error: forgedIdentityError });
      expect(h.svc.db.query(`SELECT id FROM bot_mail_deliveries`).all()).toEqual([]);
    } else {
      expect(await messages(h, source.threadId)).toContainEqual(
        expect.objectContaining({
          kind: "tool",
          toolCall: expect.objectContaining({
            name: "send_bot_message",
            status: "error",
            errorSummary: "Bot message tool context is stale or mismatched",
          }),
        }),
      );
    }
    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${targetBotId}`)).toMatchObject({
      unreadCount: 0,
    });
    if (durable) {
      const accepted = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:Use the active Turn.`);
      const deliveryId = await durableAcknowledgement(h, accepted.threadId);
      expect(h.svc.db.query(`
        SELECT id, source_bot_id, source_turn_id, target_bot_id FROM bot_mail_deliveries
      `).all()).toEqual([{
        id: deliveryId, source_bot_id: sourceBotId, source_turn_id: accepted.turnId, target_bot_id: targetBotId,
      }]);
    }
  });

  test("rejects an authenticated request when the current Agent inventory disables Bot mail", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Capability-bound source");
    const targetBotId = await makeBot(h, "Capability-bound target");
    if (durable) {
      expect(h.svc.agents.capabilityInventory("pi")?.botMail).toBeTrue();
      setPiProbeCapabilities(h, { botMail: false });
      await h.svc.agents.recheck("pi");
      expect(h.svc.agents.capabilityInventory("pi")?.botMail).toBeFalse();

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
    } else {
      const releaseFile = `mailbox-capability-${crypto.randomUUID()}.release`;
      const source = await sendToBot(
        h,
        sourceBotId,
        `send_bot_message_after_release:${releaseFile}:${targetBotId}:must not enqueue`,
      );
      await waitForWorkerObservation(
        h,
        (observation) =>
          observation.type === "message.send"
          && observation.turnId === source.turnId,
      );
      const toolDeadline = Date.now() + 5_000;
      for (;;) {
        const toolStarted = (await messages(h, source.threadId)).some(
          (message) =>
            message.kind === "tool"
            && message.toolCall?.name === "send_bot_message"
            && message.toolCall.status === "running",
        );
        if (toolStarted) break;
        if (Date.now() > toolDeadline) {
          throw new Error("source mailbox Tool Call never started");
        }
        // The Tool Call event crosses the fake-worker subprocess boundary.
        await Bun.sleep(25);
      }

      setPiProbeCapabilities(h, { botMail: false });
      await h.svc.agents.recheck("pi");
      expect(h.svc.agents.capabilityInventory("pi")?.botMail).toBeFalse();
      writeFileSync(path.join(h.home, releaseFile), "");
      await waitThreadIdle(h, source.threadId);

      expect(await messages(h, source.threadId)).toContainEqual(
        expect.objectContaining({
          kind: "tool",
          toolCall: expect.objectContaining({
            name: "send_bot_message",
            status: "error",
            errorSummary: "Bot mail is not supported by pi",
          }),
        }),
      );
      expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
      expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
        count: 0,
      });
    }
  });

  test("rejects self, missing, raw-path, and oversized addressing without delivery artifacts", async () => {
    h = await startDaemon();
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
        error: "tool params do not match send_bot_message",
        durableError: 'Validation failed for tool "send_bot_message":\n  - text: expected at most 32000 characters',
      },
    ];

    for (const testCase of cases) {
      const source = await sendToBot(h, sourceBotId, testCase.command);
      await waitThreadIdle(h, source.threadId);
      if (durable) {
        await expectDurableMailResult(h, source.threadId, {
          error: testCase.durableError ?? testCase.error,
        });
      } else {
        expect(await messages(h, source.threadId)).toContainEqual(
          expect.objectContaining({
            kind: "tool",
            toolCall: expect.objectContaining({
              name: "send_bot_message",
              status: "error",
              errorSummary: testCase.error,
            }),
          }),
        );
      }
    }

    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
      count: 0,
    });
  }, 20_000);

  test("dispatches one accepted delivery through a fresh private target session without disturbing unrelated target work", async () => {
    h = await startDaemon(undefined, { separateWorkspace: durable });
    const sourceBotId = await makeBot(h, "Source coordinator", "SOURCE-ONLY-INSTRUCTIONS");
    const targetInstructions = "TARGET-CURRENT-INSTRUCTIONS";
    const targetBotId = await makeBot(h, "Target reviewer", targetInstructions);
    const sourceBot = await api<BotDto>(h, "GET", `/api/bots/${sourceBotId}`);
    const targetBot = await api<BotDto>(h, "GET", `/api/bots/${targetBotId}`);
    const sourceSecret = "SOURCE-THREAD-SECRET";
    expect(sourceBot.agentId).toBe("pi");
    expect(targetBot.agentId).toBe(sourceBot.agentId);
    expect(targetBot.id).not.toBe(sourceBot.id);

    const sourceConversation = await sendToBot(h, sourceBotId, `say: ${sourceSecret}`);
    await waitThreadIdle(h, sourceConversation.threadId);
    const sourcePrivateCwd = "/tmp/source-private-workspace";
    if (durable) writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "mailbox-input"), "Target workspace fixture");
    h.svc.db.query(`UPDATE threads SET cwd = ? WHERE id = ?`).run(
      sourcePrivateCwd,
      sourceConversation.threadId,
    );
    const unrelatedTarget = await sendToBot(h, targetBotId, "hang");
    if (durable) {
      expect((await api<ThreadDto>(h, "GET", `/api/threads/${unrelatedTarget.threadId}`)).activeTurn).toMatchObject({
        id: unrelatedTarget.turnId, status: "working",
      });
    } else {
      await waitForWorkerObservation(
        h,
        (observation) => observation.type === "message.send" && observation.turnId === unrelatedTarget.turnId,
      );
    }

    const body = "mailbox-ordered-output";
    const sourceMailTurn = await api<{ threadId: string; turnId: string }>(
      h,
      "POST",
      `/api/threads/${sourceConversation.threadId}/messages`,
      { text: `send_bot_message:${targetBotId}:${body}` },
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
    if (durable) {
      await expectDurableMailResult(h, sourceMailTurn.threadId, { deliveryId });
      const notice = await expectDurableDispatch(h, mailboxThread.id, delivery.target_turn_id, deliveryId);
      const author = `Message from Bot Source coordinator (${sourceBotId})`;
      expect(notice).toMatchObject({
        data: { author, text: body, deliveryId },
        model: [{ role: "user", content: `${author}: ${body}` }],
      });
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
      const targetContext = JSON.stringify({ entries, agent });
      for (const sourceContext of [sourceConversation.threadId, sourceSecret, "SOURCE-ONLY-INSTRUCTIONS", sourcePrivateCwd]) {
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
        expect.objectContaining({ author: { kind: "bot" }, kind: "tool", toolCall: expect.objectContaining({ name: "read", status: "completed" }) }),
        expect.objectContaining({ author: { kind: "bot" }, kind: "response", text: "Peer mail handled.", response: expect.objectContaining({ state: "completed" }) }),
      ]);
      const unrelatedAfter = await api<ThreadDto>(h, "GET", `/api/threads/${unrelatedTarget.threadId}`);
      expect(unrelatedAfter.activeTurn).toMatchObject({ id: unrelatedTarget.turnId, status: "working" });
      expect(h.svc.db.query(`
        SELECT json_extract(s.record, '$.type') AS type, json_extract(s.record, '$.requestId') AS request_id
        FROM pi_submissions s JOIN pi_thread_conversations c ON s.conversation_id = c.conversation_id
        WHERE c.thread_id = ?
      `).all(unrelatedTarget.threadId)).toEqual([{ type: "input", request_id: unrelatedTarget.turnId }]);
    } else {
      expect(targetTranscript).toEqual([
        expect.objectContaining({
          author: { kind: "system" },
          kind: "text",
          text: body,
          peerMail: expect.objectContaining({
            deliveryId,
            sourceBotId,
            sourceName: "Source coordinator",
          }),
        }),
        expect.objectContaining({
          author: { kind: "bot" },
          kind: "thinking",
          thinking: expect.objectContaining({ state: "completed" }),
          text: "Review the isolated peer mail.",
        }),
        expect.objectContaining({
          author: { kind: "bot" },
          kind: "tool",
          toolCall: expect.objectContaining({
            name: "read",
            status: "completed",
            target: "mailbox-input",
          }),
        }),
        expect.objectContaining({
          author: { kind: "bot" },
          kind: "event",
          payload: expect.objectContaining({
            capability: "fake.progress",
            sensitivity: "public",
            payload: { stage: "peer-mail" },
          }),
        }),
        expect.objectContaining({
          author: { kind: "bot" },
          kind: "response",
          response: expect.objectContaining({ state: "completed" }),
          text: "Peer mail handled.",
        }),
      ]);

      const persistedTurns = h.svc.db.query(
        `SELECT id, native_session_id FROM turns WHERE thread_id = ? ORDER BY started_at`,
      ).all(mailboxThread.id) as Array<{ id: string; native_session_id: string }>;
      expect(persistedTurns).toEqual([
        { id: delivery.target_turn_id, native_session_id: expect.stringMatching(/^fake:\/\/s\d+$/) },
      ]);

      const targetSession = workerObservations(h).filter(
        (observation) =>
          observation.type === "session.open"
          && observation.botId === targetBotId
          && observation.threadId === mailboxThread.id,
      );
      expect(targetSession).toHaveLength(1);
      expect(targetSession[0]).toMatchObject({
        botId: targetBotId,
        threadId: mailboxThread.id,
        options: { cwd: path.join(h.home, ".omarchy-bot", "workspace"), instructions: targetInstructions },
      });
      expect(targetSession[0]?.options).not.toHaveProperty("model");

      const targetInput = workerObservations(h).find(
        (observation) =>
          observation.type === "message.send"
          && observation.turnId === delivery.target_turn_id,
      );
      expect(targetInput).toMatchObject({
        sessionId: targetSession[0]?.sessionId,
        message: {
          text: `Message from Bot Source coordinator (${sourceBotId}):\n\n${body}`,
        },
        computer: {
          botId: targetBotId,
          turnId: delivery.target_turn_id,
          workerSessionId: targetSession[0]?.sessionId,
          surfaceId: targetBot.surfaceId,
        },
        botMessage: {
          botId: targetBotId,
          turnId: delivery.target_turn_id,
          workerSessionId: targetSession[0]?.sessionId,
        },
      });
      expect(targetInput?.message).not.toHaveProperty("attachments");
      const serializedTargetInput = JSON.stringify(targetInput);
      expect(serializedTargetInput).not.toContain(sourceConversation.threadId);
      expect(serializedTargetInput).not.toContain(sourceSecret);
      expect(serializedTargetInput).not.toContain("SOURCE-ONLY-INSTRUCTIONS");
      expect(serializedTargetInput).not.toContain("memory");

      const sourceSessions = workerObservations(h).filter(
        (observation) =>
          (observation.type === "session.open" || observation.type === "session.resume")
          && observation.botId === sourceBotId,
      );
      expect(sourceSessions).toHaveLength(2);
      expect(sourceSessions[1]?.type).toBe("session.resume");
      expect(sourceSessions[1]?.options).toMatchObject({
        cwd: sourcePrivateCwd,
        instructions: "SOURCE-ONLY-INSTRUCTIONS",
      });
      expect(targetSession[0]?.nativeSessionId).not.toBe(sourceSessions[1]?.nativeSessionId);

      const unrelatedAfter = await api<ThreadDto>(h, "GET", `/api/threads/${unrelatedTarget.threadId}`);
      expect(serializedTargetInput).not.toContain(sourcePrivateCwd);
      expect(unrelatedAfter.activeTurn).toMatchObject({ id: unrelatedTarget.turnId, status: "working" });
      const controlCommands = existsSync(path.join(h.home, "fake-worker-commands.log"))
        ? readFileSync(path.join(h.home, "fake-worker-commands.log"), "utf8")
        : "";
      expect(controlCommands).not.toContain("message.steer");
      expect(controlCommands).not.toContain("turn.abort");
    }
  });

  test("a private-folder failure uses the same bounded reason for the target Turn and delivery", async () => {
    h = await startDaemon();
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
    if (durable) {
      await expectDurableMailResult(h, source.threadId, { deliveryId });
      expectNoDurableDispatch(h, targetThreads[0]!.id, failed.target_turn_id!);
    }
  });

  test("marks delivery on worker acceptance while a later target failure remains only an ordinary failed target Turn", async () => {
    h = await startDaemon();
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
    if (durable) {
      await expectDurableMailResult(h, source.threadId, { deliveryId });
      await expectDurableDispatch(h, failedThread.id, accepted.target_turn_id, deliveryId, "unanswered");
      expect(await messages(h, source.threadId)).toEqual(sourceTranscript);
    }
  });

  test("direct target deletion cascades queued mail and its visible target-owned Thread", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Deletion cascade source");
    const targetBotId = await makeBot(h, "Deletion cascade target");
    const queued = await enqueueWhileAgentUnavailable(
      h,
      sourceBotId,
      targetBotId,
      "remove this queued exchange",
    );

    const peerMailStarts = durable ? spyOn(h.svc.turns, "startPeerMailTurn") : undefined;
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
      if (peerMailStarts) {
        expect(peerMailStarts.mock.calls.filter(([input]) => input.botId === targetBotId)).toEqual([]);
      } else {
        expect(
          workerObservations(h).filter(
            (observation) => observation.type === "session.open" && observation.botId === targetBotId,
          ),
        ).toEqual([]);
      }
    } finally {
      peerMailStarts?.mockRestore();
    }
  });


  test("rejects enqueue after direct target deletion begins without acknowledging hidden work", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Deletion race source");
    const targetBotId = await makeBot(h, "Deletion race target");
    const activeTarget = await sendToBot(h, targetBotId, "hang");
    const releaseAbort = Promise.withResolvers<void>();
    const turns = h.svc.turns;
    const abortTurn = turns.abortTurn;
    if (durable) {
      expect((await api<ThreadDto>(h, "GET", `/api/threads/${activeTarget.threadId}`)).activeTurn).toMatchObject({
        id: activeTarget.turnId, status: "working",
      });
      turns.abortTurn = async function (turnId, reason) {
        if (turnId === activeTarget.turnId) await releaseAbort.promise;
        return abortTurn.call(this, turnId, reason);
      };
    } else {
      await waitForWorkerObservation(
        h,
        (observation) => observation.type === "message.send" && observation.turnId === activeTarget.turnId,
      );
      writeFileSync(
        path.join(h.home, "conformance", "pi-fake-pi-1.json"),
        JSON.stringify({ ok: true, image: "verified", fakeAbortReleaseFile: "release-mailbox-delete" }),
      );
    }

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
      if (durable) {
        await expectDurableMailResult(h, source.threadId, { error: "target Bot deletion is in progress" });
        expect((await messages(h, source.threadId)).some((message) => message.text?.startsWith("Bot message acknowledgements:"))).toBeFalse();
        expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toMatchObject([{ id: activeTarget.threadId }]);
      } else {
        expect(await messages(h, source.threadId)).toContainEqual(
          expect.objectContaining({
            kind: "tool",
            toolCall: expect.objectContaining({
              name: "send_bot_message",
              status: "error",
              errorSummary: "target Bot deletion is in progress",
            }),
          }),
        );
      }
      expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
        count: 0,
      });

    } finally {
      if (durable) {
        releaseAbort.resolve();
        turns.abortTurn = abortTurn;
      } else {
        writeFileSync(path.join(h.home, "release-mailbox-delete"), "release");
      }
      deletionResponse = await deletion;
    }
    expect(deletionResponse.ok).toBeTrue();
  });

  test("a queued delivery cannot claim a target while its direct deletion claim exists", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Dispatch deletion source");
    const targetBotId = await makeBot(h, "Dispatch deletion target");
    const queued = await enqueueWhileAgentUnavailable(
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

    await h.svc.agents.recheck("pi");
    expect(deliveryRow(h, queued.deliveryId)).toEqual({
      state: "queued",
      target_turn_id: null,
      failure_reason: null,
    });
    if (durable) {
      expectNoDurableDispatch(h, queued.threadId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) =>
            observation.type === "session.open"
            && observation.threadId === queued.threadId,
        ),
      ).toEqual([]);
    }

    h.svc.db.query(`DELETE FROM bot_deletions WHERE bot_id = ?`).run(targetBotId);
    expect((await api<{ status: string }>(h, "DELETE", `/api/bots/${targetBotId}`, {})).status).toBe(
      "deleted",
    );
    expect(
      h.svc.db.query(`SELECT id FROM bot_mail_deliveries WHERE id = ?`).get(queued.deliveryId),
    ).toBeNull();
  });

  test("keeps accepted mail visible while unavailable and dispatches it when Agent readiness returns", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Readiness source");
    const targetBotId = await makeBot(h, "Readiness target");
    const body = "dispatch after readiness returns";
    const queued = await enqueueWhileAgentUnavailable(h, sourceBotId, targetBotId, body);

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
    if (durable) {
      expectNoDurableDispatch(h, queued.threadId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) => observation.type === "session.open" && observation.botId === targetBotId,
        ),
      ).toHaveLength(0);
    }

    await h.svc.agents.recheck("pi");
    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    expect(delivered.target_turn_id).not.toBeNull();
    if (durable) {
      await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) => observation.type === "session.open" && observation.botId === targetBotId,
        ),
      ).toHaveLength(1);
    }
  });

  if (durable) test("dispatches queued peer mail durably after a worker Turn and reuses the conversation for a user Turn", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Queued mail source");
    const targetBotId = await makeBot(h, "Queued mail target");
    const body = "mailbox-ordered-output";
    writeFileSync(path.join(h.svc.cfg.sharedWorkspaceDir, "mailbox-input"), "Target workspace fixture");

    // Hold dispatch while the source enqueues mail, then let the worker run a user Turn on the target.
    const agents = h.svc.agents;
    const isReady = agents.isReady.bind(agents);
    const readiness = spyOn(agents, "isReady").mockImplementation((id) => id !== "pi" && isReady(id));
    let deliveryId: string;
    try {
      const source = await sendToBot(h, sourceBotId, `send_bot_message:${targetBotId}:${body}`);
      deliveryId = await durableAcknowledgement(h, source.threadId);
    } finally {
      readiness.mockRestore();
    }
    expect(deliveryRow(h, deliveryId).state).toBe("queued");
    const [thread] = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    if (!thread) throw new Error("Expected a target mailbox Thread");
    const threadId = thread.id;

    setSetting(h.svc.db, "runtime", "worker");
    const worker = await sendToThread(h, threadId, "say:Worker Turn complete.");
    expect((await h.svc.turns.waitForTerminal(worker.turnId)).status).toBe("completed");
    expect(h.svc.threads.getNativeSession(threadId)).toMatch(/^fake:\/\/s\d+$/);
    expectNoDurableDispatch(h, threadId, worker.turnId);
    expect(deliveryRow(h, deliveryId).state).toBe("queued");

    setSetting(h.svc.db, "runtime", "durable");
    agents.markOffline("pi", "trigger the queued delivery on readiness");
    await agents.recheck("pi");

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
  });

  test("dispatches queued mail after source deletion without inventing a live source ID", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Deleted queue source");
    const targetBotId = await makeBot(h, "Deleted queue target");
    const body = "dispatch after source deletion";
    const queued = await enqueueWhileAgentUnavailable(
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

    await h.svc.agents.recheck("pi");
    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    expect(delivered.target_turn_id).not.toBeNull();
    if (durable) {
      const notice = await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
      const author = "Message from Bot Deleted queue source";
      expect(notice.data).toEqual({ author, text: body, deliveryId: queued.deliveryId });
      expect(notice.model).toMatchObject([{ role: "user", content: `${author}: ${body}` }]);
    } else {
      const targetInput = workerObservations(h).find(
        (observation) =>
          observation.type === "message.send"
          && observation.turnId === delivered.target_turn_id,
      );
      expect(targetInput?.message?.text).toBe(
        `Message from Bot Deleted queue source:\n\n${body}`,
      );
      expect(targetInput?.message?.text).not.toContain("(null)");
    }
  });

  test("recovers an acknowledged delivery when the daemon restarts before queue claim", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Restart source");
    const targetBotId = await makeBot(h, "Restart target");
    const queued = await enqueueWhileAgentUnavailable(
      h,
      sourceBotId,
      targetBotId,
      "survive restart before claim",
    );
    const home = h.home;
    const shutdownTurns = h.svc.turns.shutdown.bind(h.svc.turns);
    h.svc.turns.shutdown = async () => {
      await h!.svc.agents.recheck("pi");
      expect(deliveryRow(h!, queued.deliveryId)).toEqual({
        state: "queued", target_turn_id: null, failure_reason: null,
      });
      await shutdownTurns();
    };

    await h.disconnectForRestart();
    h = await startDaemon(home);

    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    expect(delivered.target_turn_id).not.toBeNull();
    if (durable) {
      await waitThreadIdle(h, queued.threadId);
      await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) =>
            observation.type === "message.send"
            && observation.turnId === delivered.target_turn_id,
        ),
      ).toHaveLength(1);
    }
  });

  test("atomically claims once when startup and concurrent readiness triggers converge", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Concurrent source");
    const targetBotId = await makeBot(h, "Concurrent target");
    const queued = await enqueueWhileAgentUnavailable(
      h,
      sourceBotId,
      targetBotId,
      "claim only once",
    );
    const home = h.home;

    await h.disconnectForRestart();
    h = await startDaemon(home, { waitForAgentReady: false });
    await Promise.all([
      h.svc.agents.recheck("pi"),
      h.svc.agents.recheck("pi"),
      h.svc.agents.recheck("pi"),
    ]);

    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    const turns = h.svc.db.query(`SELECT id FROM turns WHERE thread_id = ?`).all(queued.threadId);
    expect(turns).toEqual([{ id: delivered.target_turn_id }]);
    if (durable) {
      await waitThreadIdle(h, queued.threadId);
      await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) =>
            observation.type === "message.send"
            && observation.turnId === delivered.target_turn_id,
        ),
      ).toHaveLength(1);
    }
  });

  test("startup resets an orphaned dispatch claim and dispatches it exactly once", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Orphan source");
    const targetBotId = await makeBot(h, "Orphan target");
    const queued = await enqueueWhileAgentUnavailable(
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
    h = await startDaemon(home);

    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    expect(delivered.target_turn_id).not.toBeNull();
    if (durable) {
      await waitThreadIdle(h, queued.threadId);
      await expectDurableDispatch(h, queued.threadId, delivered.target_turn_id, queued.deliveryId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) =>
            observation.type === "message.send"
            && observation.turnId === delivered.target_turn_id,
        ),
      ).toHaveLength(1);
    }
  });

  test("startup fails an uncertain external dispatch without creating another target Turn", async () => {
    h = await startDaemon();
    const sourceBotId = await makeReadyMailboxSource(h, "Uncertain source");
    const targetBotId = await makeBot(h, "Uncertain target");
    const queued = await enqueueWhileAgentUnavailable(
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
    h = await startDaemon(home);

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
    if (durable) {
      expectNoDurableDispatch(h, queued.threadId, targetTurnId);
    } else {
      expect(
        workerObservations(h).filter(
          (observation) => observation.type === "session.open" && observation.botId === targetBotId,
        ),
      ).toHaveLength(0);
    }
  });

  test("worker-start rejection becomes one bounded visible failure without replay", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Rejected source");
    const targetBotId = await makeBot(h, "Rejected target", "fake-session-open-failure");
    if (durable) {
      // Fail durable conversation configuration before any model input can be admitted.
      h.svc.db.query(`UPDATE bots SET model = ? WHERE id = ?`).run("missing-provider/private-model-selection", targetBotId);
    }
    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:reject target worker start`,
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

    await h.svc.agents.recheck("pi");
    expect(
      h.svc.db.query(`SELECT id FROM turns WHERE thread_id = ?`).all(targetThreads[0]!.id),
    ).toEqual([{ id: failed.target_turn_id }]);
    if (durable) {
      await expectDurableMailResult(h, source.threadId, { deliveryId });
      expect(failed.failure_reason).not.toContain("private-model-selection");
      expect(deliveryRow(h, deliveryId)).toEqual(failed);
      expectNoDurableDispatch(h, targetThreads[0]!.id, failed.target_turn_id);
    }
  });
});
