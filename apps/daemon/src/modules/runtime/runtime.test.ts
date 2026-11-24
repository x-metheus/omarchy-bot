import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Harness, createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { api, apiStatus, makeBot, sendToBot, sendToThread, startDaemon, waitThreadIdle } from "../../../../../tests/integration/helpers/harness.ts";
import type { DeleteBotResultDto, ThreadDto } from "@omarchy-bot/protocol";
import { setSetting } from "../../persistence/settings.ts";
import { withFakeRuntimeProvider } from "./harness-test-support.ts";
import { CredentialStore, MODEL_CREDENTIALS_FILENAME } from "./credentials.ts";
import { SecretStore } from "./secrets.ts";
import { createRuntimeModels } from "./models.ts";
import { buildSystemPrompt } from "./extensions/prompt.ts";
import { openBotRuntime, type BotRuntime } from "./runtime.ts";
import { openThreadConversation } from "./conversations.ts";
import { ALLOWED_FOLDERS_SETTING } from "../workspace/allowedFolders.ts";

test("runtime creates durable tables and can close and reopen", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-runtime-"));
  const dbPath = path.join(directory, "service.sqlite");
  const stateDir = path.join(directory, "state");
  mkdirSync(stateDir);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = await openBotRuntime({ dbPath, stateDir, homeDir: directory, dataDir: directory, sharedWorkspaceDir: path.join(directory, "workspace"), downloadsDir: path.join(directory, "Downloads") });
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
    expect(settings?.restartLimit).toBe(5);
    if (typeof options.models === "function") {
      options.models();
      options.models();
    }
    return originalOpen.call(Harness, storage, options, context);
  });
  try {
    const runtime = await openBotRuntime({ dbPath, stateDir, homeDir: directory, dataDir: directory, sharedWorkspaceDir: path.join(directory, "workspace"), downloadsDir: path.join(directory, "Downloads") });
    try {
      expect(existsSync(path.join(stateDir, MODEL_CREDENTIALS_FILENAME))).toBeTrue();
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


test("a durable Turn completes with a migrated provider after the legacy file is removed", () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "migrated reply" }] }], {}, async () => {
  const h = await startDaemon(undefined, { legacyModelCredentials: [
    { id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "legacy-fake-key", models: [{ id: "fake-model" }] },
  ] });
  try {
    expect(existsSync(path.join(h.svc.cfg.stateDir, MODEL_CREDENTIALS_FILENAME))).toBeFalse();
    expect((await createRuntimeModels(h.svc.credentials).getAuth("fake"))?.auth.apiKey).toBe("legacy-fake-key");
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");
    const botId = await makeBot(h, "Migrated provider");
    const sent = await sendToBot(h, botId, "Use the migrated provider");
    await waitThreadIdle(h, sent.threadId);
    expect(h.svc.threads.turnRow(sent.turnId)?.status).toBe("completed");
    expect(existsSync(path.join(h.svc.cfg.stateDir, MODEL_CREDENTIALS_FILENAME))).toBeFalse();
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("a durable provider failure redacts app and Bot secrets from the Turn and its status event", () => {
  const apiKey = "test-provider-key-sentinel";
  const mcpToken = "test-mcp-token-sentinel";
  const botToken = "test-bot-token-sentinel";
  const failure = `Provider rejected ${apiKey}, ${mcpToken}, and ${botToken}`;
  return withFakeRuntimeProvider([{ segments: [], failure }], {}, async () => {
    const h = await startDaemon();
    try {
      await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey, models: [{ id: "fake-model" }] });
      const botId = await makeBot(h, "Failed durable");
      const secrets = new SecretStore(h.svc.cfg.dataDir);
      const providerSecret = (await secrets.forApp().list())[0]!.name;
      await secrets.forApp().save("token", "MCP token", mcpToken);
      await secrets.forBot(botId).save("token", "Bot token", botToken);
      setSetting(h.svc.db, "default_model", "fake/fake-model");
      setSetting(h.svc.db, "runtime", "durable");

      const sent = await sendToBot(h, botId, "Run with the fake provider");
      const assertRedactedFailure = async (daemon: typeof h, afterCursor: number) => {
        await waitThreadIdle(daemon, sent.threadId);
        const turn = daemon.svc.threads.turnRow(sent.turnId);
        const events = daemon.svc.events.replay(afterCursor, daemon.svc.events.oldestCursor()).events;
        const failedEvent = events.find((event) => event.type === "turn.status" && event.aggregateId === sent.turnId
          && (event.payload as { to?: string }).to === "failed");
        expect(turn?.status).toBe("failed");
        for (const secret of [apiKey, mcpToken, botToken]) {
          expect(turn?.outcome_reason?.includes(secret)).toBeFalse();
          expect(JSON.stringify(events)).not.toContain(secret);
        }
        const reason = `Provider rejected {{secret:${providerSecret}}}, {{secret:token}}, and {{secret:token}}`;
        expect(turn?.outcome_reason).toContain(reason);
        expect(failedEvent?.payload).toMatchObject({ reason: turn?.outcome_reason });
        return events.at(-1)!.cursor;
      };
      const cursor = await assertRedactedFailure(h, 0);
      // Simulate stopping after the durable submission failed, before the Service recorded that outcome.
      h.svc.db.run("UPDATE turns SET status = 'working', finished_at = NULL, outcome_reason = NULL WHERE id = ?", [sent.turnId]);
      await h.stop();
      const restarted = await startDaemon(h.home);
      try { await assertRedactedFailure(restarted, cursor); }
      finally {
        await restarted.stop();
        rmSync(restarted.svc.cfg.stateDir, { recursive: true, force: true });
      }
    } finally {
      await h.stop();
      rmSync(h.home, { recursive: true, force: true });
      rmSync(h.svc.cfg.stateDir, { recursive: true, force: true });
    }
  });
});

