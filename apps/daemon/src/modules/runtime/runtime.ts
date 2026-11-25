import type { Database } from "bun:sqlite";
import type { AgentBotMessageToolOutput, AgentCommand, NativeMcpControlResult, NativeMcpStatus } from "@omarchy-bot/agent-contract";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import type { PluginsService } from "../plugins/plugins.ts";
import type { SidecarBroker } from "../devices/sidecarBroker.ts";
import { readAllowedFolders, readSettingsAllowedFolders } from "../workspace/allowedFolders.ts";
import type { PlatformPaths } from "../workspace/paths.ts";
import { openThreadConversation } from "./conversations.ts";
import { seedFirstTurnConversation, transcriptBeforeTurn } from "./sessionMigration.ts";
import { DurableTranscript } from "./transcript.ts";
import { resolveModelForBot } from "./models.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { awaitWithContext, BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { CredentialStore } from "./credentials.ts";
import { ApprovalStore } from "./approvals.ts";
import { createRuntimeModels } from "./models.ts";
import { compactionExtension, compactionSettings, formatAuthorText } from "./compaction.ts";
import { createFilesEnvironment, createFilesShellExtension, resolveImplicitDownloads } from "./extensions/files-shell.ts";
import { createLocalExtension } from "./extensions/local.ts";
import { createMailExtension } from "./extensions/mail.ts";
import { createMcpExtension, type McpExtensionDeps } from "./extensions/mcp.ts";
import { DispatchedCallIds } from "./extensions/model-call.ts";
import { createPluginsExtension } from "./extensions/plugins.ts";
import { buildSystemPrompt } from "./extensions/prompt.ts";
import { createSecretsExtension, type BotSecretAccess } from "./extensions/secrets.ts";
import { listWorkspaceSkills } from "./extensions/skills.ts";
import { createWebExtension, EXA_SEARCH_KEY_SECRET, readWebExemptRanges } from "./extensions/web.ts";
import { importPiProviders } from "./providerImport.ts";
import { BunSecretsBackend, probeBunSecrets } from "./bunSecrets.ts";
import { SecretStore } from "./secrets.ts";
import { McpOAuthManager, type McpOAuthManagerDeps } from "./mcpOAuth.ts";
import { AssistantEntry, configure, ConversationIdle, createRegistry, Harness, InboxDoc, LiveDoc, type AgentChange, type Conversation, type ConversationId, type ConversationWatch, type EntryId, type EntryRecord, type LiveState, type SettledSubmissionRecord, type SubmissionRecord, type Submission, type SubmissionId, type Cursor } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export const DEFAULT_MAX_TURNS = 50;

// Keep the root context in one place until operations have their own contexts.
const context = BACKGROUND_CONTEXT;
export class DurableRunAborted extends Error {
  constructor() { super("aborted"); }
}

type McpControlInput = Pick<Extract<AgentCommand, { type: "mcp.control" }>, "action" | "server" | "redirectUrl" | "authorizationId" | "expiresAt">;
type McpAuthorizationOutcome = Omit<Parameters<NonNullable<McpOAuthManagerDeps["onComplete"]>>[0], "name"> & { server: string };

export interface RuntimeServices {
  mailbox: {
    enqueue(context: { botId: string; turnId: string; toolCallId: string }, targetBotId: string, text: string): AgentBotMessageToolOutput;
  };
  sidecars: Pick<SidecarBroker, "execute">;
  plugins: Pick<PluginsService, "callManage">;
}

interface DurableTurnStart {
  db: Database;
  threads: ThreadsService;
  bots: BotsService;
  events: EventLog;
  threadId: string;
  botId: string;
  turnId: string;
  workspaceDir: string;
  admitted?(): void;
  working(): void;
}

