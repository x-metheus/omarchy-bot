import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getVercelOidcToken } from "@vercel/oidc";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { PLUGIN_PROVIDERS } from "../../../packages/protocol/src/pluginProviders.ts";
import { PluginProviderId, SKILL_CATALOG_PAGE_SIZE, SKILL_SEARCH_LIMIT } from "../../../packages/protocol/src/plugins.ts";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" };
const STATE_AUDIENCE = "omarchy-bot-oauth";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export class BrokerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function publisherOrigin(): string {
  const configured = process.env.PLUGIN_CLOUD_URL ?? process.env.SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  if (!configured) throw new BrokerError(503, "Configure the publisher PLUGIN_CLOUD_URL with its stable HTTPS origin.");
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new BrokerError(503, "PLUGIN_CLOUD_URL must be an HTTPS origin, without a path or credentials.");
  }
  return url.origin;
}

function stateKey(): Uint8Array {
  const value = process.env.OAUTH_STATE_SECRET;
  if (!value || Buffer.byteLength(value) < 32) throw new BrokerError(503, "Configure a random OAUTH_STATE_SECRET of at least 32 bytes on the publisher backend.");
  return new TextEncoder().encode(value);
}

function clientCredentials(providerId: PluginProviderId, origin: string): { clientId: string; clientSecret?: string } {
  const provider = PLUGIN_PROVIDERS[providerId];
  if (!provider.publisherOAuth) throw new BrokerError(400, `${provider.name} requires native MCP OAuth discovery and authorization, not publisher OAuth.`);
  const clientId = process.env[`OAUTH_${providerId.toUpperCase()}_CLIENT_ID`]
    ?? (provider.clientMetadata ? `${origin}/api/plugins/oauth/client/${providerId}` : undefined);
  const clientSecret = process.env[`OAUTH_${providerId.toUpperCase()}_CLIENT_SECRET`];
  if (!clientId || (provider.tokenAuth === "post" && !clientSecret)) {
    const prefix = `OAUTH_${providerId.toUpperCase()}`;
    throw new BrokerError(503, `Configure ${prefix}_CLIENT_ID${provider.tokenAuth === "post" ? ` and ${prefix}_CLIENT_SECRET` : ""} on the publisher. ${provider.registrationNote}`);
  }
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** Only local clients receive code callbacks; this is not a general-purpose redirector. */
function callbackUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const octets = hostname.split(".").map(Number);
  const local = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "::1"
    || (isIP(hostname) === 4 && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)))
    || (isIP(hostname) === 6 && /^(fc|fd|fe80:)/.test(hostname));
  if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search
    || url.pathname !== "/api/plugins/oauth/callback") throw new BrokerError(400, "OAuth callback must be a local Omarchy Bot client callback URL.");
  return url;
}

const StartBody = z.object({
  providerId: PluginProviderId,
  callbackUrl: z.string().url(),
  localState: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
const TokenBody = z.discriminatedUnion("grantType", [
  z.object({ grantType: z.literal("authorization_code"), code: z.string().min(1).max(8192), state: z.string().min(1).max(16384), verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) }).strict(),
  z.object({ grantType: z.literal("refresh_token"), providerId: PluginProviderId, refreshToken: z.string().min(1).max(32768) }).strict(),
]);
const StatePayload = z.object({
  providerId: PluginProviderId, callbackUrl: z.string(), localState: z.string(), challenge: z.string(), clientId: z.string(), nonce: z.string(), scopes: z.array(z.string()),
});

async function verifyState(state: string) {
  const verified = await jwtVerify(state, stateKey(), { issuer: publisherOrigin(), audience: STATE_AUDIENCE, algorithms: ["HS256"], maxTokenAge: "15m" });
  return StatePayload.parse(verified.payload);
}

async function readBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (Buffer.byteLength(body) > 64 * 1024) throw new BrokerError(413, "Request body is too large.");
  try { return JSON.parse(body); } catch { throw new BrokerError(400, "Invalid JSON request body."); }
}

