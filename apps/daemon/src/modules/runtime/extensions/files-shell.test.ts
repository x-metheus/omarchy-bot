import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness, ToolResultEntry, type ConversationId, type ConversationView, type ConversationWatch, type LiveState, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { err, ExecutionError, FileError, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { MIGRATIONS } from "../../../persistence/db.ts";
import { setSetting } from "../../../persistence/settings.ts";
import { ApprovalStore } from "../approvals.ts";
import type { BotsService } from "../../bots/bots.ts";
import type { EventLog } from "../../events/eventLog.ts";
import type { ThreadsService } from "../../threads/threads.ts";
import { SecretStore, type SecretBackend } from "../secrets.ts";
import { DurableTranscript } from "../transcript.ts";
import { ALLOWED_FOLDERS_SETTING, readSettingsAllowedFolders } from "../../workspace/allowedFolders.ts";
import { platformPaths, type PlatformPaths } from "../../workspace/paths.ts";
import { classifyFileAccess, createFilesEnvironment, createFilesShellExtension, DEFAULT_BASH_TIMEOUT_SECONDS, type FileApprovals, GUARDED_FILE_METHODS, hasDirectoryAncestor, MAX_BASH_TIMEOUT_SECONDS } from "./files-shell.ts";
import { createSecretsExtension, type BotSecretAccess } from "./secrets.ts";

function directories() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bot-files-shell-")));
  const paths = {
    homeDir: root,
    sharedWorkspaceDir: path.join(root, "workspace"),
    downloadsDir: path.join(root, "Downloads"),
    dataDir: path.join(root, "service-data"),
    stateDir: path.join(root, "service-state"),
  };
  const extra = path.join(root, "extra");
  const sibling = path.join(root, "extra-sibling");
  const outside = path.join(root, "outside");
  const bots = path.join(paths.sharedWorkspaceDir, "bots");
  const owned = path.join(bots, "own-bot");
  const foreign = path.join(bots, "other-bot");
  for (const dir of [...Object.values(paths), extra, sibling, outside, owned, foreign]) mkdirSync(dir, { recursive: true });
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify([extra, paths.dataDir, paths.stateDir]));
  const allowed = readSettingsAllowedFolders(db);
  db.close();
  return {
    ...paths, root, paths, extra, sibling, outside, bots, owned, foreign, allowed,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
type Directories = ReturnType<typeof directories>;

async function withTurn(
  dirs: Omit<Directories, "paths"> & { paths: PlatformPaths },
  calls: { name: string; args: Parameters<typeof fauxToolCall>[1] }[],
  inspect?: (conversation: Awaited<ReturnType<Harness["createConversation"]>>) => Promise<void>,
  options: {
    platform?: NodeJS.Platform;
    cwd?: string;
    unknownBot?: boolean;
    approvals?: FileApprovals;
    secretStore?: SecretStore;
    botId?: string;
    observe?(view: ConversationView): void;
    echoToolResult?: boolean;
  } = {},
) {
  const provider = fauxProvider({ provider: "fake", models: [{ id: "fake-model" }] });
  provider.setResponses([
    ...calls.map(({ name, args }) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })),
    options.echoToolResult ? ({ messages }) => {
      const result = messages.at(-1);
      return fauxAssistantMessage(result?.role === "toolResult"
        ? result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
        : "Finished");
    } : fauxAssistantMessage("Finished"),
  ]);
  const registry = createRegistry();
  let conversationId: ConversationId | undefined;
  const secrets: BotSecretAccess | undefined = options.secretStore && {
    store: options.secretStore,
    botId: (id) => id === conversationId ? options.botId : undefined,
  };
  registry.install(createFilesShellExtension(options.platform, options.approvals, secrets));
  if (secrets) registry.install(createSecretsExtension(secrets));
  const storage = new MemoryStorage();
  const models = createModels();
  models.setProvider(provider.provider);
  const harness = await Harness.open(storage, {
    registry,
    models,
    // Like the runtime, read Settings folders on every call so an "Always allow" applies to the next one.
    env: ({ cwd }) => createFilesEnvironment(dirs.paths, options.approvals?.settingsFolders() ?? dirs.allowed, cwd, options.unknownBot ? undefined : "own-bot"),
  }, context);
  let watch: ConversationWatch | undefined;
  try {
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    conversationId = conversation.id;
    await conversation.configure({ cwd: options.cwd ?? dirs.sharedWorkspaceDir, model: { provider: "fake", modelId: "fake-model" } }, context);
    if (options.observe) {
      watch = await conversation.watch(context);
      options.observe(watch.value);
      watch.start(async (call) => { if (call.kind === "value") options.observe?.(call.value); });
    }
    const submission = await conversation.submit({ type: "input", content: "Run the scripted tool calls" }, context);
    await inspect?.(conversation);
    const settlement = await submission.wait(context);
    const { items } = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const results = items.filter(ToolResultEntry.is).map((item) => {
      const result = item.model?.find((message) => message.role === "toolResult");
      if (!result || result.role !== "toolResult") throw new Error("Missing model tool result");
      return { ...result, diagnostics: item.data.diagnostics, text: result.content.map((content) => content.type === "text" ? content.text : "").join("\n") };
    });
    if (watch) options.observe?.({ ...watch.value, entries: items, docs: {} });
    return { settlement, results, entries: items };
  } finally {
    await watch?.stop();
    await harness.close(context);
    await storage.close(context);
  }
}

function write(target: string) { return { name: "write", args: { path: target, content: "new content" } }; }

function approvalsFor(dirs: Directories) {
  const db = new Database(":memory:");
  db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run("CREATE TABLE turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL)");
  const migration = MIGRATIONS.find((item) => item.name === "0026-durable-approvals");
  if (!migration || !("sql" in migration)) throw new Error("approvals migration missing");
  db.exec(migration.sql);
  setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify(dirs.allowed));
  const events: string[] = [];
  const store = new ApprovalStore(db, { append: (_aggregate, _id, type) => { events.push(type); return undefined as never; } });
  const approvals: FileApprovals = {
    store, paths: dirs.paths, settingsFolders: () => readSettingsAllowedFolders(db), owner: () => ({ threadId: "thread-1", botId: "own-bot" }),
  };
  return { db, store, events, approvals };
}

/** Answer each request as it appears, in order, and report what was asked. */
function answering(store: ApprovalStore, answers: ("allow_once" | "allow_folder" | "deny")[]) {
  const asked: { tool: string; path: string; folder: string }[] = [];
  return {
    asked,
    async inspect() {
      for (const answer of answers) {
        const pending = await (async () => {
          for (let tries = 0; tries < 400; tries++) {
            const [request] = store.listPending();
            if (request) return request;
            await Bun.sleep(5);
          }
          throw new Error("no approval request appeared");
        })();
        asked.push({ tool: pending.tool, path: pending.path, folder: pending.folder });
        store.answer(pending.id, answer);
      }
    },
  };
}

