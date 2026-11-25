import type { Database } from "bun:sqlite";
import type { AgentCommand, NativeMcpControlResult, NativeMcpStatus } from "@omarchy-bot/agent-contract";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import { readAllowedFolders, readSettingsAllowedFolders } from "../workspace/allowedFolders.ts";
import type { PlatformPaths } from "../workspace/paths.ts";
import { openThreadConversation } from "./conversations.ts";
import { seedFirstTurnConversation, transcriptBeforeTurn } from "./sessionMigration.ts";
import { DurableTranscript } from "./transcript.ts";
import { resolveModelForBot } from "./models.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CredentialStore } from "./credentials.ts";
import { ApprovalStore } from "./approvals.ts";
import { createRuntimeModels } from "./models.ts";
import { compactionExtension, compactionSettings } from "./compaction.ts";
import { createFilesEnvironment, createFilesShellExtension, resolveImplicitDownloads } from "./extensions/files-shell.ts";
import { createMcpExtension, type McpExtensionDeps } from "./extensions/mcp.ts";
import { buildSystemPrompt } from "./extensions/prompt.ts";
import { listWorkspaceSkills } from "./extensions/skills.ts";
import { createSecretsExtension, type BotSecretAccess } from "./extensions/secrets.ts";
import { createWebExtension, EXA_SEARCH_KEY_SECRET, readWebExemptRanges } from "./extensions/web.ts";
import { importPiProviders } from "./providerImport.ts";
import { SecretStore } from "./secrets.ts";
import { McpOAuthManager, type McpOAuthManagerDeps } from "./mcpOAuth.ts";
import { AssistantEntry, CompactionEntry, ConversationIdle, createRegistry, Harness, type Conversation, type ConversationId, type ConversationWatch, type EntryRecord, type SettledSubmissionRecord, type Submission, type SubmissionId, type Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const DEFAULT_MAX_TURNS = 50;

// Keep the root context in one place until operations have their own contexts.
const context = BACKGROUND_CONTEXT;
export class DurableRunAborted extends Error {
  constructor() { super("aborted"); }
}

type McpControlInput = Pick<Extract<AgentCommand, { type: "mcp.control" }>, "action" | "server" | "redirectUrl" | "authorizationId" | "expiresAt">;
type McpAuthorizationOutcome = Omit<Parameters<NonNullable<McpOAuthManagerDeps["onComplete"]>>[0], "name"> & { server: string };

export interface BotRuntime {
  startTurn(input: {
    db: Database;
    threads: ThreadsService;
    bots: BotsService;
    events: EventLog;
    threadId: string;
    botId: string;
    turnId: string;
    text: string;
    /** Sequence of the persisted user message. Omitting it disables transcript fallback seeding. */
    userMessageSeq?: number;
    instructions: string;
    workspaceDir: string;
    privateDir: string;
    whenBusy?: "followUp";
    admitted?(): void;
    working(): void;
  }): Promise<void>;
  recoverTurns(input: { db: Database; threads: ThreadsService; bots: BotsService; events: EventLog; registered(turnId: string): void; settled(turnId: string, outcome: { status: "completed" | "cancelled" } | { status: "failed"; reason: string }): void }): { registered: Promise<void>; settled: Promise<void> };
  activeTurn(threadId: string): Promise<string | undefined>;
  steer(turnId: string, text: string, requestId: string): Promise<void>;
  abortTurn(turnId: string): Promise<void>;
  mcpStatus(): NativeMcpStatus[];
  mcpMarkNeedsAuth(name: string): NativeMcpStatus | undefined;
  mcpControl(input: McpControlInput): Promise<NativeMcpControlResult>;
  close(): Promise<void>;
  /** Requests to use files outside the allowed folders; absent without Service storage and events. */
  readonly approvals?: ApprovalStore;
  readonly credentials: CredentialStore;
  readonly secrets: SecretStore;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldProjectEntry(entry: EntryRecord, lastEntryBeforeAbort: number | undefined): boolean {
  if (lastEntryBeforeAbort === undefined || entry.id <= lastEntryBeforeAbort || !AssistantEntry.is(entry)) return true;
  return !entry.model?.some((message) => message.role === "assistant" && message.stopReason === "aborted");
}

export async function openBotRuntime(paths: PlatformPaths & { dbPath: string }, db?: Database, options: {
  events?: Pick<EventLog, "append">;
  mcp?: Pick<McpExtensionDeps, "servers" | "prepareServers" | "fillSecrets" | "authProvider">;
  mcpOAuth?: { onAuthorization?: (outcome: McpAuthorizationOutcome) => void };
} = {}): Promise<BotRuntime> {
  const secretStore = new SecretStore(paths.dataDir);
  const mcpOptions = options.mcp;
  const manager = mcpOptions ? new McpOAuthManager({
    secrets: secretStore,
    settings({ name, serverUrl }) {
      const { servers, configurationError } = mcpOptions.servers();
      const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
      const transport = entry?.transport;
      if (configurationError || entry?.disabled || transport?.type !== "http" || new URL(transport.url).href !== serverUrl) {
        throw new Error("The MCP connection configuration changed.");
      }
      if (!transport.oauth) return {};
      const { clientId, clientSecret, callbackPort, callbackUrl, scope, clientName, authServerMetadataUrl, clientRegistration } = transport.oauth;
      return {
        ...(clientId === undefined ? {} : { clientId }),
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(callbackPort === undefined ? {} : { callbackPort }),
        ...(callbackUrl === undefined ? {} : { callbackUrl }),
        ...(scope === undefined ? {} : { scope }),
        ...(clientName === undefined ? {} : { clientName }),
        ...(authServerMetadataUrl === undefined ? {} : { authServerMetadataUrl: new URL(authServerMetadataUrl) }),
        ...(clientRegistration === undefined ? {} : { clientRegistration }),
      };
    },
    async onComplete({ name, authorizationId, ...outcome }) {
      if (outcome.status === "completed") {
        const entry = await mcp?.check(name).catch(() => undefined);
        if (entry?.status !== "connected") outcome = { status: "failed", reason: "connect_failed" };
      }
      try { await options.mcpOAuth?.onAuthorization?.({ ...outcome, authorizationId, server: name }); }
      catch { /* Event consumers must not interrupt OAuth completion. */ }
      return outcome;
    },
  }) : undefined;
  const mcp = mcpOptions && manager ? createMcpExtension({
    ...mcpOptions,
    authProvider: (name, url) => manager.authProvider(name, url),
  }) : undefined;
  let reportedCredentialsFailure = false;
  const reportCredentialsFailure = () => {
    if (reportedCredentialsFailure) return;
    reportedCredentialsFailure = true;
    console.warn("Unable to load model credential store; continuing without stored providers");
  };
  const exaSearchKey = await secretStore.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET).catch(() => undefined);
  const credentialOptions = { sensitiveValues: exaSearchKey === undefined ? [] : [exaSearchKey, exaSearchKey.trim()] };
  const credentials = await CredentialStore.open(paths.stateDir, secretStore, credentialOptions).catch(() => {
    reportCredentialsFailure();
    return new CredentialStore(secretStore, credentialOptions);
  });
  if (db && !reportedCredentialsFailure) {
    try { await importPiProviders({ db, credentials, homeDir: paths.homeDir }); }
    catch { console.warn("Unable to import Pi model providers; continuing startup"); }
  }
  const conversationBots = new Map<ConversationId, string>();
  const secrets: BotSecretAccess = { store: secretStore, botId: (id) => conversationBots.get(id) };
  const storage = await openNodeSqliteStorage(paths.dbPath, { prefix: "pi_" });
  const selections: { providerId: string; modelId: string }[] = [];
  try {
    const registry = createRegistry();
    registry.install(compactionExtension);
    const approvals = db && options.events ? new ApprovalStore(db, options.events) : undefined;
    registry.install(createFilesShellExtension(process.platform, db && approvals ? {
      store: approvals,
      paths,
      settingsFolders: () => readSettingsAllowedFolders(db),
      owner: (conversationId) => {
        const row = db.query<{ thread_id: string; bot_id: string }, [number]>("SELECT thread_id, bot_id FROM pi_thread_conversations WHERE conversation_id = ?").get(conversationId);
        return row ? { threadId: row.thread_id, botId: row.bot_id } : undefined;
      },
    } : undefined, secrets));
    registry.install(createSecretsExtension(secrets));
    registry.install(createWebExtension({
      exemptRanges: () => readWebExemptRanges(db),
      searchKey: () => secretStore.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET),
    }));
    if (mcp) registry.install(mcp);
    const harness = await Harness.open(storage, { models: () => {
      try { return createRuntimeModels(credentials, selections); } catch {
        reportCredentialsFailure();
        return createModels();
      }
    }, registry, env: ({ conversationId, cwd }) => createFilesEnvironment(paths, readSettingsAllowedFolders(db), cwd, conversationBots.get(conversationId)),
    settings: { afterFailedRun: "continue", restartLimit: 5, compaction: compactionSettings } }, context);
    let resumed = false;
    const resumeScheduler = () => {
      if (resumed) return;
      harness.resume();
      resumed = true;
    };
    try {
      const recoveringBots = db?.query<{ bot_id: string }, []>("SELECT DISTINCT bot_id FROM turns WHERE status = 'working'").all() ?? [];
      if (db) {
        for (const { bot_id } of recoveringBots) {
          try {
            const model = resolveModelForBot(db, credentials, bot_id);
            selections.push({ providerId: model.provider, modelId: model.id });
          } catch { /* Recovery will report an unavailable model on the Turn. */ }
        }
      }
      // Recovery maps the owners before the scheduler can replay their tool calls.
      if (recoveringBots.length === 0) resumeScheduler();
    } catch (error) {
      await manager?.close();
      await mcp?.close();
      await harness.close(context);
      throw error;
    }
    let closing: Promise<void> | undefined;
    let recoveryRegistration: Promise<void> | undefined;
    const active = new Map<string, { db: Database; threadId: string; admitted: Promise<{ conversation: Conversation; submission: Submission }>; pending: Promise<SettledSubmissionRecord | undefined>[]; steers: Submission[]; inputs: Set<number>; lastEntryBeforeAbort: number | undefined; abortCutoffRead?: Promise<void>; recovering?: boolean }>();
    return {
      ...(approvals ? { approvals } : {}),
      credentials,
      secrets: secretStore,
      async startTurn(input) {
        let ready!: (value: { conversation: Conversation; submission: Submission }) => void;
        let fail!: (error: unknown) => void;
        const admitted = new Promise<{ conversation: Conversation; submission: Submission }>((resolve, reject) => { ready = resolve; fail = reject; });
        void admitted.catch(() => {});
        const turn = { db: input.db, threadId: input.threadId, admitted, pending: [] as Promise<SettledSubmissionRecord | undefined>[], steers: [] as Submission[], inputs: new Set<number>(), lastEntryBeforeAbort: undefined as number | undefined };
        active.set(input.turnId, turn);
        try {
          // Submitting a fresh Turn can start the global scheduler while recovery is still mapping Bots.
          if (recoveryRegistration) await recoveryRegistration;
          const model = resolveModelForBot(input.db, credentials, input.botId);
          if (!selections.some((selection) => selection.providerId === model.provider && selection.modelId === model.id)) {
            selections.push({ providerId: model.provider, modelId: model.id });
          }
          const conversation = await openThreadConversation(input.db, harness, input.threadId, input.botId, context, {
            async seed(conversation, seedContext) {
              await seedFirstTurnConversation(conversation, seedContext, {
                threadId: input.threadId,
                legacySessionPath: input.threads.getNativeSession(input.threadId),
                transcript: () => transcriptBeforeTurn(() => input.threads.listMessages(input.threadId), input.userMessageSeq),
              });
            },
          });
          conversationBots.set(conversation.id, input.botId);
          const bot = input.bots.getDto(input.botId);
          const maxTurns = bot.maxTurns ?? DEFAULT_MAX_TURNS;
          const instructions = buildSystemPrompt({
            botName: bot.name,
            instructions: input.instructions,
            workspaceDir: input.workspaceDir,
            privateDir: input.privateDir,
            allowedFolders: readAllowedFolders(db, { ...paths, downloadsDir: resolveImplicitDownloads(paths) }),
            skills: listWorkspaceSkills(input.workspaceDir),
          });
          await conversation.configure({ cwd: paths.sharedWorkspaceDir, model: { provider: model.provider, modelId: model.id }, thinkingLevel: "medium", instructions, maxTurns }, context);
          const watch = await conversation.watch(context);
          let transcript: DurableTranscript | undefined = input.whenBusy ? undefined : new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, watch.value);
          let foreignTranscript: DurableTranscript | undefined;
          watch.start(async (call) => {
            if (call.kind !== "value") return;
            const live = call.value.docs["pi.live"] as { run?: { inputs: readonly number[] } } | undefined;
            if (!live?.run?.inputs.some((id) => turn.inputs.has(id))) {
              const projector = transcript ?? (foreignTranscript ??= new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, { ...call.value, entries: call.value.entries.filter((entry) => !CompactionEntry.is(entry)), docs: {} }));
              await projector.reconcileCompactions(call.value, conversation);
              return;
            }
            if (!transcript) {
              const { submission } = await turn.admitted;
              const status = await submission.status(context);
              const entries = status.entry === undefined ? call.value.entries : call.value.entries.filter((entry) => entry.id < status.entry!);
              transcript = new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, { ...call.value, entries });
            }
            const entries = call.value.entries.filter((entry) => shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
            transcript.update({ ...call.value, entries });
          });
          try {
            input.working();
            let submission: Submission;
            try {
              submission = await conversation.submit({ type: "input", content: input.text, requestId: input.turnId, ...(input.whenBusy ? { whenBusy: input.whenBusy, whenIdle: "reject" as const } : {}) }, context);
            } catch (error) {
              if (!(input.whenBusy && error instanceof ConversationIdle)) throw error;
              submission = await conversation.submit({ type: "input", content: input.text, requestId: input.turnId }, context);
            }
            input.db.query("INSERT INTO pi_turn_submissions (turn_id, submission_id, kind, created_at) VALUES (?, ?, 'input', ?)").run(input.turnId, submission.id, new Date().toISOString());
            turn.inputs.add(submission.id);
            ready({ conversation, submission });
            input.admitted?.();
            const settled = await submission.wait(context);
            const settlements = [settled];
            for (let index = 0; index < turn.pending.length; index++) {
              const steered = await turn.pending[index]!;
              if (steered) settlements.push(steered);
            }
            let answered = false;
            for (const settled of settlements) {
              if (settled.status !== "done") continue;
              answered = true;
              if (settled.type !== "input") throw new Error("Durable turn did not complete");
              const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
              if (!answer) throw new Error("Durable turn answer not found");
              transcript ??= new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, { ...watch.value, entries: watch.value.entries.filter((entry) => entry.id !== answer.id) });
              transcript.update({ ...watch.value, entries: [answer], docs: { ...watch.value.docs, "pi.live": {} } });
            }
            if (!answered) {
              const failed = settlements.find((item) => item.status === "unanswered");
              if (!failed || failed.status !== "unanswered") throw new Error("Durable turn did not complete");
              if (failed.reason === "aborted") throw new DurableRunAborted();
              const failure = watch.value.docs["pi.live"] as { runFailure?: { inputs: readonly number[]; reason: string; detail?: string } } | undefined;
              const runFailure = failure?.runFailure?.inputs.includes(failed.id) ? failure.runFailure : undefined;
              throw new Error(runFailure?.detail ?? (typeof failed.detail === "string" ? failed.detail : failed.reason));
            }
          } finally { await watch.stop(); }
        } catch (error) {
          let failure = error;
          if (!(error instanceof DurableRunAborted)) {
            const reason = failureMessage(error);
            const redacted = await secretStore.redactKnown(reason, input.botId);
            if (redacted !== reason) failure = new Error(redacted);
          }
          fail(failure);
          throw failure;
        } finally {
          active.delete(input.turnId);
        }
      },
      recoverTurns(input) {
        const jobs: Promise<void>[] = [];
        const rows = input.db.query<{ id: string; thread_id: string; bot_id: string }, []>("SELECT id, thread_id, bot_id FROM turns WHERE status = 'working' ORDER BY started_at, id").all();
        const reportFailure = async (row: (typeof rows)[number], reason: string) => {
          input.settled(row.id, { status: "failed", reason: await secretStore.redactKnown(reason, row.bot_id) });
        };
        const registered = (async () => {
          const prepared: {
            row: (typeof rows)[number];
            conversation: Conversation;
            owned: Submission;
            associations: { submission_id: number; kind: string }[];
          }[] = [];
          const failed: { row: (typeof rows)[number]; reason: string }[] = [];
          // Waiting on any submission can resume the global scheduler, so map all Bots first.
          for (const row of rows) {
            try {
              const indexed = input.db.query<{ conversation_id: number }, [string, string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ? AND bot_id = ?").get(row.thread_id, row.bot_id);
              if (!indexed) throw new Error("durable conversation not found");
              const conversation = await openThreadConversation(input.db, harness, row.thread_id, row.bot_id, context);
              conversationBots.set(conversation.id, row.bot_id);
              const associations = input.db.query<{ submission_id: number; kind: string }, [string]>("SELECT submission_id, kind FROM pi_turn_submissions WHERE turn_id = ? ORDER BY submission_id").all(row.id);
              const association = associations.find((item) => item.kind === "input");
              let primary = association ? await harness.submission(association.submission_id as SubmissionId, context) : undefined;
              if (!primary) {
                const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, row.id), context);
                if (record) {
                  primary = await harness.submission(record.id, context);
                  input.db.query("INSERT OR IGNORE INTO pi_turn_submissions (turn_id, submission_id, kind, created_at) VALUES (?, ?, 'input', ?)").run(row.id, record.id, new Date().toISOString());
                }
              }
              if (!primary) throw new Error("durable submission not found");
              prepared.push({ row, conversation, owned: primary, associations });
            } catch (error) {
              failed.push({ row, reason: failureMessage(error) });
            }
          }
          for (const { row, reason } of failed) await reportFailure(row, reason);
          for (const { row, conversation, owned, associations } of prepared) {
            try {
              const turn = { db: input.db, threadId: row.thread_id, admitted: Promise.resolve({ conversation, submission: owned }), pending: [] as Promise<SettledSubmissionRecord | undefined>[], steers: [] as Submission[], inputs: new Set<number>([owned.id]), lastEntryBeforeAbort: undefined as number | undefined, recovering: true };
              active.set(row.id, turn);
              input.registered(row.id);
              jobs.push((async () => {
                let watch: ConversationWatch | undefined;
                try {
                  const steerIds = new Set(associations.filter((item) => item.kind === "steer").map((item) => item.submission_id));
                  const inspected = await harness.inspect(context);
                  for (const record of inspected.submissions) {
                    if (record.conversationId === conversation.id && record.requestId?.startsWith(`${row.id}:steer:`)) steerIds.add(record.id);
                  }
                  // The Service persists the message id before admitting a steer, so even a settled
                  // steer whose association write was interrupted has a public request lookup key.
                  const messages = input.db.query<{ id: string }, [string, string]>("SELECT id FROM messages WHERE thread_id = ? AND kind = 'text' AND author_kind = 'user' AND json_valid(payload) AND json_extract(payload, '$.turnId') = ?").all(row.thread_id, row.id);
                  for (const message of messages) {
                    const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, `${row.id}:steer:${message.id}`), context);
                    if (record) steerIds.add(record.id);
                  }
                  for (const id of steerIds) {
                    const steer = await harness.submission(id as SubmissionId, context);
                    if (!steer || turn.inputs.has(steer.id)) continue;
                    turn.steers.push(steer);
                    turn.inputs.add(steer.id);
                    turn.pending.push(steer.wait(context));
                    input.db.query("INSERT OR IGNORE INTO pi_turn_submissions (turn_id, submission_id, kind, created_at) VALUES (?, ?, 'steer', ?)").run(row.id, steer.id, new Date().toISOString());
                  }
                  turn.recovering = false;
                  const status = await owned.status(context);
                  let nextEntry: number | undefined;
                  if (status.entry !== undefined) {
                    // Only another Turn's initial input bounds this Turn. Steers share its transcript.
                    const otherTurns = input.db.query<{ id: string; submission_id: number | null }, [string, string, string]>("SELECT t.id, s.submission_id FROM turns t LEFT JOIN pi_turn_submissions s ON s.turn_id = t.id AND s.kind = 'input' WHERE t.thread_id = ? AND t.bot_id = ? AND t.id != ?").all(row.thread_id, row.bot_id, row.id);
                    for (const other of otherTurns) {
                      const handle = other.submission_id === null ? undefined : await harness.submission(other.submission_id as SubmissionId, context);
                      const record = handle ? await handle.status(context) : await harness.commit((tx) => tx.submissionByRequest(conversation.id, other.id), context);
                      if (record?.type === "input" && record.entry !== undefined && record.entry > status.entry && (nextEntry === undefined || record.entry < nextEntry)) nextEntry = record.entry;
                    }
                  }
                  watch = await conversation.watch(context, { ...(status.entry === undefined ? {} : { from: status.entry }), min: 100, max: 200 });
                  const ownedWatch = watch;
                  const removed = input.db.query<{ kind: string; count: number }, [string]>("SELECT kind, count(*) AS count FROM messages WHERE turn_id = ? AND kind IN ('response', 'thinking') GROUP BY kind").all(row.id);
                  input.db.query("DELETE FROM messages WHERE turn_id = ? AND kind IN ('response', 'thinking')").run(row.id);
                  for (const item of removed) input.events.append("thread", row.thread_id, `${item.kind}.removed`, { threadId: row.thread_id, turnId: row.id, count: item.count });
                  const transcript = new DurableTranscript(input.threads, input.bots, input.events, row.thread_id, row.bot_id, row.id, { ...ownedWatch.value, entries: [] });
                  let firstEntry = status.entry;
                  const initialLive = ownedWatch.value.docs["pi.live"] as { run?: { inputs: readonly number[] } } | undefined;
                  const initialDocs = initialLive?.run && !initialLive.run.inputs.some((id) => turn.inputs.has(id)) ? { ...ownedWatch.value.docs, "pi.live": {} } : ownedWatch.value.docs;
                  await transcript.reconcileCompactions(ownedWatch.value, conversation);
                  if (firstEntry !== undefined) {
                    let entryCursor: Cursor | undefined;
                    do {
                      const page = await conversation.entries({ order: "ascending", minEntryId: firstEntry }, 100, entryCursor, context);
                      const entries = page.items.filter((entry) => (nextEntry === undefined || entry.id < nextEntry) && shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
                      transcript.update({ ...ownedWatch.value, entries, docs: { ...ownedWatch.value.docs, "pi.live": {} } });
                      entryCursor = page.next;
                    } while (entryCursor);
                    transcript.update({ ...ownedWatch.value, entries: [], docs: initialDocs });
                  }
                  ownedWatch.start(async (call) => {
                    if (call.kind !== "value") return;
                    const live = call.value.docs["pi.live"] as { run?: { inputs: readonly number[] } } | undefined;
                    if (live?.run && !live.run.inputs.some((id) => turn.inputs.has(id))) {
                      await transcript.reconcileCompactions(call.value, conversation);
                      return;
                    }
                    firstEntry ??= (await owned.status(context)).entry;
                    if (firstEntry === undefined) return;
                    const entries = call.value.entries.filter((entry) => entry.id >= firstEntry! && (nextEntry === undefined || entry.id < nextEntry) && shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
                    transcript.update({ ...call.value, entries });
                  });
                  const settlements = [await owned.wait(context)];
                  for (let i = 0; i < turn.pending.length; i++) {
                    const item = await turn.pending[i];
                    if (item) settlements.push(item);
                  }
                  let answered = false;
                  for (const item of settlements) {
                    if (item.status !== "done" || item.type !== "input") continue;
                    const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, item.answer), context);
                    if (!answer) throw new Error("Durable turn answer not found");
                    transcript.update({ ...ownedWatch.value, entries: [answer], docs: { ...ownedWatch.value.docs, "pi.live": {} } });
                    answered = true;
                  }
                  if (answered) input.settled(row.id, { status: "completed" });
                  else {
                    const failed = settlements.find((item) => item.status === "unanswered");
                    if (!failed || failed.status !== "unanswered") throw new Error("Durable turn did not complete");
                    if (failed.reason === "aborted") {
                      await ownedWatch.stop();
                      input.settled(row.id, { status: "cancelled" });
                    } else {
                      const live = ownedWatch.value.docs["pi.live"] as { runFailure?: { inputs: readonly number[]; detail?: string } } | undefined;
                      const reason = (live?.runFailure?.inputs.includes(failed.id) ? live.runFailure.detail : undefined) ?? (typeof failed.detail === "string" ? failed.detail : failed.reason);
                      await reportFailure(row, reason);
                    }
                  }
                } catch (error) { await reportFailure(row, failureMessage(error)); }
                finally { await watch?.stop(); active.delete(row.id); }
              })());
            } catch (error) {
              active.delete(row.id);
              await reportFailure(row, failureMessage(error));
            }
          }
        })().finally(resumeScheduler);
        recoveryRegistration = registered;
        const settled = registered.finally(async () => { await Promise.allSettled(jobs); });
        return { registered, settled };
      },
      async activeTurn(threadId) {
        for (const [turnId, turn] of active) {
          if (turn.threadId !== threadId) continue;
          const { submission } = await turn.admitted;
          for (const input of [submission, ...turn.steers]) {
            if ((await input.status(context)).status === "placed") return turnId;
          }
        }
        return undefined;
      },
      async steer(turnId, text, requestId) {
        const turn = active.get(turnId);
        if (!turn) throw new Error("active turn has no durable conversation");
        let submitted!: () => void;
        let rejected!: (error: unknown) => void;
        const accepted = new Promise<void>((resolve, reject) => { submitted = resolve; rejected = reject; });
        const pending = (async () => {
          let wasSubmitted = false;
          try {
            const { conversation } = await turn.admitted;
            const submission = await conversation.submit({ type: "input", content: text, whenBusy: "steer", whenIdle: "reject", requestId: `${turnId}:steer:${requestId}` }, context);
            turn.db.query("INSERT INTO pi_turn_submissions (turn_id, submission_id, kind, created_at) VALUES (?, ?, 'steer', ?)").run(turnId, submission.id, new Date().toISOString());
            turn.inputs.add(submission.id);
            turn.steers.push(submission);
            wasSubmitted = true;
            submitted();
            return await submission.wait(context);
          } catch (error) { if (wasSubmitted) throw error; rejected(error); return undefined; }
        })();
        void pending.catch(() => {});
        turn.pending.push(pending);
        await accepted;
      },
      async abortTurn(turnId) {
        const turn = active.get(turnId);
        if (turn) {
          const { conversation, submission } = await turn.admitted;
          if (turn.lastEntryBeforeAbort === undefined) {
            // The abort journals its partial as an aborted entry. Earlier entries include any partials replayed after a hard kill.
            turn.abortCutoffRead ??= conversation.entries({ order: "descending" }, 1, undefined, context)
              .then(({ items }) => { turn.lastEntryBeforeAbort = items[0]?.id ?? 0; })
              .finally(() => { delete turn.abortCutoffRead; });
            await turn.abortCutoffRead;
          }
          const result = await submission.abort(context);
          if (result === "already_placed" || (result === "settled" && (turn.pending.length > 0 || turn.recovering))) await conversation.abort(context);
        }
      },
      mcpStatus() {
        return mcp?.status() ?? [];
      },
      mcpMarkNeedsAuth(name) {
        return mcp?.markNeedsAuth(name);
      },
      async mcpControl({ action, server, redirectUrl, authorizationId, expiresAt }) {
        const status = () => mcp?.status() ?? [];
        const respond = (result: Record<string, unknown>) => ({ servers: status(), result });
        if (action === "status") return { servers: status() };
        if (typeof server !== "string" || !server.trim()) return respond({ error: "invalid_request" });
        switch (action) {
          case "connect": {
            try {
              await mcp?.prepare();
              const entry = await mcp?.check(server, paths.sharedWorkspaceDir);
              if (!entry) return respond({ error: "not_configured" });
              if (entry.status === "connected") return respond({});
              const message = "error" in entry && typeof entry.error === "string" ? entry.error : undefined;
              return respond({ error: entry.status === "needs-auth" ? "auth_required" : "connect_failed", ...(message === undefined ? {} : { message }) });
            } catch { return respond({ error: "connect_failed" }); }
          }
          case "auth-start": {
            if (typeof authorizationId !== "string" || !authorizationId.trim()) return respond({ error: "invalid_request" });
            if (!mcp || !manager) return respond({ error: "not_configured" });
            try {
              const effective = await mcp.prepare();
              const entry = Object.hasOwn(effective.servers, server) ? effective.servers[server] : undefined;
              if (effective.configurationError || entry?.disabled || entry?.transport?.type !== "http") return respond({ error: "not_configured" });
              const result = await manager.start({ name: server, serverUrl: entry.transport.url, authorizationId, ...(expiresAt === undefined ? {} : { expiresAt }) });
              return respond("authorizationUrl" in result ? { authorizationUrl: result.authorizationUrl } : { authenticated: true });
            } catch { return respond({ error: "authorization_failed" }); }
          }
          case "auth-complete": {
            if (typeof redirectUrl !== "string" || !redirectUrl.trim()) return respond({ error: "invalid_request" });
            if (!manager) return respond({ error: "not_configured" });
            try {
              const outcome = await manager.complete({ name: server, redirectUrl });
              return respond(outcome.status === "completed" ? { authenticated: true } : { error: outcome.reason });
            } catch { return respond({ error: "auth_failed" }); }
          }
          case "auth-cancel":
            await manager?.cancel({ name: server, ...(authorizationId === undefined ? {} : { authorizationId }) });
            return respond({});
          default:
            return respond({ error: "invalid_request" });
        }
      },
      close() {
        closing ??= (async () => {
          try {
            await Promise.all([manager?.close(), mcp?.close()]);
            await harness.close(context);
          } finally {
            await storage.close(context);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await storage.close(context);
    throw error;
  }
}
