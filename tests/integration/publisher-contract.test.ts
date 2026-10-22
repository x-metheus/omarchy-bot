import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PLUGIN_OPERATIONS, PLUGIN_PROVIDERS } from "../../packages/protocol/src/index.ts";
import { PluginsService } from "../../apps/daemon/src/modules/plugins/plugins.ts";
import { handlePluginCloudRequest } from "../../apps/site/server/plugins.ts";
import { identifyAccount } from "../../apps/daemon/src/modules/plugins/providerAccounts.ts";

test("microsoft and miro authorization never looks up a publisher identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-native-"));
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request, _init?: RequestInit) => {
    seen.push(new URL(input instanceof Request ? input.url : String(input)).href);
    return new Response(null, { status: 404 });
  }, { preconnect: originalFetch.preconnect });
  const service = new PluginsService(root, root, async () => ({ skills: [] }));
  const lookup = async () => { seen.push("identity-lookup"); throw new Error("identity lookup"); };
  try {
    for (const id of ["microsoft", "miro"] as const) {
      await expect(identifyAccount(id, { accessToken: "x", scopes: [], metadata: {} }, root, lookup)).rejects.toMatchObject({ status: 409 });
    }
    expect(seen.some((url) => url === "identity-lookup" || url.includes("graph.microsoft") || url.includes("api.miro.com") || url.includes("/oauth/token") || url.includes("login.microsoftonline"))).toBe(false);
  } finally {
    await service.shutdown();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
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