test("scripted Turn writes, edits and reads the Shared Workspace and writes to the other allowed folders", async () => {
  const dirs = directories();
  try {
    const downloadsFile = path.join(dirs.downloadsDir, "download.txt");
    const extraFile = path.join(dirs.extra, "extra.txt");
    const ownedFile = path.join(dirs.owned, "notes.txt");
    const { settlement, results } = await withTurn(dirs, [
      write("draft.txt"),
      { name: "edit", args: { path: "draft.txt", edits: [{ oldText: "new content", newText: "edited content" }] } },
      { name: "read", args: { path: "draft.txt" } },
      write(downloadsFile), write(extraFile), write(ownedFile),
    ]);
    expect(settlement.status).toBe("done");
    expect(results.map(({ isError }) => isError)).toEqual([false, false, false, false, false, false]);
    expect(results[2]?.text).toContain("edited content");
    expect(readFileSync(path.join(dirs.sharedWorkspaceDir, "draft.txt"), "utf8")).toBe("edited content");
    for (const file of [downloadsFile, extraFile, ownedFile]) expect(readFileSync(file, "utf8")).toBe("new content");
  } finally { dirs.close(); }
});

type Denial = (dirs: Directories) => { request: string; target: string; existing?: boolean; directory?: boolean };
const blockedTargets: [string, string, Denial][] = [
  ["outside every allowed folder", "outside the allowed folders", (d) => ({ request: path.join(d.outside, "new.txt"), target: path.join(d.outside, "new.txt") })],
  ["a parent traversal", "outside the allowed folders", (d) => ({ request: "../outside/new.txt", target: path.join(d.outside, "new.txt") })],
  ["a prefix sibling of an allowed folder", "outside the allowed folders", (d) => ({ request: path.join(d.sibling, "new.txt"), target: path.join(d.sibling, "new.txt") })],
  ["a symlink to an outside file", "outside the allowed folders", (d) => {
    const target = path.join(d.outside, "original.txt");
    writeFileSync(target, "original");
    symlinkSync(target, path.join(d.sharedWorkspaceDir, "link.txt"), "file");
    return { request: "link.txt", target, existing: true };
  }],
  ["a symlink to an outside directory", "outside the allowed folders", (d) => {
    const target = path.join(d.outside, "original.txt");
    writeFileSync(target, "original");
    symlinkSync(d.outside, path.join(d.sharedWorkspaceDir, "link"), "dir");
    return { request: "link/original.txt", target, existing: true };
  }],
  ["a symlinked ancestor of a non-existent target", "outside the allowed folders", (d) => {
    symlinkSync(d.outside, path.join(d.sharedWorkspaceDir, "link"), "dir");
    return { request: "link/not-created/file.txt", target: path.join(d.outside, "not-created") };
  }],
  ["the Service data directory", "Service data directory", (d) => ({ request: path.join(d.dataDir, "new.txt"), target: path.join(d.dataDir, "new.txt") })],
  ["the Service state directory", "Service state directory", (d) => ({ request: path.join(d.stateDir, "new.txt"), target: path.join(d.stateDir, "new.txt") })],
  ["the credential store through an alias", "credential store", (d) => {
    const target = path.join(d.stateDir, "model-credentials.json");
    writeFileSync(target, "original");
    symlinkSync(target, path.join(d.sharedWorkspaceDir, "link.txt"), "file");
    return { request: "link.txt", target, existing: true };
  }],
  ["another Bot's private folder", "another Bot's private folder", (d) => ({ request: path.join(d.foreign, "new.txt"), target: path.join(d.foreign, "new.txt") })],
  ["the bots root", "another Bot's private folder", (d) => ({ request: d.bots, target: d.bots, directory: true })],
  ["an unowned entry under bots", "another Bot's private folder", (d) => ({ request: "bots/stray.txt", target: path.join(d.bots, "stray.txt") })],
];
for (const [label, reason, prepare] of blockedTargets) {
  test(`scripted Turn refuses ${label} and leaves the target unchanged`, async () => {
    const dirs = directories();
    try {
      const { request, target, existing, directory } = prepare(dirs);
      const originalDirectory = directory ? readdirSync(target) : undefined;
      const { settlement, results } = await withTurn(dirs, [write(request)]);
      expect(settlement.status).toBe("done");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining(reason) });
      if (originalDirectory) expect(readdirSync(target)).toEqual(originalDirectory);
      else if (existing) expect(readFileSync(target, "utf8")).toBe("original");
      else expect(existsSync(target)).toBe(false);
    } finally { dirs.close(); }
  });
}

test("classification separates approvable outside paths from always-refused locations", () => {
  const dirs = directories();
  try {
    const classify = (input: string) => classifyFileAccess(dirs.paths, dirs.allowed, "own-bot", dirs.sharedWorkspaceDir, input);
    symlinkSync(dirs.outside, path.join(dirs.sharedWorkspaceDir, "link"), "dir");
    expect(classify("draft.txt")).toEqual({ kind: "allowed", path: path.join(dirs.sharedWorkspaceDir, "draft.txt") });
    expect(classify(path.join(dirs.outside, "new.txt"))).toEqual({ kind: "outside", path: path.join(dirs.outside, "new.txt") });
    // The request names the canonical target, not the alias the Bot used.
    expect(classify("link/missing/file.txt")).toEqual({ kind: "outside", path: path.join(dirs.outside, "missing", "file.txt") });
    for (const [input, reason] of [[path.join(dirs.dataDir, "x"), "Service data directory"], [path.join(dirs.stateDir, "x"), "Service state directory"], [path.join(dirs.foreign, "x"), "another Bot's private folder"]] as const) {
      expect(classify(input)).toEqual({ kind: "refused", message: expect.stringContaining(reason) });
    }
  } finally { dirs.close(); }
});

test("a grant allows exactly one outside file and never a refused location", async () => {
  const dirs = directories();
  try {
    const granted = path.join(dirs.outside, "granted.txt");
    const refused = path.join(dirs.dataDir, "granted.txt");
    const env = createFilesEnvironment(dirs.paths, dirs.allowed, dirs.sharedWorkspaceDir, "own-bot", [granted, refused]);
    expect((await env.writeFile(granted, "approved", context)).ok).toBe(true);
    expect(readFileSync(granted, "utf8")).toBe("approved");
    const sibling = await env.writeFile(path.join(dirs.outside, "sibling.txt"), "no", context);
    expect(sibling.ok ? undefined : sibling.error.message).toContain("outside the allowed folders");
    const data = await env.writeFile(refused, "no", context);
    expect(data.ok ? undefined : data.error.message).toContain("Service data directory");
    expect(existsSync(path.join(dirs.outside, "sibling.txt")) || existsSync(refused)).toBe(false);
  } finally { dirs.close(); }
});

test("an outside write waits for Allow once and asks again for the next file in that folder", async () => {
  const dirs = directories();
  const { db, store, events, approvals } = approvalsFor(dirs);
  try {
    const first = path.join(dirs.outside, "first.txt");
    const second = path.join(dirs.outside, "second.txt");
    const answers = answering(store, ["allow_once", "allow_once"]);
    const { settlement, results } = await withTurn(dirs, [write(first), write(second)], async () => {
      await answers.inspect();
    }, { approvals });
    expect(settlement.status).toBe("done");
    expect(answers.asked).toEqual([{ tool: "write", path: first, folder: dirs.outside }, { tool: "write", path: second, folder: dirs.outside }]);
    expect(results.map(({ isError }) => isError)).toEqual([false, false]);
    expect(readFileSync(first, "utf8")).toBe("new content");
    expect(readFileSync(second, "utf8")).toBe("new content");
    expect(readSettingsAllowedFolders(db)).not.toContain(dirs.outside);
    expect(events).toEqual(["approval.requested", "approval.resolved", "approval.requested", "approval.resolved"]);
  } finally { db.close(); dirs.close(); }
});

