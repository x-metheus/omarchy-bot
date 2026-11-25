import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { McpDefinition, type McpConnectionDto } from "@omarchy-bot/protocol";
import type { NativeMcpStatus } from "@omarchy-bot/agent-contract";
import { emptyNativeMcpMetadata, type NativeMcpMetadata, nativeMcpConfigFile, nativeMcpEndpoint, nativeMcpSecretKey, nativeMcpSecretPlaceholder, parseNativeMcpMetadata, resolveNativeMcpCredentials } from "@omarchy-bot/agent-contract/native-mcp-config";
import { HttpError } from "../bots/bots.ts";
import { projectNativeMcpOAuth, type NativeMcpOAuthSettings } from "./nativeMcpOAuth.ts";

type Definition = Record<string, unknown>;
type Document = { file: string; text: string; values: Record<string, Definition>; root: Record<string, unknown> };
type Common = { command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; disabled: boolean };
type RuntimeConnection = Common & { oauth?: NativeMcpOAuthSettings };

export type EffectiveMcpServer = { configurationError: string; transport?: never; disabled?: never } | {
  disabled: boolean;
  packageRevision?: string;
  transport:
    | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string>; oauth?: NativeMcpOAuthSettings }
    | { type: "sse" | "socket" };
};

export type EffectiveMcpServers = { revision: string; servers: Record<string, EffectiveMcpServer>; secrets: string[]; configurationError?: string };

const MAX_RUNTIME_CONFIG_BYTES = 1024 * 1024;

function readRuntimeConfig(file: string, workspace?: string): { contents?: Buffer } | { error: string } {
  try {
    const original = lstatSync(file);
    if (!original.isFile()) return { error: "expected an unlinked regular file" };
    if (workspace !== undefined) {
      const relative = path.relative(workspace, realpathSync(file));
      if (relative.startsWith("..") || path.isAbsolute(relative)) return { error: "configuration file is outside the workspace" };
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.dev !== original.dev || stat.ino !== original.ino) return { error: "configuration changed during the read" };
      if (stat.size > MAX_RUNTIME_CONFIG_BYTES) return { error: "configuration file exceeds 1 MiB" };
      // A file that grows after validation must still have a bounded read.
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (!read) return { contents: buffer.subarray(0, offset) };
        offset += read;
      }
      return { error: "configuration grew during the read" };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { error: "configuration file could not be read" };
  }
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): Record<string, string> {
  if (!object(value) || Object.values(value).some((item) => typeof item !== "string")) return {};
  return value as Record<string, string>;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(value: Common): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function reference(value: string): string | undefined { return value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] ?? value.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1]; }

function sourceFingerprint(value: Definition): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function configurationRevision(files: readonly string[], read: (file: string) => Buffer | null | undefined): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const name = Buffer.from(file);
    hash.update(`${name.length}:`).update(name);
    const contents = read(file);
    if (contents === undefined) hash.update("absent;");
    else if (contents === null) hash.update("unreadable;");
    else hash.update(`present:${contents.length}:`).update(contents);
  }
  return hash.digest("hex");
}

const credentialQueryName = /token|secret|password|api.?key|^(?:sig|signature)$/i;

function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = ""; url.password = "";
    for (const key of [...url.searchParams.keys()]) if (credentialQueryName.test(key)) url.searchParams.set(key, "<REDACTED>");
    return url.href;
  } catch { return "<invalid endpoint>"; }
}

const commonFields = new Set(["command", "args", "env", "env_vars", "url", "headers", "http_headers", "env_http_headers", "bearer_token_env_var", "bearerTokenEnv", "disabled", "enabled", "type"]);
const localTimingFields = new Set(["timeout", "connectionTimeout", "requestTimeout", "startup_timeout_sec", "startup_timeout_ms", "tool_timeout_sec"]);

function hasOAuthMarker(definition: Definition | undefined): boolean {
  return definition?.auth === "oauth" && typeof definition.url === "string";
}

