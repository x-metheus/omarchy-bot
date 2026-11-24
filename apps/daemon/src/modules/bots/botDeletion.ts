import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { SurfaceId } from "@omarchy-bot/domain";
import type { DeleteBotFailureDto, DeleteBotResultDto, TurnDto } from "@omarchy-bot/protocol";
import type { AttachmentsService } from "../attachments/attachments.ts";
import type { AvatarService } from "../avatars/avatarService.ts";
import type { BotScreenManager } from "../computer/botScreenManager.ts";
import type { EventLog } from "../events/eventLog.ts";
import { removePrivateFolder } from "../workspace/sharedWorkspace.ts";
import { HttpError } from "./bots.ts";

interface DeletionBotRow {
  surface_id: string;
  name: string;
  avatar_kind: string;
  avatar_file: string | null;
}

interface ComputerArtifactRow {
  id: string;
  path: string;
}

interface CountRow {
  count: number;
}
interface BotTurnAborter {
  abortTurn(turnId: string, reason: string): Promise<void>;
  waitForTerminal(turnId: string, timeoutMs?: number): Promise<TurnDto>;
}
interface BotThreadTurns {
  activeTurnIdsForBot(botId: string): string[];
}


interface BotScreenProjectionCleanup {
  closeSurface(surfaceId: SurfaceId): Promise<void>;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coordinates irreversible Bot-owned cleanup. Filesystem work finishes before
 * the SQLite delete transaction. Required cleanup failures leave a Bot record
 * for retry. Recorded old Pi session paths are cleaned up on a best-effort basis.
 */
export class BotDeletionService {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly attachments: AttachmentsService,
    private readonly avatars: AvatarService,
    private readonly turns: BotTurnAborter,
    private readonly threads: BotThreadTurns,
    private readonly screens: BotScreenManager,
    private readonly workspaceDir: string,
    private readonly terminalWaitTimeoutMs = 30_000,
    private readonly projections?: BotScreenProjectionCleanup,
  ) {}

