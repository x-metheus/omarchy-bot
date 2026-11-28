import { z } from "zod";
import { PLUGIN_PROVIDERS, type PluginProviderKey } from "./pluginProviders.ts";

export const PluginProviderId = z.enum(Object.keys(PLUGIN_PROVIDERS) as [PluginProviderKey, ...PluginProviderKey[]]);
export type PluginProviderId = z.infer<typeof PluginProviderId>;

export interface PluginServiceDto {
  id: string;
  name: string;
  description: string;
  skillSources?: string[];
}

export interface PluginProviderDto {
  id: PluginProviderId;
  name: string;
  services: PluginServiceDto[];
  mode: "mcp";
  /** A publisher configuration or provider access prerequisite, not a connected state. */
  setupReason?: string;
  nativeAuthorization?: boolean;
  registrationNote?: string;
  documentationUrl: string;
}

export const SKILL_CATALOG_PAGE_SIZE = 12;
export const SKILL_SEARCH_LIMIT = 200;
