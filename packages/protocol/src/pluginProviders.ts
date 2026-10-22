import type { PluginProviderDto, PluginProviderId, PluginServiceDto } from "./plugins.ts";

export interface PluginServiceDefinition extends PluginServiceDto {
  scopes: string[];
  mcpUrl?: string;
  skillSources?: string[];
}
export interface PluginProviderDefinition extends Omit<PluginProviderDto, "services"> {
  services: PluginServiceDefinition[];
  authorizeUrl: string;
  tokenUrl: string;
  identityScopes: string[];
  tokenAuth: "post" | "none";
  tokenEncoding?: "json";
  pkce: boolean;
  scopeSeparator?: ",";
  authorizeParams?: Record<string, string>;
  clientMetadata?: boolean;
  publisherOAuth: boolean;
  nativeOAuth?: { publicClientId?: string; redirectPort?: number; authServerMetadataUrl?: string };
  registrationNote: string;
}

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/";

/** Official provider contracts; native OAuth state and publisher credentials remain private. */
export const PLUGIN_PROVIDERS: Record<PluginProviderId, PluginProviderDefinition> = {
  google: {
    id: "google", name: "Google", mode: "mcp",
    documentationUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
    identityScopes: ["openid", "email", "profile"], tokenAuth: "post", pkce: true,
    publisherOAuth: true,
    authorizeParams: { access_type: "offline", include_granted_scopes: "true", prompt: "consent select_account" },
    registrationNote: "Register a Web OAuth client and enable the three Workspace APIs and their MCP services. Restricted-scope verification and any applicable security assessment are required for public distribution.",
    services: [
      { id: "google-drive", name: "Google Drive", description: "Search and read files; create or update app-authorized files.",
        scopes: [`${GOOGLE_SCOPE}drive.readonly`, `${GOOGLE_SCOPE}drive.file`], mcpUrl: "https://drivemcp.googleapis.com/mcp/v1" },
      { id: "gmail", name: "Gmail", description: "Search and read mail; compose drafts through the available MCP tools.",
        scopes: [`${GOOGLE_SCOPE}gmail.readonly`, `${GOOGLE_SCOPE}gmail.compose`], mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1" },
      { id: "google-calendar", name: "Google Calendar", description: "Discover calendars, read events, and check availability.",
        scopes: [`${GOOGLE_SCOPE}calendar.calendarlist.readonly`, `${GOOGLE_SCOPE}calendar.events.readonly`, `${GOOGLE_SCOPE}calendar.events.freebusy`],
        mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1" },
    ],
  },
  microsoft: {
    id: "microsoft", name: "Microsoft", mode: "mcp", documentationUrl: "https://github.com/microsoft/work-iq/tree/main/plugins/workiq",
    authorizeUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize", tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    identityScopes: ["openid", "profile", "email", "offline_access"], tokenAuth: "none", pkce: true, publisherOAuth: false,
    nativeOAuth: {
      publicClientId: "ba081686-5d24-4bc6-a0d6-d034ecffed87", redirectPort: 12798,
      authServerMetadataUrl: "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
    },
    registrationNote: "WorkIQ uses Microsoft’s published public client with organizational Microsoft 365 and Copilot licenses, tenant-admin consent, and MCP service provisioning. Personal accounts and old Graph grants are not equivalent. Native client callback and secure discovery support must be available.",
    services: [
      { id: "workiq", name: "WorkIQ", description: "Query and act on Microsoft 365 work content through the tools permitted by WorkIQ and tenant policy.",
        scopes: ["fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask"], mcpUrl: "https://workiq.svc.cloud.microsoft/mcp",
        skillSources: ["https://github.com/microsoft/work-iq/tree/main/plugins/workiq/skills/workiq"] },
    ],
  },
  notion: {
    id: "notion", name: "Notion", mode: "mcp", documentationUrl: "https://developers.notion.com/guides/mcp/build-mcp-client",
    authorizeUrl: "https://mcp.notion.com/authorize", tokenUrl: "https://mcp.notion.com/token", identityScopes: [], tokenAuth: "none", pkce: true, clientMetadata: true,
    publisherOAuth: true, nativeOAuth: {},
    registrationNote: "Native OAuth supports dynamic registration; the publisher may alternatively use Notion’s public Client ID Metadata Document flow with PKCE. Workspace policy, plan and individual tool entitlements still apply.",
    services: [{ id: "notion", name: "Notion", description: "Work with authorized workspace content through Notion MCP.", scopes: ["default"], mcpUrl: "https://mcp.notion.com/mcp",
      skillSources: [
        "https://github.com/makenotion/claude-code-notion-plugin/tree/main/skills/notion/knowledge-capture",
        "https://github.com/makenotion/claude-code-notion-plugin/tree/main/skills/notion/meeting-intelligence",
        "https://github.com/makenotion/claude-code-notion-plugin/tree/main/skills/notion/research-documentation",
        "https://github.com/makenotion/claude-code-notion-plugin/tree/main/skills/notion/spec-to-implementation",
      ] }],
  },
  github: {
    id: "github", name: "GitHub", mode: "mcp", documentationUrl: "https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md",
    authorizeUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", identityScopes: ["read:user"], tokenAuth: "post", pkce: true,
    publisherOAuth: true,
    authorizeParams: { prompt: "select_account" },
    registrationNote: "Register a publisher GitHub OAuth App. Repository scopes are broad; organization approval, SSO and tool-specific permissions still apply.",
    services: [{ id: "github", name: "GitHub", description: "Repositories, issues, pull requests, and organization context.", scopes: ["repo", "read:org"], mcpUrl: "https://api.githubcopilot.com/mcp/" }],
  },
  linear: {
    id: "linear", name: "Linear", mode: "mcp", documentationUrl: "https://linear.app/docs/mcp",
    authorizeUrl: "https://linear.app/oauth/authorize", tokenUrl: "https://api.linear.app/oauth/token", identityScopes: [], tokenAuth: "post", pkce: true, scopeSeparator: ",",
    authorizeParams: { prompt: "consent" },
    publisherOAuth: true, nativeOAuth: {},
    registrationNote: "Native OAuth supports dynamic registration without publisher credentials. A registered Linear OAuth app is an optional bearer-grant route. Each authentication context is bound to one workspace; write tools require write permission.",
    services: [{ id: "linear", name: "Linear", description: "Read and update issues and project work in the authorized workspace.", scopes: ["read", "write"], mcpUrl: "https://mcp.linear.app/mcp",
      skillSources: ["https://github.com/linear/linear-solutions/tree/main/Skills/stale-labels"] }],
  },
  asana: {
    id: "asana", name: "Asana", mode: "mcp", documentationUrl: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
    authorizeUrl: "https://app.asana.com/-/oauth_authorize", tokenUrl: "https://app.asana.com/-/oauth_token", identityScopes: [], tokenAuth: "post", pkce: true,
    publisherOAuth: true,
    authorizeParams: { resource: "https://mcp.asana.com/v2" },
    registrationNote: "Register an Asana MCP app, not an API app, and configure workspace distribution. MCP tokens cannot call Asana REST APIs; some tools require paid plans.",
    services: [{ id: "asana", name: "Asana", description: "Tasks and projects in the workspace selected during authorization.", scopes: [], mcpUrl: "https://mcp.asana.com/v2/mcp" }],
  },
  dropbox: {
    id: "dropbox", name: "Dropbox", mode: "mcp", documentationUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize", tokenUrl: "https://api.dropboxapi.com/oauth2/token", identityScopes: ["account_info.read"], tokenAuth: "post", pkce: true,
    publisherOAuth: true,
    authorizeParams: { token_access_type: "offline" },
    registrationNote: "Register a Scoped access / Full Dropbox application for this publisher. Arbitrary-client DCR is restricted; production approval and team policy apply.",
    services: [{ id: "dropbox", name: "Dropbox", description: "Files, folders, search, sharing, and file requests.", scopes: ["files.metadata.read", "files.content.read", "files.content.write", "sharing.write", "sharing.read", "file_requests.read", "file_requests.write"], mcpUrl: "https://mcp.dropbox.com/mcp" }],
  },
  hubspot: {
    id: "hubspot", name: "HubSpot", mode: "mcp", documentationUrl: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    authorizeUrl: "https://mcp.hubspot.com/oauth/authorize/user", tokenUrl: "https://mcp.hubspot.com/oauth/v3/token", identityScopes: [], tokenAuth: "post", pkce: true,
    publisherOAuth: true,
    registrationNote: "Register a HubSpot MCP auth app. Do not use an ordinary CRM app or hardcode its scopes; MCP grants and record permissions are provider-managed. Sensitive Data enabled blocks activity and conversation data; marketing drafts do not imply sending.",
    services: [{ id: "hubspot", name: "HubSpot", description: "CRM tools governed by the authorizing user’s record permissions.", scopes: [], mcpUrl: "https://mcp.hubspot.com/" }],
  },
  intercom: {
    id: "intercom", name: "Intercom", mode: "mcp", documentationUrl: "https://developers.intercom.com/docs/guides/mcp",
    authorizeUrl: "https://app.intercom.com/oauth", tokenUrl: "https://api.intercom.io/auth/eagle/token", identityScopes: [], tokenAuth: "post", tokenEncoding: "json", pkce: false,
    publisherOAuth: true, nativeOAuth: {},
    registrationNote: "Native MCP OAuth supports dynamic registration and refresh without a publisher app. Select the workspace region before authentication: US or EU; Australian workspaces are unsupported. The optional registered API OAuth route here is US-only and has no documented refresh grant; EU API OAuth requires its regional authorization host. Tools support internal notes, not customer-visible replies.",
    services: [
      { id: "intercom", name: "Intercom (US)", description: "US workspace contacts, conversations, articles, and internal notes.", scopes: [], mcpUrl: "https://mcp.intercom.com/mcp" },
      { id: "intercom-eu", name: "Intercom (EU)", description: "EU workspace contacts, conversations, articles, and internal notes.", scopes: [], mcpUrl: "https://mcp.eu.intercom.com/mcp" },
    ],
  },
  miro: {
    id: "miro", name: "Miro", mode: "mcp", documentationUrl: "https://developers.miro.com/docs/connecting-to-miro-mcp",
    authorizeUrl: "https://mcp.miro.com/authorize", tokenUrl: "https://mcp.miro.com/token", identityScopes: ["openid", "email"], tokenAuth: "post", pkce: true,
    publisherOAuth: false, nativeOAuth: {},
    registrationNote: "Official MCP supports dynamic registration on all plans; Enterprise must enable MCP and board permissions still apply. Published OAuth and OIDC metadata conflict: secure client authentication and verified identity require live confirmation, not validation bypasses. Team authorization may supersede an earlier connection.",
    services: [{ id: "miro", name: "Miro", description: "Read boards and work with the objects, comments, and diagrams exposed by official Miro MCP.", scopes: ["boards:read", "boards:write"], mcpUrl: "https://mcp.miro.com/",
      skillSources: [
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-browse",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-code-explain-on-board",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-code-review",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-code-spec",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-diagram",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-doc",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-format",
        "https://github.com/miroapp/miro-ai/tree/main/skills/miro-table",
      ] }],
  },
};
