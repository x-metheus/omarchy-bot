import { createHash } from "node:crypto";
import path from "node:path";
import { redactToolErrorSummary } from "@omarchy-bot/agent-contract";
import { PLUGIN_PROVIDERS, type PluginAccountDto, type PluginProviderId, type PluginServiceDefinition } from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { hasScopes } from "./providerAccounts.ts";
import { materializeSkillSource, type MaterializedSkillSource } from "./skillInstaller.ts";
import type { NativeMcpStore } from "./nativeMcp.ts";
import type { NativeSkills } from "./nativeSkills.ts";

interface BundleGrant {
  generation: string;
  scopes: string[];
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
  cloudUrl: string;
  metadata: Record<string, unknown>;
}

export interface BundleAccount {
  id: string;
  providerId: PluginProviderId;
  enabledServices: string[];
  status: "connected" | "reauthorize";
  bundleErrors: Record<string, string>;
  grant?: BundleGrant | undefined;
  native?: { serviceId: string; name: string } | undefined;
}

export interface BundleHost {
  rootDir: string;
  mcp: NativeMcpStore;
  skills: NativeSkills;
  accounts(): BundleAccount[];
  stopping(): boolean;
  ready(): Promise<void>;
  token(providerId: PluginProviderId, grant: BundleGrant): Promise<string>;
  persist(changed?: boolean): void;
  clearNative(): void;
  removeUnused(directory: string): Promise<void>;
  accountDto(account: BundleAccount): PluginAccountDto;
}

/** Official Service bundle provisioning. Account records stay on the host. */
export class ServiceBundles {
  #epochs = new Map<string, number>();
  #updates = new Map<string, Promise<void>>();

  constructor(private readonly host: BundleHost) {}

