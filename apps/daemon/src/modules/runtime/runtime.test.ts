import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBotRuntime } from "./runtime.ts";

test("runtime creates durable tables and can close and reopen", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-runtime-"));
  const dbPath = path.join(directory, "service.sqlite");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = await openBotRuntime(dbPath);
      try {
        const db = new Database(dbPath, { readonly: true });
        try {
          const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*'").all();
          expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
            "pi_durable_schema",
            "pi_durable_metadata",
            "pi_record_ids",
            "pi_conversations",
            "pi_entries",
            "pi_tasks",
            "pi_submissions",
            "pi_documents",
            "pi_document_revisions",
          ]));
        } finally {
          db.close();
        }
      } finally {
        await runtime.close();
        await expect(runtime.close()).resolves.toBeUndefined();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