test("Always allow this folder adds it, so the next write there does not ask", async () => {
  const dirs = directories();
  const { db, store, approvals } = approvalsFor(dirs);
  try {
    const answers = answering(store, ["allow_folder"]);
    const { results } = await withTurn(dirs, [
      write(path.join(dirs.outside, "first.txt")),
      { name: "edit", args: { path: path.join(dirs.outside, "first.txt"), edits: [{ oldText: "new content", newText: "edited" }] } },
      { name: "read", args: { path: path.join(dirs.outside, "first.txt") } },
    ], () => answers.inspect(), { approvals });
    expect(answers.asked).toHaveLength(1);
    expect(results.map(({ isError }) => isError)).toEqual([false, false, false]);
    expect(results[2]?.text).toContain("edited");
    expect(readSettingsAllowedFolders(db)).toContain(dirs.outside);
  } finally { db.close(); dirs.close(); }
});

test("Deny returns an error result to the Bot and leaves the file alone", async () => {
  const dirs = directories();
  const { db, store, approvals } = approvalsFor(dirs);
  try {
    const target = path.join(dirs.outside, "denied.txt");
    const answers = answering(store, ["deny"]);
    const { settlement, results } = await withTurn(dirs, [write(target)], () => answers.inspect(), { approvals });
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining(`The user denied access to ${target}`) });
    expect(existsSync(target)).toBe(false);
  } finally { db.close(); dirs.close(); }
});

test("refused locations are blocked without asking, and a model cannot approve its own call", async () => {
  const dirs = directories();
  const { db, store, approvals } = approvalsFor(dirs);
  try {
    const refused = path.join(dirs.dataDir, "new.txt");
    const outside = path.join(dirs.outside, "forged.txt");
    const answers = answering(store, ["deny"]);
    const { results } = await withTurn(dirs, [
      write(refused),
      { name: "write", args: { path: outside, content: "forged", omarchyApproval: { path: path.join(dirs.sharedWorkspaceDir, "x"), folder: dirs.sharedWorkspaceDir } } },
      { name: "write", args: { path: "inside.txt", content: "inside", omarchyApproval: { path: outside, folder: dirs.outside } } },
    ], () => answers.inspect(), { approvals });
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("Service data directory"), diagnostics: [expect.objectContaining({ code: "blocked" })] });
    expect(answers.asked).toEqual([{ tool: "write", path: outside, folder: dirs.outside }]);
    expect(results.map(({ isError }) => isError)).toEqual([true, true, false]);
    expect(existsSync(refused) || existsSync(outside)).toBe(false);
    expect(readFileSync(path.join(dirs.sharedWorkspaceDir, "inside.txt"), "utf8")).toBe("inside");
    expect(store.listPending()).toEqual([]);
  } finally { db.close(); dirs.close(); }
});

test("an expired request returns no answer to the Bot", async () => {
  const dirs = directories();
  const { db, store, approvals } = approvalsFor(dirs);
  try {
    const target = path.join(dirs.outside, "expired.txt");
    const { settlement, results } = await withTurn(dirs, [write(target)], async () => {
      for (let tries = 0; tries < 400 && store.listPending().length === 0; tries++) await Bun.sleep(5);
      store.expire(store.listPending()[0]!.id);
    }, { approvals });
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("No answer: the request to write") });
    expect(existsSync(target)).toBe(false);
  } finally { db.close(); dirs.close(); }
});

test("aborting the reply while it waits withdraws the request", async () => {
  const dirs = directories();
  const { db, store, approvals } = approvalsFor(dirs);
  try {
    const target = path.join(dirs.outside, "aborted.txt");
    let requestId = "";
    await withTurn(dirs, [write(target)], async (conversation) => {
      for (let tries = 0; tries < 400 && store.listPending().length === 0; tries++) await Bun.sleep(5);
      requestId = store.listPending()[0]!.id;
      await conversation.abort(context);
    }, { approvals });
    expect(store.get(requestId)?.status).toBe("cancelled");
    expect(existsSync(target)).toBe(false);
  } finally { db.close(); dirs.close(); }
});

test("a replayed write or edit does not apply its change twice", async () => {
  const dirs = directories();
  const { db, approvals } = approvalsFor(dirs);
  try {
    const extension = createFilesShellExtension(process.platform, approvals);
    // The tools differ in argument types; this test passes each one its own valid arguments.
    const tool = (name: string) => extension.tools!.find((item) => item.name === name)! as unknown as { execute(args: object, api: never, ctx: typeof context): Promise<ToolExecutionResult> };
    const target = path.join(dirs.sharedWorkspaceDir, "replayed.txt");
    const env = createFilesEnvironment(dirs.paths, dirs.allowed, dirs.sharedWorkspaceDir, "own-bot");
    const memos = new Map<string, unknown>();
    const api = (taskId: number) => ({
      env, taskId, callId: `call-${taskId}`, conversationId: 1,
      memo: async (name: string, candidate: unknown) => { const key = `${taskId}:${name}`; if (!memos.has(key)) memos.set(key, candidate); return memos.get(key); },
    }) as never;
    const text = (result: ToolExecutionResult) => Array.isArray(result.output) ? result.output.map((item) => item.type === "text" ? item.text : "").join("") : String(result.output ?? "");

    expect(text(await tool("write").execute({ path: target, content: "a" }, api(1), context))).toContain("Successfully wrote");
    writeFileSync(target, "a");
    // The rerun of task 1 finds its change landed and does not rewrite the file.
    const before = readFileSync(target);
    const rerun = await tool("write").execute({ path: target, content: "a" }, api(1), context);
    expect(rerun.isError).toBeFalsy();
    expect(readFileSync(target)).toEqual(before);

    const edit = { path: target, edits: [{ oldText: "a", newText: "aa" }] };
    expect((await tool("edit").execute(edit, api(2), context)).isError).toBeFalsy();
    expect(readFileSync(target, "utf8")).toBe("aa");
    const replayed = await tool("edit").execute(edit, api(2), context);
    expect(replayed).toMatchObject({ isError: true });
    expect(text(replayed)).toContain("changed while this edit was interrupted");
    expect(readFileSync(target, "utf8")).toBe("aa");
  } finally { db.close(); dirs.close(); }
});

test("an unmapped conversation can use the Workspace but cannot use any Bot private folder", async () => {
  const dirs = directories();
  try {
    symlinkSync(dirs.bots, path.join(dirs.sharedWorkspaceDir, "bots-alias"), "junction");
    symlinkSync(dirs.bots, path.join(dirs.foreign, "escape"), "junction");
    const { settlement, results } = await withTurn(dirs, [
      write("draft.txt"), write("bots/own-bot/plain.txt"), write("bots-alias/own-bot/alias.txt"),
      write("bots/other-bot/escape/own-bot/nested.txt"),
    ], undefined, { unknownBot: true });
    expect(settlement.status).toBe("done");
    expect(results.map(({ isError }) => isError)).toEqual([false, true, true, true]);
    for (const result of results.slice(1)) expect(result.text.includes("another Bot's private folder")).toBe(true);
    expect(readFileSync(path.join(dirs.sharedWorkspaceDir, "draft.txt"), "utf8")).toBe("new content");
    for (const file of ["plain.txt", "alias.txt", "nested.txt"]) expect(existsSync(path.join(dirs.owned, file))).toBe(false);
  } finally { dirs.close(); }
});