type UserTurnStart = DurableTurnStart & {
  text: string;
  /** Sequence of the persisted user message. Omitting it disables transcript fallback seeding. */
  userMessageSeq?: number;
  instructions: string;
  privateDir: string;
  deviceId?: string;
  whenBusy?: "followUp";
};
type PeerMailTurnStart = DurableTurnStart & {
  peerMail: { author: string; text: string; deliveryId: string };
  admissionTimeoutMs: number;
  announce(): string;
  markDelivered(): void;
};
type ServiceWrite = <T>(write: () => T) => Promise<T>;
type TurnAdmission = { conversation: Conversation; submission: Submission };
type ActiveTurn = {
  db: Database;
  threadId: string;
  deviceId?: string;
  admitted: Promise<TurnAdmission>;
  cancelAdmission?: (reason?: unknown) => void;
  pending: Promise<SettledSubmissionRecord | undefined>[];
  steers: Submission[];
  inputs: Set<number>;
  lastEntryBeforeAbort?: number | undefined;
  abortCutoffRead?: Promise<void>;
  recovering?: boolean;
};

export interface BotRuntime {
  bindServices(services: RuntimeServices): void;
  startTurn(input: UserTurnStart): Promise<void>;
  startPeerMailTurn(input: PeerMailTurnStart): Promise<void>;
  recoverPeerMailAcceptance(input: { db: Database; turnId: string; threadId: string; botId: string; markDelivered(): void }): Promise<boolean>;
  /** Run synchronous Service SQL in the same writer queue as pi storage. */
  writeService: ServiceWrite;
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
  const secretsApi = typeof Bun === "undefined" ? undefined : Bun.secrets;
  const secretStore = new SecretStore(paths.dataDir, secretsApi ? {
    backend: new BunSecretsBackend(secretsApi),
    probe: () => probeBunSecrets(secretsApi),
  } : undefined);
  const redactFailure = (reason: string, botId: string) => secretStore.redactKnown(reason, botId).catch(() => "[redacted]");
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
  const sqlite = await openNodeSqliteDatabase(paths.dbPath);
  // A Bun SQLite busy wait would block the JS thread holding the durable connection's lock.
  let writer = Promise.resolve();
  function enqueueWrite<T>(write: () => T | Promise<T>): Promise<T> {
    const result = writer.then(write);
    writer = result.then(() => {}, () => {});
    return result;
  }
  const writeService: ServiceWrite = enqueueWrite;
  const storage = await SqliteStorage.open({
    exec: sqlite.exec.bind(sqlite),
    run: sqlite.run.bind(sqlite),
    runCounted: sqlite.runCounted.bind(sqlite),
    get: sqlite.get.bind(sqlite),
    all: sqlite.all.bind(sqlite),
    close: sqlite.close.bind(sqlite),
    transaction(change) {
      return enqueueWrite(() => sqlite.transaction(change));
    },
  }, { prefix: "pi_" });
  function associateSubmission(db: Database, turnId: string, submissionId: number, kind: "input" | "steer") {
    db.query(`INSERT INTO pi_turn_submissions (turn_id, submission_id, kind, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (turn_id, submission_id) DO NOTHING`).run(turnId, submissionId, kind, new Date().toISOString());
  }