test("runtime imports a healthy legacy provider when another record fails and retains the file", async () => {
  const healthyKey = "test-healthy-key-sentinel";
  const invalidKey = "test-invalid-key-sentinel";
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const h = await startDaemon(undefined, { legacyModelCredentials: [
      { id: invalidKey, name: "Invalid", protocol: "built-in", apiKey: invalidKey },
      { id: "healthy", name: "Healthy", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: healthyKey, models: [{ id: "model" }] },
    ] });
    try {
      const models = createRuntimeModels(h.svc.credentials);
      expect(models.getModel("healthy", "model")?.id).toBe("model");
      expect((await models.getAuth("healthy"))?.auth.apiKey).toBe(healthyKey);
      expect(h.svc.credentials.getForRuntime(invalidKey)).toBeUndefined();
      expect(existsSync(path.join(h.svc.cfg.stateDir, MODEL_CREDENTIALS_FILENAME))).toBeTrue();
      expect(warning).toHaveBeenCalledWith("Unable to migrate some model credentials; keeping the legacy file for retry");
      const events = h.svc.events.replay(0, h.svc.events.oldestCursor()).events;
      const recorded = JSON.stringify([warning.mock.calls, log.mock.calls, error.mock.calls, events]);
      expect(recorded).not.toContain(healthyKey);
      expect(recorded).not.toContain(invalidKey);
    } finally {
      await h.stop();
      rmSync(h.home, { recursive: true, force: true });
      rmSync(h.svc.cfg.stateDir, { recursive: true, force: true });
    }
  } finally { warning.mockRestore(); log.mockRestore(); error.mockRestore(); }
});