test("a nested bots alias cannot traverse a foreign folder to reach the current Bot's own folder", async () => {
  const dirs = directories();
  try {
    symlinkSync(dirs.bots, path.join(dirs.foreign, "escape"), "junction");
    const target = path.join(dirs.owned, "ok.txt");
    const denied = await withTurn(dirs, [write("bots/other-bot/escape/own-bot/ok.txt")]);
    expect(denied.settlement.status).toBe("done");
    expect(denied.results[0]).toMatchObject({ isError: true, text: expect.stringContaining("another Bot's private folder") });
    expect(existsSync(target)).toBe(false);
    const allowed = await withTurn(dirs, [write("bots/own-bot/ok.txt")]);
    expect(allowed.settlement.status).toBe("done");
    expect(allowed.results[0]?.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("new content");
  } finally { dirs.close(); }
});

test("a bots alias outside the private tree allows the current Bot's own folder", async () => {
  const dirs = directories();
  try {
    symlinkSync(dirs.bots, path.join(dirs.sharedWorkspaceDir, "bots-alias"), "junction");
    const { settlement, results } = await withTurn(dirs, [write("bots-alias/own-bot/ok.txt")]);
    expect(settlement.status).toBe("done");
    expect(results[0]?.isError).toBe(false);
    expect(readFileSync(path.join(dirs.owned, "ok.txt"), "utf8")).toBe("new content");
  } finally { dirs.close(); }
});

test("the environment validates cwd, tilde paths and both sides of symlinked Bot paths", async () => {
  const dirs = directories();
  try {
    const escapedCwd = path.join(dirs.sharedWorkspaceDir, "escaped-cwd");
    symlinkSync(dirs.outside, escapedCwd, "dir");
    const { results } = await withTurn(dirs, [write(path.join(dirs.extra, "new.txt"))], undefined, { cwd: escapedCwd });
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("cwd") });
    expect(existsSync(path.join(dirs.extra, "new.txt"))).toBe(false);
    const env = createFilesEnvironment(dirs.paths, dirs.allowed, dirs.sharedWorkspaceDir, "own-bot");
    const homeRelativeAllowed = path.relative(os.homedir(), path.join(dirs.extra, "file.txt"));
    const homeRelativeDenied = path.relative(os.homedir(), path.join(dirs.outside, "file.txt"));
    if (!path.isAbsolute(homeRelativeAllowed)) {
      expect(await env.absolutePath(`~/${homeRelativeAllowed}`, context)).toEqual({ ok: true, value: path.join(dirs.extra, "file.txt") });
      expect(await env.absolutePath(`~/${homeRelativeDenied}`, context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }
    symlinkSync(dirs.foreign, path.join(dirs.owned, "foreign"), "dir");
    symlinkSync(dirs.extra, path.join(dirs.foreign, "extra"), "dir");
    for (const candidate of ["bots/own-bot/foreign/file.txt", "bots/other-bot/extra/file.txt"]) {
      expect(await env.absolutePath(candidate, context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    }
  } finally { dirs.close(); }
});

test("an allowed symlinked directory forwards its canonical target, even if the link is swapped before write", async () => {
  const dirs = directories();
  const link = path.join(dirs.sharedWorkspaceDir, "link");
  symlinkSync(dirs.extra, link, "dir");
  const target = path.join(dirs.extra, "new.txt");
  const originalWrite = NodeExecutionEnv.prototype.writeFile;
  const writeFile = spyOn(NodeExecutionEnv.prototype, "writeFile").mockImplementation(function (this: NodeExecutionEnv, file, contents, ctx) {
    unlinkSync(link);
    symlinkSync(dirs.outside, link, "dir");
    return originalWrite.call(this, file, contents, ctx);
  });
  try {
    const env = createFilesEnvironment(dirs.paths, dirs.allowed);
    expect(await env.absolutePath("link/new.txt", context)).toEqual({ ok: true, value: target });
    expect(await env.writeFile("link/new.txt", "safe", context)).toEqual({ ok: true, value: undefined });
    expect(writeFile).toHaveBeenCalledWith(target, "safe", context);
    expect(readFileSync(target, "utf8")).toBe("safe");
    expect(existsSync(path.join(dirs.outside, "new.txt"))).toBe(false);
    expect(await env.writeFile("link/refused.txt", "bad", context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(existsSync(path.join(dirs.outside, "refused.txt"))).toBe(false);
  } finally { writeFile.mockRestore(); dirs.close(); }
});

test("rename and watch forward every path in canonical form", async () => {
  const dirs = directories();
  const rename = spyOn(NodeExecutionEnv.prototype, "renameFile");
  const watch = spyOn(NodeExecutionEnv.prototype, "watch").mockResolvedValue(err(new FileError("unknown", "test watch")));
  try {
    symlinkSync(dirs.extra, path.join(dirs.sharedWorkspaceDir, "link"), "dir");
    const source = path.join(dirs.extra, "old.txt");
    const destination = path.join(dirs.extra, "new.txt");
    writeFileSync(source, "original");
    const env = createFilesEnvironment(dirs.paths, dirs.allowed);
    expect(await env.renameFile("link/old.txt", "link/new.txt", context)).toEqual({ ok: true, value: undefined });
    expect(rename).toHaveBeenCalledWith(source, destination, context);
    expect(readFileSync(destination, "utf8")).toBe("original");
    const onChange = () => {};
    await env.watch([{ path: "link/old.txt" }, { path: "link/new.txt", recursive: true }], onChange, context);
    expect(watch).toHaveBeenCalledWith([{ path: source }, { path: destination, recursive: true }], onChange, context);
  } finally { rename.mockRestore(); watch.mockRestore(); dirs.close(); }
});

test("every pi-durable filesystem method guards the paths it forwards", async () => {
  const dirs = directories();
  try {
    const env = createFilesEnvironment(dirs.paths, dirs.allowed);
    expect(env.id).toBe(new NodeExecutionEnv({ cwd: dirs.sharedWorkspaceDir }).id);
    const outside = path.join(dirs.outside, "file.txt");
    const inside = path.join(dirs.sharedWorkspaceDir, "file.txt");
    const args = {
      absolutePath: [outside, context], openTextLineReader: [outside, context], readTextFile: [outside, context],
      readTextLines: [outside, undefined, context], readBinaryFile: [outside, context], openBinaryReader: [outside, undefined, context],
      writeFile: [outside, "test", context], appendFile: [outside, "test", context], truncateFile: [outside, 0, context],
      flushFile: [outside, context], renameFile: [outside, inside, context], fileInfo: [outside, context], listDir: [outside, context],
      openDirReader: [outside, context], canonicalPath: [outside, context], exists: [outside, context],
      createDir: [outside, undefined, context], remove: [outside, { force: true }, context], watch: [[{ path: inside }, { path: outside }], () => {}, context],
    } satisfies Record<(typeof GUARDED_FILE_METHODS)[number], unknown[]>;
    const methods = Object.getOwnPropertyNames(NodeExecutionEnv.prototype).filter((name) => !["constructor", "joinPath", "exec", "createTempDir", "createTempFile", "cleanup"].includes(name));
    expect(methods.sort()).toEqual([...GUARDED_FILE_METHODS].sort());
    for (const method of GUARDED_FILE_METHODS) {
      const result: Result<unknown, FileError> = await Reflect.apply(env[method], env, args[method]);
      expect(result, method).toMatchObject({ ok: false, error: { code: "permission_denied", path: outside } });
    }
    expect(await env.renameFile(inside, outside, context)).toMatchObject({ ok: false, error: { code: "permission_denied", path: outside } });
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(outside)).toBe(false);
  } finally { dirs.close(); }
});

test("bash passes the default, requested and capped seconds to the execution environment", async () => {
  const dirs = directories();
  const exec = spyOn(NodeExecutionEnv.prototype, "exec").mockResolvedValue(err(new ExecutionError("timeout", "time limit")));
  try {
    const { settlement, results } = await withTurn(dirs, [
      { name: "bash", args: { command: "pwd" } },
      { name: "bash", args: { command: "pwd", timeout: 0.25 } },
      { name: "bash", args: { command: "pwd", timeout: 700 } },
    ], undefined, { platform: "linux" });
    expect(settlement.status).toBe("done");
    expect(exec.mock.calls.map(([, options]) => options?.timeout)).toEqual([DEFAULT_BASH_TIMEOUT_SECONDS, 0.25, MAX_BASH_TIMEOUT_SECONDS]);
    expect(results.map(({ text }) => text)).toEqual([120, 0.25, 600].map((seconds) => expect.stringContaining(`timed out after ${seconds} seconds`)));
  } finally { exec.mockRestore(); dirs.close(); }
});

function fakeSecretStore(dirs: Directories) {
  const values = new Map<string, string>();
  const backend: SecretBackend = {
    kind: "keychain",
    async get(account) { return values.get(account); },
    async set(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
  return new SecretStore(dirs.dataDir, { backend, probe: async () => ({ available: true }) });
}

const tokenPlaceholder = "{{secret:token}}";
const printToken = { name: "bash", args: { command: `printf '%s' '${tokenPlaceholder}'` } };

test.skipIf(process.platform === "win32")("bash keeps an out-of-band Bot secret out of entries, messages, console output, and events", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const value = "store-only-token-sentinel";
  const exec = spyOn(NodeExecutionEnv.prototype, "exec");
  const consoleCalls: unknown[][] = [];
  const consoleSpies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args) => { consoleCalls.push(args); }));
  const messages: unknown[] = [];
  const events: unknown[] = [];
  const views: ConversationView[] = [];
  const threads = Object.assign({} as ThreadsService, {
    listMessages: () => messages,
    appendMessage: (_threadId: string, message: unknown) => { messages.push(message); },
    appendResponseDelta: (_threadId: string, _turnId: string, _blockId: string, delta: string) => {
      const message = { text: delta };
      messages.push(message);
      return message;
    },
    completeResponse: () => undefined,
  });
  const eventLog = { append: (...args: unknown[]) => { events.push(args); } } as unknown as EventLog;
  let transcript: DurableTranscript | undefined;
  try {
    await secretStore.forBot("bot-a").save("token", "Service token", value);
    const { entries, results, settlement } = await withTurn(dirs, [printToken], undefined, {
      secretStore, botId: "bot-a", echoToolResult: true,
      observe(view) {
        views.push(view);
        transcript ??= new DurableTranscript(threads, {} as BotsService, eventLog, "thread", "bot-a", "turn", view);
        transcript.update(view);
      },
    });
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: false, text: tokenPlaceholder });
    expect(exec.mock.calls.some(([command]) => typeof command === "string" && command.includes(value))).toBe(true);
    expect(exec.mock.calls[0]?.[1]?.spill).toBeUndefined();
    expect(JSON.stringify(entries)).toContain(JSON.stringify(printToken.args.command));
    expect(JSON.stringify(messages)).toContain(tokenPlaceholder);
    expect(JSON.stringify(events)).toContain(tokenPlaceholder);
    for (const observed of [entries, views, messages, events]) {
      expect(JSON.stringify(observed).includes(value)).toBe(false);
    }
    expect(inspect(consoleCalls, { showHidden: true, depth: null, maxArrayLength: Infinity, maxStringLength: Infinity }).includes(value)).toBe(false);
  } finally {
    exec.mockRestore();
    for (const spy of consoleSpies) spy.mockRestore();
    dirs.close();
  }
});

