import { expect, test } from "bun:test";
import { handlePluginCloudRequest } from "../server/plugins.ts";

test("the publisher serves the raw and normalised catalog through its existing routes", async () => {
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
    seen.push(url.href);
    if (url.hostname === "skills.sh" && url.pathname === "/api/v1/skills") {
      return Response.json({
        data: [{ id: "owner/repo/fixture-skill", name: "Fixture", source: "owner/repo", installs: 3, undocumented: true }],
        pagination: { page: 2, perPage: 12, total: 30, hasMore: false },
      });
    }
    return new Response(null, { status: 404 });
  }, { preconnect: originalFetch.preconnect });
  try {
    const raw = await handlePluginCloudRequest(new Request(`${publisher}/api/plugins/catalog?cursor=2&view=hot`));
    expect(raw.status).toBe(200);
    expect(await raw.json()).toMatchObject({ data: [{ undocumented: true }] });
    delete process.env.VERCEL_OIDC_TOKEN;
    const unavailable = await handlePluginCloudRequest(new Request(`${publisher}/api/plugins/catalog?cursor=2&view=hot`));
    expect(unavailable.status).toBe(503);
    process.env.VERCEL_OIDC_TOKEN = "fixture-oidc";
    const normalised = await handlePluginCloudRequest(new Request(`${publisher}/api/plugins/catalog/normalised?cursor=2&view=hot`));
    expect(normalised.status).toBe(200);
    expect(await normalised.json()).toEqual({
      skills: [{ id: "owner/repo/fixture-skill", name: "Fixture", source: "owner/repo",
        sourceType: "github", installUrl: "https://github.com/owner/repo", installs: 3 }],
      pagination: { page: 2, perPage: 12, total: 30, hasMore: false },
    });
    expect(seen.some((href) => href.startsWith("https://skills.sh/api/v1/skills?"))).toBe(true);
    expect(seen.some((href) => href.includes("/api/plugins/catalog"))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ PLUGIN_CLOUD_URL: previous.url, OAUTH_STATE_SECRET: previous.secret, VERCEL_OIDC_TOKEN: previous.oidc })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
