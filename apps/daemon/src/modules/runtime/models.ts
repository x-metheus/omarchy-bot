import type { Database } from "bun:sqlite";
import type { Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { BuiltinProviderDto, ProviderModelDto } from "@omarchy-bot/protocol";
import { getSetting } from "../../persistence/settings.ts";
import { uniqueProviderModels, type CredentialStore, type StoredProvider } from "./credentials.ts";

export const DEFAULT_MODEL_SETTING = "default_model";
// Generic endpoints cannot be assumed to support images or reasoning.
export const DEFAULT_MODEL_METADATA = { contextWindow: 128_000, maxTokens: 8_192, reasoning: false, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

export function listBuiltinProviderIds(): string[] {
  return builtinProviders().map(({ id }) => id);
}

function builtinApiKeyProviders(): Provider[] {
  return builtinProviders().filter(({ auth }) => auth.apiKey !== undefined);
}

export function listBuiltinProviders(): BuiltinProviderDto[] {
  return builtinApiKeyProviders().map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Project chat-model metadata without exposing provider routes or credentials. */
export function listProviderModels(record: Pick<StoredProvider, "id" | "protocol" | "models">): ProviderModelDto[] {
  let catalog: readonly Model<string>[] = [];
  if (record.protocol === "built-in") {
    const builtin = builtinApiKeyProviders().find(({ id }) => id === record.id);
    if (!builtin) return [];
    catalog = builtin.getModels();
  }
  return uniqueProviderModels([...catalog, ...(record.models ?? [])]).map(({ id, name, contextWindow, maxTokens, reasoning, input }) => ({
    id, name, contextWindow, maxTokens, reasoning, input: input && [...input],
  }));
}

function buildProvider(record: StoredProvider, requestedIds: string[] = []): Provider {
  const registry = builtinProviders();
  const builtin = registry.find((p) => p.id === record.id);
  if (record.protocol === "built-in") {
    if (!builtin) throw new Error("Unknown built-in model provider");
    if (!record.models?.length) return builtin;
    const stock = builtin.getModels();
    const nativeRoute = stock[0];
    if (!nativeRoute) return builtin;
    const stockIds = new Set(stock.map(({ id }) => id));
    const extraModels = record.models.filter(({ id }) => !stockIds.has(id)).map((model): Model<string> => ({
      ...DEFAULT_MODEL_METADATA, ...model, name: model.name ?? model.id,
      api: nativeRoute.api, provider: builtin.id, baseUrl: nativeRoute.baseUrl,
    }));
    return {
      ...builtin,
      getModels: () => [...builtin.getModels(), ...extraModels],
      getAllModels: () => [...(builtin.getAllModels?.() ?? builtin.getModels()), ...extraModels],
    };
  }
  try {
    if (!record.baseUrl || !new URL(record.baseUrl).host) throw new Error();
  } catch { throw new Error("Invalid custom provider base URL"); }
  const auth = { apiKey: { name: record.name, resolve: async ({ credential, signal }: { credential?: { key?: string }; signal: AbortSignal }) => {
    signal.throwIfAborted();
    return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
  } } };
  const api = record.protocol === "openai-compatible" ? "openai-completions" : "anthropic-messages";
  const ids = new Set([...(record.models ?? []).map((m) => m.id), ...(requestedIds)]);
  const models: Model<string>[] = [...ids].map((id) => {
    const catalog = record.models?.find((m) => m.id === id);
    const registered = builtin?.getModels().find((m) => m.id === id && m.api === api);
    return { id, name: catalog?.name ?? registered?.name ?? id, api, provider: record.id, baseUrl: record.baseUrl!, contextWindow: catalog?.contextWindow ?? registered?.contextWindow ?? DEFAULT_MODEL_METADATA.contextWindow, maxTokens: catalog?.maxTokens ?? registered?.maxTokens ?? DEFAULT_MODEL_METADATA.maxTokens, reasoning: catalog?.reasoning ?? registered?.reasoning ?? DEFAULT_MODEL_METADATA.reasoning, input: catalog?.input ?? registered?.input ?? DEFAULT_MODEL_METADATA.input, cost: catalog?.cost ?? registered?.cost ?? DEFAULT_MODEL_METADATA.cost };
  });
  return createProvider({ id: record.id, name: record.name, baseUrl: record.baseUrl!, auth, models, api: api === "openai-completions" ? openAICompletionsApi() : anthropicMessagesApi() });
}

/** Construct a fresh pi-ai collection using the Service's loaded credentials. */
export function createRuntimeModels(store: CredentialStore, selections: readonly { providerId: string; modelId: string }[] = []): MutableModels {
  type PiCredentials = NonNullable<NonNullable<Parameters<typeof createModels>[0]>["credentials"]>;
  const chains = new Map<string, Promise<unknown>>();
  // Updates serialize per provider within this collection only and support keyed API credentials only.
  const credentials: PiCredentials = {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      const record = store.getForRuntime(id);
      return record?.apiKey ? { type: "api_key", key: record.apiKey } : undefined;
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return store.getAllForRuntime().filter((p) => p.apiKey).map((p) => ({ providerId: p.id, type: "api_key" as const }));
    },
    async modify(id, fn, options) {
      const previous = chains.get(id) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        options?.signal?.throwIfAborted();
        const record = store.getForRuntime(id);
        const current = record?.apiKey ? { type: "api_key" as const, key: record.apiKey } : undefined;
        const updated = await fn(current);
        if (!updated) return current;
        if (!record || updated.type !== "api_key" || !updated.key || updated.env) throw new Error("Unsupported model credential update");
        await store.add({ ...record, apiKey: updated.key });
        return updated;
      });
      chains.set(id, next);
      try { return await next; } finally { if (chains.get(id) === next) chains.delete(id); }
    },
    async delete(id, options) {
      const previous = chains.get(id) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => {
        options?.signal?.throwIfAborted();
        return store.remove(id);
      });
      chains.set(id, next);
      try { await next; } finally { if (chains.get(id) === next) chains.delete(id); }
    },
  };
  const models = createModels({ credentials });
  for (const record of store.getAllForRuntime()) {
    models.setProvider(buildProvider(record, selections.filter((selection) => selection.providerId === record.id).map((selection) => selection.modelId)));
  }
  return models;
}

/** Read the Bot override and service default anew on every resolution. */
export function resolveModelForBot(db: Database, store: CredentialStore, botId: string): Model<string> {
  const bot = db.query<{ model: string | null }, [string]>("SELECT model FROM bots WHERE id = ?").get(botId);
  if (!bot) throw new Error("Bot not found; provider/model unavailable");
  const selected = bot.model ?? getSetting(db, DEFAULT_MODEL_SETTING);
  if (!selected) throw new Error("No provider/model configured for Bot");
  const separator = selected.indexOf("/");
  if (separator < 1 || separator === selected.length - 1) throw new Error("Invalid Bot provider/model selection");
  const providerId = selected.slice(0, separator);
  const modelId = selected.slice(separator + 1);
  try {
    const models = createRuntimeModels(store, [{ providerId, modelId }]);
    const provider = models.getProvider(providerId);
    if (provider?.getModels().some((model) => model.id === modelId)) {
      const model = models.getModel(providerId, modelId);
      if (model) return model;
    }
  } catch {
    // The underlying error may include credentials or other private store data.
  }
  let reference: string;
  try { reference = store.redactKeys(selected); }
  catch { reference = "[unavailable]"; }
  throw new Error(`Unable to resolve Bot provider/model selection: ${reference}`);
}
