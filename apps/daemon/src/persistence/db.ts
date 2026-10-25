import { lstatSync, readdirSync, unlinkSync, type Dirent } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { AVATAR_RENDERER_ID, DEFAULT_AVATAR_STYLE_ID } from "@omarchy-bot/protocol";
import { isToolCallSummary, TOOL_CALL_INTERRUPTED_ERROR_SUMMARY, type ToolCallSummary } from "@omarchy-bot/domain";
import type { Config } from "../bootstrap/config.ts";

type MigrationConfig = Pick<Config, "artifactsDir">;

export type Migration = { name: string } & (
  | { sql: string; migrate?: never }
  | { sql?: never; migrate: (db: Database, cfg?: MigrationConfig) => void }
);

export function applyMigration(db: Database, migration: Migration, cfg?: MigrationConfig): void {
  if (migration.migrate !== undefined) {
    migration.migrate(db, cfg);
    return;
  }
  db.exec(migration.sql);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function ownedArtifactPath(artifactsDir: string, storedPath: string): string | null {
  const root = path.resolve(artifactsDir);
  const candidate = path.resolve(path.isAbsolute(storedPath) ? storedPath : path.join(root, storedPath));
  return path.dirname(candidate) === root ? candidate : null;
}

function removeOwnedArtifactPaths(cfg: MigrationConfig | undefined, storedPaths: readonly string[]): void {
  if (cfg === undefined) return;
  for (const storedPath of storedPaths) {
    const candidate = ownedArtifactPath(cfg.artifactsDir, storedPath);
    if (candidate === null) continue;
    try {
      const entry = lstatSync(candidate);
      if (entry.isFile() || entry.isSymbolicLink()) unlinkSync(candidate);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function removeUnreferencedSnapshotFiles(db: Database, cfg: MigrationConfig | undefined): void {
  if (cfg === undefined) return;
  const referenced = new Set(
    (db.query(`SELECT path FROM artifacts`).all() as Array<{ path: string }>)
      .map((row) => ownedArtifactPath(cfg.artifactsDir, row.path))
      .filter((candidate): candidate is string => candidate !== null),
  );
  let entries: Dirent[];
  try {
    entries = readdirSync(cfg.artifactsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (!/^snapshot-[A-Za-z0-9_-]+\.(?:png|jpe?g)$/.test(entry.name)) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const candidate = path.resolve(cfg.artifactsDir, entry.name);
    if (!referenced.has(candidate)) unlinkSync(candidate);
  }
}

const CURRENT_AVATAR_REPAIR_SQL = `
UPDATE bots
SET avatar_kind = 'generated',
    avatar_recipe = json_object(
      'rendererVersion', '${AVATAR_RENDERER_ID}',
      'style', '${DEFAULT_AVATAR_STYLE_ID}',
      'seed', id,
      'options', json('{}')
    )
WHERE avatar_kind IN ('generated', 'recipe')
  AND CASE
    WHEN json_valid(avatar_recipe) = 1 THEN
      CASE
        WHEN json_type(avatar_recipe, '$') = 'object' THEN NOT COALESCE(
          json_extract(avatar_recipe, '$.rendererVersion') = '${AVATAR_RENDERER_ID}'
          AND json_extract(avatar_recipe, '$.style') IN (
            'clay', 'critters', 'gaze', 'initial-face', 'moods', 'pixelbot',
            'shapes', 'sprouts', 'thumbs', 'voxel-art', 'voxel-bot'
          )
          AND json_type(avatar_recipe, '$.seed') = 'text'
          AND json_type(avatar_recipe, '$.options') = 'object',
          0
        )
        ELSE 1
      END
    ELSE 1
  END;
`;

const PROFILE_AVATAR_REPAIR_WITH_ARCHIVE_SQL = `
UPDATE bots
SET avatar_kind = 'generated',
    avatar_recipe = json_object(
      'rendererVersion', '${AVATAR_RENDERER_ID}',
      'style', '${DEFAULT_AVATAR_STYLE_ID}',
      'seed', id,
      'options', json('{}')
    )
WHERE avatar_kind IN ('generated', 'recipe')
  AND CASE
    WHEN json_valid(avatar_recipe) = 1 THEN
      CASE
        WHEN json_type(avatar_recipe, '$') = 'object' THEN NOT COALESCE(
          json_extract(avatar_recipe, '$.rendererVersion') = '${AVATAR_RENDERER_ID}'
          AND (
            json_extract(avatar_recipe, '$.style') IN (
              'clay', 'critters', 'gaze', 'initial-face', 'moods',
              'pixelbot', 'sprouts', 'thumbs', 'voxel-art', 'voxel-bot'
            )
            OR (archived = 1 AND json_extract(avatar_recipe, '$.style') = 'shapes')
          )
          AND json_type(avatar_recipe, '$.seed') = 'text'
          AND json_type(avatar_recipe, '$.options') = 'object',
          0
        )
        ELSE 1
      END
    ELSE 1
  END;
`;

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

function repairProfileAvatars(db: Database): void {
  db.exec(columnNames(db, "bots").has("archived") ? PROFILE_AVATAR_REPAIR_WITH_ARCHIVE_SQL : CURRENT_AVATAR_REPAIR_SQL);
}

function removeBotArchiveLifecycle(db: Database): void {
  const columns = columnNames(db, "bots");
  db.exec(`DELETE FROM events WHERE type IN ('bot.archived', 'bot.restored')`);
  if (!columns.has("archived") && !columns.has("archived_at")) return;

  db.exec(`
CREATE TABLE bots_archiveless (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id),
  avatar_kind TEXT NOT NULL DEFAULT 'generated',
  avatar_recipe TEXT NOT NULL DEFAULT '',
  avatar_file TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'user_created'
    CHECK (provenance IN ('user_created', 'legacy_conversation', 'legacy_inventory'))
);
INSERT INTO bots_archiveless (
  id, name, instructions, agent_id, avatar_kind, avatar_recipe, avatar_file,
  pinned, created_at, updated_at, provenance
)
SELECT
  id, name, instructions, agent_id, avatar_kind, avatar_recipe, avatar_file,
  pinned, created_at, updated_at, provenance
FROM bots;
DROP TABLE bots;
ALTER TABLE bots_archiveless RENAME TO bots;
`);
}

function removeNativeDeletionCheckpoints(db: Database): void {
  db.exec(`
UPDATE bot_deletions
SET failure_json = (
  SELECT CASE
    WHEN COUNT(*) = 0 THEN NULL
    ELSE json_group_array(json(value))
  END
  FROM json_each(
    CASE WHEN json_valid(bot_deletions.failure_json) THEN bot_deletions.failure_json ELSE '[]' END
  )
  WHERE COALESCE(json_extract(value, '$.stage'), '') <> 'native_session'
)
WHERE failure_json IS NOT NULL;
DROP TABLE IF EXISTS bot_native_session_deletions;
`);
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0001-initial",
    sql: `
CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  agent_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'missing',
  default_cwd TEXT NOT NULL DEFAULT '',
  default_model TEXT,
  permission_policy TEXT NOT NULL DEFAULT 'ask',
  enabled INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  default_cwd TEXT,
  default_model TEXT,
  permission_policy TEXT,
  memory_scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bot_id, id)
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct','channel')),
  title TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  cwd TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL,
  author_kind TEXT NOT NULL,
  author_bot_id TEXT,
  author_role_id TEXT,
  kind TEXT NOT NULL,
  text TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  owner_bot_id TEXT NOT NULL,
  owner_role_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL DEFAULT 'user',
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor_bot_id TEXT NOT NULL,
  actor_role_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL DEFAULT '',
  worker_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE role_sessions (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  native_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(role_id, thread_id)
);
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  run_id TEXT,
  worker_session_id TEXT,
  tool TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_thread ON messages(thread_id, seq);
CREATE INDEX idx_tasks_thread ON tasks(thread_id);
CREATE INDEX idx_events_aggregate ON events(aggregate_type, aggregate_id);
`,
  },
  {
    // User-created Bots reference Agents (ADR 0002). One step: build the new
    // tables, preserve only legacy Agent records with user-owned content or
    // configuration, re-point their threads, then drop the legacy model.
    // Empty inventory rows remain Agents and never become Sidebar Bots.
    name: "0002-user-created-bots",
    sql: `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  agent_version TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE bots_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL REFERENCES agents(id),
  avatar_kind TEXT NOT NULL DEFAULT 'generated',
  avatar_recipe TEXT NOT NULL DEFAULT '',
  avatar_file TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE threads_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots_new(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cwd TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads_new(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  worker_session_id TEXT,
  native_session_id TEXT NOT NULL DEFAULT '',
  steer_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome_reason TEXT
);
CREATE TABLE thread_sessions (
  thread_id TEXT PRIMARY KEY REFERENCES threads_new(id) ON DELETE CASCADE,
  native_session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots_new(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads_new(id) ON DELETE CASCADE,
  message_id TEXT,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  source_sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  turn_id TEXT,
  worker_session_id TEXT,
  tool TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE bot_state (
  bot_id TEXT PRIMARY KEY REFERENCES bots_new(id) ON DELETE CASCADE,
  last_activity_at TEXT,
  preview_text TEXT,
  preview_at TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  unread_thread_id TEXT
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Agents referenced by legacy bots must exist before the FK-valid copy below.
INSERT INTO agents (id, display_name, updated_at)
SELECT DISTINCT b.id,
       CASE b.id
         WHEN 'pi' THEN 'Pi' WHEN 'omp' THEN 'OMP' WHEN 'codex' THEN 'Codex'
         WHEN 'claude' THEN 'Claude' WHEN 'grok' THEN 'Grok' WHEN 'opencode' THEN 'OpenCode'
         WHEN 'gemini' THEN 'Gemini' WHEN 'copilot' THEN 'Copilot' WHEN 'crush' THEN 'Crush'
         ELSE b.id
       END,
       b.updated_at
FROM bots b;

-- A legacy Agent becomes a Bot only when it owns conversation data or user
-- configuration. Empty built-in inventory rows remain infrastructure.
INSERT INTO bots_new (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at)
SELECT 'bot_' || lower(hex(randomblob(16))),
       b.display_name,
       COALESCE((SELECT r.instructions FROM roles r WHERE r.bot_id = b.id AND r.id = 'default'), ''),
       b.id,
       'generated',
       '{"rendererVersion":"${AVATAR_RENDERER_ID}","style":"shapes","seed":"bot_' || lower(hex(randomblob(16))) || '","options":{}}',
       b.created_at,
       b.updated_at
FROM bots b
WHERE EXISTS (SELECT 1 FROM threads t WHERE t.bot_id = b.id)
   OR EXISTS (
     SELECT 1 FROM roles r
     WHERE r.bot_id = b.id
       AND (
         r.id <> 'default'
         OR r.name <> 'Default'
         OR trim(r.instructions) <> ''
         OR COALESCE(r.default_cwd, '') <> ''
         OR r.default_model IS NOT NULL
       )
   )
   OR trim(b.default_cwd) <> ''
   OR b.default_model IS NOT NULL
   OR b.display_name <> CASE b.id
     WHEN 'pi' THEN 'Pi' WHEN 'omp' THEN 'OMP' WHEN 'codex' THEN 'Codex'
     WHEN 'claude' THEN 'Claude' WHEN 'grok' THEN 'Grok' WHEN 'opencode' THEN 'OpenCode'
     WHEN 'gemini' THEN 'Gemini' WHEN 'copilot' THEN 'Copilot' WHEN 'crush' THEN 'Crush'
     ELSE b.id
   END;
-- Keep the generated conversation recipe tied to its new Bot identity.
-- This is provenance evidence for fresh migrations and avoids manufacturing
-- the random-seed signature used by older inventory placeholders.
UPDATE bots_new
SET avatar_recipe = json_set(avatar_recipe, '$.seed', id);


-- Re-point threads at their migrated bot (ids preserved, zero message loss).
INSERT INTO threads_new (id, bot_id, title, cwd, created_at, updated_at)
SELECT t.id,
       (SELECT bn.id FROM bots_new bn JOIN bots ob ON ob.id = t.bot_id AND bn.agent_id = ob.id),
       t.title,
       t.cwd,
       t.created_at,
       t.updated_at
FROM threads t;

-- Latest native session per thread wins (one native session per thread now).
INSERT INTO thread_sessions (thread_id, native_session_id, updated_at)
SELECT rs.thread_id, rs.native_session_id, rs.created_at
FROM role_sessions rs
JOIN (SELECT thread_id, MAX(created_at) AS latest FROM role_sessions GROUP BY thread_id) pick
  ON pick.thread_id = rs.thread_id AND pick.latest = rs.created_at;

-- Authorship now lives on the thread's Bot; drop the dangling legacy columns.
UPDATE messages SET author_bot_id = NULL, author_role_id = NULL;

DROP INDEX idx_tasks_thread;
DROP TABLE permissions;
DROP TABLE runs;
DROP TABLE tasks;
DROP TABLE role_sessions;
DROP TABLE threads;
DROP TABLE roles;
DROP TABLE bots;
ALTER TABLE bots_new RENAME TO bots;
ALTER TABLE threads_new RENAME TO threads;

CREATE INDEX idx_threads_bot ON threads(bot_id, updated_at);
CREATE INDEX idx_turns_thread ON turns(thread_id);
CREATE INDEX idx_attachments_thread ON attachments(thread_id);
`,
  },
  {
    name: "0003-permanent-bot-deletion",
    sql: `
CREATE TABLE bot_deletions (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('cleaning', 'failed')),
  failure_json TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE bot_native_session_deletions (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  native_session_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, native_session_id)
);
`,
  },
  {
    // Final expand-contract cutover. Historical tables above remain only as
    // migration provenance; every live database converges on the current model.
    name: "0004-contract-legacy-runtime",
    sql: `
UPDATE turns
SET status = 'failed',
    finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    outcome_reason = 'blocked turn could not resume after runtime contract migration'
WHERE status = 'waiting_for_approval';

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'bot', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'response', 'thinking', 'tool', 'event')),
  text TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  turn_id TEXT REFERENCES turns(id),
  block_id TEXT,
  block_state TEXT CHECK (block_state IN ('streaming', 'completed')),
  block_started_at TEXT,
  block_completed_at TEXT,
  UNIQUE(thread_id, seq),
  CHECK (
    (
      kind = 'text'
      AND author_kind IN ('user', 'system')
      AND text IS NOT NULL
      AND block_id IS NULL
      AND block_state IS NULL
      AND block_started_at IS NULL
      AND block_completed_at IS NULL
    )
    OR (
      kind IN ('response', 'thinking')
      AND author_kind = 'bot'
      AND text IS NOT NULL
      AND payload IS NULL
      AND turn_id IS NOT NULL
      AND block_id IS NOT NULL
      AND block_state IS NOT NULL
      AND block_started_at IS NOT NULL
      AND (
        (block_state = 'streaming' AND block_completed_at IS NULL)
        OR (block_state = 'completed' AND block_completed_at IS NOT NULL)
      )
    )
    OR (
      kind = 'tool'
      AND author_kind = 'bot'
      AND text IS NULL
      AND payload IS NOT NULL
      AND json_valid(payload)
      AND turn_id IS NOT NULL
      AND block_id IS NULL
      AND block_state IS NULL
      AND block_started_at IS NULL
      AND block_completed_at IS NULL
    )
    OR (
      kind = 'event'
      AND author_kind = 'bot'
      AND text IS NULL
      AND payload IS NOT NULL
      AND json_valid(payload)
      AND block_id IS NULL
      AND block_state IS NULL
      AND block_started_at IS NULL
      AND block_completed_at IS NULL
    )
  )
);
INSERT INTO messages_new (
  id, thread_id, seq, author_kind, kind, text, payload, created_at
)
SELECT id, thread_id, seq, author_kind, kind, text, payload, created_at
FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_messages_thread ON messages(thread_id, seq);
CREATE UNIQUE INDEX idx_messages_agent_block
  ON messages(block_id)
  WHERE kind IN ('response', 'thinking');

DROP TABLE IF EXISTS computer_leases;

DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS settings;

-- Replay begins at the contracted public model; no old aggregate identities
-- or approval payloads can cross the WebSocket boundary.
DELETE FROM events;
`,
  },
  {
    // Kept as an inert historical step for databases that have not applied it.
    // Destructive cleanup and recipe upgrades require explicit provenance;
    // already-applied databases are repaired by the forward migration below.
    name: "0005-created-bots-animated-avatars",
    sql: `
SELECT 1;
`,
  },
  {
    // Classify retained legacy Bots conservatively. bot_state is emitted
    // atomically with user-created Bots, while conversations and the
    // identity-tied recipe emitted by the repaired 0002 migration prove
    // legacy user ownership. A recipe shape alone cannot prove inventory, so
    // ambiguous rows keep the safe user_created default and nothing is deleted.
    name: "0006-bot-provenance-repair",
    sql: `
ALTER TABLE bots ADD COLUMN provenance TEXT NOT NULL DEFAULT 'user_created'
  CHECK (provenance IN ('user_created', 'legacy_conversation', 'legacy_inventory'));

UPDATE bots
SET provenance = 'legacy_conversation'
WHERE NOT EXISTS (SELECT 1 FROM bot_state WHERE bot_state.bot_id = bots.id)
  AND (
    trim(instructions) <> ''
    OR pinned <> 0
    OR archived <> 0
    OR archived_at IS NOT NULL
    OR avatar_file IS NOT NULL
    OR avatar_kind <> 'generated'
    OR EXISTS (SELECT 1 FROM threads WHERE threads.bot_id = bots.id)
    OR EXISTS (SELECT 1 FROM attachments WHERE attachments.bot_id = bots.id)
    OR EXISTS (SELECT 1 FROM turns WHERE turns.bot_id = bots.id)
    OR EXISTS (SELECT 1 FROM bot_deletions WHERE bot_deletions.bot_id = bots.id)
    OR EXISTS (SELECT 1 FROM bot_native_session_deletions WHERE bot_native_session_deletions.bot_id = bots.id)
    OR EXISTS (
      SELECT 1 FROM events
      WHERE events.aggregate_type = 'bot' AND events.aggregate_id = bots.id
    )
    OR name <> CASE agent_id
      WHEN 'pi' THEN 'Pi' WHEN 'omp' THEN 'OMP' WHEN 'codex' THEN 'Codex'
      WHEN 'claude' THEN 'Claude' WHEN 'grok' THEN 'Grok' WHEN 'opencode' THEN 'OpenCode'
      WHEN 'gemini' THEN 'Gemini' WHEN 'copilot' THEN 'Copilot' WHEN 'crush' THEN 'Crush'
      ELSE agent_id
    END
    OR (
      json_valid(avatar_recipe)
      AND json_extract(avatar_recipe, '$.rendererVersion') IN ('9.4.3', '${AVATAR_RENDERER_ID}')
      AND json_extract(avatar_recipe, '$.seed') = id
    )
  );

`,
  },
  {
    // Old 0005 deployments wrote DiceBear's core version alone. The renderer
    // dispatch key now pins both packages; mutate only that recipe field.
    name: "0007-pin-dicebear-renderer-id",
    sql: `
UPDATE bots
SET avatar_recipe = json_set(
  avatar_recipe,
  '$.rendererVersion',
  'dicebear-core@10.7.0+styles@10.6.0'
)
WHERE json_valid(avatar_recipe)
  AND json_type(avatar_recipe, '$') = 'object'
  AND json_extract(avatar_recipe, '$.rendererVersion') = '10.7.0'
  AND json_type(avatar_recipe, '$.style') = 'text'
  AND json_type(avatar_recipe, '$.seed') = 'text'
  AND json_type(avatar_recipe, '$.options') = 'object'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(json_extract(bots.avatar_recipe, '$.options'))
    WHERE type NOT IN ('text', 'integer', 'real', 'true', 'false')
  );
`,
  },
  {
    // NULL marks staged rows created before draft ownership existed. They are
    // deliberately unclaimable and remain eligible for the existing age GC.
    name: "0008-staged-attachment-draft-ownership",
    sql: `
ALTER TABLE attachments ADD COLUMN draft_token TEXT;
`,
  },
  {
    // The application ships one renderer. Existing non-current or unsupported
    // generated recipes become deterministic current defaults; no legacy
    // renderer remains in the browser bundle.
    name: "0009-current-avatar-renderer-only",
    sql: CURRENT_AVATAR_REPAIR_SQL,
  },
  {
    name: "0010-bot-computer-surfaces",
    migrate: (db, cfg) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS bot_surfaces (
  surface_id TEXT PRIMARY KEY CHECK (surface_id GLOB 'surf_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  lifecycle_state TEXT NOT NULL DEFAULT 'stopped' CHECK (lifecycle_state IN ('stopped', 'starting', 'ready', 'failed')),
  runtime_generation INTEGER NOT NULL DEFAULT 0,
  logical_width INTEGER NOT NULL DEFAULT 1920,
  logical_height INTEGER NOT NULL DEFAULT 1080,
  scale REAL NOT NULL DEFAULT 1,
  refresh_rate INTEGER NOT NULL DEFAULT 60,
  last_failure TEXT,
  last_image_at TEXT,
  transitioned_at TEXT NOT NULL
);
INSERT INTO bot_surfaces (surface_id, bot_id, transitioned_at)
SELECT 'surf_' || lower(hex(randomblob(16))), bots.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bots
WHERE NOT EXISTS (SELECT 1 FROM bot_surfaces WHERE bot_surfaces.bot_id = bots.id);
DROP TABLE IF EXISTS computer_leases;
`);
      const artifactColumns = new Set(
        (db.query(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      const legacyPaths = artifactColumns.size > 0 && !artifactColumns.has("surface_id")
        ? (db.query(`SELECT path FROM artifacts`).all() as Array<{ path: string }>).map((row) => row.path)
        : [];
      if (legacyPaths.length > 0 || (artifactColumns.size > 0 && !artifactColumns.has("surface_id"))) {
        db.exec(`DROP TABLE artifacts`);
      }
      db.exec(`
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  surface_id TEXT NOT NULL REFERENCES bot_surfaces(surface_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_surface ON artifacts(surface_id);
`);
      removeOwnedArtifactPaths(cfg, legacyPaths);
    },
  },
  {
    name: "0011-redacted-input-diagnostics",
    sql: `
CREATE TABLE input_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface_id TEXT NOT NULL REFERENCES bot_surfaces(surface_id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('browser')),
  action_category TEXT NOT NULL CHECK (
    action_category IN ('controller', 'pointer-button', 'pointer-scroll', 'key', 'shortcut', 'paste', 'release', 'invalid')
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'failed', 'released')),
  redacted_length INTEGER CHECK (redacted_length IS NULL OR redacted_length >= 0),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0)
);
CREATE INDEX idx_input_diagnostics_expiry ON input_diagnostics(occurred_at);
CREATE INDEX idx_input_diagnostics_surface ON input_diagnostics(surface_id, occurred_at);
`,
  },
  {
    name: "0012-bot-screen-contract",
    sql: `
UPDATE turns
SET status = 'failed',
    finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    outcome_reason = 'obsolete Computer control state removed'
WHERE status IN ('waiting_for_input', 'waiting_for_computer');
DROP TABLE IF EXISTS computer_leases;
DROP TABLE IF EXISTS legacy_unscoped_artifacts;
`,
  },
  {
    // Preserve pre-cutover archived Shapes identities alongside valid current
    // recipes; normalize ordinary and unsupported generated recipes to Pixelbot.
    name: "0010-profile-avatar-styles",
    migrate: repairProfileAvatars,
  },
  {
    // Recover every archived Bot into the ordinary population before dropping
    // the lifecycle columns. Child rows keep the same Bot IDs throughout.
    name: "0011-remove-bot-archive-lifecycle",
    migrate: removeBotArchiveLifecycle,
  },
  {
    // Native Session lifecycle is Agent-owned. Retain local Thread mappings,
    // but discard obsolete Bot-deletion checkpoints that claimed native cleanup.
    name: "0012-remove-native-session-deletion-checkpoints",
    migrate: removeNativeDeletionCheckpoints,
  },
  {
    // Keep the feature-ledger name while converging to the newer archiveless
    // Bot contract. Databases that already removed the columns are unchanged.
    name: "0013-restore-bot-archive-lifecycle",
    migrate: removeBotArchiveLifecycle,
  },
  {
    // Reassert the checked-in renderer contract after every historical path.
    name: "0014-enforce-current-avatar-recipes",
    sql: CURRENT_AVATAR_REPAIR_SQL,
  },
  {
    // Every divergent ledger converges on Surface-scoped authority while the
    // newer local-deletion and archiveless contracts remain authoritative.
    name: "0015-converge-bot-screen-persistence",
    migrate: (db, cfg) => {
      removeBotArchiveLifecycle(db);
      removeNativeDeletionCheckpoints(db);
      db.exec(`
CREATE TABLE IF NOT EXISTS computer_surface_coordination (
  surface_id TEXT PRIMARY KEY REFERENCES bot_surfaces(surface_id) ON DELETE CASCADE,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('idle', 'agent', 'web', 'takeover')),
  controller_epoch INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO computer_surface_coordination (surface_id, authority_kind, controller_epoch, updated_at)
SELECT bot_surfaces.surface_id, 'idle', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bot_surfaces
WHERE NOT EXISTS (
  SELECT 1
  FROM computer_surface_coordination
  WHERE computer_surface_coordination.surface_id = bot_surfaces.surface_id
);
${CURRENT_AVATAR_REPAIR_SQL}
`);
      removeUnreferencedSnapshotFiles(db, cfg);
    },
  },
  {
    name: "0016-bot-display-settings",
    sql: `
ALTER TABLE bots ADD COLUMN show_tool_calls INTEGER NOT NULL DEFAULT 0
  CHECK (show_tool_calls IN (0, 1));
ALTER TABLE bots ADD COLUMN show_thinking INTEGER NOT NULL DEFAULT 0
  CHECK (show_thinking IN (0, 1));
`,
  },
  {
    // Bot-authored text predates the ordered transcript contract. Give each
    // orphaned record a stable terminal Turn, then promote it in place so
    // message identity, ordering, attachments, content, and time are retained.
    name: "0017-ordered-transcript-repair",
    sql: `
INSERT INTO turns (
  id, thread_id, bot_id, status, worker_session_id, native_session_id,
  steer_count, started_at, finished_at, outcome_reason
)
SELECT
  'legacy-turn-' || messages.id,
  messages.thread_id,
  threads.bot_id,
  'completed',
  NULL,
  '',
  0,
  messages.created_at,
  messages.created_at,
  NULL
FROM messages
JOIN threads ON threads.id = messages.thread_id
WHERE messages.author_kind = 'bot'
  AND messages.kind = 'text'
  AND messages.turn_id IS NULL;

UPDATE messages
SET kind = 'response',
    payload = NULL,
    turn_id = COALESCE(turn_id, 'legacy-turn-' || id),
    block_id = 'legacy-response-' || id,
    block_state = 'completed',
    block_started_at = created_at,
    block_completed_at = created_at
WHERE author_kind = 'bot'
  AND kind = 'text';
`,
  },
  {
    // Durable Bot mail is a queue with an explicit crash boundary, not an
    // event-log projection. One source Tool Call owns at most one exchange.
    name: "0018-durable-bot-mail",
    sql: `
CREATE TABLE bot_mail_deliveries (
  id TEXT PRIMARY KEY,
  source_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  source_turn_id TEXT NOT NULL,
  source_tool_call_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  target_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'dispatching', 'delivered', 'failed')),
  target_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_turn_id, source_tool_call_id)
);
CREATE INDEX idx_bot_mail_deliveries_dispatch
  ON bot_mail_deliveries(target_bot_id, state, created_at);
`,
  },
  {
    name: "0019-legacy-tool-call-summaries",
    migrate: (db) => {
      // Keep native history private on the owning Message; only the whitelisted
      // summary is served. Bot deletion still removes all locally owned data.
      if (!columnNames(db, "messages").has("legacy_tool_data")) {
        db.exec(`ALTER TABLE messages ADD COLUMN legacy_tool_data TEXT`);
      }
      const rows = db.query<{
        id: string;
        thread_id: string;
        payload: string;
        text: string | null;
        created_at: string;
        turn_id: string | null;
      }, []>(
        `SELECT id, thread_id, payload, text, created_at, turn_id
         FROM messages WHERE kind = 'tool' AND author_kind = 'bot' AND json_valid(payload)`,
      ).all();
      const bindHistoricalTurn = db.query(
        `INSERT INTO turns (
           id, thread_id, bot_id, status, worker_session_id, native_session_id,
           steer_count, started_at, finished_at, outcome_reason
         )
         SELECT ?, id, bot_id, 'failed', NULL, '', 0, ?, NULL,
                'Historical Tool Call has no recorded Turn outcome.'
         FROM threads WHERE id = ?`,
      );
      const update = db.query(
        `UPDATE messages
         SET legacy_tool_data = COALESCE(legacy_tool_data, ?),
             payload = ?, text = NULL, turn_id = COALESCE(turn_id, ?)
         WHERE id = ?`,
      );
      for (const row of rows) {
        const payload: unknown = JSON.parse(row.payload);
        if (isToolCallSummary(payload)) continue;
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
        const legacy = payload as Record<string, unknown>;
        // Recognize the historical native event envelope, not arbitrary invalid
        // summaries. Unknown shapes remain subject to the strict reader.
        if (
          typeof legacy.toolId !== "string" || legacy.toolId.length === 0 ||
          typeof legacy.name !== "string" || legacy.name.length === 0 ||
          (legacy.state !== "running" && legacy.state !== "complete" && legacy.state !== "completed" && legacy.state !== "error") ||
          (legacy.isError !== undefined && typeof legacy.isError !== "boolean") ||
          ((legacy.state === "complete" || legacy.state === "completed") && legacy.isError === undefined)
        ) continue;
        const failed = legacy.isError === true || legacy.state === "error";
        const interrupted = !failed && legacy.state === "running";
        const summary: ToolCallSummary = {
          id: legacy.toolId,
          name: legacy.name,
          status: failed || interrupted ? "error" : "completed",
          ...(failed ? { errorSummary: "Tool call failed." } : {}),
          ...(interrupted ? { errorSummary: TOOL_CALL_INTERRUPTED_ERROR_SUMMARY } : {}),
        };
        // An unbound historical call needs a terminal binding for the current
        // schema, but its Tool outcome does not establish a successful Turn.
        const turnId = row.turn_id ?? `legacy-turn-${row.id}`;
        if (row.turn_id === null) bindHistoricalTurn.run(turnId, row.created_at, row.thread_id);
        update.run(
          JSON.stringify({ payload: row.payload, text: row.text }),
          JSON.stringify(summary),
          turnId,
          row.id,
        );
      }
    },
  },
  {
    // Controller epochs live in the Screen input lease. Restarts are fenced by
    // runtime generation, so the persisted counter is unused.
    name: "0020-drop-controller-epoch",
    migrate: (db) => {
      if (!columnNames(db, "computer_surface_coordination").has("controller_epoch")) return;
      db.exec(`
CREATE TABLE computer_surface_coordination_next (
  surface_id TEXT PRIMARY KEY REFERENCES bot_surfaces(surface_id) ON DELETE CASCADE,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('idle', 'agent', 'web', 'takeover')),
  updated_at TEXT NOT NULL
);
INSERT INTO computer_surface_coordination_next (surface_id, authority_kind, updated_at)
SELECT surface_id, authority_kind, updated_at FROM computer_surface_coordination;
DROP TABLE computer_surface_coordination;
ALTER TABLE computer_surface_coordination_next RENAME TO computer_surface_coordination;
`);
    },
  },
  {
    // Paired Device tokens and one-time pairings codes; only SHA-256 hashes are stored.
    name: "0021-paired-devices",
    sql: `
CREATE TABLE paired_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
];
export function openDb(cfg: Config): Database {
  const db = new Database(cfg.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all().map((r) => r.name));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.name));
  if (pending.length > 0) {
    // SQLite guidance: migrations run with foreign keys OFF (legacy tables are
    // dropped while children still reference them). The pragma is a no-op
    // inside a transaction, so it wraps the whole migration pass.
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      for (const m of pending) {
        const tx = db.transaction(() => {
          applyMigration(db, m, cfg);
          db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(m.name, new Date().toISOString());
        });
        tx();
      }
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    const violations = db.query(`PRAGMA foreign_key_check`).all();
    if (violations.length > 0) throw new Error(`migration left foreign-key violations: ${JSON.stringify(violations)}`);
  } else {
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}
/** Active turns cannot survive a daemon restart; supervised Bot Screens are reconciled separately. */
export function recoverOnStartup(db: Database): void {
  const now = new Date().toISOString();
  db.query(
    `UPDATE messages
     SET payload = json_set(payload, '$.status', 'error', '$.errorSummary', ?)
     WHERE kind = 'tool'
       AND json_extract(payload, '$.status') = 'running'
       AND turn_id IN (
         SELECT id FROM turns WHERE status NOT IN ('completed','cancelled','failed')
       )`,
  ).run(TOOL_CALL_INTERRUPTED_ERROR_SUMMARY);
  db.query(`DELETE FROM messages WHERE kind IN ('response', 'thinking') AND block_state = 'streaming'`).run();
  db.query(`UPDATE turns SET status='failed', finished_at=?, outcome_reason='daemon restart' WHERE status NOT IN ('completed','cancelled','failed')`).run(now);
  db.query(`UPDATE bot_deletions SET state='failed', failure_json=?, updated_at=? WHERE state='cleaning'`)
    .run(JSON.stringify([{ stage: "database", resource: "daemon", message: "daemon restarted during permanent deletion" }]), now);
  db.query(`UPDATE agents SET status='offline', reason='daemon restarted during check', updated_at=? WHERE status='checking'`).run(now);
}
