import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { applyMigration, MIGRATIONS, openDb } from "../../apps/daemon/src/persistence/db.ts";
import { renderAvatarRecipe } from "../../apps/web/src/components/avatarRenderer.ts";
import { AVATAR_RENDERER_ID, AvatarRecipeDto, type MessageDto, type ToolCallSummaryDto } from "../../packages/protocol/src/index.ts";
import { isToolCallSummary, TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } from "../../packages/domain/src/index.ts";
import { api, makeBot, startDaemon, type Harness } from "./helpers/harness.ts";
import { BotScreenManager } from "../../apps/daemon/src/modules/computer/botScreenManager.ts";
import { FakeBotScreenRuntimeAdapter } from "../../apps/daemon/src/modules/computer/fakeBotScreenRuntime.ts";

function databaseThrough(migrationName: string): { db: Database; dbPath: string; home: string; artifactsDir: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-migrations-"));
  const dbPath = path.join(home, "db.sqlite");
  const artifactsDir = path.join(home, "artifacts");
  mkdirSync(artifactsDir);
  const db = new Database(dbPath, { create: true });
  db.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

  let found = false;
  for (const migration of MIGRATIONS) {
    applyMigration(db, migration, { artifactsDir });
    db.query(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`).run(migration.name, "2026-09-01T00:00:00.000Z");
    if (migration.name === migrationName) {
      found = true;
      break;
    }
  }
  if (!found) {
    db.close();
    rmSync(home, { recursive: true, force: true });
    throw new Error(`migration ${migrationName} is unavailable`);
  }
  return { db, dbPath, home, artifactsDir };
}

function finishMigrations(db: Database, dbPath: string): Database {
  db.close();
  return openDb({ dbPath, artifactsDir: path.join(path.dirname(dbPath), "artifacts") } as never);
}

function deployedArchivelessDatabase(): { dbPath: string; home: string } {
  const { db, dbPath, home } = databaseThrough("0012-bot-screen-contract");
  const appliedAt = "2026-09-03T18:20:46.736Z";
  db.exec(`
    ALTER TABLE bots DROP COLUMN archived_at;
    ALTER TABLE bots DROP COLUMN archived;
    DROP TABLE bot_native_session_deletions;
  `);
  const divergentLedger = [
    "0010-agent-oriented-avatar-styles",
    "0011-remove-bot-archive-lifecycle",
    "0012-remove-native-session-deletion-checkpoints",
  ];
  const recordMigration = db.query(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`);
  for (const name of divergentLedger) recordMigration.run(name, appliedAt);
  db.query(`INSERT INTO agents (id, display_name, status, updated_at) VALUES ('pi', 'Pi', 'ready', ?)`).run(appliedAt);
  db.query(
    `INSERT INTO bots (id, name, instructions, agent_id, avatar_recipe, created_at, updated_at, provenance)
     VALUES ('bot_existing', 'Existing Bot', 'Preserve these instructions', 'pi', '{}', ?, ?, 'legacy_conversation')`,
  ).run(appliedAt, appliedAt);
  db.query(
    `INSERT INTO bot_surfaces (
       surface_id, bot_id, lifecycle_state, runtime_generation, transitioned_at
     ) VALUES ('surf_11111111111111111111111111111111', 'bot_existing', 'ready', 4, ?)`,
  ).run(appliedAt);
  db.query(
    `INSERT INTO threads (id, bot_id, title, created_at, updated_at)
     VALUES ('thread_existing', 'bot_existing', 'Preserved thread', ?, ?)`,
  ).run(appliedAt, appliedAt);
  db.query(
    `INSERT INTO messages (id, thread_id, seq, author_kind, kind, text, created_at)
     VALUES ('message_existing', 'thread_existing', 1, 'user', 'text', 'Preserved message', ?)`,
  ).run(appliedAt);
  db.query(`INSERT INTO bot_state (bot_id, preview_text) VALUES ('bot_existing', 'Preserved preview')`).run();
  db.close();
  return { dbPath, home };
}

describe("integration: deployed schema convergence", () => {
  test("keeps Bot Screen and divergent-ledger migrations in dependency order", () => {
    expect(MIGRATIONS.slice(-14).map((migration) => migration.name)).toEqual([
      "0010-bot-computer-surfaces",
      "0011-redacted-input-diagnostics",
      "0012-bot-screen-contract",
      "0010-profile-avatar-styles",
      "0011-remove-bot-archive-lifecycle",
      "0012-remove-native-session-deletion-checkpoints",
      "0013-restore-bot-archive-lifecycle",
      "0014-enforce-current-avatar-recipes",
      "0015-converge-bot-screen-persistence",
      "0016-bot-display-settings",
      "0017-ordered-transcript-repair",
      "0018-durable-bot-mail",
      "0019-legacy-tool-call-summaries",
      "0020-drop-controller-epoch",
    ]);
  });

  test("preserves archiveless local deletion and repairs Bot Screen state before recovery", async () => {
    const { dbPath, home } = deployedArchivelessDatabase();
    const artifactsDir = path.join(home, "artifacts");
    const droppedRowArtifact = path.join(artifactsDir, "snapshot-dropped-row.png");
    const unrelatedArtifactDirFile = path.join(artifactsDir, "operator-note.txt");
    const externalFile = path.join(home, "snapshot-external.png");
    writeFileSync(droppedRowArtifact, "orphaned legacy snapshot");
    writeFileSync(unrelatedArtifactDirFile, "not a managed snapshot");
    writeFileSync(externalFile, "outside configured artifact ownership");
    const db = openDb({ dbPath, artifactsDir } as never);
    const adapter = new FakeBotScreenRuntimeAdapter();
    const screens = new BotScreenManager(db, adapter, {
      capacity: 1,
      logicalWidth: 1920,
      logicalHeight: 1080,
    });

    try {
      await screens.recover();
      expect(existsSync(droppedRowArtifact)).toBeFalse();
      expect(existsSync(unrelatedArtifactDirFile)).toBeTrue();
      expect(existsSync(externalFile)).toBeTrue();
      expect(
        db.query(
          `SELECT id, name, instructions, agent_id, provenance
           FROM bots WHERE id = 'bot_existing'`,
        ).get(),
      ).toEqual({
        id: "bot_existing",
        name: "Existing Bot",
        instructions: "Preserve these instructions",
        agent_id: "pi",
        provenance: "legacy_conversation",
      });
      expect(
        db.query(
          `SELECT threads.title, messages.text
           FROM threads JOIN messages ON messages.thread_id = threads.id
           WHERE threads.bot_id = 'bot_existing'`,
        ).get(),
      ).toEqual({ title: "Preserved thread", text: "Preserved message" });
      const avatar = db.query<{ avatar_recipe: string }, []>(
        `SELECT avatar_recipe FROM bots WHERE id = 'bot_existing'`,
      ).get();
      expect(AvatarRecipeDto.parse(JSON.parse(avatar!.avatar_recipe))).toEqual({
        rendererVersion: AVATAR_RENDERER_ID,
        style: "pixelbot",
        seed: "bot_existing",
        options: {},
      });
      expect(
        db.query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'bot_native_session_deletions'`,
        ).get(),
      ).toBeNull();
      expect(
        db.query(
          `SELECT authority_kind
           FROM computer_surface_coordination
           WHERE surface_id = 'surf_11111111111111111111111111111111'`,
        ).get(),
      ).toEqual({ authority_kind: "idle" });
      expect(() => db.query(
        `UPDATE computer_surface_coordination SET authority_kind = 'unknown'
         WHERE surface_id = 'surf_11111111111111111111111111111111'`,
      ).run()).toThrow();
      expect(
        db.query(
          `SELECT name FROM schema_migrations
           WHERE name IN ('0013-restore-bot-archive-lifecycle', '0015-converge-bot-screen-persistence')
           ORDER BY name`,
        ).all(),
      ).toEqual([
        { name: "0013-restore-bot-archive-lifecycle" },
        { name: "0015-converge-bot-screen-persistence" },
      ]);
      expect(adapter.starts).toHaveLength(1);
      expect(adapter.starts[0]).toMatchObject({
        surfaceId: "surf_11111111111111111111111111111111",
      });
      // Recovery records the attached Bot Computer generation, not a Screen counter.
      expect(
        db.query(
          `SELECT runtime_generation FROM bot_surfaces
           WHERE surface_id = 'surf_11111111111111111111111111111111'`,
        ).get(),
      ).toEqual({ runtime_generation: adapter.generation });
    } finally {
      await screens.shutdown();
      db.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repeat boot preserves the repaired Bot and direct deletion clears Surface coordination", async () => {
    const { home } = deployedArchivelessDatabase();
    let firstDaemon: Harness | undefined;
    let secondDaemon: Harness | undefined;
    try {
      firstDaemon = await startDaemon(home);
      const coordination = firstDaemon.svc.db.query(
        `SELECT authority_kind
         FROM computer_surface_coordination
         WHERE surface_id = 'surf_11111111111111111111111111111111'`,
      ).get() as { authority_kind: string };
      expect(coordination.authority_kind).toBe("idle");
      await firstDaemon.stop();
      firstDaemon = undefined;

      secondDaemon = await startDaemon(home);
      expect(
        secondDaemon.svc.db.query(
          `SELECT id, name, instructions FROM bots WHERE id = 'bot_existing'`,
        ).get(),
      ).toEqual({
        id: "bot_existing",
        name: "Existing Bot",
        instructions: "Preserve these instructions",
      });
      expect(
        secondDaemon.svc.db.query(
          `SELECT COUNT(*) AS count FROM schema_migrations
           WHERE name = '0015-converge-bot-screen-persistence'`,
        ).get(),
      ).toEqual({ count: 1 });
      const deleted = await api<{ status: string }>(
        secondDaemon,
        "DELETE",
        "/api/bots/bot_existing",
        {},
      );
      expect(deleted.status).toBe("deleted");
      expect(secondDaemon.svc.db.query(`SELECT id FROM bots WHERE id = 'bot_existing'`).get()).toBeNull();
      expect(
        secondDaemon.svc.db.query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'bot_native_session_deletions'`,
        ).get(),
      ).toBeNull();
      expect(
        secondDaemon.svc.db.query(
          `SELECT surface_id FROM computer_surface_coordination
           WHERE surface_id = 'surf_11111111111111111111111111111111'`,
        ).get(),
      ).toBeNull();
      expect(secondDaemon.svc.db.query(`SELECT id FROM agents WHERE id = 'pi'`).get()).toEqual({ id: "pi" });
    } finally {
      await firstDaemon?.stop();
      await secondDaemon?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("upgrades deployed Bot-authored text into an ordered Response Block", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-transcript-migration-"));
    let daemon: Harness | undefined;
    try {
      daemon = await startDaemon(home);
      const botId = await makeBot(daemon, "Legacy Transcript Bot");
      const thread = daemon.svc.threads.createThread(botId, { title: "Retained conversation" });
      const createdAt = "2026-09-07T12:00:00.000Z";
      daemon.svc.db.exec("PRAGMA ignore_check_constraints = ON");
      daemon.svc.db.query(
        `INSERT INTO messages (id, thread_id, seq, author_kind, kind, text, created_at)
         VALUES ('message_legacy_bot_text', ?, 1, 'bot', 'text', 'Retained Bot response', ?)`,
      ).run(thread.id, createdAt);
      daemon.svc.db.query(
        `DELETE FROM schema_migrations WHERE name = '0017-ordered-transcript-repair'`,
      ).run();
      daemon.svc.db.exec("PRAGMA ignore_check_constraints = OFF");
      await daemon.disconnectForRestart();
      daemon = undefined;

      daemon = await startDaemon(home);
      expect(await api<MessageDto[]>(
        daemon,
        "GET",
        `/api/threads/${thread.id}/messages`,
      )).toEqual([{
        id: "message_legacy_bot_text",
        threadId: thread.id,
        seq: 1,
        author: { kind: "bot" },
        kind: "response",
        text: "Retained Bot response",
        response: {
          blockId: "legacy-response-message_legacy_bot_text",
          state: "completed",
          startedAt: createdAt,
          completedAt: createdAt,
        },
        createdAt,
      }]);
    } finally {
      await daemon?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("upgrades deployed legacy Tool Calls without exposing or losing native data", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-tool-migration-"));
    const migrationName = "0019-legacy-tool-call-summaries";
    const createdAt = "2026-09-05T05:30:00.000Z";
    const legacyId = "1ad7b030-6454-4ef0-aa84-c9a667a60503";
    const cases: {
      id: string;
      state: string;
      isError?: boolean;
      status: ToolCallSummaryDto["status"];
      errorSummary?: string;
    }[] = [
      { id: legacyId, state: "complete", isError: false, status: "completed" },
      { id: "legacy-tool-failed", state: "complete", isError: true, status: "error", errorSummary: "Tool call failed." },
      { id: "legacy-tool-error", state: "error", isError: false, status: "error", errorSummary: "Tool call failed." },
      { id: "legacy-tool-running", state: "running", isError: false, status: "error", errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY },
      { id: "legacy-tool-started-only", state: "running", status: "error", errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY },
      { id: "legacy-tool-completed", state: "completed", isError: false, status: "completed" },
    ];
    const modern: ToolCallSummaryDto = {
      id: "native-modern",
      name: "edit",
      status: "completed",
      target: "safe file.ts",
      durationMs: 12,
      additions: 2,
      deletions: 1,
    };
    let daemon: Harness | undefined;
    try {
      daemon = await startDaemon(home);
      const botId = await makeBot(daemon, "Legacy Tool Bot");
      const thread = daemon.svc.threads.createThread(botId, { title: "Retained tools" });
      const messagesPath = `/api/threads/${thread.id}/messages`;
      daemon.svc.db.exec("ALTER TABLE messages DROP COLUMN legacy_tool_data");
      const nativeRows = cases.map((entry) => ({
        id: entry.id,
        payload: JSON.stringify({
          toolId: `native-${entry.id}`,
          name: "bash",
          input: { command: "sentinel-secret-input" },
          state: entry.state,
          ...(entry.isError === undefined ? {} : { output: { content: [{ type: "text", text: "sentinel-secret-output" }] } }),
          isError: entry.isError,
        }),
        text: entry.id === "legacy-tool-error" ? "sentinel-secret-diagnostic" : null,
      }));
      daemon.svc.db.exec("PRAGMA ignore_check_constraints = ON");
      const insert = daemon.svc.db.query(
        `INSERT INTO messages (id, thread_id, seq, author_kind, kind, text, payload, created_at, turn_id)
         VALUES (?, ?, ?, 'bot', 'tool', ?, ?, ?, ?)`,
      );
      for (const [index, row] of nativeRows.entries()) {
        expect(isToolCallSummary(JSON.parse(row.payload))).toBeFalse();
        insert.run(row.id, thread.id, index + 1, row.text, row.payload, createdAt, null);
      }
      daemon.svc.db.query(
        `INSERT INTO turns (id, thread_id, bot_id, status, native_session_id, steer_count, started_at, finished_at)
         VALUES ('modern-tool-turn', ?, ?, 'completed', '', 0, ?, ?)`,
      ).run(thread.id, botId, createdAt, createdAt);
      insert.run("modern-tool-message", thread.id, cases.length + 1, null, JSON.stringify(modern), createdAt, "modern-tool-turn");
      daemon.svc.db.exec("PRAGMA ignore_check_constraints = OFF");
      const modernBefore = daemon.svc.db.query<Record<string, unknown>, []>(
        `SELECT * FROM messages WHERE id = 'modern-tool-message'`,
      ).get()!;

      await expect(api(daemon, "GET", messagesPath)).rejects.toThrow(
        `Tool Call message ${legacyId} has no valid safe summary`,
      );
      daemon.svc.db.query(`DELETE FROM schema_migrations WHERE name = ?`).run(migrationName);
      await daemon.disconnectForRestart();
      daemon = undefined;

      daemon = await startDaemon(home);
      const repaired = await api<MessageDto[]>(daemon, "GET", messagesPath);
      expect(repaired).toEqual([
        ...cases.map<MessageDto>((entry, index) => ({
          id: entry.id,
          threadId: thread.id,
          seq: index + 1,
          author: { kind: "bot" },
          kind: "tool",
          toolCall: {
            id: `native-${entry.id}`,
            name: "bash",
            status: entry.status,
            ...(entry.errorSummary === undefined ? {} : { errorSummary: entry.errorSummary }),
          },
          createdAt,
        })),
        {
          id: "modern-tool-message",
          threadId: thread.id,
          seq: cases.length + 1,
          author: { kind: "bot" },
          kind: "tool",
          toolCall: modern,
          createdAt,
        },
      ]);
      expect(JSON.stringify(repaired)).not.toContain("sentinel-secret");
      for (const row of nativeRows) {
        const stored = daemon.svc.db.query<{ legacy_tool_data: string; text: null }, [string]>(
          `SELECT legacy_tool_data, text FROM messages WHERE id = ?`,
        ).get(row.id)!;
        expect(JSON.parse(stored.legacy_tool_data)).toEqual({ payload: row.payload, text: row.text });
        expect(stored.text).toBeNull();
      }
      expect(daemon.svc.db.query(`SELECT * FROM messages WHERE id = 'modern-tool-message'`).get()).toEqual({
        ...modernBefore,
        legacy_tool_data: null,
      });
      expect(daemon.svc.db.query(
        `SELECT DISTINCT status, finished_at, outcome_reason FROM turns WHERE id LIKE 'legacy-turn-%'`,
      ).all()).toEqual([{
        status: "failed",
        finished_at: null,
        outcome_reason: "Historical Tool Call has no recorded Turn outcome.",
      }]);
      expect(daemon.svc.db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
      const storedBeforeReboot = daemon.svc.db.query(`SELECT * FROM messages ORDER BY seq`).all();
      await daemon.disconnectForRestart();
      daemon = undefined;

      daemon = await startDaemon(home);
      expect(await api<MessageDto[]>(daemon, "GET", messagesPath)).toEqual(repaired);
      expect(daemon.svc.db.query(`SELECT * FROM messages ORDER BY seq`).all()).toEqual(storedBeforeReboot);
      expect(daemon.svc.db.query(
        `SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?`,
      ).get(migrationName)).toEqual({ count: 1 });
      applyMigration(daemon.svc.db, MIGRATIONS.find((migration) => migration.name === migrationName)!);
      expect(daemon.svc.db.query(`SELECT * FROM messages ORDER BY seq`).all()).toEqual(storedBeforeReboot);
    } finally {
      await daemon?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  test("keeps unrecognized Tool Call payloads subject to strict summary validation", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omarchy-bot-unknown-tool-migration-"));
    let daemon: Harness | undefined;
    try {
      daemon = await startDaemon(home);
      const botId = await makeBot(daemon, "Unknown Tool Bot");
      const thread = daemon.svc.threads.createThread(botId, { title: "Unrecognized tool" });
      const payload = JSON.stringify({
        toolId: "unknown-native-tool",
        name: "bash",
        state: "unknown",
        input: { command: "sentinel-secret-input" },
        output: { text: "sentinel-secret-output" },
        isError: false,
      });
      daemon.svc.db.exec("PRAGMA ignore_check_constraints = ON");
      daemon.svc.db.query(
        `INSERT INTO messages (id, thread_id, seq, author_kind, kind, payload, created_at)
         VALUES ('unknown-tool-message', ?, 1, 'bot', 'tool', ?, '2026-09-05T05:30:00.000Z')`,
      ).run(thread.id, payload);
      daemon.svc.db.exec("PRAGMA ignore_check_constraints = OFF");
      daemon.svc.db.query(
        `DELETE FROM schema_migrations WHERE name = '0019-legacy-tool-call-summaries'`,
      ).run();
      const before = daemon.svc.db.query(`SELECT * FROM messages WHERE id = 'unknown-tool-message'`).get();
      await daemon.disconnectForRestart();
      daemon = undefined;

      daemon = await startDaemon(home);
      await expect(api(daemon, "GET", `/api/threads/${thread.id}/messages`)).rejects.toThrow(
        "Tool Call message unknown-tool-message has no valid safe summary",
      );
      expect(daemon.svc.db.query(`SELECT * FROM messages WHERE id = 'unknown-tool-message'`).get()).toEqual(before);
    } finally {
      await daemon?.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("integration: Bot provenance migrations", () => {
  test("preserves Bot provenance while replacing every legacy avatar recipe", () => {
    const { db, dbPath, home } = databaseThrough("0004-contract-legacy-runtime");
    const now = "2026-09-01T00:02:00.000Z";
    const userRecipe = ` {"rendererVersion":"9.4.3", "style":"micah", "seed":"changed-legacy-seed", "options":{"backgroundColor":["ff0000"],"flip":true}} `;
    const conversationRecipe = `{"options":{"radius":12},"seed":"bot_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","style":"shapes","rendererVersion":"9.4.3"}`;
    const configRecipe = `{"rendererVersion":"9.4.3","style":"pixel-art","seed":"configured-seed","options":{"scale":91}}`;
    const ambiguousRecipe = `{"rendererVersion":"9.4.3","style":"shapes","seed":"unknown-origin","options":{}}`;

    try {
      db.query(`INSERT INTO agents (id, display_name, status, updated_at) VALUES ('pi', 'Pi', 'ready', ?)`).run(now);
      db.query(
        `INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at)
         VALUES ('bot_user', 'Pi', '', 'pi', 'generated', ?, ?, ?),
                ('bot_shape_only', 'Pi', '', 'pi', 'generated', '{"rendererVersion":"9.4.3","style":"shapes","seed":"bot_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","options":{}}', ?, ?),
                ('bot_ambiguous', 'Pi', '', 'pi', 'generated', ?, ?, ?),
                ('bot_conversation', 'Pi', '', 'pi', 'generated', ?, ?, ?),
                ('bot_config', 'Pi', 'Keep this profile configuration', 'pi', 'recipe', ?, ?, ?)`,
      ).run(userRecipe, now, now, now, now, ambiguousRecipe, now, now, conversationRecipe, now, now, configRecipe, now, now);
      db.query(`INSERT INTO bot_state (bot_id) VALUES ('bot_user')`).run();
      db.query(
        `INSERT INTO threads (id, bot_id, title, created_at, updated_at)
         VALUES ('thread_legacy', 'bot_conversation', 'Data-bearing legacy conversation', ?, ?)`,
      ).run(now, now);

      const migrated = finishMigrations(db, dbPath);
      try {
        const bots = migrated.query<{ id: string; provenance: string; avatar_recipe: string }, []>(
          `SELECT id, provenance, avatar_recipe FROM bots ORDER BY id`,
        ).all();
        expect(bots.map((bot) => [bot.id, bot.provenance])).toEqual([
          ["bot_ambiguous", "user_created"],
          ["bot_config", "legacy_conversation"],
          ["bot_conversation", "legacy_conversation"],
          ["bot_shape_only", "user_created"],
          ["bot_user", "user_created"],
        ]);
        for (const bot of bots) {
          expect(AvatarRecipeDto.parse(JSON.parse(bot.avatar_recipe))).toEqual({
            rendererVersion: AVATAR_RENDERER_ID,
            style: "pixelbot",
            seed: bot.id,
            options: {},
          });
        }
      } finally {
        migrated.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        // finishMigrations already closed the setup connection.
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resets unsupported generated recipes to the sole current renderer", () => {
    const { db, dbPath, home } = databaseThrough("0008-staged-attachment-draft-ownership");
    const now = "2026-09-01T00:02:00.000Z";
    const currentRenderer = AVATAR_RENDERER_ID;

    try {
      db.query(`INSERT INTO agents (id, display_name, status, updated_at) VALUES ('pi', 'Pi', 'ready', ?)`).run(now);
      db.query(
        `INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at)
         VALUES ('bot_legacy', 'Legacy', '', 'pi', 'recipe', '{"rendererVersion":"9.4.3","style":"micah","seed":"old-seed","options":{"flip":true}}', ?, ?),
                ('bot_current', 'Current', '', 'pi', 'recipe', '{"rendererVersion":"dicebear-core@10.7.0+styles@10.6.0","style":"thumbs","seed":"current-seed","options":{}}', ?, ?),
                ('bot_malformed', 'Malformed', '', 'pi', 'generated', '{not-json', ?, ?)`,
      ).run(now, now, now, now, now, now);

      const migrated = finishMigrations(db, dbPath);
      try {
        const bots = migrated.query<{ id: string; avatar_kind: string; avatar_recipe: string }, []>(
          `SELECT id, avatar_kind, avatar_recipe FROM bots ORDER BY id`,
        ).all();
        expect(bots).toEqual([
          {
            id: "bot_current",
            avatar_kind: "recipe",
            avatar_recipe: `{"rendererVersion":"${currentRenderer}","style":"thumbs","seed":"current-seed","options":{}}`,
          },
          {
            id: "bot_legacy",
            avatar_kind: "generated",
            avatar_recipe: `{"rendererVersion":"${currentRenderer}","style":"pixelbot","seed":"bot_legacy","options":{}}`,
          },
          {
            id: "bot_malformed",
            avatar_kind: "generated",
            avatar_recipe: `{"rendererVersion":"${currentRenderer}","style":"pixelbot","seed":"bot_malformed","options":{}}`,
          },
        ]);
      } finally {
        migrated.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        // finishMigrations already closed the setup connection.
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs shorthand v10 avatar recipes after old 0005 was already recorded", () => {
    const { db, dbPath, home } = databaseThrough("0005-created-bots-animated-avatars");
    const now = "2026-09-01T00:02:00.000Z";
    const shorthandRecipe = ` {"options":{"title":"kept"},"seed":"already-upgraded","style":"pixelbot","rendererVersion":"10.7.0"} `;

    try {
      db.query(`INSERT INTO agents (id, display_name, status, updated_at) VALUES ('pi', 'Pi', 'ready', ?)`).run(now);
      db.query(
        `INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at)
         VALUES ('bot_existing', 'Existing Bot', 'Retain me', 'pi', 'generated', ?, ?, ?)`,
      ).run(shorthandRecipe, now, now);

      const migrated = finishMigrations(db, dbPath);
      try {
        const row = migrated.query<{ avatar_recipe: string }, []>(
          `SELECT avatar_recipe FROM bots WHERE id = 'bot_existing'`,
        ).get();
        const repaired = AvatarRecipeDto.parse(JSON.parse(row!.avatar_recipe));
        expect(repaired).toEqual({
          options: { title: "kept" },
          seed: "already-upgraded",
          style: "pixelbot",
          rendererVersion: AVATAR_RENDERER_ID,
        });
        expect(renderAvatarRecipe(repaired, "static")).not.toBeUndefined();
        expect(
          migrated.query(`SELECT name FROM schema_migrations WHERE name = '0005-created-bots-animated-avatars'`).get(),
        ).not.toBeNull();
      } finally {
        migrated.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        // finishMigrations already closed the setup connection.
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("legacy enabled state alone never creates a Sidebar Bot", () => {
    const { db, dbPath, home } = databaseThrough("0001-initial");
    const now = "2026-09-01T00:02:00.000Z";

    try {
      db.query(
        `INSERT INTO bots (id, display_name, status, default_cwd, enabled, created_at, updated_at)
         VALUES ('pi', 'Pi', 'ready', '', 1, ?, ?),
                ('claude', 'Claude', 'ready', '/workspace/from-legacy-profile', 0, ?, ?)`,
      ).run(now, now, now, now);
      db.query(
        `INSERT INTO roles (id, bot_id, name, instructions, memory_scope_id, created_at, updated_at)
         VALUES ('default', 'claude', 'Default', '', 'role:claude:default', ?, ?)`,
      ).run(now, now);

      const migrated = finishMigrations(db, dbPath);
      try {
        const bots = migrated.query<{ agent_id: string; provenance: string; avatar_recipe: string }, []>(
          `SELECT agent_id, provenance, avatar_recipe FROM bots`,
        ).all();
        expect(bots).toHaveLength(1);
        expect(bots[0]?.agent_id).toBe("claude");
        expect(bots[0]?.provenance).toBe("legacy_conversation");
        expect(JSON.parse(bots[0]!.avatar_recipe)).toMatchObject({
          rendererVersion: AVATAR_RENDERER_ID,
          style: "pixelbot",
          options: {},
        });
      } finally {
        migrated.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        // finishMigrations already closed the setup connection.
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("assigns stable Surfaces and removes only owned unscoped artifact files", async () => {
    const { db, dbPath, home, artifactsDir } = databaseThrough("0009-current-avatar-renderer-only");
    const now = "2026-09-01T00:02:00.000Z";
    const ownedLegacyArtifact = path.join(artifactsDir, "snapshot-legacy-artifact.png");
    const externalArtifact = path.join(home, "snapshot-external-artifact.png");
    writeFileSync(ownedLegacyArtifact, "owned legacy image");
    writeFileSync(externalArtifact, "external image");
    const recipe = JSON.stringify({
      rendererVersion: AVATAR_RENDERER_ID,
      style: "shapes",
      seed: "legacy",
      options: {},
    });
    let firstDaemon: Harness | undefined;
    let secondDaemon: Harness | undefined;
    try {
      db.query(`INSERT INTO agents (id, display_name, status, updated_at) VALUES ('pi', 'Pi', 'ready', ?)`).run(now);
      db.query(
        `INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at)
         VALUES ('bot_11111111111111111111111111111111', 'Migrated one', '', 'pi', 'generated', ?, ?, ?),
                ('bot_22222222222222222222222222222222', 'Migrated two', '', 'pi', 'generated', ?, ?, ?)`,
      ).run(recipe, now, now, recipe, now, now);
      db.query(`INSERT INTO bot_state (bot_id) VALUES (?), (?)`)
        .run("bot_11111111111111111111111111111111", "bot_22222222222222222222222222222222");
      db.query(
        `INSERT INTO artifacts (id, kind, media_type, path, created_at)
         VALUES ('legacy-artifact', 'snapshot', 'image/png', ?, ?),
                ('external-artifact', 'snapshot', 'image/png', ?, ?)`,
      ).run(ownedLegacyArtifact, now, externalArtifact, now);

      const migrated = finishMigrations(db, dbPath);
      const surfaces = migrated
        .query(`SELECT surface_id, bot_id FROM bot_surfaces ORDER BY bot_id`)
        .all() as Array<{ surface_id: string; bot_id: string }>;
      expect(surfaces).toHaveLength(2);
      expect(surfaces[0]!.surface_id).toMatch(/^surf_[0-9a-f]{32}$/);
      expect(surfaces[1]!.surface_id).toMatch(/^surf_[0-9a-f]{32}$/);
      expect(surfaces[1]!.surface_id).not.toBe(surfaces[0]!.surface_id);
      expect(
        migrated.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'computer_leases'`).get(),
      ).toBeNull();
      expect(
        migrated.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_unscoped_artifacts'`).get(),
      ).toBeNull();
      expect(
        (migrated.query(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string; notnull: number }>)
          .find((column) => column.name === "surface_id"),
      ).toMatchObject({ notnull: 1 });
      expect(existsSync(ownedLegacyArtifact)).toBeFalse();
      expect(existsSync(externalArtifact)).toBeTrue();
      migrated.close();

      firstDaemon = await startDaemon(home);
      const firstBootBot = await fetch(`${firstDaemon.baseUrl}/api/bots/bot_11111111111111111111111111111111`)
        .then((response) => response.json()) as { surfaceId: string };
      expect(firstBootBot.surfaceId).toBe(surfaces[0]!.surface_id);
      await firstDaemon.stop();
      firstDaemon = undefined;

      secondDaemon = await startDaemon(home);
      const secondBootBot = await fetch(`${secondDaemon.baseUrl}/api/bots/bot_11111111111111111111111111111111`)
        .then((response) => response.json()) as { surfaceId: string };
      expect(secondBootBot.surfaceId).toBe(surfaces[0]!.surface_id);
    } finally {
      await firstDaemon?.stop();
      await secondDaemon?.stop();
      try {
        db.close();
      } catch {
        // finishMigrations already closed the setup connection.
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("integration: archived Bot cutover", () => {
  test("restores every legacy Bot, preserves owned data, and removes obsolete lifecycle storage", async () => {
    const { db, home } = databaseThrough("0009-current-avatar-renderer-only");
    const now = "2026-09-01T00:02:00.000Z";
    const botId = "bot_archived_legacy";
    const threadId = "thread_archived_legacy";
    const attachmentId = "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const attachmentRelPath = path.join("managed", attachmentId);
    const avatarFile = `${botId}.png`;
    const visibleRecipe = JSON.stringify({
      rendererVersion: AVATAR_RENDERER_ID,
      style: "pixelbot",
      seed: "bot_visible_legacy",
      options: {},
    });
    const archivedShapesRecipe =
      ` {"options":{},"seed":"preserved-shape-seed","style":"shapes","rendererVersion":"${AVATAR_RENDERER_ID}"} `;
    let h: Harness | undefined;

    try {
      db.query(`INSERT INTO agents (id, display_name, status, updated_at) VALUES ('pi', 'Pi', 'ready', ?)`).run(now);
      db.query(
        `INSERT INTO bots (
           id, name, instructions, agent_id, avatar_kind, avatar_recipe, avatar_file,
           pinned, archived, archived_at, created_at, updated_at, provenance
         ) VALUES (?, 'Recovered teammate', 'Keep these instructions', 'pi', 'upload', '', ?, 1, 1, ?, ?, ?, 'user_created')`,
      ).run(botId, avatarFile, now, now, now);
      db.query(
        `INSERT INTO bots (
           id, name, instructions, agent_id, avatar_kind, avatar_recipe, avatar_file,
           pinned, archived, archived_at, created_at, updated_at, provenance
         ) VALUES (
           'bot_visible_legacy', 'Previously visible teammate', '', 'pi', 'generated', ?,
           NULL, 1, 0, NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'user_created'
         )`,
      ).run(visibleRecipe);
      db.query(
        `INSERT INTO bots (
           id, name, instructions, agent_id, avatar_kind, avatar_recipe, avatar_file,
           pinned, archived, archived_at, created_at, updated_at, provenance
         ) VALUES (
           'bot_archived_shapes', 'Recovered Shapes', 'Keep this Shapes identity', 'pi',
           'recipe', ?, NULL, 0, 1, ?, '2026-07-01T00:00:00.000Z', ?, 'user_created'
         )`,
      ).run(archivedShapesRecipe, now, now);
      db.query(
        `INSERT INTO bot_state (bot_id, last_activity_at)
         VALUES ('bot_archived_shapes', '2026-07-01T00:00:00.000Z')`,
      ).run();
      db.query(
        `INSERT INTO bot_state (bot_id, last_activity_at)
         VALUES ('bot_visible_legacy', '2026-08-01T00:00:00.000Z')`,
      ).run();
      db.query(
        `INSERT INTO bot_state (
           bot_id, last_activity_at, preview_text, preview_at, unread_count, unread_thread_id
         ) VALUES (?, ?, 'Preserved preview', ?, 1, ?)`,
      ).run(botId, now, now, threadId);
      db.query(
        `INSERT INTO threads (id, bot_id, title, cwd, created_at, updated_at)
         VALUES (?, ?, 'Preserved conversation', '/tmp/preserved', ?, ?)`,
      ).run(threadId, botId, now, now);
      db.query(
        `INSERT INTO messages (id, thread_id, seq, author_kind, kind, text, payload, created_at)
         VALUES ('message_archived_legacy', ?, 1, 'user', 'text', 'Preserved message', NULL, ?)`,
      ).run(threadId, now);
      db.query(
        `INSERT INTO turns (
           id, thread_id, bot_id, status, worker_session_id, native_session_id,
           steer_count, started_at, finished_at, outcome_reason
         ) VALUES ('turn_archived_legacy', ?, ?, 'completed', 'worker-legacy', 'native-legacy', 0, ?, ?, NULL)`,
      ).run(threadId, botId, now, now);
      db.query(
        `INSERT INTO thread_sessions (thread_id, native_session_id, updated_at)
         VALUES (?, 'native-legacy', ?)`,
      ).run(threadId, now);
      db.query(
        `INSERT INTO attachments (
           id, kind, bot_id, thread_id, message_id, name, media_type, size,
           rel_path, source_sha256, created_at, draft_token
         ) VALUES (?, 'managed', ?, ?, 'message_archived_legacy', 'preserved.txt',
           'text/plain', 15, ?, 'legacy-sha', ?, NULL)`,
      ).run(attachmentId, botId, threadId, attachmentRelPath, now);
      db.query(
        `INSERT INTO bot_deletions (bot_id, state, failure_json, started_at, updated_at)
         VALUES (?, 'failed', ?, ?, ?)`,
      ).run(
        botId,
        JSON.stringify([
          { stage: "native_session", resource: "native-checkpoint", message: "obsolete native retry" },
          { stage: "database", resource: botId, message: "preserved local retry" },
        ]),
        now,
        now,
      );
      db.query(
        `INSERT INTO bot_native_session_deletions (bot_id, native_session_id, deleted_at)
         VALUES (?, 'native-checkpoint', ?)`,
      ).run(botId, now);
      db.query(
        `INSERT INTO events (
           event_id, schema_version, occurred_at, aggregate_type, aggregate_id, type, payload
         ) VALUES
           ('event-archived', 1, ?, 'bot', ?, 'bot.archived', '{}'),
           ('event-restored', 1, ?, 'bot', ?, 'bot.restored', '{}'),
           ('event-profile', 1, ?, 'bot', ?, 'bot.updated', '{"name":"Recovered teammate"}')`,
      ).run(now, botId, now, botId, now, botId);

      mkdirSync(path.join(home, "avatars"), { recursive: true });
      mkdirSync(path.join(home, "attachments", "managed"), { recursive: true });
      writeFileSync(path.join(home, "avatars", avatarFile), "preserved avatar");
      writeFileSync(path.join(home, "attachments", attachmentRelPath), "preserved bytes");
      db.close();

      h = await startDaemon(home);
      const bots = await api<Array<Record<string, unknown>>>(h, "GET", "/api/bots");
      expect(bots.map((bot) => bot.id)).toEqual([botId, "bot_visible_legacy", "bot_archived_shapes"]);
      expect(bots[0]).toMatchObject({
        id: botId,
        name: "Recovered teammate",
        instructions: "Keep these instructions",
        pinned: true,
        lastActivityAt: now,
        status: "inactive",
        previewText: "Preserved preview",
      });
      for (const bot of bots) expect(bot).not.toHaveProperty("archived");

      const shapesRow = h.svc.db
        .query(`SELECT avatar_recipe FROM bots WHERE id = 'bot_archived_shapes'`)
        .get() as { avatar_recipe: string } | null;
      expect(shapesRow?.avatar_recipe).toBe(archivedShapesRecipe);
      const shapesRecipe = AvatarRecipeDto.parse(JSON.parse(shapesRow!.avatar_recipe));
      expect(bots.find((bot) => bot.id === "bot_archived_shapes")).toMatchObject({
        name: "Recovered Shapes",
        instructions: "Keep this Shapes identity",
        avatar: { kind: "recipe", recipe: shapesRecipe },
      });
      expect(renderAvatarRecipe(shapesRecipe, "static")).not.toBeUndefined();

      const threads = await api<Array<Record<string, unknown>>>(h, "GET", `/api/bots/${botId}/threads`);
      expect(threads).toContainEqual(expect.objectContaining({ id: threadId, title: "Preserved conversation" }));
      const messages = await api<Array<Record<string, unknown>>>(h, "GET", `/api/threads/${threadId}/messages`);
      expect(messages).toContainEqual(expect.objectContaining({ text: "Preserved message" }));
      expect(h.svc.threads.getNativeSession(threadId)).toBe("native-legacy");

      const attachment = await fetch(`${h.baseUrl}/api/attachments/${attachmentId}`);
      expect(attachment.status).toBe(200);
      expect(await attachment.text()).toBe("preserved bytes");
      const avatar = await fetch(`${h.baseUrl}/api/bots/${botId}/avatar`);
      expect(avatar.status).toBe(200);
      expect(await avatar.text()).toBe("preserved avatar");

      const columns = h.svc.db.query<{ name: string }, []>(`PRAGMA table_info(bots)`).all().map((column) => column.name);
      expect(columns).not.toContain("archived");
      expect(columns).not.toContain("archived_at");
      const tables = h.svc.db
        .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((table) => table.name);
      expect(tables).not.toContain("bot_native_session_deletions");
      const deletionRetry = h.svc.db
        .query<{ failure_json: string | null }, [string]>(
          `SELECT failure_json FROM bot_deletions WHERE bot_id = ?`,
        )
        .get(botId);
      expect(JSON.parse(deletionRetry?.failure_json ?? "null")).toEqual([
        { stage: "database", resource: botId, message: "preserved local retry" },
      ]);
      expect(
        h.svc.db.query(`SELECT type FROM events WHERE aggregate_id = ? ORDER BY type`).all(botId) as { type: string }[],
      ).toEqual([{ type: "bot.updated" }]);
    } finally {
      if (h !== undefined) await h.stop();
      else {
        try {
          db.close();
        } catch {
          // The setup connection was already closed before daemon startup.
        }
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
