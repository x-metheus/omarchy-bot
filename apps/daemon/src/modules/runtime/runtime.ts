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
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// Keep the root context in one place until operations have their own contexts.
const context = BACKGROUND_CONTEXT;

export interface BotRuntime {
  startTurn(input: { db: Database; threads: ThreadsService; bots: BotsService; events: EventLog; threadId: string; botId: string; turnId: string; text: string; instructions: string; working(): void }): Promise<void>;
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
    }, registry: createRegistry() }, context);
    try {
      harness.resume();
    } catch (error) {
      await harness.close(context);
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      async startTurn(input) {
        const model = resolveModelForBot(input.db, credentials, input.botId);
        if (!selections.some((selection) => selection.providerId === model.provider && selection.modelId === model.id)) {
          selections.push({ providerId: model.provider, modelId: model.id });
        }
        const conversation = await openThreadConversation(input.db, harness, input.threadId, input.botId, context);
        await conversation.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel: "medium", instructions: input.instructions }, context);
        const watch = await conversation.watch(context);
        const transcript = new DurableTranscript(input.threads, input.bots, input.events, input.threadId, input.botId, input.turnId, watch.value);
        watch.start(async (call) => { if (call.kind === "value") transcript.update(call.value); });
        try {
          input.working();
          const submission = await conversation.submit({ type: "input", content: input.text }, context);
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input") throw new Error("Durable turn did not complete");
          const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
          if (!answer) throw new Error("Durable turn answer not found");
          transcript.update({ ...watch.value, entries: [...watch.value.entries, answer] });
        } finally { await watch.stop(); }
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
