import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { redactToolErrorSummary, type AgentCommand, type AgentPluginSnapshot, type AgentPluginToolOutput, type NativeMcpControlResult, type NativePluginResources } from "@omarchy-bot/agent-contract";
import {
  HttpsOrigin, PLUGIN_OPERATIONS, PLUGIN_PROVIDERS,
  PluginManageInput, PluginProviderId, McpDefinition, SaveMcpBody,
  type AuthorizePluginBody, type CatalogSkillDetailDto,
  type InstalledSkillDto, type InstallSkillBody, type McpConnectionDto, type PluginAccountDto,
  type PluginProviderDto, type PluginServiceDefinition, type PluginStateDto, type SkillCatalogDto, type SkillCommandDto,
} from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { CatalogClient } from "./catalogClient.ts";
import { Grant, ProviderAccounts } from "./providerAccounts.ts";
import { toolOperation } from "./pluginDispatch.ts";
import { SkillInstalls } from "./skillInstall.ts";
import { ServiceBundles } from "./serviceBundles.ts";
import { NativeSkills } from "./nativeSkills.ts";
import { NativeMcpStore } from "./nativeMcp.ts";
import { McpPackages } from "./mcpPackages.ts";

const DEFAULT_PUBLISHER_ORIGIN = "https://omarchy-bot-site-ymlq.vercel.app";

const Account = z.object({
  id: z.string(), providerId: PluginProviderId, label: z.string(), identity: z.string(), enabledServices: z.array(z.string()),
  status: z.enum(["connected", "reauthorize"]), error: z.string().optional(), grant: Grant.optional(),
  bundleErrors: z.record(z.string()).default({}),
  native: z.object({ serviceId: z.string(), name: z.string() }).optional(), nativeManaged: z.boolean().default(false),
});
type Account = z.infer<typeof Account>;
const Mcp = McpDefinition.extend({
  id: z.string(), generation: z.string(), status: z.enum(["unchecked", "connected", "error"]), toolCount: z.number(), error: z.string().optional(),
});
type Mcp = z.infer<typeof Mcp>;
const Skill = z.object({
  id: z.string(), name: z.string(), description: z.string(), source: z.string(), sourceType: z.enum(["github", "well-known"]), installUrl: z.string(), installs: z.number().optional(),
  enabled: z.boolean(), revision: z.string(), directory: z.string(), installedAt: z.string(), updatedAt: z.string(), lastCheckedAt: z.string().optional(), error: z.string().optional(),
});
type Skill = z.infer<typeof Skill>;
const StoredState = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), cloudUrl: HttpsOrigin.nullable(), accounts: z.array(Account), mcp: z.array(Mcp), skills: z.array(Skill),
});
export interface PluginLease {
  snapshot: AgentPluginSnapshot;
  call(name: string, arguments_: Record<string, unknown>, signal: AbortSignal): Promise<AgentPluginToolOutput>;
  release(): void;
}


export class PluginsService {
  readonly skills: NativeSkills;
  #state: z.infer<typeof StoredState>;
  #file: string;
  readonly accounts: ProviderAccounts;
  readonly skillInstalls: SkillInstalls;
  readonly publisher: CatalogClient;
  #nativeCache: { at: number; resources: NativePluginResources; error?: string } | undefined;
  #nativePending: Promise<NativePluginResources> | undefined;
  readonly bundles: ServiceBundles;
  #timer: ReturnType<typeof setInterval>;
  #reconcileTimer: ReturnType<typeof setInterval>;
  #ready: Promise<void>;
  #stopping = false;
  #defaultError: string | undefined;
  readonly mcp: NativeMcpStore;
  readonly packages: McpPackages;

