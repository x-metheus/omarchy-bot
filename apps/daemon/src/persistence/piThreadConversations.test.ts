import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigration, MIGRATIONS } from "./db.ts";

describe("pi thread conversation migration", () => {
  test("indexes conversations per thread and bot and cascades thread deletion", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON; CREATE TABLE threads (id TEXT PRIMARY KEY); CREATE TABLE bots (id TEXT PRIMARY KEY);");
      const migration = MIGRATIONS.find((item) => item.name === "0023-pi-thread-conversations");
      expect(migration).toBeDefined();
      applyMigration(db, migration!);
      db.exec("INSERT INTO threads VALUES ('thread'); INSERT INTO bots VALUES ('bot1'), ('bot2');");
      db.exec("INSERT INTO pi_thread_conversations VALUES ('thread', 'bot1', 101, 'now'), ('thread', 'bot2', 102, 'now');");
      expect(db.query("SELECT conversation_id FROM pi_thread_conversations ORDER BY bot_id").all()).toEqual([
        { conversation_id: 101 }, { conversation_id: 102 },
      ]);
      expect(() => db.exec("INSERT INTO pi_thread_conversations VALUES ('thread', 'bot1', 103, 'now')")).toThrow();
      db.exec("DELETE FROM threads WHERE id = 'thread'");
      expect(db.query("SELECT * FROM pi_thread_conversations").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
