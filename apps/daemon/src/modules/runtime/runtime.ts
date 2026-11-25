import type { Database } from "bun:sqlite";
import type { AgentBotMessageToolOutput, AgentCommand, NativeMcpControlResult, NativeMcpStatus, WorkerUserMessage } from "@omarchy-bot/agent-contract";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import type { SurfaceId } from "@omarchy-bot/domain";
import type { ComputerBroker } from "../computer/broker.ts";
import type { PluginsService } from "../plugins/plugins.ts";
import type { SidecarBroker } from "../devices/sidecarBroker.ts";
import { readAllowedFolders, readSettingsAllowedFolders } from "../workspace/allowedFolders.ts";
import type { PlatformPaths } from "../workspace/paths.ts";
import { openThreadConversation } from "./conversations.ts";
import { DurableTranscript } from "./transcript.ts";
import { resolveActiveTurnIdentity } from "./active-turn.ts";
import { resolveModelForBot } from "./models.ts";
import type { TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, withCancel, type Context } from "@earendil-works/chord/context";
import { CredentialStore } from "./credentials.ts";
import { ApprovalStore } from "./approvals.ts";
import { createRuntimeModels } from "./models.ts";
import { compactionExtension, compactionSettings, formatAuthorText } from "./compaction.ts";
import { createFilesEnvironment, createFilesShellExtension, resolveImplicitDownloads } from "./extensions/files-shell.ts";
import { createComputerExtension } from "./extensions/computer.ts";
import { createBrowserExtension } from "./extensions/browser.ts";
import { createLocalExtension } from "./extensions/local.ts";
import { createMailExtension } from "./extensions/mail.ts";
import { createMcpExtension, type McpExtensionDeps } from "./extensions/mcp.ts";
import { DispatchedCallIds } from "./extensions/model-call.ts";
import { createPluginsExtension } from "./extensions/plugins.ts";
import { buildSystemPrompt } from "./extensions/prompt.ts";
import { createSecretsExtension, type BotSecretAccess } from "./extensions/secrets.ts";
import { listWorkspaceSkills } from "./extensions/skills.ts";
import { createWebExtension, EXA_SEARCH_KEY_SECRET, readWebExemptRanges } from "./extensions/web.ts";
import { BunSecretsBackend, probeBunSecrets } from "./bunSecrets.ts";
import { SecretStore } from "./secrets.ts";
import { McpOAuthManager, type McpOAuthManagerDeps } from "./mcpOAuth.ts";
import { AssistantEntry, configure, ConversationIdle, createRegistry, Harness, InboxDoc, LiveDoc, type AgentChange, type Conversation, type ConversationId, type ConversationWatch, type EntryId, type EntryRecord, type LiveState, type TaskId, type ToolExecutionApi, type SettledSubmissionRecord, type SubmissionRecord, type Submission, type SubmissionId, type Cursor } from "@earendil-works/pi-durable";
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