  constructor(private readonly rootDir: string, private readonly cwd: string, private readonly nativeResources: () => Promise<NativePluginResources>,
    private readonly nativeControl?: (input: Pick<Extract<AgentCommand, { type: "mcp.control" }>, "action" | "server" | "redirectUrl">) => Promise<NativeMcpControlResult>,
    private readonly clientOrigin?: () => string) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(rootDir).isDirectory() || lstatSync(rootDir).isSymbolicLink()) throw new Error("Plugin state directory must be a private real directory");
    chmodSync(rootDir, 0o700);
    this.skills = new NativeSkills(cwd, rootDir);
    this.skillInstalls = new SkillInstalls({
      rootDir, skills: this.skills,
      stopping: () => this.#stopping,
      detail: (id) => this.detail(id),
      persist: (changed) => this.#persist(changed ?? false),
      clearNative: () => { this.#nativeCache = undefined; },
      legacyDirectories: () => this.#state.skills.map((skill) => skill.directory),
      accounts: () => this.#state.accounts,
      updateService: (id, serviceId) => this.updateService(id, serviceId),
    });
    this.publisher = new CatalogClient(() => this.#cloudUrl());
    this.mcp = new NativeMcpStore(cwd, rootDir);
    this.packages = new McpPackages(this.mcp);
    try { this.skills.provisionDefault(path.resolve(import.meta.dir, "../../../../../workers/pi/resources")); }
    catch (error) { this.#defaultError = `Default Skill Creator needs attention: ${error instanceof Error ? error.message : String(error)}`; }
    this.#file = path.join(rootDir, "configuration.json");
    if (existsSync(this.#file)) {
      if (!lstatSync(this.#file).isFile() || lstatSync(this.#file).isSymbolicLink()) throw new Error("Plugin configuration must be a private regular file");
      chmodSync(this.#file, 0o600);
      this.#state = StoredState.parse(JSON.parse(readFileSync(this.#file, "utf8")));
    } else {
      this.#state = { version: 1, revision: 0, cloudUrl: null, accounts: [], mcp: [], skills: [] };
    }
    const unmigrated: Skill[] = [];
    for (const skill of this.#state.skills) {
      try {
        if (!this.skills.list().some((entry) => entry.id === skill.id)) {
          this.skills.install(this.#skillDto(skill), skill, { enabled: skill.enabled, installedAt: skill.installedAt, baselineVerified: false });
        }
      } catch (error) {
        unmigrated.push({ ...skill, error: `Native migration needs attention: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (this.#state.skills.length) {
      this.#state.skills = unmigrated;
      this.#persist(true);
    }
    const unmigratedMcp: Mcp[] = [];
    for (const connection of this.#state.mcp) {
      try { this.mcp.save(null, { name: connection.name, enabled: connection.enabled, transport: connection.transport }); }
      catch (error) { unmigratedMcp.push({ ...connection, error: `Native migration needs attention: ${error instanceof Error ? error.message : String(error)}` }); }
    }
    if (this.#state.mcp.length) { this.#state.mcp = unmigratedMcp; this.#persist(true); }
    this.#timer = setInterval(() => {
      if (this.skills.list().some((skill) => skill.enabled && skill.sourceType !== "local")) void this.updateSkills().catch(() => undefined);
      void this.packages.updateAll().catch(() => undefined);
    }, 6 * 60 * 60 * 1000);
    this.#timer.unref();
    this.#reconcileTimer = setInterval(() => {
      try { this.skills.list(); this.packages.collect(); } catch (error) { this.#defaultError = error instanceof Error ? error.message : String(error); }
    }, 2000);
    this.#reconcileTimer.unref();
    this.bundles = new ServiceBundles({
      rootDir: this.rootDir, mcp: this.mcp, skills: this.skills,
      accounts: () => this.#state.accounts,
      stopping: () => this.#stopping,
      ready: () => this.#ready,
      token: (providerId, grant) => this.accounts.token(providerId, grant),
      persist: (changed) => this.#persist(changed ?? false),
      clearNative: () => { this.#nativeCache = undefined; },
      removeUnused: (directory) => this.#removeUnusedSkill(directory),
      accountDto: (account) => this.#accountDto(account as Account),
    });
    this.accounts = new ProviderAccounts({
      cwd: this.cwd, mcp: this.mcp, publisher: this.publisher,
      accounts: () => this.#state.accounts,
      cloudUrl: () => this.#cloudUrl(),
      ready: () => this.#ready,
      persist: (changed) => this.#persist(changed ?? false),
      provision: (account, service, enabled) => this.bundles.provision(account, service, enabled),
      serviceName: (account, serviceId) => this.bundles.serviceName(account, serviceId),
      change: (account, serviceId) => this.bundles.change(account, serviceId),
      release: (providerId, serviceId) => this.bundles.release(providerId, serviceId),
      authorizeMcp: (id) => this.authorizeMcp(id),
      checkMcp: (id) => this.checkMcp(id),
    });
    this.#ready = this.#initializeServices();
  }

  #persist(configurationChanged = false): void {
    if (configurationChanged) this.#state.revision++;
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.#state), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.#file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }


  #cloudUrl(): string {
    return this.#state.cloudUrl ?? DEFAULT_PUBLISHER_ORIGIN;
  }

  configure(cloudUrl: string | null): void {
    if (cloudUrl !== null) {
      try { cloudUrl = HttpsOrigin.parse(cloudUrl); }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Publisher URL must be an HTTPS origin"); }
    }
    this.#state.cloudUrl = cloudUrl;
    this.publisher.clear();
    this.#persist(true);
  }

  async #native(): Promise<NativePluginResources> {
    this.#nativePending ??= this.nativeResources().then((resources) => {
      this.#nativeCache = { at: Date.now(), resources };
      return resources;
    }).catch((error: unknown) => {
      this.#nativeCache = { at: Date.now(), resources: { skills: [] }, error: redactToolErrorSummary(error instanceof Error ? error.message : error) };
      return this.#nativeCache.resources;
    }).finally(() => { this.#nativePending = undefined; });
    return this.#nativePending;
  }

  #accountDto(account: Account): PluginAccountDto {
    const { grant, native, nativeManaged: _nativeManaged, bundleErrors, error: _error, ...visible } = account;
    const connections = this.mcp.serviceConnections(account.id);
    const skills = this.skills.list();
    const components = PLUGIN_PROVIDERS[account.providerId].services.map((service) => {
      const connection = connections.find((item) => item.name === this.bundles.serviceName(account, service.id));
      const ownedSkills = skills.filter((skill) => skill.serviceId === `${account.providerId}/${service.id}`);
      const missing = account.enabledServices.includes(service.id) && (service.skillSources?.length ?? 0) !== ownedSkills.filter((skill) => skill.enabled).length;
      const endpointChanged = connection?.transport.type === "http" && connection.transport.url !== service.mcpUrl;
      return { serviceId: service.id, ...(connection ? { mcpId: connection.id } : {}),
        status: endpointChanged ? "conflict" as const : connection?.status ?? "not-connected" as const,
        toolCount: connection?.toolCount ?? 0,
        ...(endpointChanged ? { error: "The native Service endpoint was modified; its official account binding needs attention" }
          : bundleErrors[service.id] ? { error: bundleErrors[service.id] }
          : missing ? { error: "Official companion Skills are missing, disabled, or invalid" }
          : connection?.error ? { error: connection.error } : {}) };
    });
    if (native && account.status !== "connected" && components.some((component) => component.serviceId === native.serviceId && component.status === "connected")) {
      account.status = "connected";
      delete account.error;
      this.#persist();
    }
    const nativeConnectionId = native ? connections.find((connection) => connection.name === native.name)?.id : undefined;
    return { ...visible, status: account.status, grantedScopes: [...(grant?.scopes ?? [])], components,
      identityVerified: native === undefined, ...(nativeConnectionId ? { nativeConnectionId } : {}),
      ...(account.error === undefined ? {} : { error: account.error }) };
  }
  #mcpDto(connection: Mcp): McpConnectionDto {
    const { id, name, enabled, status, toolCount, error, transport } = connection;
    return { id, name, enabled, status, toolCount, ...(error ? { error } : {}), transport: transport.type === "stdio"
      ? { type: "stdio", command: transport.command, args: transport.args, envKeys: Object.keys(transport.env ?? {}) }
      : { type: "http", url: transport.url, headerKeys: Object.keys(transport.headers ?? {}) } };
  }
  #skillDto(skill: Skill): InstalledSkillDto {
    const { directory: _directory, error, installs, lastCheckedAt, ...visible } = skill;
    return { ...visible, ...(error === undefined ? {} : { error }), ...(installs === undefined ? {} : { installs }), ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }) };
  }

  async state(): Promise<PluginStateDto> {
    await this.#ready;
    const [cloud, native] = await Promise.all([this.publisher.providers(), this.#native()]);
    this.mcp.updateStatus(native.mcp ?? []);
    const mcp = this.packages.list();
    const skills = this.skills.list();
    const nativeError = [this.#defaultError, this.#nativeCache?.error, ...this.mcp.errors, ...this.skills.errors, ...this.packages.errors].filter(Boolean).join("\n");
    const workspaceSkills = new Set(skills.map((skill) => skill.path));
    return { revision: this.#state.revision, cloudUrl: this.#cloudUrl(), providers: cloud.providers,
      accounts: this.#state.accounts.map((account) => this.#accountDto(account)), mcp: [...mcp, ...this.#state.mcp.map((connection) => ({ ...this.#mcpDto(connection), enabled: false, readOnly: true }))],
      skills: [...skills, ...this.#state.skills.map((skill) => ({ ...this.#skillDto(skill), enabled: false, readOnly: true }))],
      nativeSkills: native.skills.filter((skill) => !workspaceSkills.has(skill.path)).map((skill) => ({ ...skill, agentId: "pi", readOnly: true })),
      ...(cloud.error ? { cloudError: cloud.error } : {}), ...(nativeError ? { nativeError } : {}) };
  }

  async saveMcp(id: string | null, input: z.input<typeof SaveMcpBody>, signal?: AbortSignal): Promise<McpConnectionDto> {
    const result = await this.packages.save(id, input, signal);
    this.#persist(true);
    return result;
  }

  async updateMcp(id: string, signal?: AbortSignal): Promise<McpConnectionDto> {
    const result = await this.packages.update(id, signal);
    this.#persist(true);
    return result;
  }

  enableMcp(id: string, enabled: boolean): void {
    this.mcp.enable(id, enabled);
    this.#persist(true);
  }
  removeMcp(id: string): void {
    this.packages.remove(id);
    this.#persist(true);
  }


  async checkMcp(id: string): Promise<McpConnectionDto> {
    if (!this.nativeControl) throw new HttpError(503, "The native Pi MCP runtime is unavailable");
    const name = this.mcp.name(id);
    const result = await this.nativeControl({ action: "connect", server: name });
    this.mcp.updateStatus(result.servers);
    const entry = this.packages.list().find((item) => item.id === id) ?? this.mcp.list(true).find((item) => item.id === id)!;
    return result.result?.error ? { ...entry, status: result.result.error === "auth_required" ? "needs-auth" : "error", error: String(result.result.error) } : entry;
  }

  async authorizeMcp(id: string, redirectUrl?: string): Promise<{ authorizationUrl?: string; authenticated?: boolean; error?: string }> {
    if (!this.nativeControl) throw new HttpError(503, "The native Pi MCP runtime is unavailable");
    const name = this.mcp.name(id);
    const response = await this.nativeControl({ action: redirectUrl === undefined ? "auth-start" : "auth-complete", server: name, ...(redirectUrl === undefined ? {} : { redirectUrl }) });
    this.mcp.updateStatus(response.servers);
    return {
      ...(typeof response.result?.authorizationUrl === "string" ? { authorizationUrl: response.result.authorizationUrl } : {}),
      ...(typeof response.result?.authenticated === "boolean" ? { authenticated: response.result.authenticated } : {}),
      ...(typeof response.result?.error === "string" ? { error: response.result.error } : {}),
    };
  }

  catalog(query = "", cursor?: string, view = "trending"): Promise<SkillCatalogDto> {
    return this.publisher.catalog(query, cursor, view);
  }

  detail(id: string): Promise<CatalogSkillDetailDto> {
    return this.publisher.detail(id);
  }

  installSkill(input: string | InstallSkillBody): Promise<InstalledSkillDto> {
    return this.skillInstalls.install(input);
  }
  updateSkills(): Promise<void> {
    return this.skillInstalls.update();
  }
  enableSkill(id: string, enabled: boolean): void {
    this.skillInstalls.enable(id, enabled);
  }
  removeSkill(id: string): void {
    this.skillInstalls.remove(id);
  }
  async #removeUnusedSkill(directory: string): Promise<void> {
    await this.skillInstalls.removeUnused(directory);
  }

  async commands(): Promise<SkillCommandDto[]> {
    const native = await this.#native();
    const shared = this.skills.list();
    const sharedPaths = new Set(shared.map((skill) => skill.path));
    const candidates = [
      ...shared.filter((skill) => skill.enabled).map((skill): SkillCommandDto => ({ name: skill.name, description: skill.description, command: `/skill:${skill.name}`, source: "native" })),
      ...native.skills.filter((skill) => !sharedPaths.has(skill.path)).map((skill): SkillCommandDto => ({ name: skill.name, description: skill.description, command: `/skill:${skill.name}`, source: "native" })),
    ];
    return candidates.filter((skill, index) => candidates.findIndex((other) => other.command === skill.command) === index);
  }


  async #initializeServices(): Promise<void> {
    for (const account of this.#state.accounts) {
      if (account.nativeManaged) continue;
      if (!PLUGIN_PROVIDERS[account.providerId].publisherOAuth && account.grant) {
        account.status = "reauthorize";
        account.error = "The previous API grant is not an official MCP grant. Add a native Service account; the old account identity was retained.";
        account.enabledServices = [];
        account.nativeManaged = true;
        this.#persist();
        continue;
      }
      try {
        for (const service of PLUGIN_PROVIDERS[account.providerId].services) {
          if (account.enabledServices.includes(service.id)) await this.bundles.provision(account, service, true);
        }
        account.nativeManaged = true;
        this.#persist();
      } catch (error) { account.error = redactToolErrorSummary(error instanceof Error ? error.message : error); this.#persist(); }
    }
  }

  async #prepareServiceCredentials(): Promise<void> {
    await this.#ready;
    for (const account of this.#state.accounts) {
      if (!account.grant || account.status !== "connected") continue;
      try {
        const token = await this.accounts.token(account.providerId, account.grant);
        for (const service of PLUGIN_PROVIDERS[account.providerId].services) {
          if (account.enabledServices.includes(service.id) && service.mcpUrl && this.mcp.serviceConnections(account.id).some((entry) => entry.name === this.bundles.serviceName(account, service.id))) {
            this.mcp.setServiceToken(this.bundles.serviceName(account, service.id), service.mcpUrl, token);
          }
        }
      } catch (error) { account.error = redactToolErrorSummary(error instanceof Error ? error.message : error); this.#persist(); }
    }
  }

  async authorize(body: AuthorizePluginBody): Promise<{ url: string }> {
    return this.accounts.authorize(body);
  }

  async finishAuthorization(url: URL): Promise<{ returnUrl: string; label: string }> {
    return this.accounts.finishAuthorization(url);
  }

  labelAccount(id: string, label: string): void {
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    account.label = label;
    this.#persist(true);
  }
  enableService(id: string, serviceId: string, enabled: boolean): Promise<PluginAccountDto> {
    return this.bundles.enable(id, serviceId, enabled);
  }
  removeService(id: string, serviceId: string): Promise<void> {
    return this.bundles.remove(id, serviceId);
  }
  updateService(id: string, serviceId: string): Promise<void> {
    return this.bundles.update(id, serviceId);
  }
  disconnectAccount(id: string): void {
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    for (const connection of this.mcp.serviceConnections(id)) this.mcp.remove(connection.id, true);
    this.#state.accounts = this.#state.accounts.filter((entry) => entry.id !== id);
    this.bundles.forget(id);
    for (const service of PLUGIN_PROVIDERS[account.providerId].services) this.bundles.release(account.providerId, service.id);
    this.#persist(true);
  }

  async #toolOutput(result: AgentPluginToolOutput): Promise<AgentPluginToolOutput> {
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) {
      const directory = path.join(this.rootDir, "results");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${randomUUID()}.json`);
      await writeFile(file, encoded, { mode: 0o600, flag: "wx" });
      return { content: [{ type: "text", text: `Full plugin output saved to ${file}; ${Buffer.byteLength(encoded)} bytes. Read this file for the complete result.` }], ...(result.isError ? { isError: true } : {}) };
    }
    return { content: result.content.map((part) => part.type === "text" ? { type: "text", text: part.text }
      : part.type === "image" ? { type: "image", data: part.data, mimeType: part.mimeType }
      : { type: "text", text: JSON.stringify(part) }), ...(result.isError ? { isError: true } : {}),
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) };
  }

  async acquire(): Promise<PluginLease> {
    if (this.#stopping) throw new Error("Plugin runtime is stopping");
    await this.#prepareServiceCredentials();
    this.mcp.reconcile();
    const snapshot: AgentPluginSnapshot = {
      revision: this.#state.revision,
      diagnostics: [...this.mcp.errors, ...this.skills.list().filter((skill) => skill.error).map((skill) => `${skill.name}: ${skill.error}`),
        ...this.#state.accounts.map((account) => `Service account ${account.id}: ${account.label}; ${account.identity}. Native MCP server names are ${account.enabledServices.map((serviceId) => this.bundles.serviceName(account, serviceId)).join(", ") || "none enabled"}.${account.error ? ` Needs attention: ${account.error}` : ""}`)],
      tools: [{
        name: "manage_plugins",
        description: "Inspect shared Services, native MCP connections and Skills. inspect reads installed inventory; inspect_skill reads catalog source and content. Search and install complete independent Skills from the catalog or explicit sources; update Skills, and enable, disable or remove Skills and custom MCPs without a product approval gate. Authorize, enable, disable, remove or update Services; label or disconnect exact account ids. Updates preserve local modifications. Changes affect subsequent native resource reloads; actual reload and native/provider authorization still apply. authorize_service returns a real URL pending user authorization, never completed consent. Never claim an unprobed MCP is connected. Use Pi's native mcp tool for provider business operations, and the default official skill-creator for local authoring.",
        inputSchema: { type: "object", properties: {
          action: { type: "string", enum: PLUGIN_OPERATIONS.flatMap((operation) => "tool" in operation && operation.tool === false ? [] : [operation.action]) },
          id: { type: "string" }, query: { type: "string" }, cursor: { type: "string" }, view: { type: "string" }, source: { type: "string" },
          skillPath: { type: "string" }, ref: { type: "string" }, enabled: { type: "boolean" },
          providerId: { type: "string", enum: PluginProviderId.options }, serviceId: { type: "string" }, label: { type: "string" },
          connection: { type: "object", description: "SaveMcpBody: name, enabled, and either transport {type:stdio,command,args?,env?} / {type:http,url,headers?}, or package {name: exact public npm package,bin?,args?,env?}. Managed npm packages update automatically; arbitrary native commands remain user-owned. Credential fields are write-only." },
          redirectUrl: { type: "string" },
        }, required: ["action"], additionalProperties: false },
      }],
    };
    let released = false;
    return {
      snapshot,
      call: async (name, args, signal) => {
        signal.throwIfAborted();
        if (released) throw new Error("Plugin turn snapshot was released");
        if (name !== "manage_plugins") throw new Error("Plugin management tool does not belong to this turn");
        const input = PluginManageInput.parse(args);
        if (input.action === "authorize_service" && !this.clientOrigin) throw new HttpError(503, "Service authorization requires a configured daemon client origin");
        const row = toolOperation(input.action);
        if (!row) throw new HttpError(404, "Unknown plugin operation");
        const { action, ...fields } = input;
        const result = await row.handler(this, {
          ...fields, ...(input.id === undefined ? {} : { accountId: input.id }),
          ...(action === "authorize_service" && this.clientOrigin ? { returnUrl: this.clientOrigin() } : {}),
          tool: true, signal,
        } as Parameters<typeof row.handler>[1]);
        return this.#toolOutput({ content: [{ type: "text", text: JSON.stringify(result) }] });
      },
      release: () => { released = true; },
    };
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#timer);
    clearInterval(this.#reconcileTimer);
    await this.packages.shutdown();
    await this.#ready;
    this.accounts.clearPending();
    await Promise.allSettled(this.skillInstalls.pending());
    await Promise.allSettled(this.bundles.pending());
  }
}
