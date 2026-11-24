import { createHash } from "node:crypto";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import {
  McpAuthRequiredError, McpClient, McpConnectionClosedError, McpSessionExpiredError, McpTimeoutError,
  normalizeMcpInputSchema, StdioTransport, StreamableHttpTransport, toLlmContent,
  type AuthProvider, type McpTransport, type Tool,
} from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import type { NativeMcpStatus } from "@omarchy-bot/agent-contract";
import type { EffectiveMcpServer, EffectiveMcpServers } from "../../plugins/nativeMcp.ts";

const DISCOVERY_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_RETAINED_OAUTH_TOKENS = 4;
const CONFIGURATION_LOAD_ERROR = "MCP configuration could not be loaded. Check the configuration in Services and retry.";
const SHUTDOWN_ERROR = "The MCP runtime is shutting down. Retry once the Service is running.";

class McpConfigurationError extends Error {}

function needsSignIn(error: unknown): boolean {
  return error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError;
}

type Redact = (text: string) => string;
type ConfiguredMcpServer = Exclude<EffectiveMcpServer, { configurationError: string }>;
type Connection = {
  fingerprint: string;
  cwd: string | undefined;
  client: McpClient;
  discovery: Promise<Tool[]>;
  tools: Promise<Tool[]>;
  toolCount?: number;
  retiring?: boolean;
};
type DiscoveryFailure = { revision: string; status: "failed" | "needs-auth" };
type McpArguments = {
  action: "search" | "describe" | "call";
  service?: string;
  tool?: string;
  query?: string;
  arguments?: Record<string, unknown>;
};

export type McpExtensionDeps = {
  servers: () => EffectiveMcpServers;
  prepareServers?: () => Promise<EffectiveMcpServers>;
  fillSecrets?: (value: string) => string;
  authProvider?: (service: string, url: string) => AuthProvider | undefined;
  callTimeoutMs?: number;
};

function credentialRedactor(secrets: string[]): Redact {
  const forms = new Set(secrets.filter(Boolean).flatMap((secret) => {
    const json = JSON.stringify(secret).slice(1, -1);
    // Unicode escapes and other re-encodings are outside literal credential redaction.
    return [secret, json, json.replaceAll("/", "\\/")];
  }));
  const patterns = [...forms].sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!patterns.length) return (text) => text;
  const pattern = new RegExp(patterns.join("|"), "g");
  return (text) => text.replace(pattern, "[redacted]");
}

function redactStrings(value: unknown, redact: Redact): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]));
  }
  return value;
}

function redactToolMetadata({ name, description, inputSchema }: Tool, redact: Redact) {
  return {
    name,
    description: description === undefined ? undefined : redact(description),
    inputSchema: redactStrings(normalizeMcpInputSchema(inputSchema), redact),
  };
}

function modelResult(content: string | NonNullable<ToolExecutionResult["output"]>, isError = false): ToolExecutionResult {
  return { output: typeof content === "string" ? [{ type: "text", text: content }] : content, isError };
}

function formatError(message: string, redact: Redact = (text) => text) {
  return { type: "text" as const, text: redact(message) };
}

function errorResult(message: string, redact?: Redact): ToolExecutionResult {
  return modelResult([formatError(message, redact)], true);
}

function fingerprint(server: ConfiguredMcpServer, cwd: string | undefined): string {
  return createHash("sha256").update(JSON.stringify([server.transport, server.transport.type === "stdio" ? cwd : undefined])).digest("hex");
}

function fillFields(fields: Record<string, string> | undefined, fill: (value: string) => string) {
  return fields && Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fill(value)]));
}

function fillArgumentRecord(fields: Record<string, unknown>, fill: (value: string) => string): Record<string, unknown> {
  function fillValue(value: unknown): unknown {
    if (typeof value === "string") return fill(value);
    if (Array.isArray(value)) return value.map(fillValue);
    if (value && typeof value === "object") return fillArgumentRecord(value as Record<string, unknown>, fill);
    return value;
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fillValue(value)]));
}

