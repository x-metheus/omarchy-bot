import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { redactToolErrorSummary, type AgentCommand, type AgentPluginSnapshot, type AgentPluginToolOutput, type NativeMcpControlResult, type NativePluginResources } from "@omarchy-bot/agent-contract";
import {
  HttpsOrigin, OAuthStartResponse, PLUGIN_OPERATIONS, PLUGIN_PROVIDERS,
  PluginManageInput, PluginProviderId, PublisherTokenResponse, McpDefinition, SaveMcpBody,
  TOKEN_METADATA_KEYS, type AuthorizePluginBody, type CatalogSkillDetailDto,
  type InstalledSkillDto, type InstallSkillBody, type McpConnectionDto, type PluginAccountDto,
  type PluginProviderDto, type PluginServiceDefinition, type PluginStateDto, type SkillCatalogDto, type SkillCommandDto,
} from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { CatalogClient } from "./catalogClient.ts";
import { hasScopes, identifyAccount } from "./providerAccounts.ts";
import { toolOperation } from "./pluginDispatch.ts";
import { SkillInstalls } from "./skillInstall.ts";
import { materializeSkill, materializeSkillSource } from "./skillInstaller.ts";
import { NativeSkills } from "./nativeSkills.ts";
import { NativeMcpStore } from "./nativeMcp.ts";
import { McpPackages } from "./mcpPackages.ts";

const DEFAULT_PUBLISHER_ORIGIN = "https://omarchy-bot-site-ymlq.vercel.app";

const Grant = z.object({
  generation: z.string(), accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number().optional(),
  scopes: z.array(z.string()), cloudUrl: HttpsOrigin, metadata: z.record(z.unknown()).default({}),
});
type Grant = z.infer<typeof Grant>;
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
interface OAuthPending {
  providerId: PluginProviderId; accountId?: string; verifier: string; cloudUrl: string; returnUrl: string; expiresAt: number;
  brokerState: string;
}
export interface PluginLease {
  snapshot: AgentPluginSnapshot;
  call(name: string, arguments_: Record<string, unknown>, signal: AbortSignal): Promise<AgentPluginToolOutput>;
  release(): void;
}


export class PluginsService {
  readonly skills: NativeSkills;
  #state: z.infer<typeof StoredState>;
  #file: string;
  #refreshing = new Map<Grant, Promise<string>>();
  #oauth = new Map<string, OAuthPending>();
  readonly skillInstalls: SkillInstalls;
  readonly publisher: CatalogClient;
  #nativeCache: { at: number; resources: NativePluginResources; error?: string } | undefined;
  #nativePending: Promise<NativePluginResources> | undefined;
  #serviceUpdates = new Map<string, Promise<void>>();
  #serviceEpochs = new Map<string, number>();
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
      const connection = connections.find((item) => item.name === this.#serviceName(account, service.id));
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

  #serviceName(account: Account, serviceId: string): string { return `service-${account.id}-${serviceId}`; }

  #serviceEpoch(account: Account, serviceId: string): number {
    return this.#serviceEpochs.get(`${account.id}/${serviceId}`) ?? 0;
  }