function projectionLimits(definition: Definition | undefined): { unsupported: string[]; local: string[] } {
  const unsupported: string[] = [], local: string[] = [];
  for (const key of Object.keys(definition ?? {})) {
    if (localTimingFields.has(key)) local.push(key);
    else if (!commonFields.has(key) && !(key === "oauth" && typeof definition?.url === "string") &&
      !(key === "auth" && hasOAuthMarker(definition))) unsupported.push(key);
  }
  if (definition?.type === "sse") unsupported.push("type=sse");
  return { unsupported, local };
}
function common(definition: Definition | undefined): Common | undefined {
  if (!definition) return undefined;
  for (const field of ["disabled", "enabled"]) if (definition[field] !== undefined && typeof definition[field] !== "boolean") throw new Error(`${field} must be a boolean`);
  for (const field of ["command", "url", "socket", "bearerTokenEnv", "bearer_token_env_var"]) if (definition[field] !== undefined && (typeof definition[field] !== "string" || !definition[field].trim())) throw new Error(`${field} must be a nonempty string`);
  for (const field of ["args", "env_vars"]) if (definition[field] !== undefined && (!Array.isArray(definition[field]) || definition[field].some((item: unknown) => typeof item !== "string"))) throw new Error(`${field} must contain only strings`);
  for (const field of ["env", "headers", "http_headers", "env_http_headers"]) if (definition[field] !== undefined && (!object(definition[field]) || Object.values(definition[field]).some((item) => typeof item !== "string"))) throw new Error(`${field} must map names to strings`);
  if (definition.type !== undefined && !["stdio", "http", "sse"].includes(String(definition.type))) throw new Error("Unsupported native transport type");
  if (definition.command !== undefined && definition.url !== undefined) throw new Error("Select one native transport, not both command and url");
  const disabled = definition.disabled === true;
  if (typeof definition.command === "string") {
    const env = { ...strings(definition.env) };
    return { command: definition.command, args: definition.args as string[] | undefined ?? [], ...(Object.keys(env).length ? { env } : {}), disabled };
  }
  if (typeof definition.url !== "string") return undefined;
  let endpoint: URL;
  try { endpoint = new URL(definition.url); } catch { throw new Error("Invalid native endpoint URL"); }
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Native endpoint must use HTTP or HTTPS");
  if (endpoint.username || endpoint.password || [...endpoint.searchParams.keys()].some((key) => credentialQueryName.test(key))) throw new Error("Move URL credentials into private environment or header configuration; the source was not propagated");
  const headers = { ...strings(definition.headers) };
  if (typeof definition.bearerTokenEnv === "string") headers.Authorization = `Bearer \${${definition.bearerTokenEnv}}`;
  return { url: definition.url, ...(Object.keys(headers).length ? { headers } : {}), disabled };
}

export class NativeMcpStore {
  readonly #file: string;
  readonly #shared: string;
  readonly #revisionFiles: readonly string[];
  #metadata: NativeMcpMetadata;
  #pending = new Set<string>();
  #conflicts = new Map<string, string>();
  #limitations = new Map<string, string>();
  #live = new Map<string, NativeMcpStatus>();
  errors: string[] = [];

  constructor(readonly workspace: string, readonly privateDir: string) {
    this.#file = nativeMcpConfigFile(privateDir);
    this.#shared = path.join(workspace, ".mcp.json");
    this.#revisionFiles = [path.resolve(this.#shared), path.resolve(this.#file)];
    this.#metadata = existsSync(this.#file) ? parseNativeMcpMetadata(JSON.parse(readFileSync(this.#file, "utf8"))) : emptyNativeMcpMetadata();
  }

  #persist(): void {
    mkdirSync(this.privateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#metadata, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  #readWorkspaceText(file: string): string {
    const result = readRuntimeConfig(file, this.workspace);
    if ("error" in result) throw new Error(`${path.relative(this.workspace, file)}: ${result.error}`);
    return result.contents?.toString("utf8") ?? "";
  }

