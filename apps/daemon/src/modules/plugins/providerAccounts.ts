import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { PLUGIN_PROVIDERS, type PluginProviderId, type PluginServiceDefinition } from "@omarchy-bot/protocol";
import { HttpError } from "../bots/bots.ts";
import { connectMcp } from "./mcp.ts";

const ProviderIdentityId = z.union([z.string().min(1), z.number().int()]);

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
