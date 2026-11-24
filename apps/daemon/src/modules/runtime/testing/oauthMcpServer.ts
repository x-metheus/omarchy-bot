import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export async function startOAuthMcpServer({
  tokenTtlSeconds = 3600,
  denyAuthorization = false,
  toolName = "read_fixture",
  toolText = "OAuth MCP fixture result",
  fixedAuthorization,
  echoAuthorization = false,
  issueAccessToken = () => crypto.randomUUID(),
  beforeTokenResponse,
  challengeScope,
  preRegisteredClient,
}: {
  tokenTtlSeconds?: number;
  denyAuthorization?: boolean;
  toolName?: string;
  toolText?: string;
  fixedAuthorization?: string;
  echoAuthorization?: boolean;
  issueAccessToken?: () => string;
  beforeTokenResponse?: (grant: "authorization_code" | "refresh_token") => Promise<void>;
  challengeScope?: string;
  preRegisteredClient?: { clientId: string; redirectUri: string };
} = {}) {
  const counts = { authorize: 0, token: 0, toolCalls: 0, unauthorized: 0, refresh: 0, oauthRequests: 0, register: 0, configuredMetadata: 0 };
  const observedAuthorization = new Set<string | null>();
  const authorizationRequests: { clientId: string; redirectUri: string; scope: string | null }[] = [];
  const registeredClientNames: (string | undefined)[] = [];
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const refreshTokens = new Map<string, string>();
  const accessTokens = new Map<string, string>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    async fetch(request) {
      const { pathname, origin, searchParams } = new URL(request.url);
      switch (`${request.method} ${pathname}`) {
        case "GET /.well-known/oauth-protected-resource":
        case "GET /.well-known/oauth-protected-resource/mcp":
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
        case "GET /oauth-metadata":
        case "GET /.well-known/oauth-authorization-server":
          if (pathname === "/oauth-metadata") counts.configuredMetadata++;
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            authorization_response_iss_parameter_supported: true,
          });
        case "POST /register": {
          counts.register++;
          if (preRegisteredClient) return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
          const { redirect_uris: redirects, client_name: clientName } = await request.json() as { redirect_uris?: string[]; client_name?: string };
          if (!Array.isArray(redirects) || !redirects.length || !redirects.every((uri) => loopbackRedirect(uri))) {
            return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
          }
          const clientId = crypto.randomUUID();
          clients.set(clientId, redirects);
          registeredClientNames.push(clientName);
          return Response.json({
            client_id: clientId, redirect_uris: redirects, token_endpoint_auth_method: "none",
          }, { status: 201 });
        }
        case "GET /authorize": {
          counts.authorize++;
          const redirectUri = searchParams.get("redirect_uri") ?? "";
          const redirect = loopbackRedirect(redirectUri);
          const state = searchParams.get("state");
          const clientId = searchParams.get("client_id") ?? "";
          const challenge = searchParams.get("code_challenge");
          authorizationRequests.push({ clientId, redirectUri, scope: searchParams.get("scope") });
          const registered = preRegisteredClient
            ? preRegisteredClient.clientId === clientId && preRegisteredClient.redirectUri === redirectUri
            : clients.get(clientId)?.includes(redirectUri);
          if (!redirect || !state || !challenge || !registered ||
            searchParams.get("response_type") !== "code" || searchParams.get("code_challenge_method") !== "S256") {
            return new Response(null, { status: 400 });
          }
          redirect.searchParams.set("state", state);
          if (denyAuthorization) {
            redirect.searchParams.set("error", "access_denied");
            redirect.searchParams.set("error_description", "Private fixture denial detail");
          } else {
            const code = crypto.randomUUID();
            codes.set(code, { clientId, redirectUri, challenge });
            redirect.searchParams.set("code", code);
            redirect.searchParams.set("iss", origin);
          }
          return Response.redirect(redirect, 302);
        }
        case "POST /token": {
          const form = new URLSearchParams(await request.text());
          const clientId = form.get("client_id") ?? "";
          const invalidGrant = () => Response.json({ error: "invalid_grant" }, { status: 400 });
          const grant = form.get("grant_type");
          switch (grant) {
            case "authorization_code": {
              counts.token++;
              const code = form.get("code") ?? "";
              const authorization = codes.get(code);
              const verifier = form.get("code_verifier") ?? "";
              if (!authorization || authorization.clientId !== clientId ||
                authorization.redirectUri !== form.get("redirect_uri") || !verifier ||
                authorization.challenge !== createHash("sha256").update(verifier).digest("base64url")) {
                return invalidGrant();
              }
              codes.delete(code);
              break;
            }
            case "refresh_token": {
              counts.refresh++;
              const refreshToken = form.get("refresh_token") ?? "";
              if (refreshTokens.get(refreshToken) !== clientId) return invalidGrant();
              refreshTokens.delete(refreshToken);
              break;
            }
            default:
              return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
          }
          await beforeTokenResponse?.(grant);
          const accessToken = issueAccessToken();
          accessTokens.set(clientId, accessToken);
          const refreshToken = crypto.randomUUID();
          refreshTokens.set(refreshToken, clientId);
          return Response.json({
            access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: tokenTtlSeconds,
          });
        }
      }
      if (pathname !== "/mcp") return new Response(null, { status: 404 });
      const authorization = request.headers.get("authorization");
      observedAuthorization.add(authorization);
      const usesOAuth = [...accessTokens.values()].some((token) => authorization === `Bearer ${token}`);
      if (usesOAuth) counts.oauthRequests++;
      if (fixedAuthorization === undefined ? !usesOAuth : authorization !== fixedAuthorization) {
        counts.unauthorized++;
        const scope = challengeScope ? `, scope="${challengeScope}"` : "";
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"${scope}` },
        });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      // JSON responses need no server-initiated stream or persistent transport.
      const fixture = new McpServer({ name: "oauth-fixture", version: "1" });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const echoedAuthorization = authorization?.includes("/")
        ? `${authorization}; escaped: ${authorization.replaceAll("/", "\\/")}` : authorization;
      fixture.registerTool(toolName, {}, () => {
        counts.toolCalls++;
        return { content: [{ type: "text", text: echoAuthorization ? `Header: ${echoedAuthorization}` : toolText }] };
      });
      if (echoAuthorization) fixture.registerTool("echo_error", {}, () => {
        counts.toolCalls++;
        return { isError: true, content: [{ type: "text", text: `Error header: ${echoedAuthorization}` }] };
      });
      await fixture.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await fixture.close();
      }
    },
  });
  return {
    url: new URL("/mcp", server.url).href,
    origin: server.url.origin,
    counts,
    observedAuthorization,
    authorizationRequests,
    registeredClientNames,
    setChallengeScope(scope: string) { challengeScope = scope; },
    deny() { denyAuthorization = true; },
    rotateAccessToken() { accessTokens.clear(); },
    async close() { await server.stop(true); },
  };
}

function loopbackRedirect(value: string): URL | undefined {
  const url = URL.parse(value);
  if (url?.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port && url.pathname !== "/" &&
    !url.username && !url.password && !url.search && !url.hash) return url;
}
