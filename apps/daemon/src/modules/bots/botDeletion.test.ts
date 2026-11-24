import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIGRATIONS, applyMigration } from "../../persistence/db.ts";
import { EventLog } from "../events/eventLog.ts";
import { SecretStore, type SecretBackend } from "../runtime/secrets.ts";
import { BotDeletionService } from "./botDeletion.ts";

async function withBotDeletion(run: (fixture: {
  deletions: BotDeletionService;
  secrets: SecretStore;
  privateFolder: string;
  failSecretDeletion: () => void;
  allowSecretDeletion: () => void;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "bot-deletion-"));
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) applyMigration(db, migration);
    db.run("INSERT INTO bots (id, name, instructions, agent_id, avatar_kind, created_at, updated_at) VALUES ('first', 'First', '', 'pi', 'generated', '', '')");
    db.run("INSERT INTO bot_surfaces (surface_id, bot_id, transitioned_at) VALUES ('surf_00000000000000000000000000000000', 'first', '')");
    const privateFolder = path.join(dir, "bots", "first");
    mkdirSync(privateFolder, { recursive: true });
    const values = new Map<string, string>();
    let rejectDelete = false;
    const backend: SecretBackend = {
      kind: "keychain",
      async get(account) { return values.get(account); },
      async set(account, value) { values.set(account, value); },
      async delete(account) {
        if (rejectDelete) throw new Error("keychain failure");
        values.delete(account);
      },
    };
    const secrets = new SecretStore(path.join(dir, "data"), backend);
    await secrets.forBot("first").save("token", "First Bot token", "first-value");
    await secrets.forBot("second").save("token", "Second Bot token", "second-value");
    const deletions = new BotDeletionService(
      db, new EventLog(db), { deleteOwnedFiles: () => ({ removed: 0, failures: [] }) },
      { deleteUploadedFile: async () => {} },
      { abortTurn: async () => {}, waitForTerminal: async () => { throw new Error("No active turn"); } },
      { activeTurnIdsForBot: () => [] }, { destroy: async () => {} }, dir, { secrets },
    );
    await run({ deletions, secrets, privateFolder, failSecretDeletion: () => { rejectDelete = true; }, allowSecretDeletion: () => { rejectDelete = false; } });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("permanent deletion removes only the deleted Bot's private secrets", () => withBotDeletion(async ({ deletions, secrets }) => {
  expect(await deletions.delete("first")).toMatchObject({ status: "deleted", removed: { secrets: 1 } });
  expect(await secrets.forBot("first").list()).toEqual([]);
  expect(await secrets.getBotSecretForRuntime("first", "token")).toBeUndefined();
  expect(await secrets.getBotSecretForRuntime("second", "token")).toBe("second-value");
}));

test("secret deletion failure preserves the private folder and allows retry", () => withBotDeletion(async ({ deletions, secrets, privateFolder, failSecretDeletion, allowSecretDeletion }) => {
  failSecretDeletion();
  expect(await deletions.delete("first")).toMatchObject({
    status: "failed", removed: { secrets: 0, privateFolder: false },
    failures: [{ stage: "secrets", resource: "first", message: "Unable to delete secret" }],
  });
  expect(existsSync(privateFolder)).toBeTrue();
  expect(await secrets.getBotSecretForRuntime("first", "token")).toBe("first-value");
  allowSecretDeletion();
  expect(await deletions.delete("first")).toMatchObject({ status: "deleted", removed: { secrets: 1, privateFolder: true } });
  expect(existsSync(privateFolder)).toBeFalse();
}));
