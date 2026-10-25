import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AttachmentDto, BotViewDto, DeleteBotResultDto } from "../../packages/protocol/src/index.ts";
import { api, authedFetch, apiStatus, makeBot, sendToBot, startDaemon, waitThreadIdle, type Harness } from "./helpers/harness.ts";

async function stageAttachment(
  h: Harness,
  botId: string,
  contents: string,
  name: string,
  draftToken = crypto.randomUUID(),
): Promise<AttachmentDto> {
  const form = new FormData();
  form.set("file", new Blob([contents], { type: "text/plain" }), name);
  const response = await authedFetch(h, `${h.baseUrl}/api/attachments/stage`, {
    method: "POST",
    headers: {
      "x-bot-id": botId,
      "x-attachment-draft-token": draftToken,
      "x-command-id": crypto.randomUUID(),
    },
    body: form,
  });
  if (!response.ok) throw new Error(`attachment staging failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<AttachmentDto>;
}

async function waitForTurnStatus(h: Harness, turnId: string, status: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const row = h.svc.db.query("SELECT status FROM turns WHERE id = ?").get(turnId) as { status: string } | null;
    if (row?.status === status) return;
    if (Date.now() >= deadline) {
      throw new Error(`turn ${turnId} did not reach ${status}; current=${row?.status ?? "missing"}`);
    }
    await Bun.sleep(20);
  }
}

async function waitForAbortCommands(h: Harness, count: number): Promise<void> {
  const commandLog = path.join(h.home, "fake-worker-commands.log");
  const deadline = Date.now() + 5_000;
  for (;;) {
    const commands = existsSync(commandLog)
      ? readFileSync(commandLog, "utf8").split("\n").filter((command) => command === "turn.abort")
      : [];
    if (commands.length >= count) return;
    if (Date.now() >= deadline) {
      throw new Error(`fake worker received ${commands.length} abort commands; expected ${count}`);
    }
    await Bun.sleep(20);
  }
}

function workerStartCount(h: Harness): number {
  const starts = path.join(h.home, "fake-agent-worker-starts.log");
  if (!existsSync(starts)) return 0;
  return readFileSync(starts, "utf8").split("\n").filter((line) => line.length > 0).length;
}

describe("local Bot deletion", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startDaemon();
  });

  afterEach(async () => {
    await h.stop();
  });

  test("deletes an inactive Bot directly", async () => {
    const inactiveBotId = await makeBot(h, "Inactive direct delete");
    const deleted = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${inactiveBotId}`, {});
    expect(deleted.status).toBe("deleted");
  });

  test("cancels waiting Turns across concurrent Threads and waits for every terminal state before cleanup", async () => {
    const botId = await makeBot(h, "Concurrent active delete");
    const siblingBotId = await makeBot(h, "Unrelated sibling");
    const waitingForInput = await sendToBot(h, botId, "hang");
    const waitingForComputer = await sendToBot(h, botId, "hang");
    await waitForTurnStatus(h, waitingForInput.turnId, "working");
    await waitForTurnStatus(h, waitingForComputer.turnId, "working");
    writeFileSync(
      path.join(h.home, "conformance", "pi-fake-pi-1.json"),
      JSON.stringify({ ok: true, image: "verified", fakeAbortReleaseFile: "release-delete-aborts" }),
    );

    const deletionResponse = authedFetch(h, `${h.baseUrl}/api/bots/${botId}`, {
      method: "DELETE",
      body: "{}",
      headers: { "content-type": "application/json", "x-command-id": crypto.randomUUID() },
    });
    await waitForAbortCommands(h, 2);

    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    expect(await apiStatus(h, "POST", `/api/bots/${botId}/messages`, { text: "late work" })).toEqual({
      status: 409,
      body: { error: "bot deletion is in progress; new work cannot start" },
    });
    writeFileSync(path.join(h.home, "release-delete-aborts"), "release");

    const response = await deletionResponse;
    expect(response.status).toBe(200);
    const deleted = await response.json() as DeleteBotResultDto;
    expect(deleted.status).toBe("deleted");
    expect(deleted.removed.threads).toBe(2);
    expect(deleted.removed.turns).toBe(2);
    expect(deleted.removed).not.toHaveProperty("nativeSessions");
    expect(deleted).not.toHaveProperty("nativeSessionCleanup");
    expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${siblingBotId}`)).id).toBe(siblingBotId);
    const commands = readFileSync(path.join(h.home, "fake-worker-commands.log"), "utf8")
      .trim()
      .split("\n");
    expect(commands.filter((command) => command === "turn.abort")).toHaveLength(2);
  });

  test("keeps the Bot and local rows after cancellation failure, then re-evaluates active Turns on retry", async () => {
    const botId = await makeBot(h, "Retry cancellation");
    const staged = await stageAttachment(h, botId, "retain until barrier succeeds", "barrier.txt");
    const stagedPath = path.join(h.svc.cfg.attachmentsDir, "staged", staged.id);
    const turn = await sendToBot(h, botId, "hang");
    await waitForTurnStatus(h, turn.turnId, "working");
    writeFileSync(
      path.join(h.home, "conformance", "pi-fake-pi-1.json"),
      JSON.stringify({ ok: true, image: "verified", fakeAbortBehavior: "fail_once" }),
    );

    const failed = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({
      status: "failed",
      botId,
      removed: {
        threads: 0,
        messages: 0,
        turns: 0,
        attachments: 0,
        avatar: false,
        computerArtifacts: 0,
        surface: false,
      },
      failures: [
        { stage: "turn_cancellation", resource: turn.turnId, message: "turn abort failed: simulated turn abort failure" },
      ],
    });
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    expect(h.svc.threads.turnRow(turn.turnId)?.status).toBe("working");
    expect(h.svc.db.query(`SELECT state FROM bot_deletions WHERE bot_id=?`).get(botId)).toEqual({ state: "failed" });
    expect(existsSync(stagedPath)).toBeTrue();
    expect(h.svc.db.query(`SELECT id FROM attachments WHERE id=?`).get(staged.id)).toEqual({ id: staged.id });

    const retried = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
    expect(retried.status).toBe("deleted");
    expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
    expect(existsSync(stagedPath)).toBeFalse();
  });

  test("times out an unconfirmed terminal barrier without cleanup and succeeds on retry", async () => {
    await h.stop();
    h = await startDaemon(undefined, { botDeletionTerminalTimeoutMs: 100 });
    const botId = await makeBot(h, "Retry terminal barrier");
    const turn = await sendToBot(h, botId, "hang");
    await waitForTurnStatus(h, turn.turnId, "working");
    writeFileSync(
      path.join(h.home, "conformance", "pi-fake-pi-1.json"),
      JSON.stringify({ ok: true, image: "verified", fakeAbortBehavior: "ignore_once" }),
    );

    const failed = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({
      status: "failed",
      botId,
      removed: {
        threads: 0,
        messages: 0,
        turns: 0,
        attachments: 0,
        avatar: false,
        computerArtifacts: 0,
        surface: false,
      },
      failures: [{ stage: "terminal_wait", resource: turn.turnId }],
    });
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).status).toBe("active");
    expect(h.svc.threads.turnRow(turn.turnId)?.status).toBe("working");

    const retried = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
    expect(retried.status).toBe("deleted");
    expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
  });

  test("removes only Bot-owned database rows and files while preserving the shared Agent and sibling Bot", async () => {
    const botId = await makeBot(h, "Delete all owned data");
    const siblingId = await makeBot(h, "Shared Agent sibling survives");
    const deletedBot = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    const computerTurn = await sendToBot(h, botId, "computer:screenshot");
    await waitThreadIdle(h, computerTurn.threadId);
    const computerArtifact = h.svc.db
      .query(`SELECT id, path FROM artifacts WHERE surface_id = ?`)
      .get(deletedBot.surfaceId) as { id: string; path: string };
    const draftToken = crypto.randomUUID();
    const managed = await stageAttachment(h, botId, "managed bytes", "managed.txt", draftToken);
    const staged = await stageAttachment(h, botId, "staged bytes", "staged.txt", draftToken);
    const sent = await api<{ threadId: string; messageId: string; turnId: string }>(h, "POST", `/api/threads/${computerTurn.threadId}/messages`, {
      text: "attachment-echo",
      attachmentIds: [managed.id],
      attachmentDraftToken: draftToken,
    });
    await waitThreadIdle(h, sent.threadId);

    const avatarFile = `${botId}.png`;
    const avatarPath = path.join(h.svc.cfg.avatarsDir, avatarFile);
    writeFileSync(avatarPath, "uploaded avatar bytes");
    h.svc.db.query(`UPDATE bots SET avatar_kind='upload', avatar_file=? WHERE id=?`).run(avatarFile, botId);
    const managedPath = path.join(h.svc.cfg.attachmentsDir, "managed", managed.id);
    const stagedPath = path.join(h.svc.cfg.attachmentsDir, "staged", staged.id);
    expect(existsSync(managedPath)).toBeTrue();
    expect(existsSync(stagedPath)).toBeTrue();
    expect(existsSync(avatarPath)).toBeTrue();
    expect(existsSync(computerArtifact.path)).toBeTrue();

    h.svc.db.query(`UPDATE thread_sessions SET native_session_id='fake://fail-delete' WHERE thread_id=?`).run(sent.threadId);
    h.svc.db.query(`UPDATE turns SET native_session_id='fake://fail-delete' WHERE bot_id=?`).run(botId);
    const result = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});

    expect(result.status).toBe("deleted");
    expect(result.removed).toEqual({
      threads: 1,
      messages: 5,
      turns: 2,
      attachments: 2,
      avatar: true,
      computerArtifacts: 1,
      surface: true,
    });
    expect(result).not.toHaveProperty("nativeSessionCleanup");
    expect(existsSync(managedPath)).toBeFalse();
    expect(existsSync(stagedPath)).toBeFalse();
    expect(existsSync(avatarPath)).toBeFalse();
    expect(existsSync(computerArtifact.path)).toBeFalse();
    expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
    expect((await apiStatus(h, "GET", `/api/threads/${sent.threadId}`)).status).toBe(404);
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM messages WHERE thread_id=?`).get(sent.threadId)).toEqual({ count: 0 });
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM turns WHERE bot_id=?`).get(botId)).toEqual({ count: 0 });
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM thread_sessions WHERE thread_id=?`).get(sent.threadId)).toEqual({ count: 0 });
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM attachments WHERE bot_id=?`).get(botId)).toEqual({ count: 0 });
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_state WHERE bot_id=?`).get(botId)).toEqual({ count: 0 });
    expect(
      h.svc.db.query(`SELECT COUNT(*) AS count FROM events WHERE aggregate_type IN ('thread','turn') AND aggregate_id IN (?, ?)`)
        .get(sent.threadId, sent.turnId),
    ).toEqual({ count: 0 });
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM artifacts WHERE surface_id=?`).get(deletedBot.surfaceId)).toEqual({ count: 0 });
    expect(h.svc.db.query(`SELECT COUNT(*) AS count FROM bot_surfaces WHERE surface_id=?`).get(deletedBot.surfaceId)).toEqual({ count: 0 });
    expect(
      h.svc.db.query(`SELECT type FROM events WHERE aggregate_type='bot' AND aggregate_id=? ORDER BY cursor`).all(botId),
    ).toEqual([{ type: "bot.deleted" }]);

    const sibling = await api<BotViewDto>(h, "GET", `/api/bots/${siblingId}`);
    expect(sibling.agentId).toBe("pi");
    expect(h.svc.agents.get("pi")?.status).toBe("ready");
    const siblingTurn = await sendToBot(h, siblingId, "say: sibling still works");
    await waitThreadIdle(h, siblingTurn.threadId);
  });

  test("succeeds while the Agent is non-ready without acquiring its worker and preserves its Native Session", async () => {
    const botId = await makeBot(h, "Delete while Agent unavailable");
    const sent = await sendToBot(h, botId, "say: create native session");
    await waitThreadIdle(h, sent.threadId);
    const nativeSessionId = h.svc.threads.getNativeSession(sent.threadId);
    if (nativeSessionId === undefined) throw new Error("fake Agent did not create a Native Session");
    h.svc.agents.markOffline("pi", "test readiness failure");
    await h.svc.supervisor.stopAgentWorker("pi");
    const startsBeforeDeletion = workerStartCount(h);

    const result = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});

    expect(result).toEqual({
      status: "deleted",
      botId,
      botName: "Delete while Agent unavailable",
      removed: {
        threads: 1,
        messages: 2,
        turns: 1,
        attachments: 0,
        avatar: false,
        computerArtifacts: 0,
        surface: true,
      },
      failures: [],
    });
    expect(workerStartCount(h)).toBe(startsBeforeDeletion);
    expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
    expect(h.svc.threads.getNativeSession(sent.threadId)).toBeUndefined();
    expect(h.svc.agents.get("pi")?.status).toBe("offline");

    const worker = await h.svc.supervisor.agentWorker("pi");
    const resumed: unknown = await worker.request({
      type: "session.resume",
      botId: "bot_native_session_survival_probe",
      threadId: "thread_native_session_survival_probe",
      nativeSessionId,
      options: { cwd: path.join(h.home, ".omarchy-bot", "workspace"), instructions: "" },
    }, 30_000);
    if (resumed === null || typeof resumed !== "object" || !("nativeSessionId" in resumed)) {
      throw new Error("fake Agent returned an invalid Session resume result");
    }
    expect(resumed.nativeSessionId).toBe(nativeSessionId);
  });

  test("reports managed-file cleanup failure without deleting the Bot and succeeds on retry", async () => {
    const botId = await makeBot(h, "Retry filesystem cleanup");
    const staged = await stageAttachment(h, botId, "owned bytes", "owned.txt");
    h.svc.db.query(`UPDATE attachments SET rel_path='../../outside-managed-root' WHERE id=?`).run(staged.id);

    const failed = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
    expect(failed.status).toBe(409);
    const result = failed.body as DeleteBotResultDto;
    expect(result.status).toBe("failed");
    expect(result.failures[0]).toEqual({
      stage: "attachment",
      resource: staged.id,
      message: "stored attachment path escapes the managed root",
    });
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).id).toBe(botId);
    expect(h.svc.db.query(`SELECT id FROM attachments WHERE id=?`).get(staged.id)).toEqual({ id: staged.id });

    h.svc.db.query(`UPDATE attachments SET rel_path=? WHERE id=?`).run(path.join("staged", staged.id), staged.id);
    const retried = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
    expect(retried.status).toBe("deleted");
  });

  test("reports database cleanup failure without false success and succeeds on retry", async () => {
    const botId = await makeBot(h, "Retry database cleanup");
    const bot = await api<BotViewDto>(h, "GET", `/api/bots/${botId}`);
    h.svc.events.append("computer", bot.surfaceId, "computer.state.changed", {
      botId,
      surfaceId: bot.surfaceId,
    });
    const ownedComputerEvents = h.svc.db.query(
      `SELECT COUNT(*) AS count FROM events
       WHERE aggregate_type='computer'
         AND json_extract(payload, '$.botId') = ?`,
    ).get(botId) as { count: number };
    expect(ownedComputerEvents.count).toBeGreaterThanOrEqual(1);
    h.svc.db.exec(`
      CREATE TRIGGER fail_bot_delete
      BEFORE DELETE ON bots
      WHEN OLD.id = '${botId}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated local database failure');
      END
    `);

    const failed = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
    expect(failed.status).toBe(409);
    const result = failed.body as DeleteBotResultDto;
    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      { stage: "database", resource: botId, message: "simulated local database failure" },
    ]);
    expect((await api<BotViewDto>(h, "GET", `/api/bots/${botId}`)).id).toBe(botId);
    expect(h.svc.db.query(`SELECT state FROM bot_deletions WHERE bot_id=?`).get(botId)).toEqual({ state: "failed" });
    const retainedComputerEvents = h.svc.db.query(
      `SELECT COUNT(*) AS count FROM events
       WHERE aggregate_type='computer'
         AND json_extract(payload, '$.botId') = ?`,
    ).get(botId) as { count: number };
    expect(retainedComputerEvents.count).toBeGreaterThanOrEqual(ownedComputerEvents.count);

    h.svc.db.exec("DROP TRIGGER fail_bot_delete");
    const retried = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
    expect(retried.status).toBe("deleted");
    expect((await apiStatus(h, "GET", `/api/bots/${botId}`)).status).toBe(404);
    expect(
      h.svc.db.query(
        `SELECT COUNT(*) AS count FROM events
         WHERE aggregate_type='computer'
           AND json_extract(payload, '$.botId') = ?`,
      ).get(botId),
    ).toEqual({ count: 0 });
  });
});