  pending(): Iterable<Promise<void>> { return this.#updates.values(); }

  serviceName(account: BundleAccount, serviceId: string): string { return `service-${account.id}-${serviceId}`; }

  change(account: BundleAccount, serviceId: string): number {
    const epoch = (this.#epochs.get(`${account.id}/${serviceId}`) ?? 0) + 1;
    this.#epochs.set(`${account.id}/${serviceId}`, epoch);
    return epoch;
  }

  forget(accountId: string): void {
    for (const key of this.#epochs.keys()) if (key.startsWith(`${accountId}/`)) this.#epochs.delete(key);
  }

  async ensure(account: BundleAccount, service: PluginServiceDefinition, update = false): Promise<void> {
    const started = this.#epochs.get(`${account.id}/${service.id}`) ?? 0;
    const sourceIds = (service.skillSources ?? []).map((source) => ({
      source, id: `service:${account.providerId}:${service.id}:${createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
    }));
    const before = new Map(this.host.skills.list().filter((skill) => skill.serviceId === `${account.providerId}/${service.id}`).map((skill) => [skill.id, skill]));
    const downloaded = new Map<string, MaterializedSkillSource>();
    try {
      for (const { source, id } of sourceIds) {
        if (update || !before.has(id)) downloaded.set(id, await materializeSkillSource({ source }, path.join(this.host.rootDir, "skills")));
      }
      if (this.host.stopping() || !this.host.accounts().includes(account) || (this.#epochs.get(`${account.id}/${service.id}`) ?? 0) !== started
        || !this.host.mcp.serviceConnections(account.id).some((connection) => connection.name === this.serviceName(account, service.id))) throw new HttpError(409, "Service changed or was removed during component preparation");
      const current = new Map(this.host.skills.list().map((skill) => [skill.id, skill]));
      const enabled = this.host.accounts().some((entry) => entry.providerId === account.providerId && entry.enabledServices.includes(service.id));
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
      this.host.skills.installBundle(installations);
      for (const owner of this.host.accounts().filter((entry) => entry.providerId === account.providerId)) delete owner.bundleErrors[service.id];
      this.host.clearNative();
      this.host.persist(true);
    } catch (error) {
      const detail = redactToolErrorSummary(error instanceof Error ? error.message : error);
      if (this.host.accounts().includes(account)) account.bundleErrors[service.id] = detail;
      for (const { id } of sourceIds) this.host.skills.markError(id, detail);
      this.host.persist();
      if (error instanceof HttpError && error.status === 409) throw error;
      throw new HttpError(502, `Official Service content could not be prepared; the previous bundle was retained. ${detail}`);
    } finally {
      await Promise.all([...downloaded.values()].map((resource) => this.host.removeUnused(resource.directory)));
    }
  }

  async provision(account: BundleAccount, service: PluginServiceDefinition, enabled: boolean): Promise<void> {
    if (!service.mcpUrl) throw new HttpError(409, "This Service does not publish an official MCP endpoint");
    const started = this.#epochs.get(`${account.id}/${service.id}`) ?? 0;
    const name = this.serviceName(account, service.id);
    const existing = this.host.mcp.serviceConnections(account.id).find((connection) => connection.name === name);
    if (existing) {
      if (existing.transport.type !== "http" || existing.transport.url !== service.mcpUrl) throw new HttpError(409, "The native Service endpoint was modified; it was not overwritten");
    } else {
      const native = account.native ? PLUGIN_PROVIDERS[account.providerId].nativeOAuth : undefined;
      this.host.mcp.putService(name, { url: service.mcpUrl, disabled: true,
        ...(native ? { oauth: {
          ...(native.publicClientId ? { clientId: native.publicClientId } : {}),
          ...(native.redirectPort ? { redirectUri: `http://localhost:${native.redirectPort}/callback` } : {}),
          ...(native.authServerMetadataUrl ? { authServerMetadataUrl: native.authServerMetadataUrl } : {}),
          ...(service.scopes.length ? { scope: service.scopes.join(" ") } : {}),
        } } : {}) }, { accountId: account.id, serviceId: service.id });
    }
    const token = enabled && account.grant ? await this.host.token(account.providerId, account.grant) : undefined;
    if (!this.host.accounts().includes(account) || (this.#epochs.get(`${account.id}/${service.id}`) ?? 0) !== started) throw new HttpError(409, "Service changed during credential preparation");
    await this.ensure(account, service);
    if (!this.host.accounts().includes(account) || (this.#epochs.get(`${account.id}/${service.id}`) ?? 0) !== started) throw new HttpError(409, "Service changed during provisioning");
    const connection = this.host.mcp.serviceConnections(account.id).find((entry) => entry.name === name);
    if (!connection) throw new HttpError(409, "Service was removed during provisioning");
    if (token !== undefined) this.host.mcp.setServiceToken(name, service.mcpUrl, token);
    if (connection.enabled !== enabled) this.host.mcp.enable(connection.id, enabled, true);
  }

  release(providerId: PluginProviderId, serviceId: string): void {
    const owners = this.host.accounts().filter((account) => account.providerId === providerId
      && this.host.mcp.serviceConnections(account.id).some((connection) => connection.name === this.serviceName(account, serviceId)));
    const enabled = owners.some((account) => account.enabledServices.includes(serviceId));
    for (const skill of this.host.skills.list().filter((entry) => entry.origin === "service" && entry.serviceId === `${providerId}/${serviceId}`)) {
      if (!owners.length) this.host.skills.remove(skill.id, true);
      else if (skill.enabled !== enabled) this.host.skills.enable(skill.id, enabled, true);
    }
    this.host.clearNative();
  }

  async enable(id: string, serviceId: string, on: boolean): Promise<PluginAccountDto> {
    await this.host.ready();
    const account = this.host.accounts().find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    const service = PLUGIN_PROVIDERS[account.providerId].services.find((entry) => entry.id === serviceId);
    if (!service) throw new HttpError(404, "Service is not part of this provider account");
    if (on && (account.status === "reauthorize" || (account.grant && !hasScopes(account.grant, service)))) throw new HttpError(409, "This service needs additional consent. Reconnect the account to request the supported provider permission group.");
    if (account.native && account.native.serviceId !== serviceId) throw new HttpError(409, "Authorize this Service or region as a separate native account connection");
    const epoch = this.change(account, serviceId);
    const wasEnabled = account.enabledServices.includes(serviceId);
    account.enabledServices = on ? [...new Set([...account.enabledServices, serviceId])] : account.enabledServices.filter((entry) => entry !== serviceId);
    this.host.persist(true);
    try {
      if (on) await this.provision(account, service, true);
      else {
        const connection = this.host.mcp.serviceConnections(account.id).find((entry) => entry.name === this.serviceName(account, serviceId));
        if (connection) this.host.mcp.enable(connection.id, false, true);
        this.release(account.providerId, serviceId);
      }
    } catch (error) {
      if (this.host.accounts().includes(account) && (this.#epochs.get(`${account.id}/${serviceId}`) ?? 0) === epoch) {
        account.enabledServices = wasEnabled ? [...new Set([...account.enabledServices, serviceId])] : account.enabledServices.filter((entry) => entry !== serviceId);
        account.bundleErrors[serviceId] = redactToolErrorSummary(error instanceof Error ? error.message : error);
        this.host.persist();
      }
      throw error;
    }
    return this.host.accountDto(account);
  }

  async remove(id: string, serviceId: string): Promise<void> {
    await this.host.ready();
    const account = this.host.accounts().find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    if (!PLUGIN_PROVIDERS[account.providerId].services.some((service) => service.id === serviceId)) throw new HttpError(404, "Unknown Service for this account");
    this.change(account, serviceId);
    const connection = this.host.mcp.serviceConnections(id).find((entry) => entry.name === this.serviceName(account, serviceId));
    if (connection) this.host.mcp.remove(connection.id, true);
    account.enabledServices = account.enabledServices.filter((entry) => entry !== serviceId);
    delete account.bundleErrors[serviceId];
    this.release(account.providerId, serviceId);
    this.host.persist(true);
  }

  update(id: string, serviceId: string): Promise<void> {
    const account = this.host.accounts().find((entry) => entry.id === id);
    if (!account) throw new HttpError(404, "Provider account not found");
    const service = PLUGIN_PROVIDERS[account.providerId].services.find((entry) => entry.id === serviceId);
    if (!service || !this.host.mcp.serviceConnections(id).some((entry) => entry.name === this.serviceName(account, serviceId))) throw new HttpError(404, "Service is not installed for this account");
    const key = `${account.providerId}/${serviceId}`;
    const pending = this.#updates.get(key);
    if (pending) return pending;
    const operation = this.ensure(account, service, true).finally(() => { if (this.#updates.get(key) === operation) this.#updates.delete(key); });
    this.#updates.set(key, operation);
    return operation;
  }
}
