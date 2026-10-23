import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { redactToolErrorSummary } from "@omarchy-bot/agent-contract";
import { z } from "zod";
import {
  HttpsOrigin, OAuthStartResponse, PLUGIN_PROVIDERS, PublisherTokenResponse, TOKEN_METADATA_KEYS,
  type AuthorizePluginBody, type PluginProviderId, type PluginServiceDefinition,
} from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { connectMcp } from "./mcp.ts";
import type { CatalogClient } from "./catalogClient.ts";
import type { NativeMcpStore } from "./nativeMcp.ts";

const ProviderIdentityId = z.union([z.string().min(1), z.number().int()]);

/** A provider credential set held on a Service account. The class below owns every write to it. */
export const Grant = z.object({
  generation: z.string(), accessToken: z.string(), refreshToken: z.string().optional(), expiresAt: z.number().optional(),
  scopes: z.array(z.string()), cloudUrl: HttpsOrigin, metadata: z.record(z.unknown()).default({}),
});
export type Grant = z.infer<typeof Grant>;

export interface ProviderAccount {
  id: string;
  providerId: PluginProviderId;
  label: string;
  identity: string;
  enabledServices: string[];
  status: "connected" | "reauthorize";
  error?: string | undefined;
  grant?: Grant | undefined;
  bundleErrors: Record<string, string>;
  native?: { serviceId: string; name: string } | undefined;
  nativeManaged: boolean;
}

interface OAuthPending {
  providerId: PluginProviderId; accountId?: string; verifier: string; cloudUrl: string; returnUrl: string; expiresAt: number;
  brokerState: string;
}

/** Host services the authorization flow needs. Provisioning arrives as callbacks so this module never imports PluginsService. */
export interface ProviderAccountsHost {
  cwd: string;
  mcp: NativeMcpStore;
  publisher: CatalogClient;
  accounts(): ProviderAccount[];
  cloudUrl(): string;
  ready(): Promise<void>;
  persist(changed?: boolean): void;
  provision(account: ProviderAccount, service: PluginServiceDefinition, enabled: boolean): Promise<void>;
  serviceName(account: ProviderAccount, serviceId: string): string;
  change(account: ProviderAccount, serviceId: string): number;
  release(providerId: PluginProviderId, serviceId: string): void;
  authorizeMcp(id: string): Promise<{ authorizationUrl?: string; authenticated?: boolean; error?: string }>;
  checkMcp(id: string): Promise<unknown>;
}

export interface AccountGrant {
  accessToken: string;
  scopes: string[];
  metadata: Record<string, unknown>;
}