test("secret storage status requires authentication and reports the active backend", async () => {
  const h = await startDaemon();
  try {
    expect((await fetch(`${h.baseUrl}/api/secrets/status`)).status).toBe(401);
    expect(await apiStatus(h, "GET", "/api/secrets/status")).toEqual({ status: 200, body: { backend: "file" } });
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
});

test("configured conversation uses the Service limit for unset and null Bots and the Bot override otherwise", () => withFakeRuntimeProvider(Array.from({ length: 3 }, () => ({ segments: [{ type: "text" as const, text: "ok" }] })), {}, async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Default limit");
    const custom = await api<{ id: string }>(h, "POST", "/api/bots", { name: "Custom limit", agentId: "pi", maxTurns: 3 });
    await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
    setSetting(h.svc.db, "default_model", "fake/fake-model");
    setSetting(h.svc.db, "runtime", "durable");
    async function limit(threadId: string): Promise<number | undefined> {
      const storage = await openNodeSqliteStorage(path.join(h.home, "db.sqlite"), { prefix: "pi_" });
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, BACKGROUND_CONTEXT);
      try {
        const indexed = h.svc.db.query<{ conversation_id: number }, [string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ?").get(threadId);
        if (!indexed) throw new Error("Conversation not indexed");
        const conversation = await harness.conversation(indexed.conversation_id as ConversationId, BACKGROUND_CONTEXT);
        if (!conversation) throw new Error("Conversation not found");
        return (await conversation.agent(BACKGROUND_CONTEXT)).maxTurns;
      } finally { await harness.close(BACKGROUND_CONTEXT); await storage.close(BACKGROUND_CONTEXT); }
    }
    const first = await sendToBot(h, botId, "default");
    await waitThreadIdle(h, first.threadId);
    expect(await limit(first.threadId)).toBe(50);
    const second = await sendToBot(h, custom.id, "custom");
    await waitThreadIdle(h, second.threadId);
    expect(await limit(second.threadId)).toBe(3);
    await api(h, "PATCH", `/api/bots/${custom.id}`, { maxTurns: null });
    await sendToThread(h, second.threadId, "reset");
    await waitThreadIdle(h, second.threadId);
    expect(await limit(second.threadId)).toBe(50);
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
}));

