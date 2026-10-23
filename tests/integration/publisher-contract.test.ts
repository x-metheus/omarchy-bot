import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { PLUGIN_OPERATIONS, PLUGIN_PROVIDERS } from "../../packages/protocol/src/index.ts";
import { PluginsService } from "../../apps/daemon/src/modules/plugins/plugins.ts";
import { handlePluginCloudRequest } from "../../apps/site/server/plugins.ts";
import { identifyAccount, ProviderAccounts, type ProviderAccount } from "../../apps/daemon/src/modules/plugins/providerAccounts.ts";
import { ServiceBundles, type BundleAccount } from "../../apps/daemon/src/modules/plugins/serviceBundles.ts";
import { NativeMcpStore } from "../../apps/daemon/src/modules/plugins/nativeMcp.ts";
import { NativeSkills } from "../../apps/daemon/src/modules/plugins/nativeSkills.ts";
import type { CatalogClient } from "../../apps/daemon/src/modules/plugins/catalogClient.ts";

test("microsoft and miro identity lookup refuses before any fetch", async () => {
  const seen: string[] = [];
  const lookup = async () => { seen.push("identity-lookup"); throw new Error("identity lookup"); };
  for (const id of ["microsoft", "miro"] as const) {
    await expect(identifyAccount(id, { accessToken: "x", scopes: [], metadata: {} }, "/", lookup)).rejects.toMatchObject({ status: 409 });
  }
  expect(seen).toEqual([]);
});
test("new daemons read the normalised catalog while the raw skills.sh route stays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-contract-"));
  const publisher = "https://publisher-contract.invalid";
  const originalFetch = globalThis.fetch;
  const previous = {
    url: process.env.PLUGIN_CLOUD_URL, secret: process.env.OAUTH_STATE_SECRET,
    oidc: process.env.VERCEL_OIDC_TOKEN,
  };
  process.env.PLUGIN_CLOUD_URL = publisher;
  process.env.OAUTH_STATE_SECRET = "publisher-contract-secret-at-least-32b";
  process.env.VERCEL_OIDC_TOKEN = "fixture-oidc";
  const seen: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === publisher) return handlePluginCloudRequest(new Request(url, init));
    seen.push(url.href);
    if (url.hostname === "skills.sh" && url.pathname === "/api/v1/skills") {
      return Response.json({
        data: [{ id: "owner/repo/fixture-skill", name: "Fixture", source: "owner/repo", installs: 3, undocumented: true }],
        pagination: { page: 2, perPage: 12, total: 30, hasMore: false },
      });
    }
    return new Response(null, { status: 404 });
  }, { preconnect: originalFetch.preconnect });
  const service = new PluginsService(root, root, async () => ({ skills: [] }));
  try {
    service.configure(publisher);
    const raw = await handlePluginCloudRequest(new Request(`${publisher}/api/plugins/catalog?cursor=2&view=hot`));
    expect(raw.status).toBe(200);
    expect(await raw.json()).toMatchObject({ data: [{ undocumented: true }] });
    delete process.env.VERCEL_OIDC_TOKEN;
    const unavailable = await handlePluginCloudRequest(new Request(`${publisher}/api/plugins/catalog?cursor=2&view=hot`));
    expect(unavailable.status).toBe(503);
    process.env.VERCEL_OIDC_TOKEN = "fixture-oidc";
    const catalog = await service.catalog("", "2", "hot");
    expect(catalog).toEqual({
      skills: [{
        id: "owner/repo/fixture-skill", name: "Fixture", description: "", source: "owner/repo",
        sourceType: "github", installUrl: "https://github.com/owner/repo", installs: 3,
      }],
      total: 30, pageSize: 12,
    });
    expect(seen.some((href) => href.startsWith("https://skills.sh/api/v1/skills?"))).toBe(true);
    expect(seen.some((href) => href.includes("/api/plugins/catalog"))).toBe(false);
  } finally {
    await service.shutdown();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ PLUGIN_CLOUD_URL: previous.url, OAUTH_STATE_SECRET: previous.secret, VERCEL_OIDC_TOKEN: previous.oidc })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("one operation table names every manage_plugins action and its daemon path", () => {
  const actions = [...new Set(PLUGIN_OPERATIONS.map((operation) => operation.action))];
  expect(actions).toEqual([
    "list", "inspect", "inspect_skill", "search_skills", "install_skill", "enable_skill", "remove_skill", "update_skills",
    "authorize_service", "enable_service", "remove_service", "update_service", "label_account", "disconnect_account",
    "save_mcp", "update_mcp", "enable_mcp", "remove_mcp", "check_mcp", "authorize_mcp",
  ]);
  expect(PLUGIN_OPERATIONS).toHaveLength(actions.length + 1);
  expect(new Set(PLUGIN_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`)).size).toBe(PLUGIN_OPERATIONS.length);
  expect(PLUGIN_OPERATIONS.find((operation) => operation.method === "PUT")).toMatchObject({ action: "save_mcp", path: "/api/plugins/mcp/:id" });
  expect(PLUGIN_OPERATIONS.find((operation) => operation.action === "search_skills")).toMatchObject({
    method: "GET", path: "/api/plugins/catalog", upstream: "catalog/normalised",
  });
  expect(PLUGIN_OPERATIONS.find((operation) => operation.action === "inspect_skill")).toMatchObject({ upstream: "catalog/detail/normalised" });
});

test("manage_plugins publishes each action once and accepts view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-schema-"));
  const service = new PluginsService(root, root, async () => ({ skills: [] }));
  try {
    const lease = await service.acquire();
    const schema = lease.snapshot.tools[0]!.inputSchema as { properties: { action: { enum?: string[]; anyOf?: Array<{ const: string }> }; view?: unknown } };
    const actions = schema.properties.action.enum ?? schema.properties.action.anyOf?.map((item) => item.const) ?? [];
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toHaveLength(20);
    expect(schema.properties.view).toEqual({ type: "string" });
    lease.release();
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
test("native authorize never calls the publisher token endpoint", async () => {
  const routes: string[] = [];
  const accounts: ProviderAccount[] = [];
  const accountsApi = new ProviderAccounts({
    cwd: "/", mcp: { serviceConnections: () => [{ id: "mcp_workiq", name: `service-${accounts[0]?.id ?? "pending"}-workiq` }] } as unknown as NativeMcpStore,
    publisher: { request: async (route: string) => { routes.push(route); throw new Error(route); } } as unknown as CatalogClient,
    accounts: () => accounts, cloudUrl: () => "https://publisher.example", ready: async () => undefined, persist: () => undefined,
    provision: async () => undefined, serviceName: (account, serviceId) => `service-${account.id}-${serviceId}`, change: () => 1, release: () => undefined,
    authorizeMcp: async () => ({ authorizationUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=fixture" }),
    checkMcp: async () => undefined,
  });
  const started = await accountsApi.authorize({ providerId: "microsoft", returnUrl: "https://client.example/", serviceId: "workiq" });
  expect(started.url).toContain("login.microsoftonline.com");
  expect(routes).toEqual([]);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]!.grant).toBeUndefined();
});

test("bundle enable remove and update mutate the account store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bundle-module-"));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "miro-skill");
  await mkdir(path.join(source, "scripts"), { recursive: true });
  await Bun.write(path.join(source, "SKILL.md"), "---\nname: miro-fixture\ndescription: Fixture board skill\n---\nUse the bundled script.\n");
  const published = PLUGIN_PROVIDERS.miro.services;
  PLUGIN_PROVIDERS.miro.services = [{ ...published[0]!, skillSources: [source] }];
  const account: BundleAccount = { id: "account_miro", providerId: "miro", enabledServices: [], status: "connected", bundleErrors: {}, native: { serviceId: "miro", name: "service-account_miro-miro" } };
  const accounts = [account];
  const persisted: boolean[] = [];
  const mcp = new NativeMcpStore(workspace, root);
  const skills = new NativeSkills(workspace, root);
  const bundles = new ServiceBundles({
    rootDir: root, mcp, skills, accounts: () => accounts, stopping: () => false, ready: async () => undefined,
    token: async () => { throw new Error("native bundle must not refresh a publisher token"); },
    persist: (changed) => { persisted.push(changed ?? false); }, clearNative: () => undefined,
    removeUnused: async () => undefined,
    accountDto: (entry) => ({ id: entry.id, providerId: entry.providerId, label: entry.id, identity: entry.id, enabledServices: entry.enabledServices, grantedScopes: [], status: entry.status }),
  });
  try {
    const enabled = await bundles.enable(account.id, "miro", true);
    expect(enabled.enabledServices).toEqual(["miro"]);
    expect(mcp.serviceConnections(account.id).map((connection) => connection.name)).toEqual(["service-account_miro-miro"]);
    expect(skills.list().some((skill) => skill.serviceId === "miro/miro" && skill.enabled)).toBe(true);
    await bundles.update(account.id, "miro");
    await bundles.remove(account.id, "miro");
    expect(account.enabledServices).toEqual([]);
    expect(mcp.serviceConnections(account.id)).toEqual([]);
    expect(skills.list().some((skill) => skill.serviceId === "miro/miro")).toBe(false);
    expect(persisted.some(Boolean)).toBe(true);
  } finally {
    PLUGIN_PROVIDERS.miro.services = published;
    await rm(root, { recursive: true, force: true });
  }
});