export function hasScopes(grant: { scopes: string[] }, service: PluginServiceDefinition): boolean {
  const granted = new Set(grant.scopes.map((scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//, "").toLowerCase()));
  return service.scopes.every((scope) => granted.has(scope.replace(/^https:\/\/graph\.microsoft\.com\//, "").toLowerCase()));
}

/** Publisher OAuth only. Native-only providers never reach a token or user lookup. */
export async function identifyAccount(providerId: PluginProviderId, grant: AccountGrant, cwd: string, fetchWithAccount: FetchLike): Promise<{ identity: string; label: string }> {
  const provider = PLUGIN_PROVIDERS[providerId];
  if (!provider.publisherOAuth) throw new HttpError(409, `${provider.name} uses native MCP authorization and has no publisher identity lookup`);
  const json = async (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await fetchWithAccount(url, { ...init, signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", accept: "application/json", ...init?.headers } });
    if (!response.ok) throw new HttpError(502, `${provider.name} identity lookup returned HTTP ${response.status}`);
    return z.record(z.unknown()).parse(await response.json());
  };
  let id: unknown;
  let label: unknown;
  switch (providerId) {
    case "google": {
      const user = await json("https://openidconnect.googleapis.com/v1/userinfo");
      const claims = z.object({ subject: z.string() }).safeParse(grant.metadata.identity);
      if (!claims.success || claims.data.subject !== user.sub) throw new HttpError(401, "Google access token and verified identity do not match");
      id = user.sub; label = user.email ?? user.name; break;
    }
    case "github": { const user = await json("https://api.github.com/user"); id = user.id; label = user.login; break; }
    case "linear": {
      const result = z.object({ data: z.object({ viewer: z.object({ id: ProviderIdentityId, name: z.string() }) }) }).parse(await json("https://api.linear.app/graphql", { method: "POST", body: JSON.stringify({ query: "{ viewer { id name } }" }) }));
      id = result.data.viewer.id; label = result.data.viewer.name; break;
    }
    case "dropbox": {
      const user = z.object({ account_id: z.string(), email: z.string().optional(), name: z.object({ display_name: z.string() }).optional() }).parse(await json("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", body: "null" }));
      id = user.account_id; label = user.email ?? user.name?.display_name; break;
    }
    case "intercom": {
      const user = z.object({ id: ProviderIdentityId, email: z.string().nullish(), name: z.string().nullish(), app: z.object({ id_code: z.string(), name: z.string().optional(), region: z.string().optional() }) }).parse(await json("https://api.intercom.io/me"));
      if (user.app.region === "AU") throw new HttpError(409, "Intercom MCP does not support Australian workspaces");
      id = `${user.app.id_code}:${user.id}`; label = user.email ? `${user.email} · ${user.app.name ?? user.app.id_code}` : user.name; grant.metadata.region = user.app.region; break;
    }
    case "notion": {
      if (typeof grant.metadata.user_id === "string" && typeof grant.metadata.workspace_id === "string") id = `${grant.metadata.workspace_id}:${grant.metadata.user_id}`;
      label = `${grant.metadata.email_domain ?? "Notion"} · ${grant.metadata.workspace_id ?? ""}`; break;
    }
    case "asana": {
      const data = z.object({ gid: ProviderIdentityId.optional(), id: ProviderIdentityId.optional(), email: z.string().optional(), name: z.string().optional() }).parse(grant.metadata.data);
      id = data.gid ?? data.id; label = data.email ?? data.name; break;
    }
    case "hubspot": {
      const connection = await connectMcp({ type: "http", url: PLUGIN_PROVIDERS.hubspot.services[0]!.mcpUrl! }, cwd, fetchWithAccount);
      try {
        const result = await connection.client.callTool({ name: "get_user_details", arguments: {} }, undefined, { timeout: 30_000 });
        if (result.isError) throw new HttpError(502, "HubSpot could not return its authenticated user details");
        const text = (result.content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
        const user = z.record(z.unknown()).parse(result.structuredContent ?? JSON.parse(text));
        const details = z.record(z.unknown()).parse(user.data ?? user);
        const userId = ProviderIdentityId.parse(details.userId ?? details.user_id);
        const hubId = ProviderIdentityId.parse(details.hubId ?? details.hub_id ?? details.portalId);
        id = `${hubId}:${userId}`;
        label = details.email ?? details.userEmail;
      } finally { await connection.close(); }
      break;
    }
    default:
      throw new HttpError(409, `${provider.name} uses native MCP authorization and has no publisher identity lookup`);
  }
  if ((typeof id !== "string" && typeof id !== "number") || !String(id)) throw new HttpError(502, `${provider.name} did not return a stable authorized account identity`);
  return { identity: `${providerId}:${id}`, label: typeof label === "string" && label.trim() ? label.trim() : `${provider.name} · ${id}` };
}

/** Publisher OAuth: start, callback completion, token refresh and grant writes on the shared account store. */
export class ProviderAccounts {
  #refreshing = new Map<Grant, Promise<string>>();
  #oauth = new Map<string, OAuthPending>();

  constructor(private readonly host: ProviderAccountsHost) {}

  /** Native-only providers never reach a token endpoint; identifyAccount already refuses them with 409. */
  async token(providerId: PluginProviderId, grant: Grant, force = false): Promise<string> {
    const refreshing = this.#refreshing.get(grant);
    if (refreshing) return refreshing;
    if (!force && (grant.expiresAt === undefined || grant.expiresAt > Date.now() + 60_000)) return grant.accessToken;
    const refresh = (async () => {
      try {
        if (!grant.refreshToken) throw new HttpError(401, "Access expired or was revoked; reconnect this provider account");
        const replacement = PublisherTokenResponse.parse(await this.host.publisher.request("oauth/token", { grantType: "refresh_token", providerId, refreshToken: grant.refreshToken }, grant.cloudUrl));
        grant.accessToken = replacement.access_token;
        if (replacement.refresh_token !== undefined) grant.refreshToken = replacement.refresh_token;
        if (replacement.expires_in === undefined) delete grant.expiresAt;
        else grant.expiresAt = Date.now() + replacement.expires_in * 1000;
        if (replacement.scope !== undefined) grant.scopes = replacement.scope.split(/[\s,]+/).filter(Boolean);
        if (this.host.accounts().some((account) => account.grant === grant)) this.host.persist();
        return grant.accessToken;
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) this.#markReauthorize(grant, "Provider authorization expired or was revoked. Reconnect this account.");
        throw error;
      }
    })().finally(() => { this.#refreshing.delete(grant); });
    this.#refreshing.set(grant, refresh);
    return refresh;
  }

  /** Fetch that carries a live bearer token and asks for a refresh once on 401. */
  authenticatedFetch(providerId: PluginProviderId, grant: Grant): FetchLike {
    return async (input, init) => {
      const token = await this.token(providerId, grant);
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      let response = await fetch(input, { ...init, headers, redirect: "manual" });
      if (response.status === 401) {
        await response.body?.cancel();
        const refreshed = grant.accessToken === token ? await this.token(providerId, grant, true) : grant.accessToken;
        headers.set("authorization", `Bearer ${refreshed}`);
        response = await fetch(input, { ...init, headers, redirect: "manual" });
        if (response.status === 401) this.#markReauthorize(grant, "Provider rejected refreshed authorization. Reconnect this account.");
      }
      return response;
    };
  }

  async authorize(body: AuthorizePluginBody): Promise<{ url: string }> {
    const cloudUrl = this.host.cloudUrl();
    const account = body.accountId === undefined ? undefined : this.host.accounts().find((entry) => entry.id === body.accountId);
    if (body.accountId !== undefined && (!account || account.providerId !== body.providerId)) throw new HttpError(404, "Provider account not found");
    await this.host.ready();
    if (PLUGIN_PROVIDERS[body.providerId].nativeOAuth && (!account?.grant || !PLUGIN_PROVIDERS[body.providerId].publisherOAuth)) return this.authorizeNative(body, account);
    for (const [state, entry] of this.#oauth) if (entry.expiresAt < Date.now()) this.#oauth.delete(state);
    const localState = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const callback = new URL("/api/plugins/oauth/callback", body.returnUrl);
    const result = OAuthStartResponse.parse(await this.host.publisher.request("oauth/start", { providerId: body.providerId, callbackUrl: callback.href,
      localState, challenge: createHash("sha256").update(verifier).digest("base64url") }));
    if (new URL(result.url).origin !== new URL(PLUGIN_PROVIDERS[body.providerId].authorizeUrl).origin) throw new HttpError(502, "Publisher returned an unexpected authorization origin");
    const brokerState = new URL(result.url).searchParams.get("state");
    if (!brokerState) throw new HttpError(502, "Publisher authorization did not include its transaction binding");
    this.#oauth.set(localState, { providerId: body.providerId, verifier, brokerState, cloudUrl, returnUrl: new URL(body.returnUrl).origin, expiresAt: Date.now() + 15 * 60_000,
      ...(body.accountId === undefined ? {} : { accountId: body.accountId }) });
    return result;
  }

  /** Native MCP authorization provisions the Service first, then hands the connection's own OAuth flow back to the caller. */
  async authorizeNative(body: AuthorizePluginBody, previous?: ProviderAccount): Promise<{ url: string }> {
    const provider = PLUGIN_PROVIDERS[body.providerId];
    if (previous && !previous.native) throw new HttpError(409, "An API grant cannot be silently rebound to native MCP authorization. Add a separate Service account.");
    const serviceId = body.serviceId ?? previous?.native?.serviceId ?? (provider.services.length === 1 ? provider.services[0]!.id : undefined);
    const service = provider.services.find((item) => item.id === serviceId);
    if (!service) throw new HttpError(400, "Select the exact Service or region before native authorization");
    if (previous && previous.native?.serviceId !== service.id) throw new HttpError(409, "Add a separate account connection for a different Service region");
    const id = previous?.id ?? `account_${randomUUID().replace(/-/g, "")}`;
    const account: ProviderAccount = previous ?? {
      id, providerId: body.providerId, label: `${provider.name} · ${id.slice(-6)}`,
      identity: "Native OAuth account identity is not exposed by this provider connection",
      enabledServices: [service.id], status: "reauthorize", nativeManaged: true,
      bundleErrors: {},
      native: { serviceId: service.id, name: `service-${id}-${service.id}` },
    };
    if (!previous) this.host.accounts().push(account);
    this.host.change(account, service.id);
    this.host.persist(true);
    try {
      await this.host.provision(account, service, account.enabledServices.includes(service.id));
      const connection = this.host.mcp.serviceConnections(account.id).find((entry) => entry.name === account.native!.name)!;
      const result = await this.host.authorizeMcp(connection.id);
      if (result.error) throw new HttpError(502, result.error);
      if (result.authenticated) await this.host.checkMcp(connection.id);
      return { url: result.authorizationUrl ?? body.returnUrl };
    } catch (error) {
      account.error = redactToolErrorSummary(error instanceof Error ? error.message : error);
      this.host.persist();
      throw error;
    }
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
    const tokens = PublisherTokenResponse.parse(await this.host.publisher.request("oauth/token", { grantType: "authorization_code", code, state: brokerState, verifier: pending.verifier }, pending.cloudUrl));
    const metadata: Record<string, unknown> = {};
    for (const key of TOKEN_METADATA_KEYS) if (key !== "refresh_token" && key !== "expires_in" && key !== "refresh_token_expires_in" && key !== "scope" && tokens[key] !== undefined) metadata[key] = tokens[key];
    const grant: Grant = { generation: randomUUID(), accessToken: tokens.access_token, scopes: (tokens.scope ?? "").split(/[\s,]+/).filter(Boolean), cloudUrl: pending.cloudUrl, metadata,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }), ...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 }) };
    const identity = await identifyAccount(pending.providerId, grant, this.host.cwd, this.authenticatedFetch(pending.providerId, grant));
    const previous = pending.accountId === undefined ? undefined : this.host.accounts().find((account) => account.id === pending.accountId);
    if (pending.accountId !== undefined && !previous) throw new HttpError(409, "Account was removed during authorization");
    if (previous && previous.identity !== identity.identity) throw new HttpError(409, "A different provider identity was authorized. Use Add account instead of reconnecting this account.");
    if (!grant.refreshToken && previous?.status === "connected" && previous.grant?.cloudUrl === grant.cloudUrl && previous.grant.refreshToken) {
      grant.refreshToken = previous.grant.refreshToken;
    }
    const services = PLUGIN_PROVIDERS[pending.providerId].services.filter((service) => hasScopes(grant, service)).map((service) => service.id);
    const account: ProviderAccount = { id: previous?.id ?? `account_${randomUUID().replace(/-/g, "")}`, providerId: pending.providerId,
      label: previous?.label ?? identity.label, identity: identity.identity, enabledServices: previous ? previous.enabledServices.filter((id) => services.includes(id)) : services,
      bundleErrors: { ...previous?.bundleErrors },
      status: "connected", grant, nativeManaged: true };
    const accounts = this.host.accounts();
    const previousIndex = accounts.findIndex((entry) => entry.id === account.id);
    if (previousIndex >= 0) accounts.splice(previousIndex, 1);
    accounts.push(account);
    for (const service of PLUGIN_PROVIDERS[account.providerId].services) {
      this.host.change(account, service.id);
      if (!account.enabledServices.includes(service.id)) {
        const connection = this.host.mcp.serviceConnections(account.id).find((entry) => entry.name === this.host.serviceName(account, service.id));
        if (connection) this.host.mcp.enable(connection.id, false, true);
        this.host.release(account.providerId, service.id);
      }
    }
    this.host.persist(true);
    for (const service of PLUGIN_PROVIDERS[account.providerId].services) if (account.enabledServices.includes(service.id)) {
      try { await this.host.provision(account, service, true); }
      catch (error) { account.bundleErrors[service.id] = redactToolErrorSummary(error instanceof Error ? error.message : error); this.host.persist(); }
    }
    return { returnUrl: pending.returnUrl, label: account.label };
  }

  clearPending(): void { this.#oauth.clear(); }

  #markReauthorize(grant: Grant, error: string): void {
    const account = this.host.accounts().find((entry) => entry.grant === grant);
    if (!account) return;
    account.status = "reauthorize";
    account.error = error;
    this.host.persist();
  }
}
