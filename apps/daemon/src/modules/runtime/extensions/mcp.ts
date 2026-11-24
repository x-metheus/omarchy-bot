import { createHash } from "node:crypto";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import {
  McpAuthRequiredError, McpClient, McpConnectionClosedError, McpSessionExpiredError, McpTimeoutError,
  normalizeMcpInputSchema, StdioTransport, StreamableHttpTransport, toLlmContent,
  type AuthProvider, type McpTransport, type Tool,
} from "@earendil-works/pi-mcp";
import type { EffectiveMcpServer, EffectiveMcpServers } from "../../plugins/nativeMcp.ts";

const DISCOVERY_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const CONFIGURATION_LOAD_ERROR = "MCP configuration could not be loaded. Check the configuration in Services and retry.";

class McpConfigurationError extends Error {}

type Redact = (text: string) => string;
type ConfiguredMcpServer = Exclude<EffectiveMcpServer, { configurationError: string }>;
type Connection = {
  fingerprint: string;
  cwd: string | undefined;
  client: McpClient;
  discovery: Promise<Tool[]>;
  tools: Promise<Tool[]>;
};
type McpArguments = {
  action: "search" | "describe" | "call";
  service?: string;
  tool?: string;
  query?: string;
  arguments?: Record<string, unknown>;
};

export type McpExtensionDeps = {
  servers: () => EffectiveMcpServers;
  fillSecrets?: (value: string) => string;
  authProvider?: (service: string) => AuthProvider | undefined;
  callTimeoutMs?: number;
};

function credentialRedactor(secrets: string[]): Redact {
  const forms = new Set(secrets.filter(Boolean).flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]));
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