test("the model request contains only the app prompt and Shared Workspace Skills", () => {
  const prompts: string[] = [];
  return withFakeRuntimeProvider([{ segments: [{ type: "text", text: "ok" }] }], { onSystemPrompt: (prompt) => prompts.push(prompt) }, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bot-prompt-home-"));
    const workspace = path.join(home, ".omarchy-bot", "workspace");
    const workspaceSkill = [path.join(workspace, ".agents/skills/workspace"), "Workspace Skill", "Workspace skill description sentinel"] as const;
    const globalSkills = [
      [path.join(home, ".pi/agent/skills/global"), "Global Pi Skill", "Global Pi skill sentinel"],
      [path.join(home, ".agents/skills/global"), "Global Agents Skill", "Global Agents skill sentinel"],
    ] as const;
    const legacyWorkspaceSkills = [
      [path.join(workspace, ".pi/skills/workspace"), "Workspace Pi Skill", "Workspace Pi skill sentinel"],
      [path.join(workspace, ".claude/skills/workspace"), "Workspace Claude Skill", "Workspace Claude skill sentinel"],
    ] as const;
    function writeSkill([directory, name, description]: readonly [string, string, string]): void {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nSkill body sentinel\n`);
    }
    globalSkills.forEach(writeSkill);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "AGENTS.md"), "Workspace AGENTS sentinel");
    const previousPiConfigDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi/agent");
    let h: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      h = await startDaemon(home);
      // Boot seeds a starter Skill. Use only the explicit workspace fixtures in this request.
      rmSync(path.join(workspace, ".agents/skills"), { recursive: true, force: true });
      [workspaceSkill, ...legacyWorkspaceSkills].forEach(writeSkill);
      const { id: botId } = await api<{ id: string }>(h, "POST", "/api/bots", { name: "Prompt Bot", agentId: "pi", instructions: "Keep track of releases." });
      await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
      setSetting(h.svc.db, "default_model", "fake/fake-model");
      setSetting(h.svc.db, "runtime", "durable");
      const extraFolder = path.join(home, "extra-files");
      setSetting(h.svc.db, ALLOWED_FOLDERS_SETTING, JSON.stringify([extraFolder]));
      const { threadId } = await sendToBot(h, botId, "Check the releases.");
      await waitThreadIdle(h, threadId);

      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt.match(/^## .+$/gm)).toEqual([
        "## Base Prompt", "## Identity and Job", "## Workspace and private folder", "## Allowed folders", "## Skills",
      ]);
      expect(prompt).toContain("Prompt Bot");
      expect(prompt).toContain("Keep track of releases.");
      expect(prompt).toContain(path.join(workspace, "bots", botId));
      const allowedFolders = [workspace, path.join(home, "Downloads"), extraFolder];
      expect(prompt).toContain(`## Allowed folders\n${allowedFolders.map((folder) => `- ${folder}`).join("\n")}\n\n## Skills`);
      expect(prompt).toContain("Workspace Skill");
      expect(prompt).toContain("Workspace skill description sentinel");
      expect(prompt).toContain(".agents/skills/workspace/SKILL.md");
      for (const [, name, description] of [...globalSkills, ...legacyWorkspaceSkills]) {
        expect(prompt).not.toContain(name);
        expect(prompt).not.toContain(description);
      }
      expect(prompt).not.toContain("Workspace AGENTS sentinel");
      expect(prompt).not.toContain("Skill body sentinel");
      const appPrompt = buildSystemPrompt({
        botName: "Prompt Bot",
        instructions: "Keep track of releases.",
        workspaceDir: workspace,
        privateDir: path.join(workspace, "bots", botId),
        allowedFolders,
        skills: [{ name: "Workspace Skill", description: "Workspace skill description sentinel", path: ".agents/skills/workspace/SKILL.md" }],
      });
      expect(prompt).toBe(`<instructions>\n${appPrompt}\n</instructions>`);
    } finally {
      await h?.stop();
      if (previousPiConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiConfigDir;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

for (const mode of ["worker", "durable"] as const) {
  test(`${mode} creates the private folder on the first Turn, keeps it on rename, and removes it on deletion`, () => withFakeRuntimeProvider([{ segments: [{ type: "text", text: "ok" }] }], {}, async () => {
    const h = await startDaemon();
    try {
      setSetting(h.svc.db, "runtime", mode);
      if (mode === "durable") {
        await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
        setSetting(h.svc.db, "default_model", "fake/fake-model");
      }
      const botId = await makeBot(h, "Before rename");
      const siblingId = await makeBot(h, "Sibling");
      const botsDir = path.join(h.svc.cfg.sharedWorkspaceDir, "bots");
      const privateDir = path.join(botsDir, botId);
      const siblingDir = path.join(botsDir, siblingId);
      expect(existsSync(privateDir)).toBe(false);
      const sent = await sendToBot(h, botId, "say: hello");
      await waitThreadIdle(h, sent.threadId);
      expect(statSync(privateDir).mode & 0o777).toBe(0o700);
      const note = path.join(privateDir, "note.txt");
      writeFileSync(note, "Bot note");
      await api(h, "PATCH", `/api/bots/${botId}`, { name: "After rename" });
      expect(readFileSync(note, "utf8")).toBe("Bot note");
      mkdirSync(siblingDir);
      writeFileSync(path.join(siblingDir, "keep.txt"), "Sibling note");
      const deleted = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
      expect(deleted.status).toBe("deleted");
      expect(deleted.removed.privateFolder).toBe(true);
      expect(existsSync(privateDir)).toBe(false);
      expect(readFileSync(path.join(siblingDir, "keep.txt"), "utf8")).toBe("Sibling note");
    } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
  }));
}

test("deletion refuses to traverse a symlinked bots folder and can retry", async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Delete this Bot");
    const siblingId = await makeBot(h, "Keep this Bot");
    const botsDir = path.join(h.svc.cfg.sharedWorkspaceDir, "bots");
    const siblingDir = path.join(h.svc.cfg.sharedWorkspaceDir, siblingId);
    const note = path.join(siblingDir, botId, "keep.txt");
    mkdirSync(path.dirname(note), { recursive: true });
    writeFileSync(note, "Sibling note");
    symlinkSync(siblingDir, botsDir);
    const response = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
    expect(response.status).toBe(409);
    const blocked = response.body as DeleteBotResultDto;
    expect(blocked.status).toBe("failed");
    expect(blocked.failures[0]?.stage).toBe("private_folder");
    expect(blocked.removed.privateFolder).toBe(false);
    expect(readFileSync(note, "utf8")).toBe("Sibling note");
    rmSync(botsDir);
    const deleted = await api<DeleteBotResultDto>(h, "DELETE", `/api/bots/${botId}`, {});
    expect(deleted.status).toBe("deleted");
    expect(deleted.removed.privateFolder).toBe(false);
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
});

test("an unreadable SKILL.md is skipped and the durable Turn completes", () => {
  const prompts: string[] = [];
  return withFakeRuntimeProvider([{ segments: [{ type: "text", text: "ok" }] }], { onSystemPrompt: (prompt) => prompts.push(prompt) }, async () => {
    const h = await startDaemon();
    try {
      const workspace = h.svc.cfg.sharedWorkspaceDir;
      for (const name of ["Available Skill", "Unreadable Skill"]) {
        const dir = path.join(workspace, ".agents", "skills", name);
        mkdirSync(dir, { recursive: true });
        const skillFile = path.join(dir, "SKILL.md");
        writeFileSync(skillFile, `---\nname: ${name}\ndescription: Skill metadata\n---\n`);
        if (name === "Unreadable Skill") chmodSync(skillFile, 0o000);
      }
      const botId = await makeBot(h, "Skill availability");
      await h.svc.credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model", reasoning: true }] });
      setSetting(h.svc.db, "default_model", "fake/fake-model");
      setSetting(h.svc.db, "runtime", "durable");
      const { threadId } = await sendToBot(h, botId, "Check the available Skills.");
      await waitThreadIdle(h, threadId);
      const thread = await api<ThreadDto>(h, "GET", `/api/threads/${threadId}`);
      expect(thread.latestTurn?.status).toBe("completed");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Available Skill: Skill metadata");
      expect(prompts[0]).not.toContain("Unreadable Skill");
    } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
  });
});

test("the next Turn sets an existing private folder to mode 0700", async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Private folder mode");
    const folder = path.join(h.svc.cfg.sharedWorkspaceDir, "bots", botId);
    mkdirSync(folder, { recursive: true });
    chmodSync(folder, 0o755);
    expect(statSync(folder).mode & 0o777).toBe(0o755);
    writeFileSync(path.join(folder, "note.txt"), "Existing note");
    const { threadId } = await sendToBot(h, botId, "say: check permissions");
    await waitThreadIdle(h, threadId);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(folder, "note.txt"), "utf8")).toBe("Existing note");
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
});

test("deletion refuses a private folder symlink and preserves the sibling Bot's notes", async () => {
  const h = await startDaemon();
  try {
    const botId = await makeBot(h, "Delete this Bot");
    const siblingId = await makeBot(h, "Keep this Bot");
    const botsDir = path.join(h.svc.cfg.sharedWorkspaceDir, "bots");
    const siblingDir = path.join(botsDir, siblingId);
    const note = path.join(siblingDir, "keep.txt");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(note, "Sibling note");
    symlinkSync(siblingDir, path.join(botsDir, botId));
    const response = await apiStatus(h, "DELETE", `/api/bots/${botId}`, {});
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      status: "failed",
      removed: { privateFolder: false },
      failures: [{ stage: "private_folder", resource: botId }],
    });
    expect(readFileSync(note, "utf8")).toBe("Sibling note");
  } finally { await h.stop(); rmSync(h.home, { recursive: true, force: true }); }
});

