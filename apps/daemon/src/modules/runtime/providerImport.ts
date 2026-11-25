import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getSetting, setSetting } from "../../persistence/settings.ts";
import { projectProviderModels, type CredentialStore, type ProviderProtocol, type StoredProvider } from "./credentials.ts";
import { DEFAULT_MODEL_SETTING } from "./models.ts";

export const PI_PROVIDER_IMPORT_SETTING = "pi_provider_import";

// Mirrors pi-coding-agent's expandTildePath with the Service's supplied home directory.
function expandPiAgentPath(input: string, homeDir: string): string {
  if (process.platform === "win32" && !input.includes("\\")) {
    const drive = input.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) return `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return path.join(homeDir, input.slice(2));
  }
  return input.startsWith("file://") ? fileURLToPath(input) : input;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function stripModelsJsonComments(content: string): string {
  return content
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => match[0] === '"' ? match : " ")
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, closing: string | undefined) => closing ?? match);
}

async function readPiFile(dir: string, name: string): Promise<Record<string, unknown>> {
  try {
    const content = (await readFile(path.join(dir, name), "utf8")).replace(/^\uFEFF/, "");
    return asRecord(JSON.parse(name === "models.json" ? stripModelsJsonComments(content) : content)) ?? {};
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Unable to read Pi provider configuration");
  }
}

function literalKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.startsWith("!") || !value.trim()) return;
  // Pi escapes literal dollars and bangs. Any other recognized reference needs an environment lookup.
  const references = /\$\$|\$!|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
  for (const [reference] of value.matchAll(references)) {
    if (reference !== "$$" && reference !== "$!") return;
  }
  return value.replace(/\$([!$])/g, "$1");
}

function isBaseUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = URL.parse(value);
  return !!url?.hostname && !url.username && !url.password && (url.protocol === "http:" || url.protocol === "https:");
}

function protocolForApi(api: unknown): ProviderProtocol | undefined {
  if (api === "openai-completions") return "openai-compatible";
  if (api === "anthropic-messages") return "anthropic-messages";
}

type ModelRoute = { id: string; api: unknown; baseUrl: unknown };
type ConfiguredModel = ModelRoute & { definition: Record<string, unknown> };

function configuredModels(config: Record<string, unknown> | undefined, builtinModels: readonly Model<string>[]): Map<string, ConfiguredModel> {
  const configured = new Map<string, ConfiguredModel>();
  if (!Array.isArray(config?.models)) return configured;
  const catalog = new Map<string, ModelRoute>(builtinModels.map((model) => [model.id, model]));
  for (const entry of config.models) {
    const definition = asRecord(entry);
    const id = definition?.id;
    if (!definition || typeof id !== "string" || !id.length) continue;
    // Pi falls back to the matching catalog model, or the first composed model for a new ID.
    const defaults = catalog.get(id) ?? catalog.values().next().value;
    const model = { id, definition, api: definition.api ?? config.api ?? defaults?.api, baseUrl: definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl };
    catalog.set(id, model);
    configured.set(id, model);
  }
  return configured;
}

function preservesRoute(provider: Pick<StoredProvider, "protocol" | "baseUrl">, model: ModelRoute, builtinModels: readonly Model<string>[]): boolean {
  if (provider.protocol === "built-in") {
    const builtin = builtinModels.find(({ id }) => id === model.id) ?? builtinModels[0];
    return !!builtin && builtin.api === model.api && builtin.baseUrl === model.baseUrl;
  }
  return protocolForApi(model.api) === provider.protocol && model.baseUrl === provider.baseUrl;
}

export async function importPiProviders({ db, credentials, homeDir, env = process.env }: {
  db: Database;
  credentials: CredentialStore;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ imported: string[]; seededModel?: string }> {
  if (getSetting(db, PI_PROVIDER_IMPORT_SETTING) !== null) return { imported: [] };

  const configuredDir = env.PI_CODING_AGENT_DIR;
  const agentDir = configuredDir ? expandPiAgentPath(configuredDir, homeDir) : path.join(homeDir, ".pi", "agent");
  const [auth, models, settings] = await Promise.all([
    readPiFile(agentDir, "auth.json"), readPiFile(agentDir, "models.json"), readPiFile(agentDir, "settings.json"),
  ]);
  const configs = asRecord(models.providers) ?? {};
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  const keys = new Set(credentials.getAllForRuntime().map(({ apiKey }) => apiKey));
  const entries = [...new Set([...Object.keys(auth), ...Object.keys(configs)])].map((id) => {
    const authEntry = asRecord(auth[id]);
    const config = asRecord(configs[id]);
    const authKey = authEntry?.type === "api_key" ? literalKey(authEntry.key) : undefined;
    const configKey = literalKey(config?.apiKey);
    if (authKey) keys.add(authKey);
    if (configKey) keys.add(configKey);
    return { id, config, apiKey: authKey ?? configKey };
  });
  // Check every source key before the first write so metadata cannot expose a key imported later.
  const secretValues = [...keys];
  const safe = (value: string) => !secretValues.some((key) => value.includes(key));
  const imported: string[] = [];
  const { defaultProvider, defaultModel } = settings;
  for (const { id, config, apiKey } of entries) {
    if (!id.trim() || id.includes("/") || !safe(id)) continue;
    if (!apiKey || credentials.getForRuntime(id)) continue;
    const builtin = builtins.get(id);
    const builtinModels = builtin?.getModels() ?? [];
    const models = [...configuredModels(config, builtinModels).values()];
    let baseUrl = config?.baseUrl;
    // Model-level URLs can supply a route for custom providers. Built-ins already have one.
    if (baseUrl === undefined && !builtin && models.some((model) => model.definition.baseUrl !== undefined)) {
      const urls = new Set(models.map((model) => model.baseUrl));
      if (urls.size > 1) continue;
      baseUrl = urls.values().next().value;
    }
    if (baseUrl !== undefined && (!isBaseUrl(baseUrl) || !safe(baseUrl))) continue;
    const apis = new Set(models.map((model) => model.api));
    const commonApi = apis.size === 1 ? apis.values().next().value : undefined;
    const api = config?.api ?? commonApi ?? builtinModels[0]?.api;
    const protocol = baseUrl === undefined ? (builtin ? "built-in" : undefined) : protocolForApi(api);
    const name = config?.name ?? builtin?.name ?? id;
    if (!protocol || typeof name !== "string" || !name.trim() || !safe(name)) continue;
    const route = { protocol, ...(baseUrl === undefined ? {} : { baseUrl }) };
    const catalog = Array.isArray(config?.models) ? projectProviderModels(
      models.filter((model) => preservesRoute(route, model, builtinModels)).map((model) => model.definition),
      (value) => value.length > 0 && safe(value),
    ) : undefined;
    try {
      await credentials.add({ id, name, ...route, apiKey, ...(catalog === undefined ? {} : { models: catalog }) });
    } catch (error) {
      if (error instanceof Error && (error.message === "Provider metadata must not contain a key" || error.message === "Secret metadata must not contain the value")) continue;
      throw new Error("Unable to import Pi model providers");
    }
    imported.push(id);
  }

  return db.transaction(() => {
    let seededModel: string | undefined;
    if (getSetting(db, DEFAULT_MODEL_SETTING) === null && typeof defaultProvider === "string" && typeof defaultModel === "string" && defaultModel.trim()) {
      const selection = `${defaultProvider}/${defaultModel}`;
      const stored = credentials.getForRuntime(defaultProvider);
      if (stored && safe(selection)) {
        const config = asRecord(configs[defaultProvider]);
        const builtinModels = builtins.get(defaultProvider)?.getModels() ?? [];
        const inherited = builtinModels.find(({ id }) => id === defaultModel);
        const route = configuredModels(config, builtinModels).get(defaultModel)
          ?? (inherited && { id: defaultModel, api: inherited.api, baseUrl: config?.baseUrl ?? inherited.baseUrl });
        const available = stored.protocol !== "built-in" || inherited || stored.models?.some(({ id }) => id === defaultModel);
        if (available && route && preservesRoute(stored, route, builtinModels)) {
          setSetting(db, DEFAULT_MODEL_SETTING, selection);
          seededModel = selection;
        }
      }
    }
    setSetting(db, PI_PROVIDER_IMPORT_SETTING, "1");
    return { imported, ...(seededModel === undefined ? {} : { seededModel }) };
  })();
}
