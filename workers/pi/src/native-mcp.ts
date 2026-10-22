import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createMcpAdapter, MCP_STATUS_EVENT } from "pi-mcp-adapter";
import { loadMcpConfig } from "pi-mcp-adapter/config";
import type { McpConfig } from "pi-mcp-adapter/types";
import type { AgentCommand, NativeMcpStatus } from "@omarchy-bot/agent-contract";
import { isNativeMcpRuntimeStatus, nativeMcpConfigFile, nativeMcpPrivateDir, parseNativeMcpMetadata, resolveNativeMcpCredentials } from "@omarchy-bot/agent-contract/native-mcp-config";
import { nativeMcpRevision } from "@omarchy-bot/agent-contract/native-mcp-revision";

const inlinePath = "<inline:omarchy-native-mcp>";
const live = new Set<NativeMcp>();

// Identify the package, not tool/extension names: unrelated extensions may also
// register an mcp tool and must retain Pi's normal collision behavior.
function isAdapterPath(file: string): boolean {
  if (file.startsWith("<")) return false;
  let directory: string;
  try { directory = path.dirname(realpathSync(file)); } catch { return false; }
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      return manifest.name === "pi-mcp-adapter";
    } catch { /* Continue to the owning package for nested extension paths. */ }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function settingsWithoutDuplicateAdapter(cwd: string): SettingsManager {
  const original = SettingsManager.create(cwd, getAgentDir());
  const scoped = new Map<string, string>();
  for (const [scope, settings, base] of [
    ["global", original.getGlobalSettings(), getAgentDir()],
    ["project", original.getProjectSettings(), path.join(cwd, ".pi")],
  ] as const) {
    const packages = settings.packages?.map((entry) => {
      const source = typeof entry === "string" ? entry : entry.source;
      const adapter = /^npm:pi-mcp-adapter(?:@|$)/.test(source) || isAdapterPath(path.resolve(base, source, "package.json"));
      return adapter ? { ...(typeof entry === "string" ? { source } : entry), extensions: [] } : entry;
    });
    const extensions = settings.extensions?.filter((file) => !isAdapterPath(path.resolve(base, file)));
    scoped.set(scope, JSON.stringify({ ...settings, ...(packages ? { packages } : {}), ...(extensions ? { extensions } : {}) }));
  }
  // Package resource selection must happen before factories register tools and flags.
  // Keep independent scopes and all other resources; never rewrite user settings.
  return SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(scoped.get(scope));
      if (next !== undefined) scoped.set(scope, next);
    },
  }, { projectTrusted: original.isProjectTrusted() });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface NativeConfig {
  config: McpConfig;
  revision: string;
}

function nativeConfig(cwd: string): NativeConfig {
  const file = nativeMcpConfigFile(nativeMcpPrivateDir());
  try {
    const revision = nativeMcpRevision(cwd, file);
    const config = loadMcpConfig(undefined, cwd);
    if (existsSync(file)) resolveNativeMcpCredentials(config, parseNativeMcpMetadata(JSON.parse(readFileSync(file, "utf8"))));
    if (nativeMcpRevision(cwd, file) !== revision) throw new Error("Native MCP configuration changed while loading");
    return { config, revision };
  } catch {
    throw new Error("Native MCP configuration could not be loaded consistently");
  }
}

export class NativeMcp {
  readonly loader: DefaultResourceLoader;
  readonly config: McpConfig;
  readonly configurationRevision: string;
  readonly cwd: string;
  private servers: NativeMcpStatus[] = [];
  private readonly unsubscribe: () => void;

