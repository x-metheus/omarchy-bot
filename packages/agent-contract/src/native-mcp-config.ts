import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const NATIVE_MCP_RUNTIME_STATUSES = ["connected", "cached", "failed", "needs-auth", "not-connected", "disabled"] as const;
export type NativeMcpRuntimeStatus = (typeof NATIVE_MCP_RUNTIME_STATUSES)[number];

export function isNativeMcpRuntimeStatus(value: unknown): value is NativeMcpRuntimeStatus {
  return typeof value === "string" && (NATIVE_MCP_RUNTIME_STATUSES as readonly string[]).includes(value);
}

export function nativeMcpPrivateDir(env: NodeJS.ProcessEnv = process.env, homedir: () => string = os.homedir): string {
  return path.join(env.OMARCHY_BOT_HOME ?? path.join(homedir(), ".local/share/omarchy-bot"), "plugins");
}

export function nativeMcpConfigFile(privateDir: string): string {
  return path.join(privateDir, "native-mcp.json");
}

const NativeMcpSecret = z.object({
  server: z.string(),
  endpoint: z.string(),
  kind: z.enum(["env", "header"]),
  field: z.string(),
  value: z.string(),
});
const NativeMcpEntry = z.object({
  id: z.string(),
  pi: z.string().nullable(),
  codex: z.string().nullable(),
  sources: z.object({ shared: z.string().nullable(), pi: z.string().nullable(), codex: z.string().nullable() }).optional(),
  owner: z.object({ accountId: z.string(), serviceId: z.string() }).optional(),
});

export const NativeMcpMetadata = z.object({
  version: z.literal(1),
  entries: z.record(NativeMcpEntry),
  adapterPackage: z.string().optional(),
  packageRevisions: z.record(z.string()).default({}),
  serviceTokens: z.record(z.object({ url: z.string(), token: z.string() })).default({}),
  secrets: z.record(NativeMcpSecret).default({}),
});
export type NativeMcpMetadata = z.infer<typeof NativeMcpMetadata>;

export function emptyNativeMcpMetadata(): NativeMcpMetadata {
  return { version: 1, entries: {}, secrets: {}, serviceTokens: {}, packageRevisions: {} };
}

export function parseNativeMcpMetadata(value: unknown): NativeMcpMetadata {
  return NativeMcpMetadata.parse(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Pi loads whatever records it can. A bad secret or entry is skipped; service tokens need no entries map. */
export function readNativeMcpMetadata(value: unknown): NativeMcpMetadata {
  if (!record(value) || !record(value.secrets)) throw new Error("Private MCP credential metadata is malformed");
  const parsed = emptyNativeMcpMetadata();
  if (value.version === 1) parsed.version = 1;
  if (record(value.entries)) {
    for (const [name, raw] of Object.entries(value.entries)) {
      const entry = NativeMcpEntry.safeParse(raw);
      if (entry.success) parsed.entries[name] = entry.data;
    }
  }
  for (const [key, raw] of Object.entries(value.secrets)) {
    const secret = NativeMcpSecret.safeParse(raw);
    if (secret.success) parsed.secrets[key] = secret.data;
  }
  const tokens = NativeMcpMetadata.shape.serviceTokens.safeParse(value.serviceTokens ?? {});
  if (tokens.success) parsed.serviceTokens = tokens.data;
  return parsed;
}

/** Non-empty `url` when set; otherwise the stdio command and args. An empty url is absent. */
export function nativeMcpEndpoint(server: { url?: string; command?: unknown; args?: unknown }): string {
  return server.url ? server.url : JSON.stringify({ command: server.command, args: server.args ?? [] });
}

export function nativeMcpSecretKey(server: string, endpoint: string, kind: "env" | "header", field: string): string {
  return `OMARCHY_BOT_MCP_${createHash("sha256").update(server).update("\0").update(endpoint).update("\0").update(kind).update("\0").update(field).digest("hex").slice(0, 24).toUpperCase()}`;
}

export function nativeMcpSecretPlaceholder(kind: "env" | "header", field: string, key: string): string {
  return `\${${kind === "env" ? field : key}}`;
}

type ResolvableServer = {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
};

function storedSecret(value: string): string {
  return value.startsWith("!") ? `!${value}` : value;
}

/** Substitute private `${FIELD}` secrets, then owned service tokens, into one loaded server map. */
export function resolveNativeMcpCredentials(
  config: { mcpServers: Readonly<Record<string, ResolvableServer>> },
  metadata: NativeMcpMetadata,
): void {
  for (const [key, raw] of Object.entries(metadata.secrets)) {
    const server = config.mcpServers[raw.server];
    if (!server || nativeMcpEndpoint(server) !== raw.endpoint) continue;
    const value = storedSecret(raw.value);
    if (raw.kind === "env" && server.env?.[raw.field] === nativeMcpSecretPlaceholder("env", raw.field, key)) server.env[raw.field] = value;
    if (raw.kind === "header" && server.headers?.[raw.field] === nativeMcpSecretPlaceholder("header", raw.field, key)) server.headers[raw.field] = value;
  }
  for (const [name, value] of Object.entries(metadata.serviceTokens)) {
    const server = config.mcpServers[name];
    const owner = metadata.entries[name]?.owner;
    if (!server || server.disabled || !owner || value.url !== server.url) continue;
    if (Object.keys(server.headers ?? {}).length) continue;
    server.headers = { Authorization: `Bearer ${value.token}` };
  }
}