test.skipIf(process.platform === "win32")("secrets and bash cannot list, delete, or use another Bot's or the app's secrets", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const botValue = "bot-a-token-sentinel";
  const appValue = "app-token-sentinel";
  try {
    await secretStore.forBot("bot-a").save("token", "Bot token", botValue);
    await secretStore.forApp().save("token", "App token", appValue);
    const { entries, results } = await withTurn(dirs, [
      { name: "secrets", args: { action: "list" } },
      { name: "secrets", args: { action: "delete", name: "token" } },
      printToken,
    ], undefined, { secretStore, botId: "bot-b" });
    expect(results[0]).toMatchObject({ isError: false, text: "[]" });
    expect(results[2]).toMatchObject({ isError: true, text: `Missing secret: ${tokenPlaceholder}` });
    expect(await secretStore.getBotSecretForRuntime("bot-a", "token")).toBe(botValue);
    expect(await secretStore.getAppSecretForRuntime("token")).toBe(appValue);
    expect(JSON.stringify(entries).includes(botValue) || JSON.stringify(entries).includes(appValue)).toBe(false);
  } finally { dirs.close(); }
});

test("secrets saves, lists metadata, and deletes model-supplied values", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const metadata = { name: "token", description: "Service token" };
  const value = "model-supplied-token-sentinel";
  try {
    const { results } = await withTurn(dirs, [
      { name: "secrets", args: { action: "save", ...metadata, value } },
      { name: "secrets", args: { action: "list" } },
    ], undefined, { secretStore, botId: "bot-a" });
    expect(results.map(({ isError }) => isError)).toEqual([false, false]);
    expect(JSON.parse(results[0]!.text)).toEqual(metadata);
    expect(JSON.parse(results[1]!.text)).toEqual([metadata]);
    expect(JSON.stringify(results).includes(value)).toBe(false);
    expect(await secretStore.getBotSecretForRuntime("bot-a", "token")).toBe(value);
    const { results: afterDelete } = await withTurn(dirs, [
      { name: "secrets", args: { action: "delete", name: "token" } },
      { name: "secrets", args: { action: "list" } },
    ], undefined, { secretStore, botId: "bot-a" });
    expect(afterDelete.map(({ isError }) => isError)).toEqual([false, false]);
    expect(JSON.parse(afterDelete[1]!.text)).toEqual([]);
    expect(await secretStore.getBotSecretForRuntime("bot-a", "token")).toBeUndefined();
  } finally { dirs.close(); }
});

