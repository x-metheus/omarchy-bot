import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseForESLint, type AST } from "toml-eslint-parser";
import { z } from "zod";
import { McpDefinition, type McpConnectionDto } from "@omarchy-bot/protocol";
import type { NativeMcpStatus } from "@omarchy-bot/agent-contract";
import { emptyNativeMcpMetadata, type NativeMcpMetadata, nativeMcpConfigFile, nativeMcpEndpoint, nativeMcpSecretKey, nativeMcpSecretPlaceholder, parseNativeMcpMetadata, resolveNativeMcpCredentials } from "@omarchy-bot/agent-contract/native-mcp-config";
import { nativeMcpRevision } from "@omarchy-bot/agent-contract/native-mcp-revision";
import { HttpError } from "../bots/bots.ts";
import { projectNativeMcpOAuth, type NativeMcpOAuthSettings } from "./nativeMcpOAuth.ts";

type Definition = Record<string, unknown>;
type Document = { file: string; text: string; values: Record<string, Definition>; root: Record<string, unknown>; toml: boolean };
type Common = { command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; disabled: boolean };
type RuntimeConnection = Common & { oauth?: NativeMcpOAuthSettings };

export type EffectiveMcpServer = { configurationError: string; transport?: never; disabled?: never } | {
  disabled: boolean;
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

function effectiveDefinition(base: Definition | undefined, override: Definition | undefined): Definition | undefined {
  if (!override) return base;
  if (!base) return override;
  const inherited = { ...base };
  // Match the pinned adapter's transport and URL-bound credential semantics.
  if (typeof override.command === "string") {
    for (const key of ["url", "headers", "requestHeadersCommand", "caFile", "auth", "bearerToken", "bearerTokenEnv", "oauth", "httpTransport", "socket"]) delete inherited[key];
  } else if (typeof override.url === "string") {
    for (const key of ["command", "args", "env", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "socket"]) delete inherited[key];
  } else if (typeof override.socket === "string") {
    for (const key of ["command", "args", "env", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "url", "headers", "requestHeadersCommand", "caFile", "auth", "bearerToken", "bearerTokenEnv", "oauth", "httpTransport"]) delete inherited[key];
  }
  if (typeof override.url === "string" && override.url !== base.url) {
    for (const key of ["headers", "requestHeadersCommand", "caFile", "auth", "bearerToken", "bearerTokenEnv"]) delete inherited[key];
    if (inherited.oauth !== false) delete inherited.oauth;
  }
  return { ...inherited, ...override };
}

function sourceFingerprint(value: Definition | undefined): string | null {
  return value ? createHash("sha256").update(stable(value)).digest("hex") : null;
}

const nativeSources = ["shared", "pi", "codex"] as const;
const SOURCE_DELETION_CONFLICT = "Native deletion conflicts with another source edit; resolve the source files before synchronizing";
type NativeSource = (typeof nativeSources)[number];
type SourceFingerprints = NativeMcpMetadata["entries"][string]["sources"];

function hasSourceDeletion(previous: SourceFingerprints, sourceExists: (source: NativeSource) => boolean): boolean {
  return previous !== undefined && nativeSources.some((source) => previous[source] !== null && !sourceExists(source));
}

function hasConcurrentSourceEdit(previous: SourceFingerprints, fingerprintSource: (source: NativeSource) => string | null): boolean {
  return previous !== undefined && nativeSources.some((source) => {
    const current = fingerprintSource(source);
    return current !== null && current !== previous[source];
  });
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
function common(definition: Definition | undefined, codex = false): Common | undefined {
  if (!definition) return undefined;
  for (const field of ["disabled", "enabled"]) if (definition[field] !== undefined && typeof definition[field] !== "boolean") throw new Error(`${field} must be a boolean`);
  for (const field of ["command", "url", "socket", "bearerTokenEnv", "bearer_token_env_var"]) if (definition[field] !== undefined && (typeof definition[field] !== "string" || !definition[field].trim())) throw new Error(`${field} must be a nonempty string`);
  for (const field of ["args", "env_vars"]) if (definition[field] !== undefined && (!Array.isArray(definition[field]) || definition[field].some((item: unknown) => typeof item !== "string"))) throw new Error(`${field} must contain only strings`);
  for (const field of ["env", "headers", "http_headers", "env_http_headers"]) if (definition[field] !== undefined && (!object(definition[field]) || Object.values(definition[field]).some((item) => typeof item !== "string"))) throw new Error(`${field} must map names to strings`);
  if (definition.type !== undefined && !["stdio", "http", "sse"].includes(String(definition.type))) throw new Error("Unsupported native transport type");
  if (definition.command !== undefined && definition.url !== undefined) throw new Error("Select one native transport, not both command and url");
  const disabled = codex ? definition.enabled === false : definition.disabled === true;
  if (typeof definition.command === "string") {
    const env = { ...strings(definition.env) };
    if (codex && Array.isArray(definition.env_vars)) for (const key of definition.env_vars) if (env[key] === undefined) env[key] = `\${${key}}`;
    return { command: definition.command, args: definition.args as string[] | undefined ?? [], ...(Object.keys(env).length ? { env } : {}), disabled };
  }
  if (typeof definition.url !== "string") return undefined;
  let endpoint: URL;
  try { endpoint = new URL(definition.url); } catch { throw new Error("Invalid native endpoint URL"); }
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Native endpoint must use HTTP or HTTPS");
  if (endpoint.username || endpoint.password || [...endpoint.searchParams.keys()].some((key) => credentialQueryName.test(key))) throw new Error("Move URL credentials into private environment or header configuration; the source was not propagated");
  const headers = { ...strings(codex ? definition.http_headers : definition.headers) };
  if (codex) {
    for (const [key, value] of Object.entries(strings(definition.env_http_headers))) headers[key] = `\${${value}}`;
    if (typeof definition.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${definition.bearer_token_env_var}}`;
  } else if (typeof definition.bearerTokenEnv === "string") headers.Authorization = `Bearer \${${definition.bearerTokenEnv}}`;
  return { url: definition.url, ...(Object.keys(headers).length ? { headers } : {}), disabled };
}
function encoded(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(encoded).join(", ")}]`;
  if (object(value)) return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${encoded(item)}`).join(", ")} }`;
  throw new Error("Unsupported TOML value; native configuration was retained");
}
function keys(key: AST.TOMLKey): string[] { return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value); }

/** Rewrite only selected MCP entries, leaving unrelated TOML tables and text untouched. */
function editToml(text: string, updates: Map<string, Definition | undefined>): string {
  const root = parseForESLint(text).ast.body[0]!;
  const edits: { start: number; end: number; text: string }[] = [];
  const appended = new Map(updates);
  for (const node of root.body) {
    if (node.type === "TOMLKeyValue") {
      const key = keys(node.key);
      if (key.length === 1 && key[0] === "mcp_servers") {
        const parsed: unknown = Bun.TOML.parse(text);
        const values = object(parsed) && object(parsed.mcp_servers) ? { ...parsed.mcp_servers } : {};
        for (const [name, definition] of updates) { if (definition) values[name] = definition; else delete values[name]; }
        edits.push({ start: node.value.range[0], end: node.value.range[1], text: encoded(values) });
        appended.clear();
      } else if (key[0] === "mcp_servers" && key[1] && updates.has(key[1])) {
        throw new Error("Dotted top-level MCP assignments require native editing; no configuration was overwritten");
      }
      continue;
    }
    if (node.resolvedKey[0] !== "mcp_servers") continue;
    if (node.resolvedKey.length === 1) {
      for (const entry of node.body) {
        const key = keys(entry.key);
        if (key.length === 1 && updates.has(key[0]!)) {
          const definition = updates.get(key[0]!);
          edits.push({ start: entry.range[0], end: entry.range[1], text: definition ? `${JSON.stringify(key[0])} = ${encoded(definition)}` : "" });
          appended.delete(key[0]!);
        }
      }
    } else if (updates.has(String(node.resolvedKey[1]))) {
      edits.push({ start: node.range[0], end: node.range[1], text: "" });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  for (const [name, definition] of appended) {
    if (!definition) continue;
    text += `\n[mcp_servers.${JSON.stringify(name)}]\n${Object.entries(definition).map(([key, value]) => `${JSON.stringify(key)} = ${encoded(value)}`).join("\n")}\n`;
  }
  Bun.TOML.parse(text);
  return text;
}

export class NativeMcpStore {
  readonly #file: string;
  readonly #shared: string;
  readonly #pi: string;
  readonly #codex: string;
  #metadata: NativeMcpMetadata;
  #pending = new Set<string>();
  #conflicts = new Map<string, string>();
  #limitations = new Map<string, string>();
  #live = new Map<string, NativeMcpStatus>();
  #setupError: string | undefined;
  errors: string[] = [];

  constructor(readonly workspace: string, readonly privateDir: string) {
    this.#file = nativeMcpConfigFile(privateDir);
    this.#shared = path.join(workspace, ".mcp.json");
    this.#pi = path.join(workspace, ".pi", "mcp.json");
    this.#codex = path.join(workspace, ".codex", "config.toml");
    this.#metadata = existsSync(this.#file) ? parseNativeMcpMetadata(JSON.parse(readFileSync(this.#file, "utf8"))) : emptyNativeMcpMetadata();
    try { this.#registerAdapter(); } catch (error) { this.#setupError = error instanceof Error ? error.message : String(error); }
  }

  #persist(): void {
    mkdirSync(this.privateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#metadata, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  #registerAdapter(): void {
    const file = path.join(this.workspace, ".pi", "settings.json");
    const document = this.#document(file);
    const packages = document.root.packages ?? [];
    if (!Array.isArray(packages)) throw new Error("Native Pi packages must be an array; existing settings were retained");
    const bundled = path.resolve(import.meta.dir, "../../../../../workers/pi/node_modules/pi-mcp-adapter");
    if (!existsSync(path.join(bundled, "package.json"))) throw new Error("The packaged Pi MCP adapter is missing");
    const previous = this.#metadata.adapterPackage;
    const index = previous === undefined ? -1 : packages.indexOf(previous);
    if (previous && index === -1) return;
    if (previous === bundled) return;
    if (!previous && packages.some((entry) => typeof entry === "string" ? /(?:^npm:|\/)pi-mcp-adapter(?:@|\/|$)/.test(entry) : object(entry) && typeof entry.source === "string" && entry.source.includes("pi-mcp-adapter"))) return;
    const updated = [...packages];
    if (index >= 0) updated[index] = bundled; else updated.push(bundled);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const parent = path.relative(this.workspace, realpathSync(path.dirname(file)));
    if (parent.startsWith("..") || path.isAbsolute(parent)) throw new Error("Native Pi settings are outside the shared workspace");
    if (this.#readWorkspaceText(file) !== document.text) throw new Error("Native Pi settings changed during provisioning");
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...document.root, packages: updated }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    this.#metadata.adapterPackage = bundled;
    this.#persist();
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
    return nativeMcpRevision(this.workspace, this.#file, (file) => {
      const result = readRuntimeConfig(file, file === path.resolve(this.#file) ? undefined : this.workspace);
      return "error" in result ? null : result.contents;
    });
  }

  #parseDocument(file: string, text: string, label = file, skipInvalidServers = false): Document {
    const toml = file === this.#codex;
    let parsed: unknown;
    try { parsed = text.trim() ? toml ? Bun.TOML.parse(text) : JSON.parse(text) : {}; }
    catch { throw new Error(`${label}: invalid ${toml ? "TOML" : "JSON"}; repair the original file, which was not overwritten`); }
    if (!object(parsed)) throw new Error(`${label}: expected a native configuration object`);
    const map = parsed[toml ? "mcp_servers" : "mcpServers"];
    const values = map === undefined || (!skipInvalidServers && map === null) ? {} : map;
    if (!object(values) || (!skipInvalidServers && Object.values(values).some((entry) => !object(entry)))) throw new Error(`${label}: malformed MCP server map`);
    const servers = skipInvalidServers ? Object.fromEntries(Object.entries(values).filter(([, entry]) => object(entry))) : values;
    return { file, text, root: parsed, values: servers as Record<string, Definition>, toml };
  }

  #write(document: Document, updates: Map<string, Definition | undefined>): void {
    if (!updates.size) return;
    if (this.#readWorkspaceText(document.file) !== document.text) throw new HttpError(409, "Native MCP configuration changed during the operation; retry after inspecting it");
    const values = { ...document.values };
    for (const [name, value] of updates) { if (value) values[name] = value; else delete values[name]; }
    const text = document.toml ? editToml(document.text, updates) : `${JSON.stringify({ ...document.root, mcpServers: values }, null, 2)}\n`;
    mkdirSync(path.dirname(document.file), { recursive: true, mode: 0o700 });
    const parentRelative = path.relative(this.workspace, realpathSync(path.dirname(document.file)));
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) throw new HttpError(409, "Native configuration parent is outside the workspace");
    const temporary = `${document.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx", mode: existsSync(document.file) ? lstatSync(document.file).mode & 0o777 : 0o600 });
    renameSync(temporary, document.file);
  }

  #merge(previous: Definition | undefined, value: Common, codex: boolean): Definition {
    const next = { ...previous };
    const transportChanged = (typeof previous?.url === "string") !== (value.url !== undefined);
    const urlChanged = value.url !== undefined && previous?.url !== undefined && previous.url !== value.url;
    if (transportChanged || urlChanged) for (const key of ["command", "args", "env", "env_vars", "url", "headers", "http_headers", "env_http_headers", "bearer_token_env_var", "bearerTokenEnv", "bearerToken", "oauth", "auth", "requestHeadersCommand", "caFile", "httpTransport", "cwd", "pluginDataDir", "literalEnv", "inheritEnv", "tls", "socket", "type"]) delete next[key];
    if (codex) {
      next.enabled = !value.disabled;
      if (value.command !== undefined) {
        next.command = value.command; next.args = value.args ?? [];
        const env: Record<string, string> = {};
        const inherited: string[] = [];
        for (const [key, item] of Object.entries(value.env ?? {})) {
          const variable = reference(item);
          if (variable === key) inherited.push(key);
          else if (variable) throw new Error(`Codex cannot rename environment reference ${variable} to ${key}; use a matching variable name or client-local configuration`);
          else env[key] = item;
        }
        if (Object.keys(env).length) next.env = env; else delete next.env;
        if (inherited.length) next.env_vars = inherited; else delete next.env_vars;
      } else {
        next.url = value.url;
        const headers: Record<string, string> = {};
        const environment: Record<string, string> = {};
        delete next.bearer_token_env_var;
        for (const [key, item] of Object.entries(value.headers ?? {})) {
          const bearer = key.toLowerCase() === "authorization" ? item.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] : undefined;
          if (bearer) next.bearer_token_env_var = bearer;
          else { const variable = reference(item); if (variable) environment[key] = variable; else headers[key] = item; }
        }
        if (Object.keys(headers).length) next.http_headers = headers; else delete next.http_headers;
        if (Object.keys(environment).length) next.env_http_headers = environment; else delete next.env_http_headers;
      }
    } else {
      next.disabled = value.disabled;
      if (value.command !== undefined) { next.command = value.command; next.args = value.args ?? []; if (value.env) next.env = value.env; else delete next.env; }
      else { next.url = value.url; if (value.headers) next.headers = value.headers; else delete next.headers; }
    }
    return next;
  }

  reconcile(): void {
    this.errors = this.#setupError ? [this.#setupError] : [];
    this.#conflicts.clear();
    this.#limitations.clear();
    let shared: Document, pi: Document, codex: Document;
    try { shared = this.#document(this.#shared); pi = this.#document(this.#pi); codex = this.#document(this.#codex); }
    catch (error) { this.errors.push(error instanceof Error ? error.message : String(error)); return; }
    const updates = new Map<string, Definition | undefined>();
    const codexUpdates = new Map<string, Definition | undefined>();
    const piUpdates = new Map<string, Definition | undefined>();
    const changedNames = new Set<string>();
    const removedNames = new Set<string>();
    const previousMetadata = this.#metadata;
    this.#metadata = { ...previousMetadata, entries: { ...previousMetadata.entries } };
    const names = new Set([...Object.keys(shared.values), ...Object.keys(pi.values), ...Object.keys(codex.values), ...Object.keys(this.#metadata.entries)]);
    for (const name of names) {
      try {
        const previous = this.#metadata.entries[name];
        const effective = effectiveDefinition(shared.values[name], pi.values[name]);
        const fromPi = common(effective);
        const fromCodex = common(codex.values[name], true);
        if ((effective && !fromPi) || (codex.values[name] && !fromCodex)) throw new Error("Native transport is not representable here; use the named native source");
        const limits = [projectionLimits(effective), projectionLimits(codex.values[name])];
        const unsupported = limits.flatMap((limit) => limit.unsupported);
        if (!previous?.owner && unsupported.length) throw new Error(`Client-specific options cannot be projected safely: ${[...new Set(unsupported)].join(", ")}. Source files were retained.`);
        const local = limits.flatMap((limit) => limit.local);
        if (local.length) this.#limitations.set(name, `Client-specific timing settings are retained only in their native source: ${[...new Set(local)].join(", ")}`);
        const sources = { shared: sourceFingerprint(shared.values[name]), pi: sourceFingerprint(pi.values[name]), codex: sourceFingerprint(codex.values[name]) };
        const deleted = hasSourceDeletion(previous?.sources, (source) => sources[source] !== null);
        if (deleted && hasConcurrentSourceEdit(previous?.sources, (source) => sources[source])) throw new Error(SOURCE_DELETION_CONFLICT);
        const piValue = fromPi ? fingerprint(fromPi) : null;
        const codexValue = fromCodex ? fingerprint(fromCodex) : null;
        const piChanged = previous ? previous.pi !== piValue : piValue !== null;
        const codexChanged = previous ? previous.codex !== codexValue : codexValue !== null;
        if (!previous?.owner && !deleted && piChanged && codexChanged && piValue !== codexValue) throw new Error("Pi/Claude and Codex have conflicting native changes; resolve the source files before synchronizing");
        if (!deleted && !piChanged && !codexChanged && isDeepStrictEqual(previous?.sources, sources)) continue;
        const selected = deleted ? undefined : previous?.owner || piChanged || !codexChanged ? fromPi : fromCodex;
        if (!previous?.owner && selected && piValue !== codexValue && [...Object.values(selected.env ?? {}), ...Object.values(selected.headers ?? {})].some((value) => !reference(value) && !/^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) {
          throw new Error("Client-local environment or header values were not copied. Use native environment references to synchronize this connection.");
        }
        const sharedNext = selected ? this.#merge(shared.values[name], selected, false) : undefined;
        // Service authentication is Pi-owned; custom connections use the common projection.
        const codexNext = selected ? previous?.owner ? codex.values[name] : this.#merge(codex.values[name], selected, true) : undefined;
        const piNext = !selected ? undefined : pi.values[name] && codexChanged && !piChanged ? this.#merge(pi.values[name], selected, false) : pi.values[name];
        if (!isDeepStrictEqual(shared.values[name], sharedNext)) updates.set(name, sharedNext);
        if (!isDeepStrictEqual(codex.values[name], codexNext)) codexUpdates.set(name, codexNext);
        if (!isDeepStrictEqual(pi.values[name], piNext)) piUpdates.set(name, piNext);
        if (!selected) {
          delete this.#metadata.entries[name];
          removedNames.add(name);
        } else {
          this.#metadata.entries[name] = {
            id: previous?.id ?? `mcp_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
            pi: fingerprint(selected), codex: previous?.owner ? codexValue : fingerprint(selected),
            sources: { shared: sourceFingerprint(sharedNext), pi: sourceFingerprint(piNext), codex: sourceFingerprint(codexNext) },
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
      this.#write(shared, updates); this.#write(codex, codexUpdates); this.#write(pi, piUpdates);
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
    const sources = { shared: readDocument(this.#shared), pi: readDocument(this.#pi), codex: readDocument(this.#codex) };
    const { shared, pi, codex } = sources;
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
    const names = new Set([...Object.keys(shared), ...Object.keys(pi), ...Object.keys(codex)]);
    const connections: Record<string, RuntimeConnection> = Object.create(null);
    const servers: Record<string, EffectiveMcpServer> = Object.create(null);
    for (const name of names) {
      const sourceDefinition = (source: NativeSource) => Object.hasOwn(sources[source], name) ? sources[source][name] : undefined;
      const previous = metadata.entries[name]?.sources;
      if (hasSourceDeletion(previous, (source) => sourceDefinition(source) !== undefined)) {
        if (hasConcurrentSourceEdit(previous, (source) => sourceFingerprint(sourceDefinition(source)))) {
          servers[name] = { configurationError: SOURCE_DELETION_CONFLICT };
        }
        continue;
      }
      const definition = effectiveDefinition(sourceDefinition("shared"), sourceDefinition("pi"));
      const codexDefinition = sourceDefinition("codex");
      const source = definition ?? codexDefinition;
      const unsupported = source?.type === "sse" || source?.httpTransport === "sse" ? "sse"
        : source?.type === "socket" || typeof source?.socket === "string" ? "socket" : undefined;
      if (unsupported) {
        servers[name] = { transport: { type: unsupported }, disabled: definition ? source?.disabled === true : source?.enabled === false };
        continue;
      }
      try {
        const fromPi = common(definition);
        const value = fromPi ?? common(codexDefinition, true);
        if (!value) continue;
        const selected = fromPi ? definition : codexDefinition;
        if ((selected?.auth !== undefined && !hasOAuthMarker(selected)) ||
          (value.url !== undefined && selected?.bearerToken !== undefined)) {
          servers[name] = { configurationError: "Unsupported MCP authentication settings. Check the configuration for this connection." };
          continue;
        }
        if (value.url !== undefined) {
          const oauth = projectNativeMcpOAuth(selected?.oauth);
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
      if (command !== undefined) servers[name] = { transport: { type: "stdio", command, args: args ?? [], ...(env ? { env } : {}) }, disabled };
      else if (url !== undefined) servers[name] = { transport: { type: "http", url, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}) }, disabled };
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
      revision: nativeMcpRevision(this.workspace, this.#file, (file) => snapshot.get(file)),
      servers,
      secrets: [...secrets].filter(Boolean),
      ...(errors.length ? { configurationError: `MCP configuration could not be loaded. ${errors.join(". ")}` } : {}),
    };
  }

  list(includeService = false): McpConnectionDto[] {
    this.reconcile();
    let shared: Document, pi: Document, codex: Document;
    try { shared = this.#document(this.#shared); pi = this.#document(this.#pi); codex = this.#document(this.#codex); } catch { return []; }
    const revision = this.#configurationRevision();
    return [...new Set([...Object.keys(shared.values), ...Object.keys(pi.values), ...Object.keys(codex.values)])].sort().flatMap((name) => {
      const metadata = this.#metadata.entries[name];
      if (!includeService && metadata?.owner) return [];
      const definition = effectiveDefinition(shared.values[name], pi.values[name]);
      let value: Common | undefined;
      let readOnly = false;
      try { value = common(definition) ?? common(codex.values[name], true); }
      catch {
        const raw = definition ?? codex.values[name];
        if (typeof raw?.url === "string") { value = { url: safeEndpoint(raw.url), disabled: raw.disabled === true || raw.enabled === false }; readOnly = true; }
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
        source: [shared.values[name] ? ".mcp.json" : "", pi.values[name] ? ".pi/mcp.json" : "", codex.values[name] ? ".codex/config.toml" : ""].filter(Boolean).join(", "),
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
    const pi = this.#document(this.#pi);
    if ((!previousName || previousName !== body.name) && (document.values[body.name] || pi.values[body.name] || this.#document(this.#codex).values[body.name])) throw new HttpError(409, "A native MCP already uses that name");
    if (previousName && this.#conflicts.has(previousName)) throw new HttpError(409, this.#conflicts.get(previousName)!);
    const previous = previousName ? effectiveDefinition(document.values[previousName], pi.values[previousName]) : undefined;
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
    const definition = this.#merge(previous, value, false);
    const updates = new Map<string, Definition | undefined>([[body.name, definition]]);
    if (previousName && previousName !== body.name) updates.set(previousName, undefined);
    this.#write(document, updates);
    if (previousName && pi.values[previousName]) this.#write(pi, new Map([[previousName, previousName === body.name ? this.#merge(pi.values[previousName], value, false) : undefined]]));
    if (previousName && previousName !== body.name) {
      const codex = this.#document(this.#codex);
      if (codex.values[previousName]) this.#write(codex, new Map([[previousName, undefined]]));
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
    for (const file of [this.#shared, this.#pi]) {
      const document = this.#document(file);
      if (document.values[name]) this.#write(document, new Map([[name, { ...document.values[name], disabled: !enabled }]]));
    }
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
    for (const file of [this.#shared, this.#pi, this.#codex]) {
      const document = this.#document(file);
      if (document.values[name]) this.#write(document, new Map([[name, undefined]]));
    }
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
    if (document.values[name] && !existing?.owner) throw new HttpError(409, "An independent native MCP occupies the Service destination");
    const previousMetadata = this.#metadata;
    this.#metadata = { ...previousMetadata, entries: { ...previousMetadata.entries, [name]: { ...existing,
      id: existing?.id ?? `mcp_${createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
      pi: existing?.pi ?? null, codex: existing?.codex ?? null, owner,
    } } };
    try {
      this.#write(document, new Map([[name, { ...document.values[name], ...definition }]]));
      this.#persist();
      this.reconcile();
    } catch (error) { this.#metadata = previousMetadata; throw error; }
  }
}