async function tokenExchange(body: z.infer<typeof TokenBody>): Promise<Response> {
  const origin = publisherOrigin();
  const state = body.grantType === "authorization_code" ? await verifyState(body.state) : undefined;
  const providerId = state?.providerId ?? (body.grantType === "refresh_token" ? body.providerId : undefined);
  if (!providerId) throw new BrokerError(400, "Missing OAuth provider.");
  const provider = PLUGIN_PROVIDERS[providerId];
  const credentials = clientCredentials(providerId, origin);
  const parameters: Record<string, string> = { client_id: credentials.clientId, grant_type: body.grantType };
  if (credentials.clientSecret) parameters.client_secret = credentials.clientSecret;
  if (body.grantType === "authorization_code" && state) {
    const challenge = createHash("sha256").update(body.verifier).digest("base64url");
    if (state.clientId !== credentials.clientId || challenge.length !== state.challenge.length
      || !timingSafeEqual(Buffer.from(challenge), Buffer.from(state.challenge))) throw new BrokerError(400, "OAuth verifier does not match the initiating client.");
    parameters.code = body.code;
    parameters.redirect_uri = `${origin}/api/plugins/oauth/callback`;
    if (provider.pkce) parameters.code_verifier = body.verifier;
  } else if (body.grantType === "refresh_token") {
    if (providerId === "intercom") throw new BrokerError(400, "Intercom API OAuth does not document a refresh grant. Reconnect the account.");
    parameters.refresh_token = body.refreshToken;
  }
  const response = await fetch(provider.tokenUrl, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": provider.tokenEncoding === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
    body: provider.tokenEncoding === "json" ? JSON.stringify(parameters) : new URLSearchParams(parameters),
  });
  let raw: Record<string, unknown>;
  try { raw = await response.json() as Record<string, unknown>; }
  catch { throw new BrokerError(response.status === 429 ? 429 : 502, `${provider.name} returned an invalid OAuth response.`); }
  if (!response.ok || typeof raw.access_token !== "string" || raw.error) {
    const code = typeof raw.error === "string" && /^[a-z_]{1,80}$/.test(raw.error) ? raw.error : "token_exchange_failed";
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502
      : ["invalid_grant", "invalid_token", "access_denied"].includes(code) ? 401
      : ["invalid_client", "unauthorized_client"].includes(code) ? 503 : 502;
    throw new BrokerError(status, `${provider.name} OAuth failed: ${code}.`);
  }
  const tokens: Record<string, unknown> = { access_token: raw.access_token, token_type: raw.token_type ?? "Bearer" };
  for (const key of ["refresh_token", "expires_in", "refresh_token_expires_in", "scope", "user_id", "workspace_id", "email_domain", "team_id", "data"]) {
    if (raw[key] !== undefined) tokens[key] = raw[key];
  }
  if (state && raw.scope === undefined) tokens.scope = state.scopes.join(" ");
  if (state && providerId === "google") {
    if (typeof raw.id_token !== "string") throw new BrokerError(401, "The identity provider did not return its required ID token.");
    const verified = await jwtVerify(raw.id_token, GOOGLE_JWKS, {
      audience: credentials.clientId, algorithms: ["RS256"], clockTolerance: 30,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    const claims = verified.payload;
    if (claims.nonce !== state.nonce) throw new BrokerError(401, "Identity nonce mismatch.");
    tokens.identity = { subject: claims.sub, tenantId: claims.tid, userId: claims.oid };
  }
  return new Response(JSON.stringify(tokens), { headers: JSON_HEADERS });
}

export async function handlePluginCloudRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/plugins\/?/, "");
    if (route === "providers" && request.method === "GET") {
      let origin: string | undefined;
      let setupError: string | undefined;
      try { origin = publisherOrigin(); stateKey(); } catch (error) { setupError = error instanceof Error ? error.message : "Publisher setup is missing."; }
      return new Response(JSON.stringify(Object.values(PLUGIN_PROVIDERS).map((provider) => {
        let setupReason: string | undefined;
        if (!provider.nativeOAuth) {
          setupReason = setupError;
          if (!setupReason && origin) { try { clientCredentials(provider.id, origin); } catch (error) { setupReason = error instanceof Error ? error.message : "OAuth registration is missing."; } }
        }
        return { id: provider.id, name: provider.name, mode: provider.mode, documentationUrl: provider.documentationUrl,
          services: provider.services.map(({ id, name, description }) => ({ id, name, description })), ...(setupReason ? { setupReason } : {}) };
      })), { headers: JSON_HEADERS });
    }
    if (route.startsWith("oauth/client/") && request.method === "GET") {
      const providerId = PluginProviderId.parse(route.slice("oauth/client/".length));
      if (!PLUGIN_PROVIDERS[providerId].clientMetadata) throw new BrokerError(404, "No public client metadata for this provider.");
      const origin = publisherOrigin();
      return Response.json({ client_id: `${origin}/api/plugins/oauth/client/${providerId}`, client_name: "Omarchy Bot", client_uri: origin,
        redirect_uris: [`${origin}/api/plugins/oauth/callback`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    }
    if (route === "oauth/start" && request.method === "POST") {
      const body = StartBody.parse(await readBody(request));
      callbackUrl(body.callbackUrl);
      const origin = publisherOrigin();
      const provider = PLUGIN_PROVIDERS[body.providerId];
      const credentials = clientCredentials(body.providerId, origin);
      const scopes = [...new Set([...provider.identityScopes, ...provider.services.flatMap((service) => service.scopes)])];
      const nonce = crypto.randomUUID();
      const state = await new SignJWT({ ...body, clientId: credentials.clientId, scopes, nonce })
        .setProtectedHeader({ alg: "HS256" }).setIssuer(origin).setAudience(STATE_AUDIENCE).setIssuedAt().setExpirationTime("15m").sign(stateKey());
      const authorize = new URL(provider.authorizeUrl);
      authorize.search = new URLSearchParams({ ...provider.authorizeParams, client_id: credentials.clientId,
        redirect_uri: `${origin}/api/plugins/oauth/callback`, response_type: "code", state,
        ...(scopes.length ? { scope: scopes.join(provider.scopeSeparator ?? " ") } : {}),
        ...(provider.pkce ? { code_challenge: body.challenge, code_challenge_method: "S256" } : {}),
        ...(provider.id === "google" ? { nonce } : {}),
      }).toString();
      return new Response(JSON.stringify({ url: authorize.href }), { headers: JSON_HEADERS });
    }
    if (route === "oauth/callback" && request.method === "GET") {
      const signedState = url.searchParams.get("state");
      if (!signedState) throw new BrokerError(400, "Missing OAuth state.");
      const state = await verifyState(signedState);
      const destination = callbackUrl(state.callbackUrl);
      destination.searchParams.set("state", state.localState);
      const code = url.searchParams.get("code");
      if (code) { destination.searchParams.set("code", code); destination.searchParams.set("brokerState", signedState); }
      else destination.searchParams.set("error", "authorization_denied");
      return new Response(null, { status: 303, headers: { ...JSON_HEADERS, location: destination.href } });
    }
    if (route === "oauth/token" && request.method === "POST") return await tokenExchange(TokenBody.parse(await readBody(request)));
    if ((route === "catalog" || route === "catalog/detail") && request.method === "GET") {
      let token: string;
      try { token = await getVercelOidcToken(); } catch { throw new BrokerError(503, "Enable Vercel OIDC federation. Local development also requires an authenticated, linked Vercel project."); }
      let upstream: URL;
      if (route === "catalog/detail") {
        const id = url.searchParams.get("id") ?? "";
        const parts = id.split("/");
        if (parts.length < 2 || parts.length > 3 || parts.some((part, index) => !part || part === "." || part === ".." || !(index === parts.length - 1 ? /^[A-Za-z0-9_.:-]+$/ : /^[A-Za-z0-9_.-]+$/).test(part))) throw new BrokerError(400, "Invalid skill identity.");
        upstream = new URL(`https://skills.sh/api/v1/skills/${parts.map(encodeURIComponent).join("/")}`);
      } else {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (query.length === 1 || query.length > 256) throw new BrokerError(400, "Search needs 2–256 characters.");
        upstream = new URL(query ? "https://skills.sh/api/v1/skills/search" : "https://skills.sh/api/v1/skills");
        if (query) { upstream.searchParams.set("q", query); upstream.searchParams.set("limit", String(SKILL_SEARCH_LIMIT)); }
        else {
          const page = url.searchParams.get("cursor") ?? "0";
          const view = url.searchParams.get("view") ?? "trending";
          if (!/^\d{1,8}$/.test(page) || !["all-time", "trending", "hot"].includes(view)) throw new BrokerError(400, "Invalid catalog pagination.");
          upstream.search = new URLSearchParams({ view, page, per_page: String(SKILL_CATALOG_PAGE_SIZE) }).toString();
        }
      }
      const response = await fetch(upstream, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000), redirect: "error" });
      const headers = new Headers({ "content-type": "application/json", "referrer-policy": "no-referrer" });
      for (const name of ["cache-control", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
        const value = response.headers.get(name); if (value) headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    }
    return new Response(JSON.stringify({ error: "Unknown publisher endpoint." }), { status: 404, headers: JSON_HEADERS });
  } catch (error) {
    const invalidRequest = error instanceof z.ZodError || error instanceof joseErrors.JOSEError;
    const status = error instanceof BrokerError ? error.status : invalidRequest ? 400 : 502;
    const message = status === 503 ? "This service is temporarily unavailable. Please try again later." : error instanceof BrokerError ? error.message : invalidRequest ? "Invalid or expired authorization request." : "Publisher upstream request failed.";
    return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
  }
}