test.each(["file", "keychain"])("secrets reports the first %s-backed save without returning the value", async (backend) => {
  const dirs = directories();
  const secretStore = backend === "file" ? new SecretStore(dirs.dataDir) : fakeSecretStore(dirs);
  const metadata = { name: "token", description: "Service token" };
  const value = "file-save-token-sentinel";
  try {
    const { results } = await withTurn(dirs, [
      { name: "secrets", args: { action: "save", ...metadata, value } },
    ], undefined, { secretStore, botId: "bot-a" });
    const result = results[0]!;
    expect(result.isError).toBe(false);
    const expectedLines = [JSON.stringify(metadata)];
    if (backend === "file") {
      expectedLines.push("Warning — No OS keychain is available. This secret is stored in a private plaintext file readable by your user, including commands run by a Bot.");
    }
    expect(result.text.includes(value)).toBeFalse();
    expect(result.text.split("\n")).toEqual(expectedLines);
    expect(await secretStore.getBotSecretForRuntime("bot-a", "token") === value).toBeTrue();
  } finally { dirs.close(); }
});

test("secrets rejects a malformed save without copying the value into the result or diagnostics", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const value = "malformed-save-token-sentinel";
  try {
    const { results } = await withTurn(dirs, [
      { name: "secrets", args: { action: "save", name: "INVALID NAME", description: "Service token", value } },
    ], undefined, { secretStore, botId: "bot-a" });
    const result = results[0]!;
    expect(result.isError).toBe(true);
    expect(result.text.includes(value)).toBe(false);
    expect(JSON.stringify(result.diagnostics).includes(value)).toBe(false);
    expect(result.diagnostics).toContainEqual({ severity: "error", code: "invalid_arguments", message: "Invalid secrets arguments." });
    expect(await secretStore.forBot("bot-a").list()).toEqual([]);
  } finally { dirs.close(); }
});

test.skipIf(process.platform === "win32")("bash withholds split secret output until the redacted final result", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const value = "split-output-token-sentinel";
  const streamed: string[] = [];
  try {
    await secretStore.forBot("bot-a").save("token", "Service token", value);
    const { results, entries } = await withTurn(dirs, [{ name: "bash", args: {
      command: 'printf "prefix:%s" "${TOKEN:0:8}"; sleep 0.2; printf "%s:end" "${TOKEN:8}"; sleep 0.3',
      env: { TOKEN: tokenPlaceholder },
    } }], undefined, {
      secretStore, botId: "bot-a",
      observe(view) {
        for (const slot of (view.docs["pi.live"] as LiveState | undefined)?.tools ?? []) {
          if (slot.status === "running" && slot.output) streamed.push(slot.output);
        }
      },
    });
    expect(streamed).toEqual([]);
    expect(results[0]).toMatchObject({ isError: false, text: `prefix:${tokenPlaceholder}:end` });
    expect(JSON.stringify(entries)).toContain(`"TOKEN":"${tokenPlaceholder}"`);
    expect(JSON.stringify(entries).includes(value)).toBe(false);
  } finally { dirs.close(); }
});

test.skipIf(process.platform === "win32")("bash streams output when no secret is used", async () => {
  const dirs = directories();
  const streamed: string[] = [];
  try {
    const { results } = await withTurn(dirs, [
      { name: "bash", args: { command: 'printf "ordinary output"; sleep 0.3' } },
    ], undefined, {
      observe(view) {
        for (const slot of (view.docs["pi.live"] as LiveState | undefined)?.tools ?? []) {
          if (slot.status === "running" && slot.output) streamed.push(slot.output);
        }
      },
    });
    expect(streamed).toContain("ordinary output");
    expect(results[0]).toMatchObject({ isError: false, text: "ordinary output" });
  } finally { dirs.close(); }
});

test.skipIf(process.platform === "win32")("bash keeps only a bounded tail and omits spill files when it uses a secret", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const exec = spyOn(NodeExecutionEnv.prototype, "exec");
  try {
    await secretStore.forBot("bot-a").save("token", "Service token", "bounded-output-token-sentinel");
    const { results } = await withTurn(dirs, [{ name: "bash", args: {
      command: 'printf "%052000d\\n%s" 0 "$TOKEN"',
      env: { TOKEN: tokenPlaceholder },
    } }], undefined, { secretStore, botId: "bot-a" });
    expect(results[0]).toMatchObject({
      isError: false,
      content: [{ type: "text", text: tokenPlaceholder }, expect.objectContaining({ type: "text" })],
      diagnostics: [expect.objectContaining({ code: "truncated" })],
    });
    expect(exec.mock.calls[0]?.[1]?.spill).toBeUndefined();
  } finally { exec.mockRestore(); dirs.close(); }
});

test.skipIf(process.platform === "win32")("bash redacts secret values that the output sanitizer would reassemble", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const value = "sanitized-output-token-sentinel";
  try {
    await secretStore.forBot("bot-a").save("token", "Service token", value);
    const { entries, results } = await withTurn(dirs, [{ name: "bash", args: {
      command: 'printf "%s\\\\033[32m%s" "${TOKEN:0:8}" "${TOKEN:8}"',
      env: { TOKEN: tokenPlaceholder },
    } }], undefined, { secretStore, botId: "bot-a" });
    expect(JSON.stringify(entries).includes(value)).toBe(false);
    expect(results[0]).toMatchObject({ isError: false, text: tokenPlaceholder });
  } finally { dirs.close(); }
});

test("bash redacts shell failure messages and diagnostics", async () => {
  const dirs = directories();
  const secretStore = fakeSecretStore(dirs);
  const value = "shell-failure-token-sentinel";
  const error = new ExecutionError("spawn_error", `Cannot execute ${value}`, new Error(value));
  error.spillPath = `/tmp/${value}`;
  const exec = spyOn(NodeExecutionEnv.prototype, "exec").mockResolvedValue(err(error));
  try {
    await secretStore.forBot("bot-a").save("token", "Service token", value);
    const { entries, results } = await withTurn(dirs, [printToken], undefined, { platform: "linux", secretStore, botId: "bot-a" });
    expect(results[0]).toMatchObject({
      isError: true,
      text: expect.stringContaining(`Cannot execute ${tokenPlaceholder}`),
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "full_output", message: `Full output: /tmp/${tokenPlaceholder}` })]),
    });
    expect(JSON.stringify(entries).includes(value)).toBe(false);
  } finally { exec.mockRestore(); dirs.close(); }
});

test.skipIf(process.platform === "win32")("bash starts with PATH and excludes the Service environment marker", async () => {
  const dirs = directories();
  const key = "OMARCHY_BASH_ENV_TEST_MARKER";
  const previous = process.env[key];
  process.env[key] = "service-only-sentinel";
  try {
    const { results } = await withTurn(dirs, [{ name: "bash", args: { command: "env" } }]);
    expect(results[0]?.isError).toBe(false);
    expect(/^PATH=.+$/m.test(results[0]?.text ?? "")).toBe(true);
    expect(results[0]?.text.includes(key)).toBe(false);
    expect(process.env[key]).toBe("service-only-sentinel");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    dirs.close();
  }
});

