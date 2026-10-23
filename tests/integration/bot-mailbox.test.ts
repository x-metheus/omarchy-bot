import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { BotDto, BotViewDto, MessageDto, ThreadDto } from "../../packages/protocol/src/index.ts";
import {
  api,
  apiStatus,
  makeBot,
  messages,
  sendToBot,
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
  expect(h.svc.agents.capabilityInventory("omp")?.botMail).toBeTrue();
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
  return { deliveryId, threadId };
}

describe("durable Bot mailbox", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  test("a Turn-bound fake worker receives one durable acknowledgement, refuses a repeated send, and creates one visible target exchange", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Release coordinator");
    const targetBotId = await makeBot(h, "Verification partner");
    const body = "Review the release checklist before handoff.";

    const source = await sendToBot(
      h,
      sourceBotId,
      `send_bot_message:${targetBotId}:${body}:retry`,
    );
    await waitThreadIdle(h, source.threadId);

    const sourceTranscript = await messages(h, source.threadId);
    const acknowledgement = sourceTranscript.find(
      (message) => message.kind === "response" && message.text?.startsWith("Bot message acknowledgements:"),
    )?.text;
    // The repeated Tool Call is refused before the mailbox, so the retry adds no delivery.
    expect(acknowledgement).toMatch(
      /^Bot message acknowledgements: (delivery_[a-f0-9]{32}) queued\.$/,
    );
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({ count: 1 });
    expect(sourceTranscript).toContainEqual(
      expect.objectContaining({
        author: { kind: "bot" },
        kind: "tool",
        toolCall: expect.objectContaining({ name: "send_bot_message", status: "completed" }),
      }),
    );

    let targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads).toHaveLength(1);
    expect(targetThreads[0]).toMatchObject({ botId: targetBotId, title: "From Release coordinator" });
    await waitThreadIdle(h, targetThreads[0]!.id);
    targetThreads = await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`);
    expect(targetThreads[0]!.activeTurn).toBeUndefined();
    expect(targetThreads[0]!.latestTurn).toMatchObject({ botId: targetBotId, status: "completed" });

    const targetMessages = await api<MessageDto[]>(
      h,
      "GET",
      `/api/threads/${targetThreads[0]!.id}/messages`,
    );
    const deliveryId = /^Bot message acknowledgements: (delivery_[a-f0-9]{32})/.exec(acknowledgement ?? "")?.[1];
    if (deliveryId === undefined) throw new Error("source acknowledgement omitted the delivery ID");
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
    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
    expect(await api<BotViewDto>(h, "GET", `/api/bots/${targetBotId}`)).toMatchObject({
      unreadCount: 0,
    });
  });

  test("rejects an authenticated request when the current Agent inventory disables Bot mail", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Capability-bound source");
    const targetBotId = await makeBot(h, "Capability-bound target");
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
      },
    ];

    for (const testCase of cases) {
      const source = await sendToBot(h, sourceBotId, testCase.command);
      await waitThreadIdle(h, source.threadId);
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

    expect(await api<ThreadDto[]>(h, "GET", `/api/bots/${targetBotId}/threads`)).toEqual([]);
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
      count: 0,
    });
  }, 20_000);

  test("dispatches one accepted delivery through a fresh private target session without disturbing unrelated target work", async () => {
    h = await startDaemon();
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
    h.svc.db.query(`UPDATE threads SET cwd = ? WHERE id = ?`).run(
      sourcePrivateCwd,
      sourceConversation.threadId,
    );
    const unrelatedTarget = await sendToBot(h, targetBotId, "hang");
    await waitForWorkerObservation(
      h,
      (observation) => observation.type === "message.send" && observation.turnId === unrelatedTarget.turnId,
    );

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

    const deletion = await api<{ status: string }>(h, "DELETE", `/api/bots/${targetBotId}`, {});

    expect(deletion.status).toBe("deleted");
    expect(await apiStatus(h, "GET", `/api/threads/${queued.threadId}`)).toEqual({
      status: 404,
      body: { error: `unknown thread ${queued.threadId}` },
    });
    expect(
      h.svc.db.query(`SELECT id FROM bot_mail_deliveries WHERE id = ?`).get(queued.deliveryId),
    ).toBeNull();
    expect(
      workerObservations(h).filter(
        (observation) => observation.type === "session.open" && observation.botId === targetBotId,
      ),
    ).toEqual([]);
  });


  test("rejects enqueue after direct target deletion begins without acknowledging hidden work", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Deletion race source");
    const targetBotId = await makeBot(h, "Deletion race target");
    const activeTarget = await sendToBot(h, targetBotId, "hang");
    await waitForWorkerObservation(
      h,
      (observation) => observation.type === "message.send" && observation.turnId === activeTarget.turnId,
    );
    writeFileSync(
      path.join(h.home, "conformance", "pi-fake-pi-1.json"),
      JSON.stringify({ ok: true, image: "verified", fakeAbortReleaseFile: "release-mailbox-delete" }),
    );

    const deletion = fetch(`${h.baseUrl}/api/bots/${targetBotId}`, {
      method: "DELETE",
      body: "{}",
      headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID() },
    });
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
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_mail_deliveries`).get()).toEqual({
      count: 0,
    });

    writeFileSync(path.join(h.home, "release-mailbox-delete"), "release");
    const deletionResponse = await deletion;
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
    expect(
      workerObservations(h).filter(
        (observation) =>
          observation.type === "session.open"
          && observation.threadId === queued.threadId,
      ),
    ).toEqual([]);

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
    expect(
      workerObservations(h).filter(
        (observation) => observation.type === "session.open" && observation.botId === targetBotId,
      ),
    ).toHaveLength(0);

    await h.svc.agents.recheck("pi");
    const delivered = await waitForDeliveryState(h, queued.deliveryId, "delivered");
    await waitThreadIdle(h, queued.threadId);
    expect(delivered.target_turn_id).not.toBeNull();
    expect(
      workerObservations(h).filter(
        (observation) => observation.type === "session.open" && observation.botId === targetBotId,
      ),
    ).toHaveLength(1);
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
    const targetInput = workerObservations(h).find(
      (observation) =>
        observation.type === "message.send"
        && observation.turnId === delivered.target_turn_id,
    );
    expect(targetInput?.message?.text).toBe(
      `Message from Bot Deleted queue source:\n\n${body}`,
    );
    expect(targetInput?.message?.text).not.toContain("(null)");
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
    expect(
      workerObservations(h).filter(
        (observation) =>
          observation.type === "message.send"
          && observation.turnId === delivered.target_turn_id,
      ),
    ).toHaveLength(1);
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
    expect(
      workerObservations(h).filter(
        (observation) =>
          observation.type === "message.send"
          && observation.turnId === delivered.target_turn_id,
      ),
    ).toHaveLength(1);
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
    expect(
      workerObservations(h).filter(
        (observation) =>
          observation.type === "message.send"
          && observation.turnId === delivered.target_turn_id,
      ),
    ).toHaveLength(1);
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
    expect(
      workerObservations(h).filter(
        (observation) => observation.type === "session.open" && observation.botId === targetBotId,
      ),
    ).toHaveLength(0);
  });

  test("worker-start rejection becomes one bounded visible failure without replay", async () => {
    h = await startDaemon();
    const sourceBotId = await makeBot(h, "Rejected source");
    const targetBotId = await makeBot(h, "Rejected target", "fake-session-open-failure");
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
  });
});
