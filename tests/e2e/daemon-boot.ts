/**
 * Bun-side E2E entrypoint. The parent setup provides isolated storage and the
 * fake workers, while this process runs the real daemon main().
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import { loadConfig } from "../../apps/daemon/src/bootstrap/config.ts";
import { main } from "../../apps/daemon/src/bootstrap/main.ts";
import { applyMigration, MIGRATIONS, openDb } from "../../apps/daemon/src/persistence/db.ts";
import { AVATAR_RENDERER_ID } from "../../packages/protocol/src/index.ts";
import { handlePluginCloudRequest } from "../../apps/site/server/plugins.ts";

if (process.env.OMARCHY_BOT_E2E_OAUTH === "1") {
  process.env.PLUGIN_CLOUD_URL = "https://oauth-e2e.invalid";
  process.env.OAUTH_STATE_SECRET = "isolated-oauth-e2e-state-secret-32-bytes";
  process.env.OAUTH_GITHUB_CLIENT_ID = "e2e-github-client";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "e2e-github-secret";
  const originalFetch = globalThis.fetch;
  // Only publisher transport and provider endpoints are substituted; Service HTTP and WebSockets are real.
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://oauth-e2e.invalid") return handlePluginCloudRequest(request);
    if (url.href === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "e2e-provider-token", scope: "read:user repo read:org", token_type: "bearer" });
    if (url.href === "https://api.github.com/user") return Response.json({ id: 12345, login: "e2e-github-person" });
    return originalFetch(request);
  }, { preconnect: originalFetch.preconnect });
}

const dataDir = process.env.OMARCHY_BOT_HOME;
if (dataDir === undefined) throw new Error("OMARCHY_BOT_HOME is required for E2E startup");
const cfg = loadConfig();
const legacyDb = new Database(path.join(dataDir, "db.sqlite"), { create: true });
legacyDb.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
for (const migration of MIGRATIONS) {
  if (migration.name === "0010-bot-computer-surfaces") break;
  applyMigration(legacyDb, migration, cfg);
  legacyDb.query(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`).run(
    migration.name,
    "2026-09-01T00:00:00.000Z",
  );
}
legacyDb.query(
  `INSERT INTO agents (id, display_name, status, updated_at)
   VALUES ('pi', 'Pi', 'ready', '2026-09-01T00:00:00.000Z')`,
).run();
legacyDb.query(
  `INSERT INTO bots (
     id, name, instructions, agent_id, avatar_kind, avatar_recipe, pinned,
     archived, archived_at, created_at, updated_at, provenance
   ) VALUES (
     'bot_legacy_archived', 'Restored legacy bot', 'Preserved legacy profile', 'pi',
     'generated', ?, 0, 1, '2026-08-31T00:00:00.000Z',
     '2026-08-30T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 'user_created'
   )`,
).run(JSON.stringify({
  rendererVersion: AVATAR_RENDERER_ID,
  style: "shapes",
  seed: "bot_legacy_archived",
  options: {},
}));
legacyDb.query(
  `INSERT INTO bot_state (bot_id, last_activity_at, preview_text)
   VALUES ('bot_legacy_archived', '2026-08-31T00:00:00.000Z', 'Recovered during startup')`,
).run();
legacyDb.close();

// Apply the archive-removal and Bot Surface migrations, then model a database
// whose current avatar-recipe migration needs to be replayed by main().
const MIGRATED_AVATAR_BOT_ID = "bot_00000000000000000000000000000001";
const db = openDb(cfg);
const now = new Date().toISOString();
db.query(
  `INSERT INTO agents (id, display_name, status, updated_at)
   VALUES ('pi', 'Pi', 'ready', ?)
   ON CONFLICT(id) DO NOTHING`,
).run(now);
db.query(
  `INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, avatar_recipe, created_at, updated_at)
   VALUES (?, 'Recovered Avatar Bot', '', 'pi', 'generated', ?, ?, ?)
   ON CONFLICT(id) DO NOTHING`,
).run(
  MIGRATED_AVATAR_BOT_ID,
  JSON.stringify({
    rendererVersion: AVATAR_RENDERER_ID,
    style: "unsupported-migrated-style",
    seed: "incompatible-current-recipe",
    options: {},
  }),
  now,
  now,
);
db.query(`INSERT INTO bot_state (bot_id) VALUES (?) ON CONFLICT(bot_id) DO NOTHING`).run(MIGRATED_AVATAR_BOT_ID);
db.query(
  `INSERT INTO bot_surfaces (surface_id, bot_id, transitioned_at)
   VALUES ('surf_00000000000000000000000000000001', ?, ?)
   ON CONFLICT(bot_id) DO NOTHING`,
).run(MIGRATED_AVATAR_BOT_ID, now);
db.query(`DELETE FROM schema_migrations WHERE name = '0014-enforce-current-avatar-recipes'`).run();
db.close();

const { port } = await main({
  useHostApplicationUnits: false,
  botScreenRuntimeDir: path.join(dataDir, "r"),
});
console.log(`E2E_DAEMON_READY ${port}`);
