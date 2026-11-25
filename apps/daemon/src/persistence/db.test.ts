import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigration, MIGRATIONS, recoverOnStartup } from "./db.ts";

test("startup preserves working Turns with a conversation mapping or a durable submission", () => {
  using db = new Database(":memory:");
  for (const migration of MIGRATIONS) applyMigration(db, migration);
  db.exec(`
    INSERT INTO bots (id, name, agent_id, created_at, updated_at) VALUES ('bot', 'Bot', 'pi', '', '');
    INSERT INTO threads (id, bot_id, title, created_at, updated_at) VALUES
      ('mapped', 'bot', 'Mapped', '', ''), ('unmapped', 'bot', 'Unmapped', '', '');
    INSERT INTO pi_thread_conversations VALUES ('mapped', 'bot', 1, '');
    INSERT INTO turns (id, thread_id, bot_id, native_session_id, status, started_at) VALUES
      ('working-mapped', 'mapped', 'bot', '', 'working', ''),
      ('working-unmapped', 'unmapped', 'bot', '', 'working', ''),
      ('with-submission', 'unmapped', 'bot', '', 'working', '');
    INSERT INTO pi_turn_submissions VALUES ('with-submission', 1, 'input', '');
  `);

  recoverOnStartup(db);

  expect(db.query("SELECT id, status, outcome_reason FROM turns ORDER BY id").all()).toEqual([
    { id: "with-submission", status: "working", outcome_reason: null },
    { id: "working-mapped", status: "working", outcome_reason: null },
    { id: "working-unmapped", status: "failed", outcome_reason: "daemon restart" },
  ]);
});