const processCommand = 'echo "$$" > shell.pid; sleep 60 & echo "$!" > child.pid; wait';
async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 2500;
  for (;;) {
    try { assertion(); return; } catch (error) { if (Date.now() >= deadline) throw error; }
    await Bun.sleep(20);
  }
}
function pidFiles(dirs: Directories) {
  return ["shell.pid", "child.pid"].map((file) => {
    const contents = readFileSync(path.join(dirs.sharedWorkspaceDir, file), "utf8").trim();
    expect(contents).toMatch(/^\d+$/);
    return Number(contents);
  });
}
async function expectDead(pids: number[]) {
  await waitFor(() => {
    for (const pid of pids) {
      const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
      expect(stat.exitCode === 1 || stat.stdout.toString().trimStart().startsWith("Z")).toBe(true);
    }
  });
}

test.skipIf(process.platform === "win32")("bash starts in the Shared Workspace and a shorter timeout kills a runaway process group", async () => {
  const dirs = directories();
  try {
    const start = performance.now();
    const { settlement, results } = await withTurn(dirs, [
      { name: "bash", args: { command: "pwd" } },
      { name: "bash", args: { command: processCommand, timeout: 0.5 } },
    ]);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(settlement.status).toBe("done");
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.text.trim()).toBe(dirs.sharedWorkspaceDir);
    expect(results[1]).toMatchObject({ isError: true, text: expect.stringContaining("timed out after 0.5 seconds") });
    await expectDead(pidFiles(dirs));
  } finally { dirs.close(); }
});

test.skipIf(process.platform === "win32")("aborting the Turn aborts bash and kills the running shell and child", async () => {
  const dirs = directories();
  try {
    let pids: number[] = [];
    const { settlement, results } = await withTurn(dirs, [{ name: "bash", args: { command: processCommand } }], async (conversation) => {
      await waitFor(() => { pids = pidFiles(dirs); });
      await conversation.abort(context);
    });
    expect(settlement).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringMatching(/aborted/i) });
    await expectDead(pids);
  } finally { dirs.close(); }
});

test("the bash tool reports a clear Windows error without invoking the shell", async () => {
  const dirs = directories();
  const exec = spyOn(NodeExecutionEnv.prototype, "exec");
  try {
    const { settlement, results } = await withTurn(dirs, [{ name: "bash", args: { command: "pwd" } }], undefined, { platform: "win32" });
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("bash is unsupported on Windows") });
    expect(exec).not.toHaveBeenCalled();
  } finally { exec.mockRestore(); dirs.close(); }
});

test("disabling Downloads denies a scripted write elsewhere in the home directory", async () => {
  const dirs = directories();
  try {
    const config = path.join(dirs.root, ".config");
    mkdirSync(config);
    writeFileSync(path.join(config, "user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/"\n');
    const paths = { ...dirs.paths, downloadsDir: platformPaths({ platform: "linux", home: dirs.root, env: {} }).downloadsDir };
    const target = path.join(dirs.root, "home-only.txt");
    const { settlement, results } = await withTurn({ ...dirs, paths, allowed: [] }, [write(target)]);
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("outside the allowed folders") });
    expect(existsSync(target)).toBe(false);
  } finally { dirs.close(); }
});

test("the first write creates missing allowed folders without granting access to their ancestors", async () => {
  const dirs = directories();
  try {
    rmSync(dirs.downloadsDir, { recursive: true });
    const extra = path.join(dirs.extra, "missing-parent", "configured-folder");
    const paths = { ...dirs.paths };
    const download = path.join(dirs.downloadsDir, "nested", "file.txt");
    const configured = path.join(extra, "nested", "file.txt");
    const downloadsParent = path.dirname(dirs.downloadsDir);
    const db = new Database(":memory:");
    db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify([extra]));
    const allowed = readSettingsAllowedFolders(db);
    db.close();
    const { settlement, results } = await withTurn({ ...dirs, paths, allowed }, [
      write(download), write(configured), { name: "read", args: { path: downloadsParent } },
    ]);
    expect(settlement.status).toBe("done");
    expect(results.map(({ isError }) => isError)).toEqual([false, false, true]);
    expect(results[2]?.text).toContain("outside the allowed folders");
    for (const file of [download, configured]) expect(readFileSync(file, "utf8")).toBe("new content");
    const env = createFilesEnvironment(paths, allowed);
    expect(await env.canonicalPath(downloadsParent, context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(await env.listDir(downloadsParent, context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
  } finally { dirs.close(); }
});

test.each(["read", "edit"])("%s refuses existing protected content and leaves it unchanged", async (name) => {
  const dirs = directories();
  try {
    const target = path.join(dirs.foreign, "notes.txt");
    writeFileSync(target, "private content");
    const args = name === "read" ? { path: target } : { path: target, edits: [{ oldText: "private content", newText: "changed" }] };
    const { settlement, results } = await withTurn(dirs, [{ name, args }]);
    expect(settlement.status).toBe("done");
    expect(results).toHaveLength(1);
    expect(results[0]!.text.includes("private content")).toBe(false);
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("another Bot's private folder") });
    expect(readFileSync(target, "utf8")).toBe("private content");
  } finally { dirs.close(); }
});

test("directory identity follows a symlinked and dotted spelling without matching a sibling", () => {
  const dirs = directories();
  try {
    const link = path.join(dirs.extra, "bots-alias");
    symlinkSync(dirs.bots, link, "junction");
    expect(hasDirectoryAncestor(dirs.bots, `${link}${path.sep}.${path.sep}other-bot${path.sep}missing.txt`)).toBe(true);
    expect(hasDirectoryAncestor(dirs.bots, path.join(dirs.extra, "bots-sibling", "missing.txt"))).toBe(false);
  } finally { dirs.close(); }
});

function caseInsensitiveFilesystem(): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), "bot-case-probe-"));
  try {
    mkdirSync(path.join(root, "Bots"));
    return existsSync(path.join(root, "bots"));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test.skipIf(!caseInsensitiveFilesystem())("alternate-case bots spelling cannot reach another Bot's private folder", async () => {
  const dirs = directories();
  try {
    const { settlement, results } = await withTurn(dirs, [write("Bots/other-bot/new.txt")]);
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("another Bot's private folder") });
    expect(existsSync(path.join(dirs.foreign, "new.txt"))).toBe(false);
  } finally { dirs.close(); }
});

test.each(["remove", "rename source", "rename destination", "watch"])("%s refuses a directory containing a protected root", async (operation) => {
  const dirs = directories();
  const refusalProbe = err<void, FileError>(new FileError("unknown", "operation reached the inner environment"));
  const remove = spyOn(NodeExecutionEnv.prototype, "remove").mockResolvedValue(refusalProbe);
  const rename = spyOn(NodeExecutionEnv.prototype, "renameFile").mockResolvedValue(refusalProbe);
  const watch = spyOn(NodeExecutionEnv.prototype, "watch").mockResolvedValue(err(new FileError("unknown", "test watch")));
  try {
    const protectedFile = path.join(dirs.foreign, "protected.txt");
    const source = path.join(dirs.extra, "source");
    mkdirSync(source);
    writeFileSync(protectedFile, "private content");
    const env = createFilesEnvironment(dirs.paths, dirs.allowed);
    const workspace = dirs.sharedWorkspaceDir;
    const operations = {
      remove: () => env.remove(workspace, { recursive: true }, context),
      "rename source": () => env.renameFile(workspace, path.join(dirs.extra, "moved"), context),
      "rename destination": () => env.renameFile(source, workspace, context),
      watch: () => env.watch([{ path: dirs.extra }, { path: workspace, recursive: true }], () => {}, context),
    };
    const result = await operations[operation as keyof typeof operations]();
    expect(result).toMatchObject({ ok: false, error: { code: "permission_denied", message: expect.stringContaining("another Bot's private folder") } });
    expect(readFileSync(protectedFile, "utf8")).toBe("private content");
    expect(remove).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
  } finally { remove.mockRestore(); rename.mockRestore(); watch.mockRestore(); dirs.close(); }
});