  async function recordPeerMailAcceptance(db: Database, turnId: string, submissionId: number, markDelivered: () => void) {
    for (let attempt = 1; ; attempt++) {
      try {
        await writeService(() => db.transaction(() => {
          associateSubmission(db, turnId, submissionId, "input");
          markDelivered();
        })());
        return;
      } catch (error) {
        const code = (error as { code?: string } | null | undefined)?.code;
        if (attempt < 3 && typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))) continue;
        throw error;
      }
    }
  }

  function projectTurn(conversation: Conversation, watch: ConversationWatch, turn: ActiveTurn, transcript: DurableTranscript) {
    let current: { first: EntryId; input: SubmissionId } | undefined;
    let updating: Promise<void> | undefined;
    const projectedAnswers = new Set<EntryId>();
    let lastProjectedAnswer: EntryId | undefined;
    let failedRunBoundary: { first: EntryId; successor: EntryId } | undefined;

    async function successorFirst(failedFirst: EntryId, failedInputs: readonly SubmissionId[]): Promise<EntryId | undefined> {
      if (failedRunBoundary?.first === failedFirst) return failedRunBoundary.successor;
      // pi keeps runFailure visible after its successor settles. The next placed input bounds the failed run even then.
      const priorInputs = new Set(failedInputs);
      let successor: EntryId | undefined;
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanSubmissions({ conversationId: conversation.id }, 100, cursor, context);
        for (const record of page.items) {
          if (record.type === "input" && record.entry !== undefined && record.entry > failedFirst && !priorInputs.has(record.id) && (successor === undefined || record.entry < successor)) {
            successor = record.entry;
          }
        }
        cursor = page.next;
      } while (cursor);
      if (successor !== undefined) failedRunBoundary = { first: failedFirst, successor };
      return successor;
    }

    async function projectEntries(view: ConversationWatch["value"], first: EntryId, last: EntryId): Promise<void> {
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: "ascending", minEntryId: first, maxEntryId: last }, 100, cursor, context);
        const entries = page.items.filter((entry) => shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
        await writeService(() => transcript.update({ ...view, entries, docs: {} }));
        cursor = page.next;
      } while (cursor);
    }

    async function projectAnswers(records: readonly (SubmissionRecord | undefined)[]): Promise<void> {
      const answered = records.filter((record) => record?.type === "input" && record.status === "done")
        .sort((left, right) => left.answer - right.answer);
      for (const record of answered) {
        if (projectedAnswers.has(record.answer)) continue;
        // For a run that has already ended, its earliest placed input is the first submission sharing its answer.
        let primary = record;
        if (current?.input !== record.id) {
          let cursor: Cursor | undefined;
          do {
            const page = await storage.scanSubmissions({ conversationId: conversation.id, status: "done" }, 100, cursor, context);
            for (const candidate of page.items) {
              if (candidate.type === "input" && candidate.status === "done" && candidate.answer === record.answer && candidate.entry < primary.entry) primary = candidate;
            }
            cursor = page.next;
          } while (cursor);
        }
        if (turn.inputs.has(primary.id)) {
          await projectEntries(watch.value, primary.entry, record.answer);
          if (lastProjectedAnswer === undefined || record.answer > lastProjectedAnswer) lastProjectedAnswer = record.answer;
        }
        projectedAnswers.add(record.answer);
      }
    }

    async function projectView(view: ConversationWatch["value"]): Promise<void> {
      const live = view.docs["pi.live"] as LiveState | undefined;
      const first = live?.run?.first;
      const primary = live?.run?.inputs[0];
      if (current && current.first !== first) {
        await projectAnswers([await storage.submission(current.input, context)]);
        current = undefined;
      }
      const failure = live?.runFailure;
      const failedFirst = failure?.first;
      const failedPrimary = failure?.inputs[0];
      if (failure && failedFirst !== undefined && failedPrimary !== undefined && turn.inputs.has(failedPrimary)) {
        const cutoff = first ?? await successorFirst(failedFirst, failure.inputs);
        const failedEntries = view.entries.filter((entry) => entry.id >= failedFirst && (cutoff === undefined || entry.id < cutoff) && shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
        await writeService(() => transcript.update({ ...view, entries: failedEntries, docs: {} }));
      }
      // Recovery can settle a run before its watch has delivered the ending revision.
      if (first === undefined || primary === undefined || !turn.inputs.has(primary) || (lastProjectedAnswer !== undefined && first <= lastProjectedAnswer)) {
        await transcript.reconcileCompactions(view, conversation, writeService);
        return;
      }
      if (current === undefined && view.before !== undefined && view.before >= first) {
        await projectEntries(view, first, view.before);
      }
      current = { first, input: primary };
      const entries = view.entries.filter((entry) => entry.id >= first && shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
      await writeService(() => transcript.update({ ...view, entries }));
    }

    return {
      projectAnswers,
      async start() {
        await projectView(watch.value);
        watch.start((call) => {
          if (call.kind !== "value") return Promise.resolve();
          updating = projectView(call.value);
          return updating;
        });
      },
      async finish(settlements: readonly SettledSubmissionRecord[]) {
        await watch.stop();
        await updating;
        await projectAnswers(settlements);
      },
    };
  }

  const selections: { providerId: string; modelId: string }[] = [];
  function rememberModelSelection(providerId: string, modelId: string): void {
    if (!selections.some((selection) => selection.providerId === providerId && selection.modelId === modelId)) {
      selections.push({ providerId, modelId });
    }
  }
  const conversationBots = new Map<ConversationId, string>();
  const secrets: BotSecretAccess = { store: secretStore, botId: (id) => conversationBots.get(id) };
  const active = new Map<string, ActiveTurn>();
  const dispatched = new DispatchedCallIds();
  function releaseTurn(turnId: string): void {
    active.delete(turnId);
    dispatched.deleteTurn(turnId);
  }
  let services: RuntimeServices | undefined;
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
    if (mcp) registry.install(mcp);
    registry.install(createLocalExtension(db, () => services?.sidecars, active, dispatched));
    registry.install(createMailExtension(db, () => services?.mailbox, active, undefined, writeService));
    registry.install(createPluginsExtension(db, () => services?.plugins, active, dispatched));
    registry.install(createWebExtension({
      exemptRanges: () => readWebExemptRanges(db),
      searchKey: () => secretStore.getAppSecretForRuntime(EXA_SEARCH_KEY_SECRET),
    }));
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
            rememberModelSelection(model.provider, model.id);
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
    async function startTurn(input: UserTurnStart | PeerMailTurnStart): Promise<void> {
      const whenBusy = "whenBusy" in input ? input.whenBusy : undefined;
      const peerMail = "peerMail" in input ? input : undefined;
      const admission = Promise.withResolvers<TurnAdmission>();
      void admission.promise.catch(() => {});
      const waiting = peerMail ? withCancel(context) : undefined;
      const waitingContext = waiting?.context ?? context;
      const admissionTimer = peerMail && waiting ? setTimeout(() => {
        waiting.cancel(new DOMException("Peer mail admission timed out", "TimeoutError"));
      }, peerMail.admissionTimeoutMs) : undefined;
      const turn: ActiveTurn = {
        db: input.db, threadId: input.threadId, admitted: admission.promise, pending: [], steers: [], inputs: new Set(),
        ...("deviceId" in input && input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(waiting ? { cancelAdmission: waiting.cancel } : {}),
      };
      active.set(input.turnId, turn);
      let watch: ConversationWatch | undefined;
      let bookkeeping: Promise<void> | undefined;
      try {
        const privateDir = "privateDir" in input ? input.privateDir : await awaitWithContext(writeService(() => {
          waitingContext.abortSignal?.throwIfAborted();
          return input.announce();
        }), waitingContext);
        // Submitting a fresh Turn can start the global scheduler while recovery is still mapping Bots.
        if (recoveryRegistration) await awaitWithContext(recoveryRegistration, waitingContext);
        const currentSettings = (): AgentChange => {
          const model = resolveModelForBot(input.db, credentials, input.botId);
          rememberModelSelection(model.provider, model.id);
          const bot = input.bots.getDto(input.botId);
          const instructions = buildSystemPrompt({
            botName: bot.name,
            instructions: "instructions" in input ? input.instructions : bot.instructions,
            workspaceDir: input.workspaceDir,
            privateDir,
            allowedFolders: readAllowedFolders(db, { ...paths, downloadsDir: resolveImplicitDownloads(paths) }),
            skills: listWorkspaceSkills(input.workspaceDir),
          });
          return { cwd: paths.sharedWorkspaceDir, model: { provider: model.provider, modelId: model.id }, thinkingLevel: "medium", instructions, maxTurns: bot.maxTurns ?? DEFAULT_MAX_TURNS };
        };
        const userSettings = peerMail ? undefined : currentSettings();
        let configuredOnCreate = false;
        waitingContext.abortSignal?.throwIfAborted();
        const conversation = await awaitWithContext(
          openThreadConversation(input.db, harness, input.threadId, input.botId, context, {
            writeService,
            async seed(conversation, seedContext) {
              const userMessageSeq = "userMessageSeq" in input ? input.userMessageSeq : undefined;
              await seedFirstTurnConversation(conversation, seedContext, {
                threadId: input.threadId,
                legacySessionPath: input.threads.getNativeSession(input.threadId),
                transcript: () => transcriptBeforeTurn(() => input.threads.listMessages(input.threadId), userMessageSeq),
              });
            },
            ...(peerMail ? {
              initialSettings() {
                configuredOnCreate = true;
                return currentSettings();
              },
            } : {}),
          }),
          waitingContext,
        );
        conversationBots.set(conversation.id, input.botId);
        waitingContext.abortSignal?.throwIfAborted();
        if (userSettings) {
          await conversation.configure(userSettings, context);
        } else if (!configuredOnCreate) {
          for (;;) {
            await conversation.waitForIdle(waitingContext);
            waitingContext.abortSignal?.throwIfAborted();
            // An input can start a run between the idle wait and this commit.
            const configured = await awaitWithContext(conversation.commit(async (tx) => {
              if ((await tx.doc(LiveDoc, conversation.id)).run) return false;
              waitingContext.abortSignal?.throwIfAborted();
              await configure(tx, conversation.id, currentSettings());
              return true;
            }, waitingContext), waitingContext);
            if (configured) break;
          }
        }

        const attaching = conversation.watch(context);
        try {
          watch = await awaitWithContext(attaching, waitingContext);
        } catch (error) {
          void attaching.then((attached) => attached.stop(), () => {});
          throw error;
        }
        const ownedWatch = watch;
        const transcript = new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, { ...ownedWatch.value, entries: [] });
        const projection = projectTurn(conversation, ownedWatch, turn, transcript);
        const register = (submission: Submission) => {
          turn.inputs.add(submission.id);
          admission.resolve({ conversation, submission });
          input.admitted?.();
        };

        if (peerMail) {
          await awaitWithContext(writeService(() => {
            waitingContext.abortSignal?.throwIfAborted();
            input.working();
          }), waitingContext);
        } else {
          input.working();
        }
        let submission: Submission;
        if ("peerMail" in input) {
          const { author, text, deliveryId } = input.peerMail;
          waitingContext.abortSignal?.throwIfAborted();
          submission = await conversation.submit({
            type: "input",
            requestId: input.turnId,
            whenBusy: "followUp",
            content: formatAuthorText(author, text),
            entry: { kind: "write", data: { author, text, deliveryId } },
          }, waitingContext);
          clearTimeout(admissionTimer);
          delete turn.cancelAdmission;
          register(submission);
          bookkeeping = recordPeerMailAcceptance(input.db, input.turnId, submission.id, input.markDelivered).catch((error: unknown) => {
            console.error(`peer-mail Turn ${input.turnId} was admitted but Service bookkeeping failed`, error);
          });
        } else {
          try {
            submission = await conversation.submit({ type: "input", content: input.text, requestId: input.turnId, ...(whenBusy ? { whenBusy, whenIdle: "reject" as const } : {}) }, context);
          } catch (error) {
            if (!(whenBusy && error instanceof ConversationIdle)) throw error;
            submission = await conversation.submit({ type: "input", content: input.text, requestId: input.turnId }, context);
          }
          await writeService(() => associateSubmission(input.db, input.turnId, submission.id, "input"));
          register(submission);
        }
        await projection.start();
        const settlements = [await submission.wait(context)];
        for (let index = 0; index < turn.pending.length; index++) {
          const steered = await turn.pending[index]!;
          if (steered) settlements.push(steered);
        }
        await projection.finish(settlements);
        if (!settlements.some((item) => item.status === "done")) {
          const failed = settlements.find((item) => item.status === "unanswered");
          if (!failed || failed.status !== "unanswered") throw new Error("Durable turn did not complete");
          if (failed.reason === "aborted") throw new DurableRunAborted();
          const failure = ownedWatch.value.docs["pi.live"] as { runFailure?: { inputs: readonly number[]; reason: string; detail?: string } } | undefined;
          const runFailure = failure?.runFailure?.inputs.includes(failed.id) ? failure.runFailure : undefined;
          throw new Error(runFailure?.detail ?? (typeof failed.detail === "string" ? failed.detail : failed.reason));
        }
      } catch (error) {
        let failure = error;
        if (!(error instanceof DurableRunAborted)) {
          const reason = failureMessage(error);
          const redacted = await redactFailure(reason, input.botId);
          if (redacted !== reason) failure = new Error(redacted);
        }
        admission.reject(failure);
        throw failure;
      } finally {
        clearTimeout(admissionTimer);
        try { await watch?.stop(); }
        finally {
          await bookkeeping;
          releaseTurn(input.turnId);
        }
      }
    }

    return {
      ...(approvals ? { approvals } : {}),
      credentials,
      secrets: secretStore,
      bindServices(bound) { services = bound; },
      startTurn,
      startPeerMailTurn: startTurn,
      writeService,
      async recoverPeerMailAcceptance(input) {
        const indexed = input.db.query<{ conversation_id: ConversationId }, [string, string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ? AND bot_id = ?").get(input.threadId, input.botId);
        if (!indexed) return false;
        const submission = await harness.commit(async (tx) => {
          const conversationId = indexed.conversation_id;
          const record = await tx.submissionByRequest(conversationId, input.turnId);
          if (record?.type !== "input") return;
          if (record.entry !== undefined) {
            return (await tx.entry(record.entry))?.kind === "write" ? record : undefined;
          }
          if (record.status === "queued") {
            const inbox = await tx.doc(InboxDoc, conversationId);
            return inbox.items.find((item) => item.id === record.id)?.entry?.kind === "write" ? record : undefined;
          }
          // Withdrawing a queued input removes its inbox item. This request ID belongs to the mailbox's own Turn.
          if (record.status === "unanswered") return record;
        }, context);
        if (!submission) return false;
        await recordPeerMailAcceptance(input.db, input.turnId, submission.id, input.markDelivered);
        return true;
      },
      recoverTurns(input) {
        const jobs: Promise<void>[] = [];
        const rows = input.db.query<{ id: string; thread_id: string; bot_id: string }, []>("SELECT id, thread_id, bot_id FROM turns WHERE status = 'working' ORDER BY started_at, id").all();
        const settleTurn = (...args: Parameters<typeof input.settled>) => writeService(() => input.settled(...args));
        const reportFailure = async (row: (typeof rows)[number], reason: string) => {
          const redacted = await redactFailure(reason, row.bot_id);
          await settleTurn(row.id, { status: "failed", reason: redacted });
        };
        const registered = (async () => {
          const prepared: {
            row: (typeof rows)[number];
            conversation: Conversation;
            owned: Submission;
            associations: { submission_id: number; kind: string }[];
          }[] = [];
          const failed: { row: (typeof rows)[number]; reason: string }[] = [];
          // Waiting on any submission can resume the global scheduler, so map all Bots and remember their conversations' models first.
          for (const row of rows) {
            try {
              const indexed = input.db.query<{ conversation_id: number }, [string, string]>("SELECT conversation_id FROM pi_thread_conversations WHERE thread_id = ? AND bot_id = ?").get(row.thread_id, row.bot_id);
              if (!indexed) throw new Error("durable conversation not found");
              const conversation = await openThreadConversation(input.db, harness, row.thread_id, row.bot_id, context, { writeService });
              conversationBots.set(conversation.id, row.bot_id);
              const associations = input.db.query<{ submission_id: number; kind: string }, [string]>("SELECT submission_id, kind FROM pi_turn_submissions WHERE turn_id = ? ORDER BY submission_id").all(row.id);
              const association = associations.find((item) => item.kind === "input");
              let primary = association ? await harness.submission(association.submission_id as SubmissionId, context) : undefined;
              if (!primary) {
                const record = await harness.commit((tx) => tx.submissionByRequest(conversation.id, row.id), context);
                if (record?.type === "input") {
                  primary = await harness.submission(record.id, context);
                  // Mailbox reconciliation owns the transaction for the association and delivery.
                  const peerMail = input.db.query("SELECT 1 FROM bot_mail_deliveries WHERE target_bot_id = ? AND target_turn_id = ?").get(row.bot_id, row.id);
                  if (!peerMail) await writeService(() => associateSubmission(input.db, row.id, record.id, "input"));
                }
              }
              if (!primary) throw new Error("durable submission not found");
              const { model } = await conversation.agent(context);
              if (model) rememberModelSelection(model.provider, model.modelId);
              prepared.push({ row, conversation, owned: primary, associations });
            } catch (error) {
              failed.push({ row, reason: failureMessage(error) });
            }
          }
          for (const { row, reason } of failed) await reportFailure(row, reason);
          for (const { row, conversation, owned, associations } of prepared) {
            try {
              const admission = { conversation, submission: owned };
              const turn: ActiveTurn = { db: input.db, threadId: row.thread_id, admitted: Promise.resolve(admission), pending: [], steers: [], inputs: new Set([owned.id]), recovering: true };
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
                    await writeService(() => associateSubmission(input.db, row.id, steer.id, "steer"));
                  }
                  turn.recovering = false;
                  const firstEntry = (await owned.status(context)).entry;
                  watch = await conversation.watch(context, { ...(firstEntry === undefined ? {} : { from: firstEntry }), min: 100, max: 200 });
                  const ownedWatch = watch;
                  const transcript = await writeService(() => {
                    const removed = input.db.query<{ kind: string; count: number }, [string]>("SELECT kind, count(*) AS count FROM messages WHERE turn_id = ? AND kind IN ('response', 'thinking') GROUP BY kind").all(row.id);
                    input.db.query("DELETE FROM messages WHERE turn_id = ? AND kind IN ('response', 'thinking')").run(row.id);
                    for (const item of removed) input.events.append("thread", row.thread_id, `${item.kind}.removed`, { threadId: row.thread_id, turnId: row.id, count: item.count });
                    return new DurableTranscript(input.threads, input.bots, input.events, row.thread_id, row.bot_id, row.id, { ...ownedWatch.value, entries: [] });
                  });
                  const projection = projectTurn(conversation, ownedWatch, turn, transcript);
                  await projection.projectAnswers(await Promise.all([owned, ...turn.steers].map((submission) => submission.status(context))));
                  await projection.start();
                  const settlements = [await owned.wait(context)];
                  for (let i = 0; i < turn.pending.length; i++) {
                    const item = await turn.pending[i];
                    if (item) settlements.push(item);
                  }
                  await projection.finish(settlements);
                  if (settlements.some((item) => item.status === "done")) await settleTurn(row.id, { status: "completed" });
                  else {
                    const failed = settlements.find((item) => item.status === "unanswered");
                    if (!failed || failed.status !== "unanswered") throw new Error("Durable turn did not complete");
                    if (failed.reason === "aborted") {
                      await ownedWatch.stop();
                      await settleTurn(row.id, { status: "cancelled" });
                    } else {
                      const live = ownedWatch.value.docs["pi.live"] as { runFailure?: { inputs: readonly number[]; detail?: string } } | undefined;
                      const reason = (live?.runFailure?.inputs.includes(failed.id) ? live.runFailure.detail : undefined) ?? (typeof failed.detail === "string" ? failed.detail : failed.reason);
                      await reportFailure(row, reason);
                    }
                  }
                } catch (error) { await reportFailure(row, failureMessage(error)); }
                finally {
                  try { await watch?.stop(); }
                  finally { releaseTurn(row.id); }
                }
              })());
            } catch (error) {
              releaseTurn(row.id);
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
          // Pending mail can be waiting for this Thread's placed run to finish.
          if (turn.threadId !== threadId || turn.cancelAdmission) continue;
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
            turn.inputs.add(submission.id);
            turn.steers.push(submission);
            await writeService(() => associateSubmission(turn.db, turnId, submission.id, "steer"));
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
          if (turn.cancelAdmission) {
            turn.cancelAdmission(new DurableRunAborted());
            // A submission already committing can still be admitted and must then be aborted by its handle.
            if (!(await turn.admitted.catch(() => undefined))) return;
          }
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