type UserTurnStart = DurableTurnStart & WorkerUserMessage & {
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
type TurnRun = { first: EntryId; input: SubmissionId };
type TurnDeadline = {
  budgetMs: number;
  remainingMs: number;
  conversation?: Conversation;
  run?: TurnRun & { toolTasks: ReadonlySet<number> };
  timer?: ReturnType<typeof setTimeout>;
  resumedAt?: number;
  attemptedRun?: EntryId;
  attempt?: Promise<SubmissionId | undefined>;
  retryDelayMs?: number;
};

function newTurnDeadline(budgetMs: number | undefined): TurnDeadline | undefined {
  return budgetMs === undefined ? undefined : { budgetMs, remainingMs: budgetMs };
}

function pauseTurnDeadline(deadline: TurnDeadline): void {
  if (deadline.resumedAt === undefined) return;
  deadline.remainingMs = Math.max(0, deadline.remainingMs - (performance.now() - deadline.resumedAt));
  clearTimeout(deadline.timer);
  delete deadline.resumedAt;
  delete deadline.timer;
}

function pendingToolTasks(live: LiveState | undefined): ReadonlySet<number> {
  const tasks = new Set<number>();
  for (const { taskId, status } of [...live?.tools ?? [], ...live?.nestedTools ?? []]) {
    if (taskId !== undefined && status !== "done") tasks.add(taskId);
  }
  return tasks;
}

type ActiveTurn = {
  db: Database;
  threadId: string;
  deviceId?: string;
  admitted: Promise<TurnAdmission>;
  cancelAdmission?: (reason?: unknown) => void;
  steerAdmissions: Promise<Submission | undefined>[];
  steers: Submission[];
  inputs: Set<number>;
  lastEntryBeforeAbort?: number | undefined;
  abortCutoffRead?: Promise<void>;
  deadline?: TurnDeadline | undefined;
  userAborting?: boolean;
  recovering?: boolean;
};

export interface BotRuntime {
  bindServices(services: RuntimeServices): void;
  startTurn(input: UserTurnStart): Promise<void>;
  startPeerMailTurn(input: PeerMailTurnStart): Promise<void>;
  recoverPeerMailAcceptance(input: { db: Database; turnId: string; threadId: string; botId: string; markDelivered(): void }): Promise<boolean>;
  /** Run synchronous Service SQL in the same writer queue as pi storage. */
  writeService: ServiceWrite;
  quiesceConversation(conversationId: number, timeoutMs: number): Promise<void>;
  recoverTurns(input: { db: Database; threads: ThreadsService; bots: BotsService; events: EventLog; registered(turnId: string): void; settled(turnId: string, outcome: { status: "completed" | "cancelled" } | { status: "failed"; reason: string }): void }): { registered: Promise<void>; settled: Promise<void> };
  activeTurn(threadId: string): Promise<string | undefined>;
  steer(turnId: string, text: string, requestId: string): Promise<void>;
  abortTurn(turnId: string): Promise<void>;
  mcpStatus(): NativeMcpStatus[];
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

async function contentWithManagedAttachments(text: string, attachments: NonNullable<WorkerUserMessage["attachments"]>): Promise<string | TextContent[]> {
  const blocks: TextContent[] = [{ type: "text", text }];
  for (const { id, name, mediaType, path } of attachments) {
    // Compaction currently serializes model content as text, including image data.
    if (!mediaType.startsWith("text/") && mediaType !== "application/json") continue;
    let content: string;
    try {
      content = await Bun.file(path).text();
    } catch {
      throw new Error(`Unable to read managed attachment ${id}`);
    }
    blocks.push({ type: "text", text: `${id}|${name}|${mediaType}|${content}` });
  }
  return blocks.length > 1 ? blocks : text;
}

function shouldProjectEntry(entry: EntryRecord, lastEntryBeforeAbort: number | undefined): boolean {
  if (lastEntryBeforeAbort === undefined || entry.id <= lastEntryBeforeAbort || !AssistantEntry.is(entry)) return true;
  return !entry.model?.some((message) => message.role === "assistant" && message.stopReason === "aborted");
}

export async function openBotRuntime(paths: PlatformPaths & { dbPath: string }, db?: Database, options: {
  events?: Pick<EventLog, "append">;
  turnTimeoutMs?: number;
  mcp?: Pick<McpExtensionDeps, "servers" | "prepareServers" | "fillSecrets" | "authProvider">;
  mcpOAuth?: {
    onAuthorization?: (outcome: McpAuthorizationOutcome) => void;
  };
  computer?: Pick<ComputerBroker, "agentToolAct" | "agentBrowserAct">;
} = {}): Promise<BotRuntime> {
  const secretsApi = typeof Bun === "undefined" ? undefined : Bun.secrets;
  const secretStore = new SecretStore(paths.dataDir, secretsApi ? {
    backend: new BunSecretsBackend(secretsApi),
    probe: () => probeBunSecrets(secretsApi),
  } : undefined);
  const redactFailure = (reason: string, botId: string) => secretStore.redactKnown(reason, botId).catch(() => "[redacted]");
  const mcpOptions = options.mcp;
  const onAuthorization = options.mcpOAuth?.onAuthorization;
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
      try { await onAuthorization?.({ ...outcome, authorizationId, server: name }); }
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

  function projectTurn(conversation: Conversation, watch: ConversationWatch, turn: ActiveTurn, transcript: DurableTranscript, observeRun: (run: TurnRun | undefined, live: LiveState | undefined) => void) {
    let current: TurnRun | undefined;
    let updating: Promise<void> | undefined;
    const projectedAnswers = new Set<EntryId>();
    let lastProjectedAnswer: EntryId | undefined;
    let lastProjectedFailure: EntryId | undefined;

    async function successorFirst(failedFirst: EntryId, failedInputs: readonly SubmissionId[]): Promise<EntryId | undefined> {
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

    async function projectSettled(view: ConversationWatch["value"], records: readonly (SubmissionRecord | undefined)[], settledAfterView = false): Promise<void> {
      const ranges: { first: EntryId; last: EntryId; failed?: true }[] = [];
      const live = view.docs["pi.live"] as LiveState | undefined;
      const failure = live?.runFailure;
      const failedFirst = failure?.first;
      const failedPrimary = failure?.inputs[0];
      const latest = view.entries.at(-1)?.id ?? view.before;
      if (failure && failedFirst !== undefined && failedFirst !== lastProjectedFailure && failedPrimary !== undefined && turn.inputs.has(failedPrimary) && latest !== undefined) {
        const successor = await successorFirst(failedFirst, failure.inputs);
        const last = successor !== undefined && successor <= latest ? (successor - 1) as EntryId : latest;
        if (last >= failedFirst) ranges.push({ first: failedFirst, last, failed: true });
      }
      const answered = records.filter((record) => record?.type === "input" && record.status === "done");
      const answers = new Set<EntryId>();
      for (const record of answered) {
        // Storage can already hold a newer answer than this watch revision.
        if (projectedAnswers.has(record.answer) || answers.has(record.answer) || (!settledAfterView && (latest === undefined || record.answer > latest))) continue;
        answers.add(record.answer);
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
        if (turn.inputs.has(primary.id)) ranges.push({ first: primary.entry, last: record.answer });
        else projectedAnswers.add(record.answer);
      }
      // A settled steer and the failed run it followed can both be present when recovery first attaches.
      for (const { first, last, failed } of ranges.sort((left, right) => left.first - right.first)) {
        await projectEntries(view, first, last);
        if (failed) {
          lastProjectedFailure = first;
          continue;
        }
        projectedAnswers.add(last);
        if (lastProjectedAnswer === undefined || last > lastProjectedAnswer) lastProjectedAnswer = last;
      }
    }

    async function projectView(view: ConversationWatch["value"], recoveryRecords?: readonly SubmissionRecord[]): Promise<void> {
      const live = view.docs["pi.live"] as LiveState | undefined;
      const first = live?.run?.first;
      const primary = live?.run?.inputs[0];
      observeRun(first !== undefined && primary !== undefined && turn.inputs.has(primary) && live?.run?.afterRun === undefined ? { first, input: primary } : undefined, live);
      const ended = current?.first !== first ? current : undefined;
      await projectSettled(view, ended ? [await storage.submission(ended.input, context)] : recoveryRecords ?? []);
      if (ended) current = undefined;
      const recovering = recoveryRecords !== undefined;
      // Recovery can settle a run before its watch has delivered the ending revision.
      if (first === undefined || primary === undefined || !turn.inputs.has(primary) || (lastProjectedAnswer !== undefined && first <= lastProjectedAnswer)) {
        await transcript.reconcileCompactions(view, conversation, writeService);
        if (recovering) await writeService(() => transcript.resume({ ...view, docs: {} }));
        return;
      }
      if (current === undefined && view.before !== undefined && view.before >= first) {
        await projectEntries(view, first, view.before);
      }
      current = { first, input: primary };
      const entries = view.entries.filter((entry) => entry.id >= first && shouldProjectEntry(entry, turn.lastEntryBeforeAbort));
      await writeService(() => {
        if (recovering) {
          transcript.update({ ...view, entries, docs: {} });
          transcript.resume(view);
        } else {
          transcript.update({ ...view, entries });
        }
      });
    }

    return {
      async start(recoveryRecords?: readonly SubmissionRecord[]) {
        await projectView(watch.value, recoveryRecords);
        watch.start((call) => {
          if (call.kind !== "value") return Promise.resolve();
          updating = projectView(call.value);
          return updating;
        });
      },
      async finish(settlements: readonly SettledSubmissionRecord[]) {
        await watch.stop();
        await updating;
        if (settlements.some((record) => record.status === "unanswered" && record.entry !== undefined)) {
          // Stopping a watch drops buffered revisions, which can include a settled failure.
          const settledWatch = await conversation.watch(context, { min: 1, max: 1 });
          try { await projectSettled(settledWatch.value, settlements); }
          finally { await settledWatch.stop(); }
        } else {
          await projectSettled(watch.value, settlements, true);
        }
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
    const deadline = active.get(turnId)?.deadline;
    if (deadline) pauseTurnDeadline(deadline);
    active.delete(turnId);
    dispatched.deleteTurn(turnId);
  }
  let services: RuntimeServices | undefined;
  try {
    const registry = createRegistry();
    registry.install(compactionExtension);
    const approvals = db && options.events ? new ApprovalStore(db, options.events, Date.now, (conversationId) => {
      for (const [turnId, turn] of active) {
        if (turn.deadline?.conversation?.id === conversationId) updateTurnDeadline(turnId, turn);
      }
    }) : undefined;
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
    const computer = options.computer;
    if (db && computer) {
      const findSurface = db.query<{ surfaceId: SurfaceId }, [string]>("SELECT surface_id AS surfaceId FROM bot_surfaces WHERE bot_id = ?");
      const owner = async (api: ToolExecutionApi, context: Context) => {
        const { botId, turnId } = await resolveActiveTurnIdentity(api, context, db, active);
        const surface = findSurface.get(botId);
        return surface ? { botId, turnId, surfaceId: surface.surfaceId } : undefined;
      };
      registry.install(createComputerExtension({
        broker: { agentToolAct: (owner, turnId, toolCallId, action, signal) => computer.agentToolAct(owner, turnId, toolCallId, action, signal, true) },
        owner,
      }));
      registry.install(createBrowserExtension({ broker: computer, owner }));
    }
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
    settings: {
      afterFailedRun: "continue", restartLimit: 5, compaction: compactionSettings,
      // Request persistence as soon as Pi publishes progress that the Service can project.
      progress: { persistWithinMs: 0 },
    } }, context);
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
    function updateTurnDeadline(turnId: string, turn: ActiveTurn): void {
      const deadline = turn.deadline;
      if (!deadline || active.get(turnId) !== turn) return;
      const { conversation, run } = deadline;
      if (!conversation || !run || turn.userAborting || approvals?.hasPendingForTasks(conversation.id, run.toolTasks)) {
        pauseTurnDeadline(deadline);
        return;
      }
      if (deadline.resumedAt !== undefined || deadline.attempt || deadline.attemptedRun === run.first) return;
      deadline.resumedAt = performance.now();
      deadline.timer = setTimeout(() => {
        pauseTurnDeadline(deadline);
        deadline.attemptedRun = run.first;
        deadline.attempt = expireTurnDeadline(turn, conversation, run, deadline).catch(() => {
          console.error(`Could not abort timed-out durable Turn ${turnId}`);
          delete deadline.attemptedRun;
          deadline.retryDelayMs = Math.min((deadline.retryDelayMs ?? 25) * 2, 1_000);
          return undefined;
        }).then((timedOutInput) => {
          if (timedOutInput === undefined) {
            delete deadline.attempt;
            updateTurnDeadline(turnId, turn);
          }
          return timedOutInput;
        });
      }, Math.max(deadline.remainingMs, deadline.retryDelayMs ?? 0));
      deadline.timer.unref();
    }

    function deadlineObserver(turnId: string, turn: ActiveTurn, conversation: Conversation) {
      return (run: TurnRun | undefined, live: LiveState | undefined) => {
        const deadline = turn.deadline;
        if (!deadline) return;
        if (deadline.run?.first !== run?.first) pauseTurnDeadline(deadline);
        deadline.conversation = conversation;
        if (run) deadline.run = { ...run, toolTasks: pendingToolTasks(live) };
        else delete deadline.run;
        updateTurnDeadline(turnId, turn);
      };
    }

    async function expireTurnDeadline(turn: ActiveTurn, conversation: Conversation, run: TurnRun, deadline: TurnDeadline): Promise<SubmissionId | undefined> {
      function ownedRun(live: Readonly<LiveState> | undefined) {
        const current = live?.run;
        return current?.first === run.first && current.inputs[0] === run.input && current.afterRun === undefined ? current : undefined;
      }

      let revision: { live: Readonly<LiveState> | undefined } | undefined;
      const observation = await harness.observeDoc(LiveDoc, conversation.id, {
        advance(call) {
          if (call.kind === "value") revision = { live: call.retired ? undefined : call.value };
        },
        end() { revision = { live: undefined }; },
      }, context);
      const skip = AbortSignal.abort();
      let checkedTask: TaskId | undefined;
      let cutoff = 0;
      let accepted: boolean | undefined;
      const checkedContext: Context = {
        telemetry: context.telemetry,
        value: context.value.bind(context),
        toString: context.toString.bind(context),
        get abortSignal() {
          // pi-durable 1.5.2 checks the context at entry to the abort transaction.
          if (accepted !== undefined) return accepted ? context.abortSignal : skip;
          const live = revision ? revision.live : observation?.value;
          const current = ownedRun(live);
          accepted = false;
          if (!current) return skip;
          const toolTasks = pendingToolTasks(live);
          if (turn.userAborting || approvals?.hasPendingForTasks(conversation.id, toolTasks) || (checkedTask !== undefined && current.taskId !== checkedTask)) {
            if (deadline.run?.first === run.first) deadline.run = { ...run, toolTasks };
            delete deadline.attemptedRun;
            return skip;
          }
          if (checkedTask === undefined) return skip;
          turn.lastEntryBeforeAbort = cutoff;
          accepted = true;
          return context.abortSignal;
        },
      };
      try {
        // Queue these together. The first commit's reads wait for any pending writes to the run or task.
        const check = conversation.commit(async (tx) => {
          const current = ownedRun(await tx.doc(LiveDoc, conversation.id));
          if (!current) return;
          const task = await tx.task(current.taskId);
          if (!task || task.abortRequested || task.state.status === "terminal") return;
          cutoff = await tx.latestEntryId(conversation.id) ?? 0;
          checkedTask = task.id;
        }, context);
        // A Turn that times out withdraws queued follow-ups and steers on the same Thread because the timeout uses
        // Conversation.abort(). Restoring Task 4's continue-after-failure behavior for timeouts would require
        // persisted timeout intent and per-run ownership of combined admissions.
        const abort = conversation.abort(checkedContext).catch((error: unknown) => {
          if (error !== skip.reason) throw error;
        });
        await Promise.all([check, abort]);
        return accepted ? run.input : undefined;
      } catch (error) {
        if (accepted) delete turn.lastEntryBeforeAbort;
        throw error;
      } finally {
        observation?.detach();
      }
    }

    async function settleTurnInputs(turn: ActiveTurn, submission: Submission): Promise<{ settlements: SettledSubmissionRecord[]; timeoutReason?: string }> {
      const settlements = [await submission.wait(context)];
      for (const pending of turn.steerAdmissions) {
        const steer = await pending;
        if (steer) settlements.push(await steer.wait(context));
      }
      const deadline = turn.deadline;
      if (!deadline) return { settlements };
      const timedOutInput = await deadline.attempt;
      pauseTurnDeadline(deadline);
      delete turn.deadline;
      // As at Checkpoint B, a hard kill between pi-durable committing the aborted entry and the Service writing
      // terminal status can leave recovery reporting the fallback abort reason instead of the timeout reason.
      return settlements.some((record) => record.id === timedOutInput && record.status === "unanswered" && record.reason === "aborted")
        ? { settlements, timeoutReason: `timed out after ${Math.round(deadline.budgetMs / 1000)}s` }
        : { settlements };
    }

    async function abortTurn(turnId: string): Promise<void> {
      const turn = active.get(turnId);
      if (!turn) return;
      turn.userAborting = true;
      try {
        if (turn.deadline) {
          pauseTurnDeadline(turn.deadline);
          if (await turn.deadline.attempt !== undefined) return;
        }
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
        if (result === "already_placed" || (result === "settled" && (turn.steerAdmissions.length > 0 || turn.recovering))) await conversation.abort(context);
      } catch (error) {
        delete turn.userAborting;
        delete turn.lastEntryBeforeAbort;
        updateTurnDeadline(turnId, turn);
        throw error;
      }
    }
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
        db: input.db, threadId: input.threadId, admitted: admission.promise, steerAdmissions: [], steers: [], inputs: new Set(),
        deadline: peerMail ? undefined : newTurnDeadline(options.turnTimeoutMs),
        ...("deviceId" in input && input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(waiting ? { cancelAdmission: waiting.cancel } : {}),
      };
      active.set(input.turnId, turn);
      let watch: ConversationWatch | undefined;
      let bookkeeping: Promise<void> | undefined;
      const runTurn = async () => {
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
          const transcript = new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, { ...ownedWatch.value, entries: [] }, input.db);
          const projection = projectTurn(conversation, ownedWatch, turn, transcript, deadlineObserver(input.turnId, turn, conversation));
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
            bookkeeping = recordPeerMailAcceptance(input.db, input.turnId, submission.id, input.markDelivered).catch(async (error: unknown) => {
              const reason = await redactFailure(failureMessage(error), input.botId);
              console.error(`peer-mail Turn ${input.turnId} was admitted but Service bookkeeping failed`, reason);
            });
          } else {
            const content = input.attachments?.length ? await contentWithManagedAttachments(input.text, input.attachments) : input.text;
            try {
              submission = await conversation.submit({ type: "input", content, requestId: input.turnId, ...(whenBusy ? { whenBusy, whenIdle: "reject" as const } : {}) }, context);
            } catch (error) {
              if (!(whenBusy && error instanceof ConversationIdle)) throw error;
              submission = await conversation.submit({ type: "input", content, requestId: input.turnId }, context);
            }
            await writeService(() => associateSubmission(input.db, input.turnId, submission.id, "input"));
            register(submission);
          }
          await projection.start();
          const { settlements, timeoutReason } = await settleTurnInputs(turn, submission);
          await projection.finish(settlements);
          if (timeoutReason !== undefined) throw new Error(timeoutReason);
          if (!settlements.some((item) => item.status === "done")) {
            const failed = settlements.find((item) => item.status === "unanswered");
            if (!failed || failed.status !== "unanswered") throw new Error("Durable turn did not complete");
            if (failed.reason === "aborted") throw new DurableRunAborted();
            const failure = ownedWatch.value.docs["pi.live"] as { runFailure?: { inputs: readonly number[]; reason: string; detail?: string } } | undefined;
            const runFailure = failure?.runFailure?.inputs.includes(failed.id) ? failure.runFailure : undefined;
            throw new Error(runFailure?.detail ?? (typeof failed.detail === "string" ? failed.detail : failed.reason));
          }
        } finally {
          clearTimeout(admissionTimer);
          try { await watch?.stop(); }
          finally {
            try { await bookkeeping; }
            finally { releaseTurn(input.turnId); }
          }
        }
      };
      try {
        await runTurn().finally(async () => {
          // Shutdown can suspend a tool that will resume the next time the Service opens.
          if (!closing) await writeService(() => input.threads.finalizeDurableToolCalls(input.turnId));
        });
      } catch (error) {
        let failure = error;
        if (!(error instanceof DurableRunAborted)) {
          const reason = failureMessage(error);
          const redacted = await redactFailure(reason, input.botId);
          if (redacted !== reason) failure = new Error(redacted);
        }
        admission.reject(failure);
        throw failure;
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
      async quiesceConversation(conversationId, timeoutMs) {
        const stopping = withAbortSignal(AbortSignal.timeout(timeoutMs), context);
        const conversation = await harness.conversation(conversationId as ConversationId, stopping);
        // Background compaction can still write after every Service Turn has settled.
        await conversation?.abort(stopping, { background: true });
      },
      async recoverPeerMailAcceptance(input) {
        try {
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
        } catch (error) {
          throw new Error(await redactFailure(failureMessage(error), input.botId));
        }
      },
      recoverTurns(input) {
        const jobs: Promise<void>[] = [];
        const rows = input.db.query<{ id: string; thread_id: string; bot_id: string }, []>("SELECT id, thread_id, bot_id FROM turns WHERE status = 'working' ORDER BY started_at, id").all();
        type Outcome = Parameters<typeof input.settled>[1];
        const settle = async (row: (typeof rows)[number], outcome: Outcome) => {
          try {
            if (!closing) await writeService(() => input.threads.finalizeDurableToolCalls(row.id));
          } catch (error) {
            outcome = { status: "failed", reason: failureMessage(error) };
          }
          if (outcome.status === "failed") {
            outcome = { status: "failed", reason: await redactFailure(outcome.reason, row.bot_id) };
          }
          try {
            await writeService(() => input.settled(row.id, outcome));
          } catch (error) {
            throw new Error(await redactFailure(failureMessage(error), row.bot_id));
          }
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
          for (const { row, reason } of failed) await settle(row, { status: "failed", reason });
          for (const { row, conversation, owned, associations } of prepared) {
            try {
              const admission = { conversation, submission: owned };
              const budgetMs = options.turnTimeoutMs;
              const peerMail = budgetMs !== undefined && input.db.query("SELECT 1 FROM bot_mail_deliveries WHERE target_bot_id = ? AND target_turn_id = ?").get(row.bot_id, row.id);
              const turn: ActiveTurn = {
                db: input.db, threadId: row.thread_id, admitted: Promise.resolve(admission), steerAdmissions: [], steers: [], inputs: new Set([owned.id]), recovering: true,
                deadline: peerMail ? undefined : newTurnDeadline(budgetMs),
              };
              active.set(row.id, turn);
              input.registered(row.id);
              const recover = async (): Promise<Outcome> => {
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
                    turn.steerAdmissions.push(Promise.resolve(steer));
                    await writeService(() => associateSubmission(input.db, row.id, steer.id, "steer"));
                  }
                  turn.recovering = false;
                  const records = await Promise.all([owned, ...turn.steers].map((submission) => submission.status(context)));
                  const firstEntry = records[0]?.entry;
                  watch = await conversation.watch(context, { ...(firstEntry === undefined ? {} : { from: firstEntry }), min: 100, max: 200 });
                  const ownedWatch = watch;
                  const transcript = new DurableTranscript(input.threads, input.bots, input.events, row.thread_id, row.bot_id, row.id, { ...ownedWatch.value, entries: [] }, input.db);
                  const projection = projectTurn(conversation, ownedWatch, turn, transcript, deadlineObserver(row.id, turn, conversation));
                  await projection.start(records);
                  const { settlements, timeoutReason } = await settleTurnInputs(turn, owned);
                  await projection.finish(settlements);
                  if (timeoutReason !== undefined) return { status: "failed", reason: timeoutReason };
                  if (settlements.some((item) => item.status === "done")) return { status: "completed" };
                  const failed = settlements.find((item) => item.status === "unanswered");
                  if (!failed || failed.status !== "unanswered") throw new Error("Durable turn did not complete");
                  if (failed.reason === "aborted") return { status: "cancelled" };
                  const live = ownedWatch.value.docs["pi.live"] as { runFailure?: { inputs: readonly number[]; detail?: string } } | undefined;
                  const reason = (live?.runFailure?.inputs.includes(failed.id) ? live.runFailure.detail : undefined) ?? (typeof failed.detail === "string" ? failed.detail : failed.reason);
                  return { status: "failed", reason };
                } finally {
                  await watch?.stop();
                }
              };
              const job = recover().then(
                (outcome) => settle(row, outcome),
                (error: unknown) => settle(row, { status: "failed", reason: failureMessage(error) }),
              ).finally(() => { releaseTurn(row.id); });
              // A job can reject before registration finishes and the drain observes it.
              void job.catch(() => {});
              jobs.push(job);
            } catch (error) {
              releaseTurn(row.id);
              await settle(row, { status: "failed", reason: failureMessage(error) });
            }
          }
        })().finally(resumeScheduler);
        recoveryRegistration = registered;
        const settled = registered.finally(async () => {
          const results = await Promise.allSettled(jobs);
          const failure = results.find((result) => result.status === "rejected");
          if (failure) throw failure.reason;
        });
        // Recovery runs in the background, and callers can await settlement later.
        void settled.catch(() => {});
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
        const admission = (async () => {
          const { conversation } = await turn.admitted;
          const submission = await conversation.submit({ type: "input", content: text, whenBusy: "steer", whenIdle: "reject", requestId: `${turnId}:steer:${requestId}` }, context);
          turn.inputs.add(submission.id);
          turn.steers.push(submission);
          await writeService(() => associateSubmission(turn.db, turnId, submission.id, "steer"));
          return submission;
        })();
        turn.steerAdmissions.push(admission.catch(() => undefined));
        await admission;
      },
      abortTurn,
      mcpStatus() {
        return mcp?.status() ?? [];
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