test.each([false, true])("recovery maps both working Bots before waits and new admissions and resumes even if callbacks throw (%s)", async (throwFromCallbacks) => {
  const root = mkdtempSync(path.join(tmpdir(), "bot-runtime-recovery-mapping-"));
  const paths = {
    dbPath: path.join(root, "durable.sqlite"), homeDir: root,
    dataDir: path.join(root, "data"), stateDir: path.join(root, "state"),
    sharedWorkspaceDir: path.join(root, "workspace"), downloadsDir: path.join(root, "Downloads"),
  };
  const db = new Database(":memory:");
  db.run("CREATE TABLE turns (id TEXT, thread_id TEXT, bot_id TEXT, status TEXT, started_at TEXT)");
  db.run("CREATE TABLE pi_thread_conversations (thread_id TEXT, bot_id TEXT, conversation_id INTEGER, created_at TEXT)");
  db.run("CREATE TABLE pi_turn_submissions (turn_id TEXT, submission_id INTEGER, kind TEXT)");
  db.run("CREATE TABLE messages (id TEXT, thread_id TEXT, turn_id TEXT, kind TEXT, author_kind TEXT, payload TEXT)");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("CREATE TABLE bots (id TEXT PRIMARY KEY, model TEXT)");
  const credentials = await CredentialStore.open(paths.stateDir, new SecretStore(paths.dataDir));
  await credentials.add({ id: "fake", name: "Fake", protocol: "openai-compatible", baseUrl: "http://127.0.0.1", apiKey: "fake-key", models: [{ id: "fake-model" }] });
  const rows = ["first", "second"].map((name, index) => ({
    thread: `thread-${name}`, bot: `bot-${name}`, turn: `turn-${name}`, submission: index + 1,
    privateFile: path.join(paths.sharedWorkspaceDir, "bots", `bot-${name}`, "notes.txt"),
  }));
  const ids: ConversationId[] = [];
  const ctx = BACKGROUND_CONTEXT;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const callerAgentDir = path.join(root, "caller-pi-agent");
  const callerKey = "test-recovery-caller-pi-key";
  let runtime: BotRuntime | undefined;
  let restoreOpen: (() => void) | undefined;
  try {
    mkdirSync(callerAgentDir, { mode: 0o700 });
    writeFileSync(path.join(callerAgentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: callerKey } }), { mode: 0o600 });
    process.env.PI_CODING_AGENT_DIR = callerAgentDir;
    const storage = await openNodeSqliteStorage(paths.dbPath, { prefix: "pi_" });
    const initial = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
    try {
      for (const row of rows) {
        mkdirSync(path.dirname(row.privateFile), { recursive: true });
        writeFileSync(row.privateFile, row.bot);
        const conversation = await openThreadConversation(db, initial, row.thread, row.bot, ctx);
        ids.push(conversation.id);
        db.run("INSERT INTO bots VALUES (?, 'fake/fake-model')", [row.bot]);
        db.run("INSERT INTO turns VALUES (?, ?, ?, 'working', '')", [row.turn, row.thread, row.bot]);
        db.run("INSERT INTO pi_turn_submissions VALUES (?, ?, 'input')", [row.turn, row.submission]);
      }
    } finally { await initial.close(ctx); await storage.close(ctx); }

    const waited: { submission: number; privateAccess: boolean[] }[] = [];
    let resumed = 0;
    let finishSecondOpen!: () => void;
    const schedulerStarted = new Promise<void>((resolve) => { finishSecondOpen = resolve; });
    const freshSubmit = new Error("fresh submission reached the scheduler");
    let freshPrivateAccess: boolean[] | undefined;
    const originalOpen = Harness.open;
    Harness.open = async (storage, options, context) => {
      const harness = await originalOpen.call(Harness, storage, options, context);
      const open = harness.conversation.bind(harness);
      const readPrivateFolders = () => Promise.all(rows.map(async (row, index) => {
        const env = await options.env?.({ conversationId: ids[index]!, read: harness }, ctx);
        return (await env?.readTextFile(row.privateFile, ctx))?.ok ?? false;
      }));
      harness.conversation = async (id, callContext) => {
        if (id === ids[1]) await Promise.race([schedulerStarted, Bun.sleep(250)]);
        const conversation = await open(id, callContext);
        if (id === ids[0] && conversation) {
          conversation.submit = new Proxy(conversation.submit, { async apply() {
            freshPrivateAccess = await readPrivateFolders();
            finishSecondOpen();
            throw freshSubmit;
          } });
        }
        return conversation;
      };
      const resume = harness.resume.bind(harness);
      harness.resume = () => { resumed++; resume(); };
      // A recovered wait can start the global scheduler. Check the env for both conversations at that boundary.
      harness.submission = async (id) => {
        const conversationId = ids[id - 1];
        if (conversationId === undefined) return undefined;
        return {
          id,
          status: async () => ({ id, conversationId, type: "input", status: "queued" }),
          wait: async () => {
            waited.push({ submission: id, privateAccess: await readPrivateFolders() });
            finishSecondOpen();
            return { id, conversationId, type: "input", status: "unanswered", reason: "aborted" };
          },
          abort: async () => "settled",
        };
      };
      return harness;
    };
    restoreOpen = () => { Harness.open = originalOpen; };
    const agentDir = path.join(root, "empty-pi-agent");
    mkdirSync(agentDir, { mode: 0o700 });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    runtime = await openBotRuntime(paths, db);
    const runtimeProviders = runtime.credentials.getAllForRuntime();
    expect(runtimeProviders.some(({ apiKey }) => apiKey === callerKey)).toBeFalse();
    expect(runtimeProviders.map(({ id }) => id)).toEqual(["fake"]);
    expect(resumed).toBe(0);
    const callbackError = new Error("callback failure");
    const registered: string[] = [];
    const settled: string[] = [];
    type Recovery = Parameters<BotRuntime["recoverTurns"]>[0];
    const threads = { listMessages: () => [] } as unknown as Recovery["threads"];
    const bots = { getDto: () => ({ name: "Recovery Bot", maxTurns: null }) } as unknown as Recovery["bots"];
    const events = {} as Recovery["events"];
    const recovery = runtime.recoverTurns({
      db, threads, bots, events,
      registered: (id) => {
        registered.push(id);
        if (throwFromCallbacks) throw callbackError;
      },
      settled: (id, outcome) => {
        settled.push(`${id}:${outcome.status}`);
        if (throwFromCallbacks) throw callbackError;
      },
    });
    if (throwFromCallbacks) {
      await expect(recovery.settled).rejects.toBe(callbackError);
      expect(waited).toEqual([]);
      expect(settled).toEqual([`${rows[0]!.turn}:failed`]);
    } else {
      const [first] = rows;
      const fresh = expect(runtime.startTurn({
        db, threads, bots, events, botId: first!.bot, threadId: first!.thread, turnId: "fresh-turn", text: "Try a fresh Turn",
        instructions: "", workspaceDir: paths.sharedWorkspaceDir, privateDir: path.dirname(first!.privateFile), working() {},
      })).rejects.toBe(freshSubmit);
      await Promise.all([recovery.settled, fresh]);
      expect(freshPrivateAccess).toEqual([true, true]);
      expect(registered).toEqual(rows.map(({ turn }) => turn));
      expect(waited.sort((a, b) => a.submission - b.submission)).toEqual(rows.map(({ submission }) => ({ submission, privateAccess: [true, true] })));
      expect(settled.sort()).toEqual(rows.map(({ turn }) => `${turn}:cancelled`));
    }
    expect(resumed).toBe(1);
  } finally {
    if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    restoreOpen?.();
    await runtime?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