export function createMcpExtension({ servers: loadServers, prepareServers, fillSecrets = (value) => value, authProvider, callTimeoutMs = CALL_TIMEOUT_MS }: McpExtensionDeps) {
  const connections = new Map<string, Connection>();
  const issuedTokensByName = new Map<string, Set<string>>();
  const failures = new Map<string, DiscoveryFailure>();
  const pendingCloses = new Map<string, Promise<void>>();
  const pendingPreparations = new Set<Promise<EffectiveMcpServers>>();
  const callQueues = new Map<string, Promise<void>>();
  let closing: Promise<void> | undefined;

  function enqueue<T>(name: string, run: () => Promise<T>): Promise<T> {
    const next = (callQueues.get(name) ?? Promise.resolve()).then(run);
    const finished = next.then(() => {}, () => {}).finally(() => {
      if (callQueues.get(name) === finished) callQueues.delete(name);
    });
    callQueues.set(name, finished);
    return next;
  }

  function trackTokens(name: string, provider: AuthProvider): AuthProvider {
    return {
      async token() {
        const token = await provider.token();
        if (closing) return undefined;
        if (token) {
          let issuedTokens = issuedTokensByName.get(name);
          if (!issuedTokens) issuedTokensByName.set(name, issuedTokens = new Set());
          issuedTokens.delete(token);
          issuedTokens.add(token);
          if (issuedTokens.size > MAX_RETAINED_OAUTH_TOKENS) issuedTokens.delete(issuedTokens.values().next().value!);
        }
        return token;
      },
      ...(provider.onUnauthorized ? { onUnauthorized: provider.onUnauthorized.bind(provider) } : {}),
    };
  }

  function redactFor(name: string | undefined, secrets: string[]): Redact {
    const issuedTokens = name === undefined
      ? [...issuedTokensByName.values()].flatMap((tokens) => [...tokens])
      : issuedTokensByName.get(name) ?? [];
    return credentialRedactor([...secrets, ...issuedTokens]);
  }

  function discard(name: string, connection: Connection) {
    if (connections.get(name) !== connection) return pendingCloses.get(name);
    connections.delete(name);
    // A failed handshake can already be closing its transport inside connect().
    const finished = Promise.allSettled([pendingCloses.get(name), connection.client.close(), connection.discovery]).then(() => {
      if (pendingCloses.get(name) === finished) pendingCloses.delete(name);
    });
    pendingCloses.set(name, finished);
    return finished;
  }

  function getConnection(
    name: string, server: ConfiguredMcpServer, revision: string, cwd: string | undefined, revalidate: (key: string) => void,
  ): Connection | undefined {
    const configuration = server.transport;
    if (configuration.type !== "stdio" && configuration.type !== "http") return undefined;
    const key = fingerprint(server, cwd);
    const cached = connections.get(name);
    if (cached?.fingerprint === key && !cached.retiring && cached.client.connectionState !== "closed") return cached;
    if (cached) discard(name, cached);
    const resolved = configuration.type === "stdio"
      ? { ...configuration, env: fillFields(configuration.env, fillSecrets) ?? {} }
      : { ...configuration, headers: fillFields(configuration.headers, fillSecrets) ?? {} };
    const auth = resolved.type === "http" && !Object.keys(resolved.headers).some((key) => key.toLowerCase() === "authorization")
      ? authProvider?.(name, resolved.url) : undefined;
    const transport: McpTransport = resolved.type === "stdio"
      ? new StdioTransport({
        command: resolved.command, args: resolved.args.map(fillSecrets),
        ...(cwd !== undefined ? { cwd } : {}), env: resolved.env, inheritEnv: false,
      })
      : new StreamableHttpTransport({
        url: resolved.url, headers: resolved.headers, ...(auth ? { authProvider: trackTokens(name, auth) } : {}),
        fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
      });
    const client = new McpClient({ name: "omarchy-bot", version: "0.1.0", requestTimeoutMs: DISCOVERY_TIMEOUT_MS });
    const previousClose = pendingCloses.get(name);
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const discovery = (async () => {
      if (previousClose) await awaitWithContext(previousClose, context);
      signal.throwIfAborted();
      if (previousClose) revalidate(key);
      if (client.connectionState === "closed") throw new McpConnectionClosedError();
      await client.connect(transport);
      return client.listTools({ signal, timeoutMs: DISCOVERY_TIMEOUT_MS });
    })();
    const tools = awaitWithContext(discovery, context).then((found) => {
      connection.toolCount = found.length;
      return found;
    }, (error) => {
      if (connections.get(name) === connection && !(error instanceof McpConfigurationError)) {
        failures.set(name, { revision, status: needsSignIn(error) ? "needs-auth" : "failed" });
      }
      if (signal.aborted) throw new McpTimeoutError(DISCOVERY_TIMEOUT_MS);
      throw error;
    });
    const connection: Connection = { fingerprint: key, cwd, client, discovery, tools };
    connections.set(name, connection);
    failures.delete(name);
    void tools.catch(() => discard(name, connection));
    return connection;
  }

  function readServers(): EffectiveMcpServers | undefined {
    try { return loadServers(); }
    catch { return undefined; }
  }

  function refreshServers(effective: EffectiveMcpServers | undefined) {
    if (!effective) return undefined;
    const servers = new Map(Object.entries(effective.servers));
    for (const [name, failure] of failures) {
      if (failure.revision !== effective.revision) failures.delete(name);
    }
    for (const [name, connection] of connections) {
      if (connection.retiring) continue;
      const server = servers.get(name);
      if (!server || "configurationError" in server || server.disabled || connection.fingerprint !== fingerprint(server, connection.cwd)) {
        connection.retiring = true;
        // Start closing in order. The next connection can then revalidate after pendingCloses resolves.
        void enqueue(name, async () => { discard(name, connection); });
      }
    }
    return { ...effective, servers };
  }

  function withService<T>(
    action: McpArguments["action"], name: string, server: EffectiveMcpServer, cwd: string | undefined, context: Context,
    snapshot: { revision: string; secrets: string[] },
    run: (connection: Connection, tools: Tool[], getRedactor: () => Redact) => T | Promise<T>,
  ): Promise<{ result: T } | { error: string }> {
    if ("configurationError" in server) {
      return Promise.resolve({ error: redactFor(name, snapshot.secrets)(server.configurationError) });
    }
    const signal = context.abortSignal;
    const existingConnection = connections.get(name);
    const queued = server.transport.type === "stdio" || action === "call" || existingConnection?.retiring;
    const hasPredecessor = queued && callQueues.has(name);
    const execute = async () => {
      signal?.throwIfAborted();
      let secrets = snapshot.secrets;
      let revision = snapshot.revision;
      let connection: Connection | undefined;
      const getRedactor = () => redactFor(name, secrets);
      const failure = (message: string) => ({ error: getRedactor()(message) });
      if (closing) return { error: SHUTDOWN_ERROR };
      const configurationError = (message: string) => new McpConfigurationError(getRedactor()(message));
      const readServer = () => {
        const current = refreshServers(readServers());
        if (!current) throw configurationError(CONFIGURATION_LOAD_ERROR);
        revision = current.revision;
        secrets = [...snapshot.secrets, ...current.secrets];
        if (current.configurationError) throw configurationError(current.configurationError);
        const selected = current.servers.get(name);
        if (!selected) {
          const redact = redactFor(undefined, secrets);
          throw new McpConfigurationError(redact(`MCP service "${name}" is no longer configured. Use mcp search to find available services.`));
        }
        if ("configurationError" in selected) throw configurationError(selected.configurationError);
        if (selected.disabled) throw configurationError(`MCP service "${name}" is disabled. Enable it in Services before retrying.`);
        return selected;
      };
      let currentServer = server;
      try {
        if (action === "call" || hasPredecessor) currentServer = readServer();
        connection = getConnection(name, currentServer, revision, cwd, (key) => {
          if (fingerprint(readServer(), cwd) !== key) {
            throw configurationError(`MCP service "${name}" changed while waiting for its previous connection to close. Use mcp search before retrying.`);
          }
        });
        if (!connection) {
          failures.set(name, { revision, status: "failed" });
          return failure(`MCP service "${name}" uses unsupported transport ${currentServer.transport.type}. Configure stdio or Streamable HTTP.`);
        }
        const tools = await awaitWithContext(connection.tools, context);
        signal?.throwIfAborted();
        if (closing) return { error: SHUTDOWN_ERROR };
        const result = await awaitWithContext(Promise.resolve(run(connection, tools, getRedactor)), context);
        return { result };
      } catch (error) {
        const deadline = signal?.reason?.name === "TimeoutError";
        const needsAuth = needsSignIn(error);
        if (connection && needsAuth && connections.get(name) === connection) {
          failures.set(name, { revision, status: "needs-auth" });
        }
        if (connection && (error instanceof McpConnectionClosedError || error instanceof McpSessionExpiredError ||
          error instanceof McpTimeoutError || needsAuth || deadline || (currentServer.transport.type === "stdio" && signal?.aborted))) {
          await discard(name, connection);
        }
        if (signal?.aborted) throw error;
        if (closing) return { error: SHUTDOWN_ERROR };
        if (error instanceof McpConfigurationError) return { error: error.message };
        if (needsAuth) return failure(`MCP service "${name}" needs sign-in. Sign in through Services and retry.`);
        if (error instanceof McpTimeoutError) return failure(`MCP service "${name}" timed out after ${error.timeoutMs / 1000} seconds (${error.timeoutMs} ms).`);
        return failure(`MCP service "${name}" failed. Check its configuration in Services and retry.`);
      }
    };
    return queued ? awaitWithContext(enqueue(name, execute), context) : execute();
  }

  const extension = defineExtension({
    name: "omarchy-mcp",
    tools: [defineTool({
      name: "mcp",
      description: "Search configured MCP services and their tools, describe a tool's input schema, or call a tool on a specific service.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "describe", "call"] },
          service: { type: "string" },
          tool: { type: "string" },
          query: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      async execute(input, api, context) {
        const signal = context.abortSignal;
        signal?.throwIfAborted();
        if (closing) return errorResult(SHUTDOWN_ERROR);
        const { action, service, tool, query, arguments: args } = input as McpArguments;
        if (action !== "search" && (!service || !tool)) {
          return errorResult(`Specify both service and tool for ${action === "describe" ? "describe" : "call"}. Use mcp search to find their names.`);
        }
        let loaded: EffectiveMcpServers | undefined;
        try {
          if (prepareServers) {
            // Credential writes can outlive the Turn's wait for preparation.
            const preparation = prepareServers();
            pendingPreparations.add(preparation);
            const forgetPreparation = () => { pendingPreparations.delete(preparation); };
            void preparation.then(forgetPreparation, forgetPreparation);
            loaded = await awaitWithContext(preparation, context);
          } else {
            loaded = readServers();
          }
        } catch { signal?.throwIfAborted(); }
        signal?.throwIfAborted();
        if (closing) return errorResult(SHUTDOWN_ERROR);
        const effective = refreshServers(loaded);
        if (!effective) return errorResult(CONFIGURATION_LOAD_ERROR);
        const { servers, revision, secrets } = effective;
        const selected = service ? servers.get(service) : undefined;
        if (effective.configurationError) return errorResult(effective.configurationError, redactFor(selected ? service : undefined, secrets));
        if (service && !selected) {
          return errorResult(`Unknown MCP service "${service}". Use mcp search to find available services.`, redactFor(undefined, secrets));
        }
        if (service && selected?.disabled) {
          return errorResult(`MCP service "${service}" is disabled. Enable it in Services before retrying.`, redactFor(service, secrets));
        }
        const snapshot = { revision, secrets };
        const cwd = api.env?.cwd;

        if (action === "search") {
          const term = query?.trim().toLowerCase() ?? "";
          const matches = (value: string) => value.toLowerCase().includes(term);
          const targets = [...servers].filter(([name, server]) => !server.disabled && (!service || name === service));
          const found = await Promise.all(targets.map(([name, server]) => withService(action, name, server, cwd, context, snapshot, (_connection, tools, getRedactor) => {
            const redact = getRedactor();
            const matchesService = matches(name);
            const foundTools = tools.map((item) => redactToolMetadata(item, redact))
              .filter((item) => matchesService || matches(item.name) || matches(item.description ?? ""))
              .map(({ name, description }) => ({ name, description }));
            return matchesService || foundTools.length ? { service: name, tools: foundTools } : undefined;
          })));
          const errors = found.flatMap((item) => "error" in item ? [item.error] : []);
          const services = found.flatMap((item) => "result" in item && item.result ? [item.result] : []);
          if (errors.length && errors.length === targets.length) return modelResult(errors.join("\n"), true);
          return modelResult(JSON.stringify({ services, ...(errors.length ? { errors } : {}) }, null, 2));
        }

        const result = await withService(action, service!, selected!, cwd, context, snapshot, async ({ client }, tools, getRedactor) => {
          const selectedTool = tools.find((item) => item.name === tool);
          if (!selectedTool) return errorResult(`Unknown MCP tool "${tool}" on "${service}". Use mcp search for this service.`, getRedactor());
          if (action === "describe") {
            const { name, description, inputSchema } = redactToolMetadata(selectedTool, getRedactor());
            return modelResult(JSON.stringify({ service, tool: name, description, inputSchema }, null, 2));
          }
          const result = await client.callTool(selectedTool.name, args && fillArgumentRecord(args, fillSecrets), {
            ...(signal ? { signal } : {}), timeoutMs: callTimeoutMs,
          });
          if (closing) return errorResult(SHUTDOWN_ERROR);
          const redact = getRedactor();
          // Redacting a numeric JSON literal produces a bare [redacted] token. Text results need not be valid JSON.
          const content = !result.content?.length && result.structuredContent !== undefined
            ? [{ type: "text" as const, text: JSON.stringify(redactStrings(result.structuredContent, redact), null, 2) }]
            : toLlmContent(result).map((part) => part.type === "text" ? { ...part, text: redact(part.text) } : part);
          if (result.isError && !content.length) return errorResult(`MCP tool "${tool}" on "${service}" reported a failure.`, redact);
          return modelResult(content, result.isError === true);
        });
        return "error" in result ? modelResult(result.error, true) : result.result;
      },
    })],
  });

  const mcp = Object.assign(extension, {
    async check(name: string, cwd?: string): Promise<NativeMcpStatus | undefined> {
      if (closing) return undefined;
      return enqueue(name, async () => {
        if (closing) return undefined;
        const effective = refreshServers(readServers());
        const server = effective?.servers.get(name);
        // Stdio processes start in the caller's workspace through tool discovery or execution.
        if (effective && server && !effective.configurationError && !("configurationError" in server) &&
          !server.disabled && server.transport.type === "http") {
          const previous = connections.get(name);
          if (previous) discard(name, previous);
          failures.delete(name);
          const { revision } = effective;
          let connection: Connection | undefined;
          try {
            connection = getConnection(name, server, revision, cwd, (key) => {
              const current = refreshServers(readServers());
              const selected = current?.servers.get(name);
              if (current?.configurationError || !selected || "configurationError" in selected || selected.disabled ||
                fingerprint(selected, cwd) !== key) throw new McpConfigurationError();
            });
            if (connection) await connection.tools;
          } catch (error) {
            if (connection) discard(name, connection);
            else failures.set(name, { revision, status: needsSignIn(error) ? "needs-auth" : "failed" });
          }
          await pendingCloses.get(name);
        }
        return mcp.status().find((entry) => entry.name === name);
      });
    },
    status(): NativeMcpStatus[] {
      if (closing) return [];
      const effective = refreshServers(readServers());
      if (!effective) return [];
      const { revision: configurationRevision, configurationError } = effective;
      return [...effective.servers].map(([name, server]) => {
        const disabled = server.disabled === true;
        if (disabled || configurationError) {
          return { name, configurationRevision, status: disabled ? "disabled" : "failed", toolCount: 0, disabled };
        }
        const connection = connections.get(name);
        const toolCount = !connection?.retiring && connection?.client.connectionState === "connected" ? connection.toolCount : undefined;
        let status: NativeMcpStatus["status"] = "not-connected";
        if (toolCount !== undefined) status = "connected";
        else if ("configurationError" in server) status = "failed";
        else status = failures.get(name)?.status ?? status;
        return { name, configurationRevision, status, toolCount: toolCount ?? 0, disabled };
      });
    },
    retainedTokenSetCountForTest(): number {
      return issuedTokensByName.size;
    },
    close(): Promise<void> {
      if (!closing) {
        const shutdown = Promise.withResolvers<void>();
        closing = shutdown.promise;
        for (const [name, connection] of connections) discard(name, connection);
        shutdown.resolve(Promise.allSettled([...pendingCloses.values(), ...pendingPreparations]).then(() => {
          issuedTokensByName.clear();
        }));
      }
      return closing;
    },
  });
  return mcp;
}
