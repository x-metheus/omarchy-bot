import { z } from "zod";
import { PluginProviderId, SKILL_CATALOG_PAGE_SIZE, SKILL_SEARCH_LIMIT } from "./plugins.ts";

/** One HTTPS origin: no credentials, path, query, or fragment. Publisher and daemon share this check. */
export const HttpsOrigin = z.string().url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Publisher URL must be an HTTPS origin" });
    return z.NEVER;
  }
  return url.origin;
});
export type HttpsOrigin = z.infer<typeof HttpsOrigin>;

/** Fields a daemon may persist from a publisher token response. Unknown fields are ignored, never stored. */
export const TOKEN_METADATA_KEYS = [
  "refresh_token", "expires_in", "refresh_token_expires_in", "scope",
  "user_id", "workspace_id", "email_domain", "team_id", "data", "identity",
] as const;

/** The publisher only adds fields (ADR 0012), so unknown identity fields are ignored; `subject` stays required. */
const GoogleIdentity = z.object({ subject: z.string().min(1) }).strip();

export const PublisherTokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number().positive().optional(),
  refresh_token_expires_in: z.coerce.number().optional(),
  scope: z.string().optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  workspace_id: z.union([z.string(), z.number()]).optional(),
  email_domain: z.string().optional(),
  team_id: z.union([z.string(), z.number()]).optional(),
  data: z.unknown().optional(),
  identity: GoogleIdentity.optional(),
}).strip();
export type PublisherTokenResponse = z.infer<typeof PublisherTokenResponse>;

export const OAuthStartBody = z.object({
  providerId: PluginProviderId,
  callbackUrl: z.string().url(),
  localState: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const OAuthTokenBody = z.discriminatedUnion("grantType", [
  z.object({
    grantType: z.literal("authorization_code"),
    code: z.string().min(1).max(8192),
    state: z.string().min(1).max(16384),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  }).strict(),
  z.object({
    grantType: z.literal("refresh_token"),
    providerId: PluginProviderId,
    refreshToken: z.string().min(1).max(32768),
  }).strict(),
]);

export const OAuthStartResponse = z.object({ url: z.string().url() }).strip();
export const PublisherProvidersResponse = z.array(z.object({
  id: PluginProviderId,
  setupReason: z.string().optional(),
}).strip());

const sourceType = z.enum(["github", "well-known"]);

/** Raw skills.sh document. Additive: extra fields parse and are not part of the normalised contract. */
export const SkillsShCatalogEntry = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  installs: z.number().optional(),
}).passthrough().transform((entry) => ({
  id: entry.id,
  name: entry.name,
  source: entry.source,
  sourceType: entry.source.includes("/") ? "github" as const : "well-known" as const,
  installUrl: entry.source.includes("/") ? `https://github.com/${entry.source}` : `https://${entry.source}`,
  ...(entry.installs === undefined ? {} : { installs: entry.installs }),
}));

export const SkillsShCatalogResponse = z.object({
  data: z.array(SkillsShCatalogEntry),
  pagination: z.object({
    page: z.number().int().nonnegative(),
    perPage: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }).passthrough().optional(),
}).passthrough();
export type SkillsShCatalogResponse = z.infer<typeof SkillsShCatalogResponse>;

export const NormalisedCatalogSkill = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
  sourceType,
  installUrl: z.string().url(),
  installs: z.number().optional(),
}).strip();

export const NormalisedCatalogResponse = z.object({
  skills: z.array(NormalisedCatalogSkill),
  pagination: z.object({
    page: z.number().int().nonnegative(),
    perPage: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }).strip().optional(),
}).strip();
export type NormalisedCatalogResponse = z.infer<typeof NormalisedCatalogResponse>;

export function normaliseCatalog(raw: SkillsShCatalogResponse): NormalisedCatalogResponse {
  return {
    skills: raw.data,
    ...(raw.pagination ? { pagination: {
      page: raw.pagination.page, perPage: raw.pagination.perPage, total: raw.pagination.total, hasMore: raw.pagination.hasMore,
    } } : {}),
  };
}

export const SkillsShDetailResponse = z.object({
  id: z.string(),
  source: z.string(),
  slug: z.string(),
  installs: z.number().optional(),
  files: z.array(z.object({ path: z.string(), contents: z.string() }).passthrough()).nullable(),
}).passthrough();

export const NormalisedSkillDetail = z.object({
  id: z.string(),
  source: z.string(),
  slug: z.string(),
  installs: z.number().optional(),
  content: z.string(),
}).strip();

export { SKILL_CATALOG_PAGE_SIZE, SKILL_SEARCH_LIMIT };
