import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";

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
export type ProviderProjection = Omit<StoredProvider, "apiKey"> & { hasKey: boolean };
export const MODEL_CREDENTIALS_FILENAME = "model-credentials.json";

type WebSearchProvider = "exa";
type CredentialFile = { providers: StoredProvider[]; sections?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWebSearchKey(sections: CredentialFile["sections"], provider: WebSearchProvider) {
  const keys = sections?.webSearchKeys;
  if (!isRecord(keys)) return undefined;
  const key = keys[provider];
  return typeof key === "string" ? key.trim() || undefined : undefined;
}

/** The file is private to the Service. Never put its contents in logs or DTOs. */
export class CredentialStore {
  private readonly file: string;
  constructor(stateDir: string) { this.file = path.join(stateDir, MODEL_CREDENTIALS_FILENAME); }

  private load(): CredentialFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const sections = isRecord(parsed) ? parsed : undefined;
      const providers = sections ? ("providers" in sections ? sections.providers : []) : parsed;
      if (!Array.isArray(providers) || !providers.every((p) => p && typeof p.id === "string" && !p.id.includes("/") && typeof p.name === "string" && typeof p.apiKey === "string" && ["built-in", "openai-compatible", "anthropic-messages"].includes(p.protocol) && (p.protocol === "built-in" || typeof p.baseUrl === "string") && (p.models === undefined || (Array.isArray(p.models) && p.models.every((m: unknown) => typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string"))))) throw new Error();
      return sections ? { providers, sections } : { providers };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: [] };
      throw new Error("Unable to read model credential store");
    }
  }

  /** Internal accessor: contains secrets and must only be used for model authentication. */
  getForRuntime(id: string): StoredProvider | undefined { return this.load().providers.find((p) => p.id === id); }
  getAllForRuntime(): StoredProvider[] { return this.load().providers; }

  // Task 22 moves these keys into the OS secret store.
  getWebSearchKey(provider: WebSearchProvider): string | undefined { return readWebSearchKey(this.load().sections, provider); }
  setWebSearchKey(provider: WebSearchProvider, key: string): void {
    const { providers, sections } = this.load();
    const storedKeys = sections?.webSearchKeys;
    const webSearchKeys = { ...(isRecord(storedKeys) ? storedKeys : {}), [provider]: key.trim() };
    this.save({ providers, sections: { ...sections, webSearchKeys } });
  }

  list(): ProviderProjection[] {
    const { providers: records, sections } = this.load();
    const keys = [...records.map((p) => p.apiKey), readWebSearchKey(sections, "exa") ?? ""].filter(Boolean);
    const safe = (value: string): boolean => !keys.some((key) => value.includes(key));
    return records.filter((p) => safe(p.id) && safe(p.name) && (p.baseUrl === undefined || safe(p.baseUrl))).map((p) => ({
      id: p.id, name: p.name, protocol: p.protocol, hasKey: p.apiKey.length > 0,
      ...(p.baseUrl === undefined ? {} : { baseUrl: p.baseUrl }),
      ...(p.models === undefined ? {} : { models: p.models.filter(({ id, name }) => safe(id) && (typeof name !== "string" || safe(name))).map(({ id, name, contextWindow, maxTokens, reasoning, input, cost }) => ({ id, ...(typeof name === "string" ? { name } : {}), ...(typeof contextWindow === "number" ? { contextWindow } : {}), ...(typeof maxTokens === "number" ? { maxTokens } : {}), ...(typeof reasoning === "boolean" ? { reasoning } : {}), ...(Array.isArray(input) && input.every((value) => value === "text" || value === "image") ? { input: [...input] } : {}), ...(cost && typeof cost.input === "number" && typeof cost.output === "number" && typeof cost.cacheRead === "number" && typeof cost.cacheWrite === "number" ? { cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } } : {}) })) }),
    }));
  }
  add(provider: StoredProvider): void {
    if (!provider.id || provider.id.includes("/") || !provider.name || !provider.apiKey || !["built-in", "openai-compatible", "anthropic-messages"].includes(provider.protocol) || (provider.protocol !== "built-in" && !provider.baseUrl)) throw new Error("Invalid model provider");
    const credentials = this.load();
    this.save({ ...credentials, providers: [...credentials.providers.filter((p) => p.id !== provider.id), provider] });
  }
  remove(id: string): void {
    const credentials = this.load();
    this.save({ ...credentials, providers: credentials.providers.filter((p) => p.id !== id) });
  }
  private save(credentials: CredentialFile): void {
    const dir = path.dirname(this.file);
    const temp = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      // Keep the legacy array format until the file has separate sections.
      const { providers, sections } = credentials;
      const data = sections === undefined ? providers : { ...sections, providers };
      writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } catch {
      try { unlinkSync(temp); } catch { /* no temporary file */ }
      throw new Error("Unable to write model credential store");
    }
  }
}
