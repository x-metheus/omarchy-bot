import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CredentialStore } from "./credentials.ts";
import { createRuntimeModels } from "./models.ts";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// Keep the root context in one place until operations have their own contexts.
const context = BACKGROUND_CONTEXT;

export interface BotRuntime {
  close(): Promise<void>;
}

export async function openBotRuntime(dbPath: string, stateDir: string): Promise<BotRuntime> {
  const credentials = new CredentialStore(stateDir);
  const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
  let reportedCredentialsFailure = false;
  try {
    const harness = await Harness.open(storage, { models: () => {
      try { return createRuntimeModels(credentials); } catch {
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