  async delete(botId: string): Promise<DeleteBotResultDto> {
    const bot = this.db
      .query(
        `SELECT bots.name, bots.avatar_kind, bots.avatar_file, bot_surfaces.surface_id
         FROM bots JOIN bot_surfaces ON bot_surfaces.bot_id = bots.id
         WHERE bots.id = ?`,
      )
      .get(botId) as DeletionBotRow | null;
    if (bot === null) throw new HttpError(404, `unknown bot ${botId}`);

    this.#claim(botId);

    const activeTurnIds = this.threads.activeTurnIdsForBot(botId);

    if (activeTurnIds.length > 0) {
      const cancellationResults = await Promise.allSettled(
        activeTurnIds.map((turnId) => this.turns.abortTurn(turnId, "bot deleted")),
      );
      const cancellationFailures = cancellationResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [{
              stage: "turn_cancellation" as const,
              resource: activeTurnIds[index]!,
              message: errorMessage(result.reason),
            }]
          : []);
      if (cancellationFailures.length > 0) {
        return this.#barrierFailure(botId, bot.name, cancellationFailures);
      }

      const terminalResults = await Promise.allSettled(
        activeTurnIds.map((turnId) => this.turns.waitForTerminal(turnId, this.terminalWaitTimeoutMs)),
      );
      const terminalFailures = terminalResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [{
              stage: "terminal_wait" as const,
              resource: activeTurnIds[index]!,
              message: errorMessage(result.reason),
            }]
          : []);
      const stillActive = this.threads.activeTurnIdsForBot(botId);
      for (const turnId of stillActive) {
        if (terminalFailures.some((failure) => failure.resource === turnId)) continue;
        terminalFailures.push({
          stage: "terminal_wait",
          resource: turnId,
          message: `turn ${turnId} remained active after cancellation`,
        });
      }
      if (terminalFailures.length > 0) {
        return this.#barrierFailure(botId, bot.name, terminalFailures);
      }
    }



    const threadCount = this.#count(`SELECT COUNT(*) AS count FROM threads WHERE bot_id = ?`, botId);
    const messageCount = this.#count(
      `SELECT COUNT(*) AS count FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`,
      botId,
    );
    const turnCount = this.#count(`SELECT COUNT(*) AS count FROM turns WHERE bot_id = ?`, botId);
    const attachmentCount = this.#count(`SELECT COUNT(*) AS count FROM attachments WHERE bot_id = ?`, botId);
    const computerArtifacts = this.db
      .query(`SELECT artifacts.id, artifacts.path FROM artifacts WHERE surface_id = ?`)
      .all(bot.surface_id) as ComputerArtifactRow[];

    let attachmentFilesRemoved = 0;
    let avatarRemoved = false;
    let privateFolderRemoved = false;
    let computerArtifactsRemoved = 0;
    const failures: DeleteBotFailureDto[] = [];

    try {
      await this.projections?.closeSurface(bot.surface_id as SurfaceId);
    } catch (error) {
      failures.push({ stage: "surface", resource: bot.surface_id, message: errorMessage(error) });
    }
    try {
      await this.screens.destroy(bot.surface_id as SurfaceId);
    } catch (error) {
      failures.push({ stage: "surface", resource: bot.surface_id, message: errorMessage(error) });
    }

    if (failures.length === 0) {
      const attachmentCleanup = this.attachments.deleteOwnedFiles(botId);
      attachmentFilesRemoved = attachmentCleanup.removed;
      failures.push(...attachmentCleanup.failures.map((failure) => ({ stage: "attachment" as const, ...failure })));
    }

    if (failures.length === 0 && bot.avatar_kind === "upload" && bot.avatar_file !== null) {
      try {
        await this.avatars.deleteUploadedFile(bot.avatar_file);
        avatarRemoved = true;
      } catch (error) {
        failures.push({ stage: "avatar", resource: bot.avatar_file, message: errorMessage(error) });
      }
    }
    if (failures.length === 0) {
      for (const artifact of computerArtifacts) {
        try {
          await rm(artifact.path, { force: true });
          computerArtifactsRemoved += 1;
        } catch (error) {
          failures.push({ stage: "surface", resource: artifact.id, message: errorMessage(error) });
        }
      }
    }

    if (failures.length === 0) {
      try {
        privateFolderRemoved = removePrivateFolder(botId, this.workspaceDir);
      } catch (error) {
        failures.push({ stage: "private_folder", resource: botId, message: errorMessage(error) });
      }
    }

    if (failures.length > 0) {
      const failed: DeleteBotResultDto = {
        status: "failed",
        botId,
        botName: bot.name,
        oldSessionFilesRemoved: 0,
        removed: {
          threads: 0,
          messages: 0,
          turns: 0,
          attachments: attachmentFilesRemoved,
          avatar: avatarRemoved,
          privateFolder: privateFolderRemoved,
          computerArtifacts: computerArtifactsRemoved,
          surface: false,
        },
        failures,
      };
      this.#recordFailure(botId, failures);
      return failed;
    }

    const oldSessionFilesRemoved = await this.#removeOldSessionFiles(botId);
    const deleted: DeleteBotResultDto = {
      status: "deleted",
      botId,
      botName: bot.name,
      oldSessionFilesRemoved,
      removed: {
        threads: threadCount,
        messages: messageCount,
        turns: turnCount,
        attachments: attachmentCount,
        avatar: avatarRemoved,
        privateFolder: privateFolderRemoved,
        computerArtifacts: computerArtifacts.length,
        surface: true,
      },
      failures: [],
    };

    try {
      const commit = this.db.transaction(() => {
        this.db.query(
          `DELETE FROM events WHERE
             (aggregate_type = 'bot' AND aggregate_id = ?)
             OR (aggregate_type = 'thread' AND aggregate_id IN (SELECT id FROM threads WHERE bot_id = ?))
             OR (aggregate_type = 'turn' AND aggregate_id IN (SELECT id FROM turns WHERE bot_id = ?))
             OR (
               aggregate_type = 'computer'
               AND (
                 aggregate_id = ?
                 OR aggregate_id = ?
                 OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.botId') = ?
               )
             )`,
        ).run(botId, botId, botId, bot.surface_id, botId, botId);
        this.db.query(`DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`).run(botId);
        this.db.query(`DELETE FROM attachments WHERE bot_id = ?`).run(botId);
        this.db.query(`DELETE FROM thread_sessions WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?)`).run(botId);
        this.db.query(`DELETE FROM turns WHERE bot_id = ?`).run(botId);
        this.db.query(`DELETE FROM artifacts WHERE surface_id = ?`).run(bot.surface_id);
        this.db.query(`DELETE FROM input_diagnostics WHERE surface_id = ?`).run(bot.surface_id);
        this.db.query(`DELETE FROM threads WHERE bot_id = ?`).run(botId);
        this.db.query(`DELETE FROM bot_state WHERE bot_id = ?`).run(botId);
        this.db.query(`DELETE FROM bot_deletions WHERE bot_id = ?`).run(botId);
        this.db.query(`DELETE FROM bot_surfaces WHERE surface_id = ?`).run(bot.surface_id);
        this.db.query(`DELETE FROM bots WHERE id = ?`).run(botId);
        this.events.append("bot", botId, "bot.deleted", { ...deleted, surfaceId: bot.surface_id });
      });
      commit();
    } catch (error) {
      const databaseFailure: DeleteBotFailureDto = { stage: "database", resource: botId, message: errorMessage(error) };
      this.#recordFailure(botId, [databaseFailure]);
      return {
        ...deleted,
        status: "failed",
        removed: { ...deleted.removed, threads: 0, messages: 0, turns: 0, surface: false },
        failures: [databaseFailure],
      };
    }
    return deleted;
  }

  async #removeOldSessionFiles(botId: string): Promise<number> {
    const sessions = this.db.query<{ native_session_id: string }, [string]>(`
      SELECT DISTINCT thread_sessions.native_session_id
      FROM thread_sessions
      JOIN threads ON threads.id = thread_sessions.thread_id
      WHERE threads.bot_id = ? AND thread_sessions.native_session_id <> ''
    `).all(botId);

    const otherBotSession = this.db.query<{ owned: number }, [string, string]>(`
      SELECT 1 AS owned
      FROM thread_sessions
      JOIN threads ON threads.id = thread_sessions.thread_id
      WHERE thread_sessions.native_session_id = ? AND threads.bot_id <> ?
      LIMIT 1
    `);

    let removed = 0;
    for (const { native_session_id: path } of sessions) {
      if (!isAbsolute(path)) continue;
      if (path.split(sep === "\\" ? /[\\/]/ : "/").includes("..")) {
        console.warn("OLD_SESSION_PARENT_TRAVERSAL");
        continue;
      }

      let entry;
      try {
        const parent = dirname(path);
        const resolvedParent = await realpath(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOTDIR") return undefined;
          throw error;
        });
        if (resolvedParent === undefined) continue;
        if (resolvedParent !== parent) {
          console.warn("OLD_SESSION_PARENT_MISMATCH");
          continue;
        }
        entry = await lstat(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
        if (code !== "ENOENT") console.warn(code);
        continue;
      }
      if (entry.isDirectory()) {
        console.warn("EISDIR");
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (otherBotSession.get(path, botId) !== null) continue;

      try {
        await unlink(path);
        removed += 1;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
        if (code !== "ENOENT") console.warn(code);
      }
    }
    return removed;
  }

  #count(sql: string, botId: string): number {
    const row = this.db.query(sql).get(botId) as CountRow;
    return row.count;
  }


  #barrierFailure(
    botId: string,
    botName: string,
    failures: DeleteBotFailureDto[],
  ): DeleteBotResultDto {
    this.#recordFailure(botId, failures);
    return {
      status: "failed",
      botId,
      botName,
      oldSessionFilesRemoved: 0,
      removed: {
        threads: 0,
        messages: 0,
        turns: 0,
        attachments: 0,
        avatar: false,
        privateFolder: false,
        computerArtifacts: 0,
        surface: false,
      },
      failures,
    };
  }

  #claim(botId: string): void {
    const existing = this.db.query(`SELECT state FROM bot_deletions WHERE bot_id = ?`).get(botId) as { state: string } | null;
    if (existing?.state === "cleaning") throw new HttpError(409, "permanent deletion is already in progress");
    const now = new Date().toISOString();
    this.db.query(
      `INSERT INTO bot_deletions (bot_id, state, failure_json, started_at, updated_at)
       VALUES (?, 'cleaning', NULL, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET state='cleaning', failure_json=NULL, started_at=excluded.started_at, updated_at=excluded.updated_at`,
    ).run(botId, now, now);
  }

  #recordFailure(botId: string, failures: readonly DeleteBotFailureDto[]): void {
    this.db.query(`UPDATE bot_deletions SET state='failed', failure_json=?, updated_at=? WHERE bot_id = ?`)
      .run(JSON.stringify(failures), new Date().toISOString(), botId);
  }
}