  constructor(cwd: string, appendSystemPrompt?: string[], bundle = nativeConfig(cwd)) {
    this.cwd = path.resolve(cwd);
    this.config = bundle.config;
    this.configurationRevision = bundle.revision;
    const factory = createMcpAdapter({ config: this.config });
    const eventBus = createEventBus();
    this.unsubscribe = eventBus.on(MCP_STATUS_EVENT, (payload) => {
      if (!record(payload) || payload.version !== 1 || !Array.isArray(payload.servers)) return;
      const next: NativeMcpStatus[] = [];
      for (const server of payload.servers) {
        if (!record(server) || typeof server.name !== "string" || typeof server.status !== "string"
          || !isNativeMcpRuntimeStatus(server.status) || typeof server.disabled !== "boolean"
          || typeof server.toolCount !== "number" || !Number.isSafeInteger(server.toolCount) || server.toolCount < 0) return;
        next.push({ name: server.name, configurationRevision: this.configurationRevision, status: server.status as NativeMcpStatus["status"], toolCount: server.toolCount, disabled: server.disabled });
      }
      this.servers = next;
    });
    this.loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager: settingsWithoutDuplicateAdapter(this.cwd),
      eventBus,
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      extensionFactories: [{ name: "omarchy-native-mcp", factory }],
    });
  }

  async load(): Promise<void> {
    await this.loader.reload();
    if (this.loader.getExtensions().errors.some((error) => error.path === inlinePath)) {
      // Extension errors may embed configuration or credentials.
      throw new Error("Native MCP adapter failed to load");
    }
  }

  async bind(session: AgentSession): Promise<void> {
    await session.bindExtensions({ mode: "json" });
    live.add(this);
  }

  async dispose(session?: AgentSession): Promise<void> {
    try {
      if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      try { session?.dispose(); } finally {
        this.unsubscribe();
        live.delete(this);
        this.servers = [];
      }
    }
  }

  snapshot(): NativeMcpStatus[] { return this.servers.map((server) => ({ ...server })); }
}

export function nativeMcpStatus(cwd: string): NativeMcpStatus[] {
  const key = path.resolve(cwd);
  const servers: NativeMcpStatus[] = [];
  for (const owner of live) {
    if (owner.cwd === key) servers.push(...owner.snapshot());
  }
  return servers;
}

type ControlCommand = Extract<AgentCommand, { type: "mcp.control" }>;
interface ControlSession {
  session: AgentSession;
  native: NativeMcp;
  pendingAuth: Set<string>;
  unsubscribe: () => void;
}

// Only structured, known error codes cross this boundary. Native exception text
// can contain URLs, headers, or subprocess output with credentials.
const safeErrors: Record<string, true> = { auth_required: true, connect_failed: true, aborted: true, not_found: true, server_disabled: true, auth_failed: true, invalid_args: true, invalid_input: true, no_pending_auth: true, oauth_not_supported: true, auth_start_failed: true, auth_complete_failed: true, not_authenticated: true };
function controlDetails(value: unknown): Record<string, unknown> {
  if (!record(value)) return { error: "invalid_adapter_result" };
  const result: Record<string, unknown> = {};
  if (typeof value.authenticated === "boolean") result.authenticated = value.authenticated;
  if (typeof value.authorizationUrl === "string") {
    try {
      const url = new URL(value.authorizationUrl);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.hash
        && ![...url.searchParams.keys()].some((key) => /^(access_token|refresh_token|id_token|client_secret|token)$/i.test(key))) {
        result.authorizationUrl = value.authorizationUrl;
      } else result.error = "invalid_authorization_url";
    } catch { result.error = "invalid_authorization_url"; }
  }
  if (value.error !== undefined) result.error = typeof value.error === "string" && Object.hasOwn(safeErrors, value.error) ? value.error : "native_mcp_failed";
  return result;
}

