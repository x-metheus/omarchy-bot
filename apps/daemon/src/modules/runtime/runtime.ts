import type { Database } from "bun:sqlite";
import type { ThreadsService } from "../threads/threads.ts";
import type { BotsService } from "../bots/bots.ts";
import type { EventLog } from "../events/eventLog.ts";
import { openThreadConversation } from "./conversations.ts";
import { DurableTranscript } from "./transcript.ts";
import { resolveModelForBot } from "./models.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CredentialStore } from "./credentials.ts";
import { createRuntimeModels } from "./models.ts";
import { AssistantEntry, ConversationIdle, createRegistry, Harness, type Conversation, type SettledSubmissionRecord, type Submission } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// Keep the root context in one place until operations have their own contexts.
const context = BACKGROUND_CONTEXT;
export class DurableRunAborted extends Error {
  constructor() { super("aborted"); }
}

export interface BotRuntime {
  startTurn(input: { db: Database; threads: ThreadsService; bots: BotsService; events: EventLog; threadId: string; botId: string; turnId: string; text: string; instructions: string; whenBusy?: "followUp"; requestId?: string; admitted?(): void; working(): void }): Promise<void>;
  activeTurn(threadId: string): Promise<string | undefined>;
  steer(turnId: string, text: string, requestId: string): Promise<void>;
  abortTurn(turnId: string): Promise<void>;
  close(): Promise<void>;
}

export async function openBotRuntime(dbPath: string, stateDir: string): Promise<BotRuntime> {
  const credentials = new CredentialStore(stateDir);
  const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
  let reportedCredentialsFailure = false;
  const selections: { providerId: string; modelId: string }[] = [];
  try {
    const harness = await Harness.open(storage, { models: () => {
      try { return createRuntimeModels(credentials, selections); } catch {
        if (!reportedCredentialsFailure) {
          reportedCredentialsFailure = true;
          console.warn("Unable to load model credential store; continuing without stored providers");
        }
        return createModels();
      }
    }, registry: createRegistry(), settings: { afterFailedRun: "continue" } }, context);
    try {
      harness.resume();
    } catch (error) {
      await harness.close(context);
      throw error;
    }
    let closing: Promise<void> | undefined;
    const active = new Map<string, { threadId: string; admitted: Promise<{ conversation: Conversation; submission: Submission }>; pending: Promise<SettledSubmissionRecord | undefined>[]; steers: Submission[]; inputs: Set<number> }>();
    return {
      async startTurn(input) {
        let ready!: (value: { conversation: Conversation; submission: Submission }) => void;
        let fail!: (error: unknown) => void;
        const admitted = new Promise<{ conversation: Conversation; submission: Submission }>((resolve, reject) => { ready = resolve; fail = reject; });
        void admitted.catch(() => {});
        const turn = { threadId: input.threadId, admitted, pending: [] as Promise<SettledSubmissionRecord | undefined>[], steers: [] as Submission[], inputs: new Set<number>() };
        active.set(input.turnId, turn);
        try {
          const model = resolveModelForBot(input.db, credentials, input.botId);
          if (!selections.some((selection) => selection.providerId === model.provider && selection.modelId === model.id)) {
            selections.push({ providerId: model.provider, modelId: model.id });
          }
          const conversation = await openThreadConversation(input.db, harness, input.threadId, input.botId, context);
          const bot = input.db.query<{ max_turns: number | null }, [string]>("SELECT max_turns FROM bots WHERE id = ?").get(input.botId);
          if (!bot) throw new Error("Bot not found; turn limit unavailable");
          const maxTurns = bot.max_turns ?? ((await conversation.agent(context)).maxTurns === undefined ? undefined : null);
          await conversation.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel: "medium", instructions: input.instructions, ...(maxTurns === undefined ? {} : { maxTurns }) }, context);
          const watch = await conversation.watch(context);
          let transcript: DurableTranscript | undefined = input.whenBusy ? undefined : new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, watch.value);
          watch.start(async (call) => {
            if (call.kind !== "value") return;
            const live = call.value.docs["pi.live"] as { run?: { inputs: readonly number[] } } | undefined;
            if (!live?.run?.inputs.some((id) => turn.inputs.has(id))) return;
            if (!transcript) {
              const { submission } = await turn.admitted;
              const status = await submission.status(context);
              const entries = status.entry === undefined ? call.value.entries : call.value.entries.filter((entry) => entry.id < status.entry!);
              transcript = new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, { ...call.value, entries });
            }
            transcript.update(call.value);
          });
          try {
            input.working();
            let submission: Submission;
            try {
              submission = await conversation.submit({ type: "input", content: input.text, ...(input.whenBusy ? { whenBusy: input.whenBusy, whenIdle: "reject" as const, requestId: input.requestId } : {}) }, context);
            } catch (error) {
              if (!(input.whenBusy && error instanceof ConversationIdle)) throw error;
              submission = await conversation.submit({ type: "input", content: input.text, ...(input.requestId === undefined ? {} : { requestId: input.requestId }) }, context);
            }
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
          fail(error);
          throw error;
        } finally {
          active.delete(input.turnId);
        }
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
            const submission = await conversation.submit({ type: "input", content: text, whenBusy: "steer", whenIdle: "reject", requestId }, context);
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
          const result = await submission.abort(context);
          if (result === "already_placed" || (result === "settled" && turn.pending.length > 0)) await conversation.abort(context);
        }
      },
      close() {
        closing ??= (async () => {
          try {
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
