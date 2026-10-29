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
import { isNativeMcpRuntimeStatus, nativeMcpConfigFile, nativeMcpPrivateDir, readNativeMcpMetadata, resolveNativeMcpCredentials } from "@omarchy-bot/agent-contract/native-mcp-config";
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
    if (existsSync(file)) resolveNativeMcpCredentials(config, readNativeMcpMetadata(JSON.parse(readFileSync(file, "utf8"))));
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
  pendingAuth: Map<string, { id: string; expiresAt: number }>;
  completedAuth: Set<string>;
  unsubscribe: () => void;
  cwd: string;
  server: string | undefined;
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

  constructor(private readonly modelRuntime: () => Promise<ModelRuntime>,
    private readonly onAuthorization: (server: string, authorizationId: string, status: "completed" | "failed", reason?: string) => void = () => {}) {
    this.reconciliationTimer = setInterval(() => {
      if (this.closed) return;
      for (const [key, entry] of this.sessions) {
        for (const [server, pending] of entry.pendingAuth) if (pending.expiresAt <= Date.now()) {
          this.cancel(key, pending.id);
          this.onAuthorization(server, pending.id, "failed", "expired");
        }
        if (!this.queues.has(key)) void this.execute({ type: "mcp.control", requestId: crypto.randomUUID(), cwd: entry.cwd, action: "status", ...(entry.server ? { server: entry.server } : {}) });
      }
    }, 2_000);
    this.reconciliationTimer.unref();
  }

  private cancel(key: string, authorizationId?: string): void {
    const entry = this.sessions.get(key);
    if (!entry || (authorizationId && ![...entry.pendingAuth.values()].some(pending => pending.id === authorizationId))) return;
    this.sessions.delete(key);
    entry.pendingAuth.clear();
    entry.unsubscribe();
    // Session shutdown aborts the adapter OAuth runtime before awaiting cleanup.
    void entry.native.dispose(entry.session).catch(() => undefined);
  }

  async execute(cmd: ControlCommand): Promise<{ servers: NativeMcpStatus[]; result?: Record<string, unknown> }> {
    const cwd = path.resolve(cmd.cwd);
    const key = cmd.server ? `${cwd}\0${cmd.server}` : cwd;
    if (cmd.action === "auth-cancel") {
      this.cancel(key, cmd.authorizationId);
      return { servers: nativeMcpStatus(cwd) };
    }
    const operation = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.closed) throw new Error("Native MCP controls are closed");
      let entry = this.sessions.get(key);
      if (cmd.action === "auth-start" && entry) {
        this.cancel(key);
        entry = undefined;
      }
      if (cmd.action === "status" && (!entry || entry.pendingAuth.size > 0)) return { servers: nativeMcpStatus(cwd) };
      if (cmd.action === "auth-complete" && !entry) return { servers: nativeMcpStatus(cwd), result: { error: "no_pending_auth" } };
      let bundle: NativeConfig;
      try {
        bundle = cmd.action === "auth-complete" && entry
          ? { config: entry.native.config, revision: entry.native.configurationRevision }
          : nativeConfig(cwd);
        if (cmd.server) bundle = { ...bundle, config: { ...bundle.config,
          mcpServers: Object.fromEntries(Object.entries(bundle.config.mcpServers).filter(([name]) => name === cmd.server)),
          ...(bundle.config.claudePlugins ? { claudePlugins: bundle.config.claudePlugins.map(plugin => ({ ...plugin, mcp: false })) } : {}) } };
      } catch {
        if (entry && entry.pendingAuth.size === 0) {
          this.sessions.delete(key);
          entry.unsubscribe();
          await entry.native.dispose(entry.session);
        }
        throw new Error("Native MCP configuration could not be loaded consistently");
      }
      if (entry && cmd.action !== "auth-complete"
        && (entry.native.configurationRevision !== bundle.revision || !isDeepStrictEqual(entry.native.config, bundle.config))) {
        if (entry.pendingAuth.size > 0) return { servers: nativeMcpStatus(cwd), result: { error: "configuration_changed_pending_auth" } };
        this.sessions.delete(key);
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
          const pendingAuth: ControlSession["pendingAuth"] = new Map();
          const completedAuth = new Set<string>();
          const unsubscribe = session.subscribe((event) => {
            if (event.type !== "message_end" || event.message.role !== "custom"
              || event.message.customType !== "mcp-oauth-status" || !record(event.message.details)) return;
            const details = event.message.details;
            if (typeof details.server === "string" && (details.status === "authenticated" || details.status === "failed")) {
              const pending = pendingAuth.get(details.server);
              if (!pending) return;
              if (pending.expiresAt <= Date.now()) {
                this.cancel(key, pending.id);
                this.onAuthorization(details.server, pending.id, "failed", "expired");
                return;
              }
              if (details.status === "authenticated") completedAuth.add(pending.id);
              pendingAuth.delete(details.server);
              this.onAuthorization(details.server, pending.id, details.status === "authenticated" ? "completed" : "failed", details.status === "failed" ? details.reason === "expired" ? "expired" : "auth_failed" : undefined);
            }
          });
          entry = { session, native, pendingAuth, completedAuth, unsubscribe, cwd, server: cmd.server };
          this.sessions.set(key, entry);
        } catch {
          await native.dispose(session);
          throw new Error("Native MCP control session failed to initialize");
        }
      }
      if ((cmd.action === "auth-start" || cmd.action === "auth-complete") && cmd.expiresAt !== undefined && cmd.expiresAt <= Date.now()) {
        this.cancel(key);
        return { servers: nativeMcpStatus(cwd), result: { error: "expired" } };
      }
      if (cmd.action === "auth-complete" && cmd.authorizationId && entry.completedAuth.has(cmd.authorizationId)) return { servers: nativeMcpStatus(cwd), result: { authenticated: true } };
      if (cmd.action === "auth-complete" && (!cmd.authorizationId || entry.pendingAuth.get(cmd.server!)?.id !== cmd.authorizationId)) return { servers: nativeMcpStatus(cwd), result: { error: "no_pending_auth" } };
      const tool = entry.session.getToolDefinition("mcp");
      const adapterTool = entry.native.loader.getExtensions().extensions.find((extension) => extension.path === inlinePath)?.tools.get("mcp")?.definition;
      if (!tool || tool !== adapterTool) throw new Error("Native MCP gateway unavailable or shadowed by another native extension");
      const params = cmd.action === "connect" ? { connect: cmd.server }
        : cmd.action === "auth-start" ? { action: "auth-start", server: cmd.server }
        : { action: "auth-complete", server: cmd.server, args: { redirectUrl: cmd.redirectUrl } };
      if (cmd.action === "auth-start") entry.pendingAuth.set(cmd.server, { id: cmd.authorizationId ?? cmd.requestId, expiresAt: cmd.expiresAt ?? Date.now() + 15 * 60_000 });
      try {
        const output = await tool.execute(`mcp-control-${crypto.randomUUID()}`, params, this.abort.signal, undefined, entry.session.extensionRunner.createContext());
        const result = controlDetails(output.details);
        if (result.error !== undefined) {
          if (cmd.action === "auth-start" || cmd.action === "auth-complete") this.cancel(key);
        }
        if (result.authenticated === true) {
          const pending = entry.pendingAuth.get(cmd.server);
          if (pending) entry.completedAuth.add(pending.id);
          entry.pendingAuth.delete(cmd.server);
        }
        return { servers: nativeMcpStatus(cwd), result };
      } catch {
        if (cmd.action === "auth-start" || cmd.action === "auth-complete") this.cancel(key);
        throw new Error("Native MCP control operation failed");
      }
    });
    this.queues.set(key, operation);
    try { return await operation; } catch {
      return { servers: nativeMcpStatus(cwd), result: { error: "native_mcp_failed" } };
    } finally { if (this.queues.get(key) === operation) this.queues.delete(key); }
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