export class NativeMcpControls {
  private readonly sessions = new Map<string, ControlSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  private readonly reconciliationTimer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly modelRuntime: () => Promise<ModelRuntime>) {
    this.reconciliationTimer = setInterval(() => {
      if (this.closed) return;
      for (const cwd of this.sessions.keys()) {
        if (!this.queues.has(cwd)) void this.execute({ type: "mcp.control", requestId: crypto.randomUUID(), cwd, action: "status" });
      }
    }, 2_000);
    this.reconciliationTimer.unref();
  }

  async execute(cmd: ControlCommand): Promise<{ servers: NativeMcpStatus[]; result?: Record<string, unknown> }> {
    const cwd = path.resolve(cmd.cwd);
    const operation = (this.queues.get(cwd) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.closed) throw new Error("Native MCP controls are closed");
      let entry = this.sessions.get(cwd);
      if (cmd.action === "status" && (!entry || entry.pendingAuth.size > 0)) return { servers: nativeMcpStatus(cwd) };
      if (cmd.action === "auth-complete" && !entry) return { servers: nativeMcpStatus(cwd), result: { error: "no_pending_auth" } };
      let bundle: NativeConfig;
      try {
        bundle = cmd.action === "auth-complete" && entry
          ? { config: entry.native.config, revision: entry.native.configurationRevision }
          : nativeConfig(cwd);
      } catch {
        if (entry && entry.pendingAuth.size === 0) {
          this.sessions.delete(cwd);
          entry.unsubscribe();
          await entry.native.dispose(entry.session);
        }
        throw new Error("Native MCP configuration could not be loaded consistently");
      }
      if (entry && cmd.action !== "auth-complete"
        && (entry.native.configurationRevision !== bundle.revision || !isDeepStrictEqual(entry.native.config, bundle.config))) {
        if (entry.pendingAuth.size > 0) return { servers: nativeMcpStatus(cwd), result: { error: "configuration_changed_pending_auth" } };
        this.sessions.delete(cwd);
        entry.unsubscribe();
        await entry.native.dispose(entry.session);
        entry = undefined;
      }
      if (cmd.action === "status") return { servers: nativeMcpStatus(cwd) };
      if (!cmd.server) return { servers: nativeMcpStatus(cwd), result: { error: "server_required" } };
      if (!entry) {
        const native = new NativeMcp(cwd, undefined, bundle);
        let session: AgentSession | undefined;
        try {
          await native.load();
          ({ session } = await createAgentSession({ cwd, agentDir: getAgentDir(), resourceLoader: native.loader,
            sessionManager: SessionManager.inMemory(cwd), modelRuntime: await this.modelRuntime() }));
          await native.bind(session);
          const pendingAuth = new Set<string>();
          const unsubscribe = session.subscribe((event) => {
            if (event.type !== "message_end" || event.message.role !== "custom"
              || event.message.customType !== "mcp-oauth-status" || !record(event.message.details)) return;
            const details = event.message.details;
            if (typeof details.server === "string" && (details.status === "authenticated" || details.status === "failed")) {
              pendingAuth.delete(details.server);
            }
          });
          entry = { session, native, pendingAuth, unsubscribe };
          this.sessions.set(cwd, entry);
        } catch {
          await native.dispose(session);
          throw new Error("Native MCP control session failed to initialize");
        }
      }
      const tool = entry.session.getToolDefinition("mcp");
      const adapterTool = entry.native.loader.getExtensions().extensions.find((extension) => extension.path === inlinePath)?.tools.get("mcp")?.definition;
      if (!tool || tool !== adapterTool) throw new Error("Native MCP gateway unavailable or shadowed by another native extension");
      const params = cmd.action === "connect" ? { connect: cmd.server }
        : cmd.action === "auth-start" ? { action: "auth-start", server: cmd.server }
        : { action: "auth-complete", server: cmd.server, args: { redirectUrl: cmd.redirectUrl } };
      if (cmd.action === "auth-start") entry.pendingAuth.add(cmd.server);
      try {
        const output = await tool.execute(`mcp-control-${crypto.randomUUID()}`, params, this.abort.signal, undefined, entry.session.extensionRunner.createContext());
        const result = controlDetails(output.details);
        if (cmd.action === "auth-start" && typeof result.authorizationUrl !== "string") entry.pendingAuth.delete(cmd.server);
        if (result.authenticated === true) entry.pendingAuth.delete(cmd.server);
        return { servers: nativeMcpStatus(cwd), result };
      } catch {
        if (cmd.action === "auth-start") entry.pendingAuth.delete(cmd.server);
        throw new Error("Native MCP control operation failed");
      }
    });
    this.queues.set(cwd, operation);
    try { return await operation; } catch {
      return { servers: nativeMcpStatus(cwd), result: { error: "native_mcp_failed" } };
    } finally { if (this.queues.get(cwd) === operation) this.queues.delete(cwd); }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    clearInterval(this.reconciliationTimer);
    this.abort.abort();
    await Promise.allSettled(this.queues.values());
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(entries.map((entry) => {
      entry.unsubscribe();
      return entry.native.dispose(entry.session);
    }));
  }
}
