import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SecretStore } from "../../apps/daemon/src/modules/runtime/secrets.ts";
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

  test("removes only Bot-owned database rows, files, and secrets while preserving the shared Agent and sibling Bot", async () => {
    const botId = await makeBot(h, "Delete all owned data");
    const siblingId = await makeBot(h, "Shared Agent sibling survives");
    const secrets = new SecretStore(h.svc.cfg.dataDir);
    await secrets.forBot(botId).save("token", "Deleted Bot token", "deleted-test-value");
    await secrets.forBot(siblingId).save("token", "Sibling Bot token", "sibling-test-value");
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
      text: "say: managed attachment",
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
      secrets: 1,
      privateFolder: true,
      computerArtifacts: 1,
      surface: true,
    });
    expect(result).not.toHaveProperty("nativeSessionCleanup");
    expect(await secrets.forBot(botId).list()).toEqual([]);
    expect(await secrets.getBotSecretForRuntime(siblingId, "token")).toBe("sibling-test-value");
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