export function createMcpExtension({ servers: loadServers, fillSecrets = (value) => value, authProvider, callTimeoutMs = CALL_TIMEOUT_MS }: McpExtensionDeps) {
  const connections = new Map<string, Connection>();
  const pendingCloses = new Map<string, Promise<void>>();
  const callQueues = new Map<string, Promise<void>>();
  let closing: Promise<void> | undefined;

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
    name: string, server: ConfiguredMcpServer, cwd: string | undefined, revalidate: (key: string) => void,
  ): Connection | undefined {
    const configuration = server.transport;
    if (configuration.type !== "stdio" && configuration.type !== "http") return undefined;
    const key = fingerprint(server, cwd);
    const cached = connections.get(name);
    if (cached?.fingerprint === key && cached.client.connectionState !== "closed") return cached;
    if (cached) discard(name, cached);
    const resolved = configuration.type === "stdio"
      ? { ...configuration, env: fillFields(configuration.env, fillSecrets) ?? {} }
      : { ...configuration, headers: fillFields(configuration.headers, fillSecrets) ?? {} };
    const auth = resolved.type === "http" ? authProvider?.(name) : undefined;
    const transport: McpTransport = resolved.type === "stdio"
      ? new StdioTransport({
        command: resolved.command, args: resolved.args.map(fillSecrets),
        ...(cwd !== undefined ? { cwd } : {}), env: resolved.env, inheritEnv: false,
      })
      : new StreamableHttpTransport({
        url: resolved.url, headers: resolved.headers, ...(auth ? { authProvider: auth } : {}),
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
    const tools = awaitWithContext(discovery, context).catch((error) => {
      if (signal.aborted) throw new McpTimeoutError(DISCOVERY_TIMEOUT_MS);
      throw error;
    });
    const connection = { fingerprint: key, cwd, client, discovery, tools };
    connections.set(name, connection);
    void tools.catch(() => discard(name, connection));
    return connection;
  }

  function refreshServers() {
    let effective: EffectiveMcpServers;
    try { effective = loadServers(); }
    catch { return undefined; }
    const servers = new Map(Object.entries(effective.servers));
    for (const [name, connection] of connections) {
      const server = servers.get(name);
      if (!server || "configurationError" in server || server.disabled || connection.fingerprint !== fingerprint(server, connection.cwd)) discard(name, connection);
    }
    return { ...effective, servers };
  }

  function withService<T>(
    action: McpArguments["action"], name: string, server: EffectiveMcpServer, cwd: string | undefined, context: Context,
    credentials: { secrets: string[]; redact: Redact },
    run: (connection: Connection, tools: Tool[], redact: Redact) => T | Promise<T>,
  ): Promise<{ result: T } | { error: string }> {
    if ("configurationError" in server) {
      return Promise.resolve({ error: credentials.redact(server.configurationError) });
    }
    const signal = context.abortSignal;
    const queued = server.transport.type === "stdio" || action === "call";
    const predecessor = queued ? callQueues.get(name) : undefined;
    const execute = async () => {
      signal?.throwIfAborted();
      let redact = credentials.redact;
      const failure = (message: string) => ({ error: formatError(message, redact).text });
      if (closing) return failure("The MCP runtime is shutting down. Retry once the Service is running.");
      const configurationError = (message: string) => new McpConfigurationError(redact(message));
      const readServer = () => {
        const current = refreshServers();
        if (!current) throw configurationError(CONFIGURATION_LOAD_ERROR);
        redact = credentialRedactor([...new Set([...credentials.secrets, ...current.secrets])]);
        if (current.configurationError) throw configurationError(current.configurationError);
        const selected = current.servers.get(name);
        if (!selected) throw configurationError(`MCP service "${name}" is no longer configured. Use mcp search to find available services.`);
        if ("configurationError" in selected) throw configurationError(selected.configurationError);
        if (selected.disabled) throw configurationError(`MCP service "${name}" is disabled. Enable it in Services before retrying.`);
        return selected;
      };
      let currentServer = server;
      let connection: Connection | undefined;
      try {
        if (action === "call" || predecessor) currentServer = readServer();
        connection = getConnection(name, currentServer, cwd, (key) => {
          if (fingerprint(readServer(), cwd) !== key) {
            throw configurationError(`MCP service "${name}" changed while waiting for its previous connection to close. Use mcp search before retrying.`);
          }
        });
        if (!connection) return failure(`MCP service "${name}" uses unsupported transport ${currentServer.transport.type}. Configure stdio or Streamable HTTP.`);
        const tools = await awaitWithContext(connection.tools, context);
        signal?.throwIfAborted();
        const result = await awaitWithContext(Promise.resolve(run(connection, tools, redact)), context);
        return { result };
      } catch (error) {
        const deadline = signal?.reason?.name === "TimeoutError";
        if (connection && (error instanceof McpConnectionClosedError || error instanceof McpSessionExpiredError ||
          error instanceof McpTimeoutError || deadline || (currentServer.transport.type === "stdio" && signal?.aborted))) {
          await discard(name, connection);
        }
        if (signal?.aborted) throw error;
        if (error instanceof McpConfigurationError) return { error: error.message };
        if (error instanceof McpAuthRequiredError) return failure(`MCP service "${name}" needs sign-in. Sign in through Services and retry.`);
        if (error instanceof McpTimeoutError) return failure(`MCP service "${name}" timed out after ${error.timeoutMs / 1000} seconds (${error.timeoutMs} ms).`);
        return failure(`MCP service "${name}" failed. Check its configuration in Services and retry.`);
      }
    };
    if (!queued) return execute();
    const next = (predecessor ?? Promise.resolve()).then(execute);
    const finished = next.then(() => {}, () => {}).finally(() => {
      if (callQueues.get(name) === finished) callQueues.delete(name);
    });
    callQueues.set(name, finished);
    return awaitWithContext(next, context);
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
        if (closing) return errorResult("The MCP runtime is shutting down. Retry once the Service is running.");
        const { action, service, tool, query, arguments: args } = input as McpArguments;
        if (action !== "search" && (!service || !tool)) {
          return errorResult(`Specify both service and tool for ${action === "describe" ? "describe" : "call"}. Use mcp search to find their names.`);
        }
        const effective = refreshServers();
        if (!effective) return errorResult(CONFIGURATION_LOAD_ERROR);
        const { servers, secrets } = effective;
        const redact = credentialRedactor(secrets);
        const credentials = { secrets, redact };
        const cwd = api.env?.cwd;
        if (effective.configurationError) return errorResult(effective.configurationError, redact);
        const selected = service ? servers.get(service) : undefined;
        if (service && !selected) return errorResult(`Unknown MCP service "${service}". Use mcp search to find available services.`, redact);
        if (service && selected?.disabled) return errorResult(`MCP service "${service}" is disabled. Enable it in Services before retrying.`, redact);

        if (action === "search") {
          const term = query?.trim().toLowerCase() ?? "";
          const matches = (value: string) => value.toLowerCase().includes(term);
          const targets = [...servers].filter(([name, server]) => !server.disabled && (!service || name === service));
          const found = await Promise.all(targets.map(([name, server]) => withService(action, name, server, cwd, context, credentials, (_connection, tools, redact) => {
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

        const result = await withService(action, service!, selected!, cwd, context, credentials, async ({ client }, tools, redact) => {
          const selectedTool = tools.find((item) => item.name === tool);
          if (!selectedTool) return errorResult(`Unknown MCP tool "${tool}" on "${service}". Use mcp search for this service.`, redact);
          if (action === "describe") {
            const { name, description, inputSchema } = redactToolMetadata(selectedTool, redact);
            return modelResult(JSON.stringify({ service, tool: name, description, inputSchema }, null, 2));
          }
          const result = await client.callTool(selectedTool.name, args && fillArgumentRecord(args, fillSecrets), {
            ...(signal ? { signal } : {}), timeoutMs: callTimeoutMs,
          });
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

  return Object.assign(extension, {
    close(): Promise<void> {
      if (!closing) {
        for (const [name, connection] of connections) discard(name, connection);
        closing = Promise.all(pendingCloses.values()).then(() => {});
      }
      return closing;
    },
  });
}
