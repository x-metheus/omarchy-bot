import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";

const [threadId, botId, tool, filePath] = Bun.argv.slice(2);
if (!threadId || !botId || !filePath || (tool !== "read" && tool !== "write" && tool !== "edit")) {
  throw new Error("Expected a Thread ID, Bot ID, file tool, and path");
}

const state: unknown = JSON.parse(readFileSync(path.join(import.meta.dirname, ".daemon.json"), "utf8"));
if (state === null || typeof state !== "object" || !("runDir" in state) || typeof state.runDir !== "string") {
  throw new Error("Missing isolated e2e daemon run directory");
}

// The Service has no route for creating approvals. Seed only the row in the
// isolated database and let the real Service list it, answer it, and emit the resolution.
using db = new Database(path.join(state.runDir, "data", "db.sqlite"), { create: false });
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
const id = crypto.randomUUID();
const now = Date.now();
db.query(`
  INSERT INTO approvals (
    id, task_id, call_id, conversation_id, thread_id, bot_id, turn_id,
    tool, path, folder, status, created_at, expires_at
  ) VALUES (
    ?, COALESCE((SELECT MIN(task_id) FROM approvals WHERE task_id < 0), 0) - 1, ?, 0, ?, ?, NULL,
    ?, ?, ?, 'pending', ?, ?
  )
`).run(id, id, threadId, botId, tool, filePath, path.dirname(filePath),
  new Date(now).toISOString(), new Date(now + 60 * 60 * 1000).toISOString());
console.log(id);
