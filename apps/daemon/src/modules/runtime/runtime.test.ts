import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Harness } from "@earendil-works/pi-durable";
import { CredentialStore } from "./credentials.ts";
import { openBotRuntime } from "./runtime.ts";

test("runtime creates durable tables and can close and reopen", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-runtime-"));
  const dbPath = path.join(directory, "service.sqlite");
  const stateDir = path.join(directory, "state");
  const store = new CredentialStore(stateDir);
  store.add({ id: "openai", name: "OpenAI", protocol: "built-in", apiKey: "test-key" });
  expect(existsSync(path.join(stateDir, "model-credentials.json"))).toBe(true);
  expect(existsSync(path.join(directory, "model-credentials.json"))).toBe(false);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = await openBotRuntime(dbPath, stateDir);
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

test("runtime opens and creates durable tables with corrupt credentials", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-runtime-corrupt-"));
  const stateDir = path.join(directory, "state");
  const dbPath = path.join(directory, "service.sqlite");
  mkdirSync(stateDir);
  writeFileSync(path.join(stateDir, "model-credentials.json"), "");
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const originalOpen = Harness.open;
  const open = spyOn(Harness, "open").mockImplementation((storage, options, context) => {
    const settings = typeof options.settings === "function" ? options.settings() : options.settings;
    expect(settings?.afterFailedRun).toBe("continue");
    if (typeof options.models === "function") {
      options.models();
      options.models();
    }
    return originalOpen.call(Harness, storage, options, context);
  });
  try {
    const runtime = await openBotRuntime(dbPath, stateDir);
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*'").all();
        expect(tables.map(({ name }) => name)).toContain("pi_durable_schema");
      } finally { db.close(); }
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith("Unable to load model credential store; continuing without stored providers");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("test-key");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("apiKey");
    } finally { await runtime.close(); }
  } finally { open.mockRestore(); warning.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
