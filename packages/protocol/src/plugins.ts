import { z } from "zod";

export const PluginProviderId = z.enum([
  "google", "microsoft", "notion", "github", "linear", "asana", "dropbox", "hubspot", "intercom", "miro",
]);
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

export interface PluginAccountDto {
  id: string;
  providerId: PluginProviderId;
  label: string;
  identity: string;
  enabledServices: string[];
  grantedScopes: string[];
  status: "connected" | "reauthorize";
  error?: string;
  nativeConnectionId?: string;
  identityVerified?: boolean;
  components?: { serviceId: string; mcpId?: string; status: McpConnectionDto["status"]; toolCount: number; error?: string }[];
}

export const McpTransport = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().trim().min(1).max(4096),
    args: z.array(z.string()).max(128).default([]),
    env: z.record(z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal("http"),
    url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Use an HTTP or HTTPS URL"),
    headers: z.record(z.string()).optional(),
  }).strict(),
]);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpDefinition = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  transport: McpTransport,
}).strict();

export const NpmMcpPackage = z.object({
  name: z.string().trim().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "Use an exact public npm package name, without a version or command"),
  bin: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  args: z.array(z.string()).max(126).default([]),
  env: z.record(z.string()).optional(),
}).strict();
export type NpmMcpPackage = z.input<typeof NpmMcpPackage>;

export const SaveMcpBody = z.union([
  McpDefinition,
  McpDefinition.omit({ transport: true }).extend({ package: NpmMcpPackage }).strict(),
]);
export type SaveMcpBody = z.input<typeof SaveMcpBody>;

/** Credential values are never projected back to the client. */
export interface McpConnectionDto {
  id: string;
  name: string;
  enabled: boolean;
  transport: { type: "stdio"; command: string; args: string[]; envKeys: string[] }
    | { type: "http"; url: string; headerKeys: string[] };
  status: "unchecked" | "connected" | "error" | "not-connected" | "needs-auth" | "disabled" | "conflict";
  toolCount: number;
  error?: string;
  source?: string;
  pendingReload?: boolean;
  readOnly?: boolean;
  package?: {
    name: string;
    bin: string;
    args: string[];
    version: string;
    availableVersion?: string;
    modified: boolean;
    updateStatus: "current" | "modified" | "failed" | "available";
    lastCheckedAt: string;
    error?: string;
  };
}

export interface CatalogSkillDto {
  id: string;
  name: string;
  sourceType: "github" | "well-known" | "local";
  installUrl: string;
  skillPath?: string;
  description: string;
  source: string;
  installs?: number;
}
export interface CatalogSkillDetailDto extends CatalogSkillDto {
  content: string;
  url: string;
}
export const SKILL_CATALOG_PAGE_SIZE = 12;
export const SKILL_SEARCH_LIMIT = 200;

export interface SkillCatalogDto {
  skills: CatalogSkillDto[];
  total: number;
  pageSize: number;
  searchLimit?: number;
  nextCursor?: string;
}
export interface InstalledSkillDto extends CatalogSkillDto {
  enabled: boolean;
  revision: string;
  installedAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  error?: string;
  path?: string;
  origin?: "installed" | "local" | "default" | "service";
  modified?: boolean;
  availableRevision?: string;
  updateStatus?: "current" | "modified" | "failed" | "available";
  serviceId?: string;
  readOnly?: boolean;
}
export interface NativeSkillDto {
  name: string;
  description: string;
  path: string;
  agentId: string;
  readOnly: true;
}
export interface PluginStateDto {
  revision: number;
  cloudUrl: string;
  cloudError?: string;
  providers: PluginProviderDto[];
  accounts: PluginAccountDto[];
  mcp: McpConnectionDto[];
  skills: InstalledSkillDto[];
  nativeSkills: NativeSkillDto[];
  nativeError?: string;
}
export interface SkillCommandDto {
  name: string;
  description: string;
  command: string;
  source: "managed" | "native";
}

export const ConfigurePluginsBody = z.object({
  cloudUrl: z.string().url().nullable().refine(
    (value) => value === null || new URL(value).protocol === "https:",
    "The publisher backend must use HTTPS",
  ),
}).strict();
export const PluginEnabledBody = z.object({ enabled: z.boolean() }).strict();
export const SkillSourceBody = z.object({
  source: z.string().trim().min(1).max(4096),
  skillPath: z.string().min(1).max(1024).optional(),
  ref: z.string().min(1).max(200).optional(),
}).strict();
export const InstallSkillBody = z.union([z.object({ id: z.string().min(1).max(512) }).strict(), SkillSourceBody]);
export type InstallSkillBody = z.infer<typeof InstallSkillBody>;
export const PluginAccountBody = z.object({ label: z.string().trim().min(1).max(120) }).strict();
export const PluginServiceBody = z.object({ serviceId: z.string().min(1), enabled: z.boolean() }).strict();
export const AuthorizePluginBody = z.object({
  providerId: PluginProviderId,
  accountId: z.string().optional(),
  serviceId: z.string().min(1).optional(),
  /** Browser origin; the route validates it against the request origin. */
  returnUrl: z.string().url(),
}).strict();
export type AuthorizePluginBody = z.infer<typeof AuthorizePluginBody>;
