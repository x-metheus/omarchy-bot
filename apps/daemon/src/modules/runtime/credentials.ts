import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { SecretScope, SecretStore } from "./secrets.ts";

export type ProviderProtocol = "openai-compatible" | "anthropic-messages" | "built-in";
export type StoredModel = Pick<Model<string>, "id"> & Partial<Pick<Model<string>, "name" | "contextWindow" | "maxTokens" | "reasoning" | "input" | "cost">>;
export interface StoredProvider {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  apiKey: string;
  models?: StoredModel[];
}
type ProviderRecord = Omit<StoredProvider, "apiKey">;
export type ProviderProjection = ProviderRecord & { hasKey: boolean };
export const MODEL_CREDENTIALS_FILENAME = "model-credentials.json";
const PROVIDER_PREFIX = "provider-";

function secretName(id: string): string {
  return PROVIDER_PREFIX + createHash("sha256").update(id).digest("hex").slice(0, 48);
}

function isProviderRecord(value: unknown): value is ProviderRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ProviderRecord>;
  return typeof record.id === "string" && record.id.length > 0 && !record.id.includes("/")
    && typeof record.name === "string" && record.name.length > 0
    && (record.protocol === "built-in" || record.protocol === "openai-compatible" || record.protocol === "anthropic-messages")
    && (record.protocol === "built-in" ? record.baseUrl === undefined || typeof record.baseUrl === "string" : !!record.baseUrl && typeof record.baseUrl === "string")
    && (record.models === undefined || (Array.isArray(record.models) && record.models.every((model) => typeof model?.id === "string")));
}

function isStoredProvider(value: unknown): value is StoredProvider {
  return isProviderRecord(value) && "apiKey" in value && typeof value.apiKey === "string" && value.apiKey.length > 0;
}

function readLegacyProviders(file: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Unable to read model credential store");
  }
}

function safeText(keys: readonly string[]): (value: string) => boolean {
  return (value) => !keys.some((key) => value.includes(key));
}

function hasSafeFields(record: ProviderRecord, safe: (value: string) => boolean): boolean {
  return safe(record.id) && safe(record.name) && (record.baseUrl === undefined || safe(record.baseUrl));
}

export function projectProviderModels(models: unknown[], safe: (value: string) => boolean): StoredModel[] {
  return models.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const { id, name, contextWindow, maxTokens, reasoning, input, cost } = model as Partial<StoredModel>;
    if (typeof id !== "string" || !safe(id) || (typeof name === "string" && !safe(name))) return [];
    return [{
      id,
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof maxTokens === "number" ? { maxTokens } : {}),
      ...(typeof reasoning === "boolean" ? { reasoning } : {}),
      ...(Array.isArray(input) && input.every((value) => value === "text" || value === "image") ? { input: [...input] } : {}),
      ...(cost && typeof cost.input === "number" && typeof cost.output === "number" && typeof cost.cacheRead === "number" && typeof cost.cacheWrite === "number"
        ? { cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } } : {}),
    }];
  });
}

function providerRecord(record: ProviderRecord, safe: (value: string) => boolean): ProviderRecord {
  const { id, name, protocol, baseUrl, models } = record;
  return {
    id, name, protocol,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(models === undefined ? {} : { models: projectProviderModels(models, safe) }),
  };
}

/** Service-only provider credentials. Expose metadata through list(), never the runtime accessors. */
export class CredentialStore {
  readonly #providers = new Map<string, StoredProvider>();
  readonly #app: SecretScope;
  #pending: Promise<void> = Promise.resolve();

  constructor(secrets: SecretStore) { this.#app = secrets.forApp(); }

  static async open(stateDir: string, secrets: SecretStore): Promise<CredentialStore> {
    const store = new CredentialStore(secrets);
    const file = path.join(stateDir, MODEL_CREDENTIALS_FILENAME);
    const legacy = readLegacyProviders(file);
    if (legacy) {
      let complete = true;
      const markIncomplete = () => { complete = false; };
      const safe = safeText(legacy.flatMap((value) => {
        if (value && typeof value === "object" && "apiKey" in value && typeof value.apiKey === "string" && value.apiKey) {
          return [value.apiKey];
        }
        return [];
      }));
      const saved = new Map<string, StoredProvider>();
      for (const provider of legacy) {
        try {
          if (!isStoredProvider(provider)) throw new Error();
          saved.set(provider.id, await store.#save(provider, safe));
        } catch { markIncomplete(); }
      }
      try {
        await store.#load(secrets, markIncomplete);
      } catch {
        throw new Error("Unable to migrate model credentials");
      }
      for (const [id, provider] of saved) {
        if (JSON.stringify(store.#providers.get(id)) !== JSON.stringify(provider)) {
          store.#providers.delete(id);
          markIncomplete();
        }
      }
      if (complete) {
        try { rmSync(file, { force: true }); }
        catch { markIncomplete(); }
      }
      if (!complete) console.warn("Unable to migrate some model credentials; keeping the legacy file for retry");
    } else {
      try {
        await store.#load(secrets);
      } catch {
        throw new Error("Unable to read model credential store");
      }
    }
    return store;
  }

  getForRuntime(id: string): StoredProvider | undefined { return structuredClone(this.#providers.get(id)); }
  getAllForRuntime(): StoredProvider[] { return structuredClone([...this.#providers.values()]); }

  list(): ProviderProjection[] {
    const records = [...this.#providers.values()];
    const safe = safeText(records.map(({ apiKey }) => apiKey));
    return records.filter((record) => hasSafeFields(record, safe)).map((record) => ({
      ...providerRecord(record, safe), hasKey: record.apiKey.length > 0,
    }));
  }

  async add(provider: StoredProvider): Promise<void> {
    if (!isStoredProvider(provider)) throw new Error("Invalid model provider");
    const input = structuredClone(provider);
    return this.#write(async () => {
      const safe = safeText([input.apiKey, ...[...this.#providers.values()].map(({ apiKey }) => apiKey)]);
      const record = await this.#save(input, safe);
      this.#providers.delete(record.id);
      this.#providers.set(record.id, record);
    });
  }

  remove(id: string): Promise<void> {
    return this.#write(async () => {
      // Stop using the cached key while a failed backend deletion can still be retried.
      this.#providers.delete(id);
      await this.#app.delete(secretName(id));
    });
  }

  async #load(secrets: SecretStore, onInvalidProvider?: () => void): Promise<void> {
    for (const { name, description } of await this.#app.list()) {
      if (!name.startsWith(PROVIDER_PREFIX)) continue;
      try {
        const record: unknown = JSON.parse(description);
        if (!isProviderRecord(record) || secretName(record.id) !== name) throw new Error();
        const apiKey = await secrets.getAppSecretForRuntime(name);
        if (!apiKey) throw new Error();
        this.#providers.set(record.id, { ...record, apiKey });
      } catch (error) {
        if (!onInvalidProvider) throw error;
        onInvalidProvider();
      }
    }
  }

  async #save(provider: StoredProvider, safe: (value: string) => boolean): Promise<StoredProvider> {
    if (!hasSafeFields(provider, safe)) throw new Error("Provider metadata must not contain a key");
    const record = providerRecord(provider, safe);
    await this.#app.save(secretName(record.id), JSON.stringify(record), provider.apiKey);
    return { ...record, apiKey: provider.apiKey };
  }

  #write(operation: () => Promise<void>): Promise<void> {
    const next = this.#pending.catch(() => {}).then(operation);
    this.#pending = next;
    return next;
  }
}