  #changeService(account: Account, serviceId: string): number {
    const epoch = this.#serviceEpoch(account, serviceId) + 1;
    this.#serviceEpochs.set(`${account.id}/${serviceId}`, epoch);
    return epoch;
  }

  async #ensureBundle(account: Account, service: PluginServiceDefinition, update = false): Promise<void> {
    const epoch = this.#serviceEpoch(account, service.id);
    const sourceIds = (service.skillSources ?? []).map((source) => ({
      source, id: `service:${account.providerId}:${service.id}:${createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
    }));
    const before = new Map(this.skills.list().filter((skill) => skill.serviceId === `${account.providerId}/${service.id}`).map((skill) => [skill.id, skill]));
    const downloaded = new Map<string, Awaited<ReturnType<typeof materializeSkillSource>>>();
    try {
      for (const { source, id } of sourceIds) {
        if (update || !before.has(id)) downloaded.set(id, await materializeSkillSource({ source }, path.join(this.rootDir, "skills")));
      }
      if (this.#stopping || !this.#state.accounts.includes(account) || this.#serviceEpoch(account, service.id) !== epoch
        || !this.mcp.serviceConnections(account.id).some((connection) => connection.name === this.#serviceName(account, service.id))) throw new HttpError(409, "Service changed or was removed during component preparation");
      const current = new Map(this.skills.list().map((skill) => [skill.id, skill]));
      const enabled = this.#state.accounts.some((entry) => entry.providerId === account.providerId && entry.enabledServices.includes(service.id));
      const installations: Parameters<NativeSkills["installBundle"]>[0][number][] = [];
      for (const { id } of sourceIds) {
        const existing = current.get(id);
        if (update && existing?.revision !== before.get(id)?.revision) throw new HttpError(409, "Service content changed during download; the current bundle was retained");
        if (!update && existing?.enabled === enabled) continue;
        const resource = downloaded.get(id);
        if (resource && (update || !existing)) {
          installations.push({ catalog: { ...resource.catalog, id }, materialized: resource, options: { origin: "service", serviceId: `${account.providerId}/${service.id}`, enabled } });
        } else if (existing?.path) {
          installations.push({
            catalog: { id, name: existing.name, description: existing.description, source: existing.source, sourceType: existing.sourceType, installUrl: existing.installUrl,
              ...(existing.skillPath ? { skillPath: existing.skillPath } : {}) },
            materialized: { directory: path.dirname(existing.path), revision: existing.revision },
            options: { origin: "service", serviceId: `${account.providerId}/${service.id}`, enabled },
          });
        } else throw new HttpError(409, "An official companion resource disappeared during preparation");
      }
      this.skills.installBundle(installations);
      for (const owner of this.#state.accounts.filter((entry) => entry.providerId === account.providerId)) delete owner.bundleErrors[service.id];
      this.#nativeCache = undefined;
      this.#persist(true);
    } catch (error) {
      const detail = redactToolErrorSummary(error instanceof Error ? error.message : error);
      if (this.#state.accounts.includes(account)) account.bundleErrors[service.id] = detail;
      for (const { id } of sourceIds) this.skills.markError(id, detail);
      this.#persist();
      if (error instanceof HttpError && error.status === 409) throw error;
      throw new HttpError(502, `Official Service content could not be prepared; the previous bundle was retained. ${detail}`);
    } finally {
      await Promise.all([...downloaded.values()].map((resource) => this.#removeUnusedSkill(resource.directory)));
    }
  }

  async #provisionService(account: Account, service: PluginServiceDefinition, enabled: boolean): Promise<void> {
    if (!service.mcpUrl) throw new HttpError(409, "This Service does not publish an official MCP endpoint");
    const epoch = this.#serviceEpoch(account, service.id);
    const name = this.#serviceName(account, service.id);
    const existing = this.mcp.serviceConnections(account.id).find((connection) => connection.name === name);
    if (existing) {
      if (existing.transport.type !== "http" || existing.transport.url !== service.mcpUrl) throw new HttpError(409, "The native Service endpoint was modified; it was not overwritten");
    } else {
      const native = account.native ? PLUGIN_PROVIDERS[account.providerId].nativeOAuth : undefined;
      this.mcp.putService(name, { url: service.mcpUrl, disabled: true,
        ...(native ? { oauth: {
          ...(native.publicClientId ? { clientId: native.publicClientId } : {}),
          ...(native.redirectPort ? { redirectUri: `http://localhost:${native.redirectPort}/callback` } : {}),
          ...(native.authServerMetadataUrl ? { authServerMetadataUrl: native.authServerMetadataUrl } : {}),
          ...(service.scopes.length ? { scope: service.scopes.join(" ") } : {}),
        } } : {}) }, { accountId: account.id, serviceId: service.id });
    }
    const token = enabled && account.grant ? await this.#token(account.providerId, account.grant) : undefined;
    if (!this.#state.accounts.includes(account) || this.#serviceEpoch(account, service.id) !== epoch) throw new HttpError(409, "Service changed during credential preparation");
    await this.#ensureBundle(account, service);
    if (!this.#state.accounts.includes(account) || this.#serviceEpoch(account, service.id) !== epoch) throw new HttpError(409, "Service changed during provisioning");
    const connection = this.mcp.serviceConnections(account.id).find((entry) => entry.name === name);
    if (!connection) throw new HttpError(409, "Service was removed during provisioning");
    if (token !== undefined) this.mcp.setServiceToken(name, service.mcpUrl, token);
    if (connection.enabled !== enabled) this.mcp.enable(connection.id, enabled, true);
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
          if (account.enabledServices.includes(service.id)) await this.#provisionService(account, service, true);
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
        const token = await this.#token(account.providerId, account.grant);
        for (const service of PLUGIN_PROVIDERS[account.providerId].services) {
          if (account.enabledServices.includes(service.id) && service.mcpUrl && this.mcp.serviceConnections(account.id).some((entry) => entry.name === this.#serviceName(account, service.id))) {
            this.mcp.setServiceToken(this.#serviceName(account, service.id), service.mcpUrl, token);
          }
        }
      } catch (error) { account.error = redactToolErrorSummary(error instanceof Error ? error.message : error); this.#persist(); }
    }
  }

  async #authorizeNative(body: AuthorizePluginBody, previous?: Account): Promise<{ url: string }> {
    const provider = PLUGIN_PROVIDERS[body.providerId];
    if (previous && !previous.native) throw new HttpError(409, "An API grant cannot be silently rebound to native MCP authorization. Add a separate Service account.");
    const serviceId = body.serviceId ?? previous?.native?.serviceId ?? (provider.services.length === 1 ? provider.services[0]!.id : undefined);
    const service = provider.services.find((item) => item.id === serviceId);
    if (!service) throw new HttpError(400, "Select the exact Service or region before native authorization");
    if (previous && previous.native?.serviceId !== service.id) throw new HttpError(409, "Add a separate account connection for a different Service region");
    const id = previous?.id ?? `account_${randomUUID().replace(/-/g, "")}`;
    const account: Account = previous ?? {
      id, providerId: body.providerId, label: `${provider.name} · ${id.slice(-6)}`,
      identity: "Native OAuth account identity is not exposed by this provider connection",
      enabledServices: [service.id], status: "reauthorize", nativeManaged: true,
      bundleErrors: {},
      native: { serviceId: service.id, name: `service-${id}-${service.id}` },
    };
    if (!previous) this.#state.accounts.push(account);
    this.#changeService(account, service.id);
    this.#persist(true);
    try {
      await this.#provisionService(account, service, account.enabledServices.includes(service.id));
      const connection = this.mcp.serviceConnections(account.id).find((entry) => entry.name === account.native!.name)!;
      const result = await this.authorizeMcp(connection.id);
      if (result.error) throw new HttpError(502, result.error);
      if (result.authenticated) await this.checkMcp(connection.id);
      return { url: result.authorizationUrl ?? body.returnUrl };
    } catch (error) {
      account.error = redactToolErrorSummary(error instanceof Error ? error.message : error);
      this.#persist();
      throw error;
    }
  }

  async authorize(body: AuthorizePluginBody): Promise<{ url: string }> {
    const cloudUrl = this.#cloudUrl();
    const account = body.accountId === undefined ? undefined : this.#state.accounts.find((entry) => entry.id === body.accountId);
    if (body.accountId !== undefined && (!account || account.providerId !== body.providerId)) throw new HttpError(404, "Provider account not found");
    await this.#ready;
    if (PLUGIN_PROVIDERS[body.providerId].nativeOAuth && (!account?.grant || !PLUGIN_PROVIDERS[body.providerId].publisherOAuth)) return this.#authorizeNative(body, account);
    for (const [state, entry] of this.#oauth) if (entry.expiresAt < Date.now()) this.#oauth.delete(state);
    const localState = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const callback = new URL("/api/plugins/oauth/callback", body.returnUrl);
    const result = OAuthStartResponse.parse(await this.publisher.request("oauth/start", { providerId: body.providerId, callbackUrl: callback.href,
      localState, challenge: createHash("sha256").update(verifier).digest("base64url") }));
    if (new URL(result.url).origin !== new URL(PLUGIN_PROVIDERS[body.providerId].authorizeUrl).origin) throw new HttpError(502, "Publisher returned an unexpected authorization origin");
    const brokerState = new URL(result.url).searchParams.get("state");
    if (!brokerState) throw new HttpError(502, "Publisher authorization did not include its transaction binding");
    this.#oauth.set(localState, { providerId: body.providerId, verifier, brokerState, cloudUrl, returnUrl: new URL(body.returnUrl).origin, expiresAt: Date.now() + 15 * 60_000,
      ...(body.accountId === undefined ? {} : { accountId: body.accountId }) });
    return result;
  }

  async finishAuthorization(url: URL): Promise<{ returnUrl: string; label: string }> {
    const state = url.searchParams.get("state") ?? "";
    const pending = this.#oauth.get(state);
    if (!pending || pending.expiresAt < Date.now()) throw new HttpError(400, "Authorization state is missing, expired, or already used. Start again from Plugins.");
    this.#oauth.delete(state);
    const code = url.searchParams.get("code");
    const brokerState = url.searchParams.get("brokerState");
    if (url.searchParams.has("error") || !code || !brokerState) throw new HttpError(400, "Authorization was not granted");
    if (brokerState !== pending.brokerState) throw new HttpError(400, "Authorization callback belongs to a different publisher transaction");
    const tokens = PublisherTokenResponse.parse(await this.publisher.request("oauth/token", { grantType: "authorization_code", code, state: brokerState, verifier: pending.verifier }, pending.cloudUrl));
    const metadata: Record<string, unknown> = {};
    for (const key of TOKEN_METADATA_KEYS) if (key !== "refresh_token" && key !== "expires_in" && key !== "refresh_token_expires_in" && key !== "scope" && tokens[key] !== undefined) metadata[key] = tokens[key];
    const grant: Grant = { generation: randomUUID(), accessToken: tokens.access_token, scopes: (tokens.scope ?? "").split(/[\s,]+/).filter(Boolean), cloudUrl: pending.cloudUrl, metadata,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }), ...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 }) };
    const identity = await this.#identify(pending.providerId, grant);
    const previous = pending.accountId === undefined ? undefined : this.#state.accounts.find((account) => account.id === pending.accountId);
    if (pending.accountId !== undefined && !previous) throw new HttpError(409, "Account was removed during authorization");
    if (previous && previous.identity !== identity.identity) throw new HttpError(409, "A different provider identity was authorized. Use Add account instead of reconnecting this account.");
    if (!grant.refreshToken && previous?.status === "connected" && previous.grant?.cloudUrl === grant.cloudUrl && previous.grant.refreshToken) {
      grant.refreshToken = previous.grant.refreshToken;
    }
    const services = PLUGIN_PROVIDERS[pending.providerId].services.filter((service) => hasScopes(grant, service)).map((service) => service.id);
    const account: Account = { id: previous?.id ?? `account_${randomUUID().replace(/-/g, "")}`, providerId: pending.providerId,
      label: previous?.label ?? identity.label, identity: identity.identity, enabledServices: previous ? previous.enabledServices.filter((id) => services.includes(id)) : services,
      bundleErrors: { ...previous?.bundleErrors },
      status: "connected", grant, nativeManaged: true };
    this.#state.accounts = [...this.#state.accounts.filter((item) => item.id !== account.id), account];
    for (const service of PLUGIN_PROVIDERS[account.providerId].services) {
      this.#changeService(account, service.id);
      if (!account.enabledServices.includes(service.id)) {
        const connection = this.mcp.serviceConnections(account.id).find((entry) => entry.name === this.#serviceName(account, service.id));
        if (connection) this.mcp.enable(connection.id, false, true);
        this.#releaseBundle(account.providerId, service.id);
      }
    }
    this.#persist(true);
    for (const service of PLUGIN_PROVIDERS[account.providerId].services) if (account.enabledServices.includes(service.id)) {
      try { await this.#provisionService(account, service, true); }
      catch (error) { account.bundleErrors[service.id] = redactToolErrorSummary(error instanceof Error ? error.message : error); this.#persist(); }
    }
    return { returnUrl: pending.returnUrl, label: account.label };
  }

  labelAccount(id: string, label: string): void {
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    account.label = label;
    this.#persist(true);
  }
  async enableService(id: string, serviceId: string, enabled: boolean): Promise<PluginAccountDto> {
    await this.#ready;
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    const service = PLUGIN_PROVIDERS[account.providerId].services.find((entry) => entry.id === serviceId);
    if (!service) throw new HttpError(404, "Service is not part of this provider account");
    if (enabled && (account.status === "reauthorize" || (account.grant && !hasScopes(account.grant, service)))) throw new HttpError(409, "This service needs additional consent. Reconnect the account to request the supported provider permission group.");
    if (account.native && account.native.serviceId !== serviceId) throw new HttpError(409, "Authorize this Service or region as a separate native account connection");
    const epoch = this.#changeService(account, serviceId);
    const wasEnabled = account.enabledServices.includes(serviceId);
    account.enabledServices = enabled ? [...new Set([...account.enabledServices, serviceId])] : account.enabledServices.filter((entry) => entry !== serviceId);
    this.#persist(true);
    try {
      if (enabled) await this.#provisionService(account, service, true);
      else {
        const connection = this.mcp.serviceConnections(account.id).find((entry) => entry.name === this.#serviceName(account, serviceId));
        if (connection) this.mcp.enable(connection.id, false, true);
        this.#releaseBundle(account.providerId, serviceId);
      }
    } catch (error) {
      if (this.#state.accounts.includes(account) && this.#serviceEpoch(account, serviceId) === epoch) {
        account.enabledServices = wasEnabled ? [...new Set([...account.enabledServices, serviceId])] : account.enabledServices.filter((entry) => entry !== serviceId);
        account.bundleErrors[serviceId] = redactToolErrorSummary(error instanceof Error ? error.message : error);
        this.#persist();
      }
      throw error;
    }
    return this.#accountDto(account);
  }

  #releaseBundle(providerId: PluginProviderId, serviceId: string): void {
    const owners = this.#state.accounts.filter((account) => account.providerId === providerId
      && this.mcp.serviceConnections(account.id).some((connection) => connection.name === this.#serviceName(account, serviceId)));
    const enabled = owners.some((account) => account.enabledServices.includes(serviceId));
    for (const skill of this.skills.list().filter((entry) => entry.origin === "service" && entry.serviceId === `${providerId}/${serviceId}`)) {
      if (!owners.length) this.skills.remove(skill.id, true);
      else if (skill.enabled !== enabled) this.skills.enable(skill.id, enabled, true);
    }
    this.#nativeCache = undefined;
  }

  async removeService(id: string, serviceId: string): Promise<void> {
    await this.#ready;
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    if (!PLUGIN_PROVIDERS[account.providerId].services.some((service) => service.id === serviceId)) throw new HttpError(404, "Unknown Service for this account");
    this.#changeService(account, serviceId);
    const connection = this.mcp.serviceConnections(id).find((entry) => entry.name === this.#serviceName(account, serviceId));
    if (connection) this.mcp.remove(connection.id, true);
    account.enabledServices = account.enabledServices.filter((entry) => entry !== serviceId);
    delete account.bundleErrors[serviceId];
    this.#releaseBundle(account.providerId, serviceId);
    this.#persist(true);
  }

  updateService(id: string, serviceId: string): Promise<void> {
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    const service = PLUGIN_PROVIDERS[account.providerId].services.find((entry) => entry.id === serviceId);
    if (!service || !this.mcp.serviceConnections(id).some((entry) => entry.name === this.#serviceName(account, serviceId))) throw new HttpError(404, "Service is not installed for this account");
    const key = `${account.providerId}/${serviceId}`;
    const pending = this.#serviceUpdates.get(key);
    if (pending) return pending;
    const operation = this.#ensureBundle(account, service, true).finally(() => { if (this.#serviceUpdates.get(key) === operation) this.#serviceUpdates.delete(key); });
    this.#serviceUpdates.set(key, operation);
    return operation;
  }
  disconnectAccount(id: string): void {
    const account = this.#state.accounts.find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    for (const connection of this.mcp.serviceConnections(id)) this.mcp.remove(connection.id, true);
    this.#state.accounts = this.#state.accounts.filter((entry) => entry.id !== id);
    for (const service of PLUGIN_PROVIDERS[account.providerId].services) {
      this.#serviceEpochs.delete(`${id}/${service.id}`);
      this.#releaseBundle(account.providerId, service.id);
    }
    this.#persist(true);
  }

  async #token(providerId: PluginProviderId, grant: Grant, force = false): Promise<string> {
    const refreshing = this.#refreshing.get(grant);
    if (refreshing) return refreshing;
    if (!force && (grant.expiresAt === undefined || grant.expiresAt > Date.now() + 60_000)) return grant.accessToken;
    const refresh = (async () => {
      try {
        if (!grant.refreshToken) throw new HttpError(401, "Access expired or was revoked; reconnect this provider account");
        const replacement = PublisherTokenResponse.parse(await this.publisher.request("oauth/token", { grantType: "refresh_token", providerId, refreshToken: grant.refreshToken }, grant.cloudUrl));
        grant.accessToken = replacement.access_token;
        if (replacement.refresh_token !== undefined) grant.refreshToken = replacement.refresh_token;
        if (replacement.expires_in === undefined) delete grant.expiresAt;
        else grant.expiresAt = Date.now() + replacement.expires_in * 1000;
        if (replacement.scope !== undefined) grant.scopes = replacement.scope.split(/[\s,]+/).filter(Boolean);
        if (this.#state.accounts.some((account) => account.grant === grant)) this.#persist();
        return grant.accessToken;
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          const account = this.#state.accounts.find((entry) => entry.grant === grant);
          if (account) { account.status = "reauthorize"; account.error = "Provider authorization expired or was revoked. Reconnect this account."; this.#persist(); }
        }
        throw error;
      }
    })().finally(() => { this.#refreshing.delete(grant); });
    this.#refreshing.set(grant, refresh);
    return refresh;
  }

  #authenticatedFetch(providerId: PluginProviderId, grant: Grant): FetchLike {
    return async (input, init) => {
      const token = await this.#token(providerId, grant);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      let response = await fetch(input, { ...init, headers, redirect: "manual" });
      if (response.status === 401) {
        await response.body?.cancel();
        const refreshed = grant.accessToken === token ? await this.#token(providerId, grant, true) : grant.accessToken;
        headers.set("authorization", `Bearer ${refreshed}`);
        response = await fetch(input, { ...init, headers, redirect: "manual" });
        if (response.status === 401) {
          const account = this.#state.accounts.find((entry) => entry.grant === grant);
          if (account) {
            account.status = "reauthorize";
            account.error = "Provider rejected refreshed authorization. Reconnect this account.";
            this.#persist();
          }
        }
      }
      return response;
    };
  }

  async #identify(providerId: PluginProviderId, grant: Grant): Promise<{ identity: string; label: string }> {
    return identifyAccount(providerId, grant, this.cwd, this.#authenticatedFetch(providerId, grant));
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
        ...this.#state.accounts.map((account) => `Service account ${account.id}: ${account.label}; ${account.identity}. Native MCP server names are ${account.enabledServices.map((serviceId) => this.#serviceName(account, serviceId)).join(", ") || "none enabled"}.${account.error ? ` Needs attention: ${account.error}` : ""}`)],
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
    this.#oauth.clear();
    await Promise.allSettled(this.skillInstalls.pending());
    await Promise.allSettled(this.#serviceUpdates.values());
  }
}
