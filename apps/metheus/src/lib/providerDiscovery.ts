import { useEffect, useState } from "react";
import {
  agentDaemon,
  DaemonError,
  type ProviderConfiguration,
  type ProviderConnection,
} from "./agentDaemon.ts";

export const defaultDiscoveryDelayMs = 350;

export interface ProviderConnectionDraft {
  baseUrl: string;
  apiKey: string;
  omitStoredKey?: boolean;
}

export type ModelDiscoveryOutcome =
  | { connection: ProviderConnectionDraft; models: string[] }
  | { connection: ProviderConnectionDraft; error: string };

export interface ResolvedProviderConnection {
  baseUrl: string | undefined;
  authentication: ProviderConnection["authentication"];
  keyStored: boolean;
  ready: boolean;
}

export type ProviderModelFetcher = (
  connection: ProviderConnection & { id?: string },
  signal: AbortSignal,
) => Promise<{ models: string[] }>;

export function apiRoot(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.href.includes("?") &&
      !url.href.includes("#")
    ) {
      return url.href.replace(/\/+$/, "");
    }
  } catch {
    // An incomplete URL is normal while editing.
  }
  return undefined;
}

export function resolveProviderConnection(
  draft: ProviderConnectionDraft,
  configuration: Pick<ProviderConfiguration, "baseUrl" | "hasApiKey"> | undefined,
): ResolvedProviderConnection {
  const baseUrl = apiRoot(draft.baseUrl);
  const keyStored = Boolean(configuration?.hasApiKey) && baseUrl === configuration?.baseUrl;
  const authentication: ProviderConnection["authentication"] =
    draft.apiKey || (keyStored && !draft.omitStoredKey) ? "apiKey" : "none";
  const ready = baseUrl !== undefined && (!draft.apiKey || /^[!-~]+$/.test(draft.apiKey));
  return { baseUrl, authentication, keyStored, ready };
}

export function useProviderModelDiscovery(
  connection: ProviderConnectionDraft,
  configuration: Pick<ProviderConfiguration, "id" | "baseUrl" | "hasApiKey"> | undefined,
  options: {
    delayMs?: number;
    fetchModels?: ProviderModelFetcher;
  } = {},
) {
  const { delayMs = defaultDiscoveryDelayMs, fetchModels = agentDaemon.providerModels } = options;
  const [discovery, setDiscovery] = useState<ModelDiscoveryOutcome>();
  const resolved = resolveProviderConnection(connection, configuration);
  const { baseUrl, authentication, ready } = resolved;
  const { apiKey } = connection;
  const id = configuration?.id;

  useEffect(() => {
    if (!ready || !baseUrl) return;
    const controller = new AbortController();
    const lookup = window.setTimeout(async () => {
      try {
        const listing = await fetchModels(
          { baseUrl, authentication, ...(apiKey ? { apiKey } : {}), ...(id ? { id } : {}) },
          controller.signal,
        );
        if (!controller.signal.aborted) setDiscovery({ connection, models: listing.models });
      } catch (error) {
        if (!controller.signal.aborted) {
          setDiscovery({
            connection,
            error: error instanceof DaemonError ? error.message : "Could not load the provider's models.",
          });
        }
      }
    }, delayMs);
    return () => {
      window.clearTimeout(lookup);
      controller.abort();
    };
  }, [ready, baseUrl, authentication, apiKey, id, connection, delayMs, fetchModels]);

  const result = discovery?.connection === connection ? discovery : undefined;
  const models = result && "models" in result ? result.models : [];
  const error = result && "error" in result ? result.error : undefined;
  const loading = ready && !result;

  return {
    ...resolved,
    result,
    models,
    error,
    loading,
  };
}