test.skipIf(process.platform !== "linux" || !Bun.which("setsid"))("bash settles by its deadline when a detached descendant keeps emitting to its pipe", async () => {
  const dirs = directories();
  const detachedPid = path.join(dirs.sharedWorkspaceDir, "detached.pid");
  const cleanup = spyOn(NodeExecutionEnv.prototype, "cleanup");
  try {
    const start = performance.now();
    const command = `setsid sh -c 'echo $$ > detached.pid; i=0; while [ "$i" -lt 100 ]; do printf .; sleep 0.05; i=$((i+1)); done' & wait`;
    const { settlement, results } = await withTurn(dirs, [{ name: "bash", args: { command, timeout: 1 } }]);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(settlement.status).toBe("done");
    expect(results[0]).toMatchObject({ isError: true, text: expect.stringContaining("Command timed out after 1 seconds") });
    const pid = Number(readFileSync(detachedPid, "utf8").trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(cleanup).toHaveBeenCalled();
  } finally {
    cleanup.mockRestore();
    if (existsSync(detachedPid)) {
      const pid = Number(readFileSync(detachedPid, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* The fixture may have exited. */ }
      }
    }
    dirs.close();
  }
}, 10000);

test("a late Downloads alias to home grants only explicit Settings folders", async () => {
  const dirs = directories();
  try {
    rmSync(dirs.downloadsDir, { recursive: true });
    const paths = platformPaths({ platform: "linux", env: {}, home: dirs.root });
    expect(paths.downloadsDir).toBe(dirs.downloadsDir);
    const configured = { ...dirs.paths, homeDir: paths.homeDir, downloadsDir: paths.downloadsDir };
    symlinkSync(dirs.root, dirs.downloadsDir, "junction");
    const db = new Database(":memory:");
    db.run("CREATE TABLE service_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify([dirs.extra]));
    const allowed = readSettingsAllowedFolders(db);
    setSetting(db, ALLOWED_FOLDERS_SETTING, JSON.stringify([dirs.downloadsDir]));
    const explicitDownloads = readSettingsAllowedFolders(db);
    db.close();
    const privateFile = path.join(dirs.root, "home-only.txt");
    const settingsFile = path.join(dirs.extra, "settings.txt");
    const turn = await withTurn({ ...dirs, paths: configured, allowed }, [write(privateFile), write(settingsFile)]);
    expect(turn.settlement.status).toBe("done");
    expect(turn.results[0]).toMatchObject({ isError: true, text: expect.stringContaining("outside the allowed folders") });
    expect(existsSync(privateFile)).toBe(false);
    expect(turn.results[1]?.isError).toBe(false);
    expect(readFileSync(settingsFile, "utf8")).toBe("new content");
    const explicit = createFilesEnvironment(configured, explicitDownloads);
    expect(await explicit.writeFile(privateFile, "explicit grant", context)).toEqual({ ok: true, value: undefined });
    expect(readFileSync(privateFile, "utf8")).toBe("explicit grant");
  } finally { dirs.close(); }
});

test("credential and fallback secret identities refuse allowed aliases and hard links", async () => {
  const dirs = directories();
  try {
    const protectedFile = path.join(dirs.extra, "credential-target.json");
    writeFileSync(protectedFile, "private credentials");
    symlinkSync(protectedFile, path.join(dirs.stateDir, "model-credentials.json"), "file");
    symlinkSync(dirs.extra, path.join(dirs.sharedWorkspaceDir, "alias"), "junction");
    const hardLink = path.join(dirs.extra, "credential-alias.json");
    linkSync(protectedFile, hardLink);
    const fallback = path.join(dirs.dataDir, "secrets", "secret-values.json");
    mkdirSync(path.dirname(fallback));
    writeFileSync(fallback, "private fallback values");
    const fallbackLink = path.join(dirs.extra, "secret-link.json");
    const fallbackAlias = path.join(dirs.extra, "renamed.json");
    linkSync(fallback, fallbackLink);
    renameSync(fallbackLink, fallbackAlias);
    const { settlement, results } = await withTurn(dirs, [write("alias/credential-target.json"), write(hardLink), write("alias/renamed.json")]);
    expect(settlement.status).toBe("done");
    expect(results.map(({ isError }) => isError)).toEqual([true, true, true]);
    for (const result of results) expect(result.text.includes("credential store")).toBe(true);
    expect(readFileSync(protectedFile, "utf8")).toBe("private credentials");
    expect(readFileSync(hardLink, "utf8")).toBe("private credentials");
    expect(readFileSync(fallbackAlias, "utf8")).toBe("private fallback values");
  } finally { dirs.close(); }
});

test("a symlinked Workspace preserves own-folder access across equivalent roots and refuses sibling Bots", async () => {
  const dirs = directories();
  try {
    const workspaceAlias = path.join(dirs.root, "workspace-alias");
    symlinkSync(dirs.sharedWorkspaceDir, workspaceAlias, "junction");
    const botsAlias = path.join(dirs.extra, "bots-alias");
    symlinkSync(dirs.bots, botsAlias, "junction");
    symlinkSync(dirs.owned, path.join(dirs.bots, "foreign-link"), "junction");
    const paths = { ...dirs.paths, sharedWorkspaceDir: workspaceAlias };
    const lexical = path.join(workspaceAlias, "bots", "own-bot", "absolute.txt");
    const identityAlias = path.join(botsAlias, "own-bot", "relative.txt");
    const sibling = path.join(workspaceAlias, "bots", "other-bot", "denied.txt");
    const { settlement, results } = await withTurn({ ...dirs, paths }, [
      write("bots/own-bot/relative.txt"),
      { name: "read", args: { path: "bots/own-bot/relative.txt" } },
      write(lexical),
      { name: "read", args: { path: lexical } },
      { name: "read", args: { path: identityAlias } },
      write(sibling), write(path.join(botsAlias, "foreign-link", "denied.txt")),
    ], undefined, { cwd: workspaceAlias });
    expect(settlement.status).toBe("done");
    expect(results.map(({ isError }) => isError)).toEqual([false, false, false, false, false, true, true]);
    for (const index of [1, 3, 4]) expect(results[index]!.text).toContain("new content");
    for (const result of results.slice(5)) expect(result.text.includes("another Bot's private folder")).toBe(true);
    for (const file of ["relative.txt", "absolute.txt"]) expect(readFileSync(path.join(dirs.owned, file), "utf8")).toBe("new content");
    expect(existsSync(path.join(dirs.owned, "denied.txt"))).toBe(false);
    expect(existsSync(sibling)).toBe(false);
  } finally { dirs.close(); }
});