  #document(file: string): Document {
    return this.#parseDocument(file, this.#readWorkspaceText(file));
  }

  #configurationRevision(): string {
    return configurationRevision(this.#revisionFiles, (file) => {
      const result = readRuntimeConfig(file, file === path.resolve(this.#file) ? undefined : this.workspace);
      return "error" in result ? null : result.contents;
    });
  }

  #parseDocument(file: string, text: string, label = file, skipInvalidServers = false): Document {
    let parsed: unknown;
    try { parsed = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new Error(`${label}: invalid JSON; repair the original file, which was not overwritten`); }
    if (!object(parsed)) throw new Error(`${label}: expected a native configuration object`);
    const map = parsed.mcpServers;
    const values = map === undefined || (!skipInvalidServers && map === null) ? {} : map;
    if (!object(values) || (!skipInvalidServers && Object.values(values).some((entry) => !object(entry)))) throw new Error(`${label}: malformed MCP server map`);
    const servers = skipInvalidServers ? Object.fromEntries(Object.entries(values).filter(([, entry]) => object(entry))) : values;
    return { file, text, root: parsed, values: servers as Record<string, Definition> };
  }

  #write(document: Document, updates: Map<string, Definition | undefined>): void {
    if (!updates.size) return;
    if (this.#readWorkspaceText(document.file) !== document.text) throw new HttpError(409, "Native MCP configuration changed during the operation; retry after inspecting it");
    const values = { ...document.values };
    for (const [name, value] of updates) { if (value) values[name] = value; else delete values[name]; }
    const text = `${JSON.stringify({ ...document.root, mcpServers: values }, null, 2)}\n`;
    mkdirSync(path.dirname(document.file), { recursive: true, mode: 0o700 });
    const parentRelative = path.relative(this.workspace, realpathSync(path.dirname(document.file)));
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new HttpError(409, "Native configuration parent is outside the workspace");
    const temporary = `${document.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx", mode: existsSync(document.file) ? lstatSync(document.file).mode & 0o777 : 0o600 });
    renameSync(temporary, document.file);
  }

  #merge(previous: Definition | undefined, value: Common): Definition {
    const next = { ...previous };
    const transportChanged = (typeof previous?.url === "string") !== (value.url !== undefined);
    const urlChanged = value.url !== undefined && previous?.url !== undefined && previous.url !== value.url;
    if (transportChanged || urlChanged) for (const key of ["command", "args", "env", "env_vars", "url", "headers", "http_headers", "env_http_headers", "bearer_token_env_var", "bearerTokenEnv", "bearerToken", "oauth", "auth", "requestHeadersCommand", "caFile", "httpTransport", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "tls", "socket", "type"]) delete next[key];
    next.disabled = value.disabled;
    if (value.command !== undefined) { next.command = value.command; next.args = value.args ?? []; if (value.env) next.env = value.env; else delete next.env; }
    else { next.url = value.url; if (value.headers) next.headers = value.headers; else delete next.headers; }
    return next;
  }

  reconcile(): void {
    this.errors = [];
    this.#conflicts.clear();
    this.#limitations.clear();
    let shared: Document;
    try { shared = this.#document(this.#shared); }
    catch (error) { this.errors.push(error instanceof Error ? error.message : String(error)); return; }
    const updates = new Map<string, Definition | undefined>();
    const changedNames = new Set<string>();
    const removedNames = new Set<string>();
    const previousMetadata = this.#metadata;
    this.#metadata = { ...previousMetadata, entries: { ...previousMetadata.entries } };
    const names = new Set([...Object.keys(shared.values), ...Object.keys(this.#metadata.entries)]);
    for (const name of names) {
      try {
        const previous = this.#metadata.entries[name];
        const definition = shared.values[name];
        if (definition === undefined) {
          delete this.#metadata.entries[name];
          removedNames.add(name);
        } else {
          const value = common(definition);
          if (!value) throw new Error("Native transport is not representable here; use the named native source");
          const { unsupported, local } = projectionLimits(definition);
          if (!previous?.owner && unsupported.length) throw new Error(`Client-specific options cannot be projected safely: ${unsupported.join(", ")}. Source files were retained.`);
          if (local.length) this.#limitations.set(name, `Client-specific timing settings are retained only in their native source: ${local.join(", ")}`);
          const next = this.#merge(definition, value);
          const source = sourceFingerprint(next);
          const configChanged = !isDeepStrictEqual(definition, next);
          if (!configChanged && previous?.sources?.shared === source) continue;
          if (configChanged) updates.set(name, next);
          this.#metadata.entries[name] = {
            id: previous?.id ?? `mcp_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
            // Keep the legacy metadata fields expected by the remaining worker contract.
            pi: fingerprint(value), codex: null,
            sources: { shared: source, pi: null, codex: null },
            ...(previous?.owner ? { owner: previous.owner } : {}),
          };
        }
        changedNames.add(name);
      } catch (error) { this.#conflicts.set(name, error instanceof Error ? error.message : "Native synchronization failed"); }
    }
    if (this.#conflicts.size) {
      this.#metadata = previousMetadata;
      for (const [name, error] of this.#conflicts) this.errors.push(`${name}: ${error}`);
      return;
    }
    try {
      this.#write(shared, updates);
      if (removedNames.size) {
        this.#metadata.secrets = { ...this.#metadata.secrets };
        this.#metadata.serviceTokens = { ...this.#metadata.serviceTokens };
        this.#metadata.packageRevisions = { ...this.#metadata.packageRevisions };
        for (const name of removedNames) {
          delete this.#metadata.serviceTokens[name];
          const id = previousMetadata.entries[name]?.id;
          if (id) delete this.#metadata.packageRevisions[id];
          for (const [key, secret] of Object.entries(this.#metadata.secrets)) if (secret.server === name) delete this.#metadata.secrets[key];
          this.#live.delete(name);
        }
      }
      if (changedNames.size) this.#persist();
      for (const name of changedNames) this.#pending.add(name);
    } catch (error) {
      this.#metadata = previousMetadata;
      this.errors.push(error instanceof Error ? error.message : "Native synchronization failed; source files were retained");
    }
  }

  /** Credential-bearing connection definitions for the in-process runtime. */
  effectiveServers(): EffectiveMcpServers {
    const errors: string[] = [];
    const snapshot = new Map<string, Buffer | null | undefined>();
    const read = (file: string, label: string, workspace?: string) => {
      const result = readRuntimeConfig(file, workspace);
      const contents = "error" in result ? null : result.contents;
      snapshot.set(path.resolve(file), contents);
      if ("error" in result) errors.push(`${label}: ${result.error}`);
      return contents;
    };
    const readDocument = (file: string): Record<string, Definition> => {
      const label = path.relative(this.workspace, file);
      const contents = read(file, label, this.workspace);
      if (contents === undefined || contents === null) return {};
      try { return this.#parseDocument(file, contents.toString("utf8"), label, true).values; }
      catch (error) {
        errors.push((error as Error).message);
        return {};
      }
    };
    const shared = readDocument(this.#shared);
    const privateContents = read(this.#file, "native-mcp.json");
    let metadata = emptyNativeMcpMetadata();
    if (privateContents === undefined) {
      this.#metadata = metadata;
    } else if (privateContents !== null) {
      try {
        metadata = parseNativeMcpMetadata(JSON.parse(privateContents.toString("utf8")));
        this.#metadata = metadata;
      } catch { errors.push("native-mcp.json: invalid JSON or private metadata"); }
    }
    const connections: Record<string, RuntimeConnection> = Object.create(null);
    const servers: Record<string, EffectiveMcpServer> = Object.create(null);
    for (const name of Object.keys(shared)) {
      const definition = shared[name];
      const unsupported = definition?.type === "sse" || definition?.httpTransport === "sse" ? "sse"
        : definition?.type === "socket" || typeof definition?.socket === "string" ? "socket" : undefined;
      if (unsupported) {
        servers[name] = { transport: { type: unsupported }, disabled: definition?.disabled === true };
        continue;
      }
      try {
        const value = common(shared[name]);
        if (!value) continue;
        if ((definition?.auth !== undefined && !hasOAuthMarker(definition)) ||
          (value.url !== undefined && definition?.bearerToken !== undefined)) {
          servers[name] = { configurationError: "Unsupported MCP authentication settings. Check the configuration for this connection." };
          continue;
        }
        if (value.url !== undefined) {
          const oauth = projectNativeMcpOAuth(definition?.oauth);
          if (oauth === null) {
            servers[name] = { configurationError: "Invalid MCP OAuth configuration. Check the OAuth settings for this connection." };
            continue;
          }
          connections[name] = { ...value, ...(oauth ? { oauth } : {}) };
        } else connections[name] = value;
      } catch { /* Invalid definitions do not prevent other servers from loading. */ }
    }
    const secrets = resolveNativeMcpCredentials({ mcpServers: connections }, metadata, { literalSecrets: true });
    for (const [name, { command, args, env, url, headers, disabled, oauth }] of Object.entries(connections)) {
      if (command !== undefined) {
        const id = metadata.entries[name]?.id;
        const packageRevision = id === undefined ? undefined : metadata.packageRevisions[id];
        servers[name] = { transport: { type: "stdio", command, args: args ?? [], ...(env ? { env } : {}) }, disabled,
          ...(packageRevision !== undefined ? { packageRevision } : {}) };
      } else if (url !== undefined) servers[name] = { transport: { type: "http", url, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}) }, disabled };
      if (oauth?.clientSecret) secrets.add(oauth.clientSecret);
      for (const [key, value] of Object.entries(env ?? headers ?? {})) {
        if (/secret|token|key|password|credential|auth|cookie/i.test(key)) secrets.add(value);
        if (!headers) continue;
        const header = key.toLowerCase();
        if (header === "authorization") {
          const token = value.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
          if (token) secrets.add(token);
        } else if (header === "cookie") {
          for (const cookie of value.split(";")) {
            const separator = cookie.indexOf("=");
            if (separator === -1) continue;
            const cookieValue = cookie.slice(separator + 1).trim();
            if (cookieValue) secrets.add(cookieValue);
            if (cookieValue.length > 2 && cookieValue.startsWith('"') && cookieValue.endsWith('"')) {
              secrets.add(cookieValue.slice(1, -1));
            }
          }
        }
      }
    }
    return {
      revision: configurationRevision(this.#revisionFiles, (file) => snapshot.get(file)),
      servers,
      secrets: [...secrets].filter(Boolean),
      ...(errors.length ? { configurationError: `MCP configuration could not be loaded. ${errors.join(". ")}` } : {}),
    };
  }

  list(includeService = false): McpConnectionDto[] {
    this.reconcile();
    let shared: Document;
    try { shared = this.#document(this.#shared); } catch { return []; }
    const revision = this.#configurationRevision();
    return Object.keys(shared.values).sort().flatMap((name) => {
      const metadata = this.#metadata.entries[name];
      if (!includeService && metadata?.owner) return [];
      const definition = shared.values[name];
      let value: Common | undefined;
      let readOnly = false;
      try { value = common(definition); }
      catch {
        if (typeof definition?.url === "string") { value = { url: safeEndpoint(definition.url), disabled: definition.disabled === true || definition.enabled === false }; readOnly = true; }
      }
      if (!value) return [];
      const conflict = this.#conflicts.get(name);
      const observed = this.#live.get(name);
      const live = observed?.configurationRevision === revision ? observed : undefined;
      const pending = this.#pending.has(name) || (observed !== undefined && live === undefined);
      const status = conflict ? "conflict" : value.disabled ? "disabled" : pending ? "unchecked" : live?.status === "connected" ? "connected" : live?.status === "needs-auth" ? "needs-auth" : live?.status === "failed" ? "error" : "not-connected";
      const error = conflict ?? this.#limitations.get(name);
      return [{ id: metadata?.id ?? `mcp_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`, name, enabled: !value.disabled,
        transport: value.command !== undefined ? { type: "stdio" as const, command: value.command, args: value.args ?? [], envKeys: Object.keys(value.env ?? {}) } : { type: "http" as const, url: value.url!, headerKeys: Object.keys(value.headers ?? {}) },
        status, toolCount: status === "connected" ? live?.toolCount ?? 0 : 0,
        source: ".mcp.json",
        pendingReload: pending, ...(readOnly ? { readOnly: true } : {}), ...(error ? { error } : {}) } satisfies McpConnectionDto];
    });
  }

  setPackageRevision(id: string, revision: string | undefined): void {
    if (this.#metadata.packageRevisions[id] === revision) return;
    const name = this.name(id);
    if (revision === undefined) delete this.#metadata.packageRevisions[id];
    else this.#metadata.packageRevisions[id] = revision;
    this.#persist();
    this.#pending.add(name);
  }

  name(id: string): string { const entry = this.list(true).find((item) => item.id === id); if (!entry) throw new HttpError(404, "Native MCP connection not found"); return entry.name; }
  updateStatus(statuses: NativeMcpStatus[]): void {
    this.reconcile();
    const revision = this.#configurationRevision();
    this.#live.clear();
    if (!statuses.length) this.#pending.clear();
    for (const status of statuses) {
      if (status.configurationRevision !== revision) {
        if (!this.#live.has(status.name)) this.#live.set(status.name, status);
        continue;
      }
      const previous = this.#live.get(status.name);
      if (previous?.configurationRevision !== revision || previous.status !== "connected") this.#live.set(status.name, status);
      this.#pending.delete(status.name);
    }
  }

  save(id: string | null, input: z.input<typeof McpDefinition>): McpConnectionDto {
    const body = McpDefinition.parse(input);
    this.reconcile();
    if (this.errors.length) throw new HttpError(409, this.errors.join("\n"));
    const previousName = id ? this.name(id) : undefined;
    if (previousName && this.#metadata.entries[previousName]?.owner) throw new HttpError(409, "Manage this MCP through its owning Service");
    const document = this.#document(this.#shared);
    if (previousName !== body.name && document.values[body.name]) throw new HttpError(409, "A native MCP already uses that name");
    if (previousName && this.#conflicts.has(previousName)) throw new HttpError(409, this.#conflicts.get(previousName)!);
    const previous = previousName ? document.values[previousName] : undefined;
    const value: Common = body.transport.type === "stdio" ? { command: body.transport.command, args: body.transport.args ?? [], env: body.transport.env ?? (previous?.command === body.transport.command ? strings(previous?.env) : {}), disabled: !body.enabled }
      : { url: body.transport.url, headers: body.transport.headers ?? (previous?.url === body.transport.url ? strings(previous?.headers) : {}), disabled: !body.enabled };
    if (value.url) {
      const url = new URL(value.url);
      if (url.username || url.password || [...url.searchParams.keys()].some((key) => credentialQueryName.test(key))) throw new HttpError(400, "Keep MCP credentials out of URLs");
    }
    const endpoint = nativeMcpEndpoint(value);
    if (previousName && previous && body.transport.type === "stdio" && body.transport.env === undefined && previous.command === value.command) {
      const oldEndpoint = nativeMcpEndpoint({ command: previous.command, args: previous.args ?? [] });
      for (const [key, secret] of Object.entries(this.#metadata.secrets)) {
        if (secret.server !== previousName || secret.endpoint !== oldEndpoint || secret.kind !== "env" || value.env?.[secret.field] !== nativeMcpSecretPlaceholder("env", secret.field, key)) continue;
        const rebound = nativeMcpSecretKey(body.name, endpoint, "env", secret.field);
        delete this.#metadata.secrets[key];
        this.#metadata.secrets[rebound] = { ...secret, server: body.name, endpoint };
      }
    }
    for (const [kind, fields] of [["env", value.env], ["header", value.headers]] as const) {
      for (const [field, secret] of Object.entries(fields ?? {})) {
        if (reference(secret) || /^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(secret) || secret.startsWith("!")) continue;
        const key = nativeMcpSecretKey(body.name, endpoint, kind, field);
        this.#metadata.secrets[key] = { server: body.name, endpoint, kind, field, value: secret };
        fields![field] = nativeMcpSecretPlaceholder(kind, field, key);
      }
    }
    this.#persist();
    const definition = this.#merge(previous, value);
    const updates = new Map<string, Definition | undefined>([[body.name, definition]]);
    if (previousName && previousName !== body.name) updates.set(previousName, undefined);
    this.#write(document, updates);
    if (previousName && previousName !== body.name) {
      delete this.#metadata.entries[previousName];
      this.#metadata.entries[body.name] = { id: id!, pi: null, codex: null };
      for (const secret of Object.values(this.#metadata.secrets)) if (secret.server === previousName && secret.endpoint === endpoint) secret.server = body.name;
      this.#persist();
    }
    this.reconcile();
    return this.list().find((entry) => entry.name === body.name)!;
  }

  enable(id: string, enabled: boolean, service = false): void {
    const name = this.name(id);
    if (!service && this.#metadata.entries[name]?.owner) throw new HttpError(409, "Manage this MCP through its owning Service");
    const document = this.#document(this.#shared);
    if (document.values[name]) this.#write(document, new Map([[name, { ...document.values[name], disabled: !enabled }]]));
    if (!enabled && this.#metadata.serviceTokens[name]) {
      delete this.#metadata.serviceTokens[name];
      this.#persist();
    }
    this.reconcile();
  }

  remove(id: string, service = false): void {
    const name = this.name(id);
    if (!service && this.#metadata.entries[name]?.owner) throw new HttpError(409, "Manage this MCP through its owning Service");
    if (this.#conflicts.has(name) || this.errors.length) throw new HttpError(409, "Resolve conflicting native source changes before removing this connection");
    const document = this.#document(this.#shared);
    if (document.values[name]) this.#write(document, new Map([[name, undefined]]));
    delete this.#metadata.entries[name];
    delete this.#metadata.packageRevisions[id];
    delete this.#metadata.serviceTokens[name];
    for (const [key, secret] of Object.entries(this.#metadata.secrets)) if (secret.server === name) delete this.#metadata.secrets[key];
    this.#live.delete(name);
    this.#persist();
  }

  serviceConnections(accountId: string): McpConnectionDto[] {
    return this.list(true).filter((connection) => this.#metadata.entries[connection.name]?.owner?.accountId === accountId);
  }

  setServiceToken(name: string, url: string, token: string): void {
    const definition = this.#document(this.#shared).values[name];
    if (!this.#metadata.entries[name]?.owner || definition?.disabled === true || definition?.url !== url || Object.keys(strings(definition.headers)).length) {
      delete this.#metadata.serviceTokens[name];
      this.#persist();
      throw new HttpError(409, "The Service source was modified; account credentials were not attached");
    }
    const previous = this.#metadata.serviceTokens[name];
    if (previous?.url === url && previous.token === token) return;
    this.#metadata.serviceTokens[name] = { url, token };
    this.#persist();
  }

  putService(name: string, definition: Definition, owner: { accountId: string; serviceId: string }): void {
    this.reconcile();
    const existing = this.#metadata.entries[name];
    if (existing && !isDeepStrictEqual(existing.owner, owner)) throw new HttpError(409, "The Service MCP name conflicts with an independent native resource");
    const document = this.#document(this.#shared);
    const previous = document.values[name];
    if (previous && !existing?.owner) throw new HttpError(409, "An independent native MCP occupies the Service destination");
    const inherited = { ...previous };
    if (typeof definition.url === "string" && previous?.url !== definition.url) {
      delete inherited.auth;
      delete inherited.oauth;
    }
    const previousMetadata = this.#metadata;
    this.#metadata = { ...previousMetadata, entries: { ...previousMetadata.entries, [name]: { ...existing,
      id: existing?.id ?? `mcp_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
      pi: existing?.pi ?? null, codex: existing?.codex ?? null, owner,
    } } };
    try {
      this.#write(document, new Map([[name, { ...inherited, ...definition }]]));
      this.#persist();
      this.reconcile();
    } catch (error) { this.#metadata = previousMetadata; throw error; }
  }
}

