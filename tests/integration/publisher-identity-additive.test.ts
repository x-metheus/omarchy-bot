import { expect, test } from "bun:test";
import { ProviderAccounts, type ProviderAccount, type Grant } from "../../apps/daemon/src/modules/plugins/providerAccounts.ts";
import type { CatalogClient } from "../../apps/daemon/src/modules/plugins/catalogClient.ts";
import type { NativeMcpStore } from "../../apps/daemon/src/modules/plugins/nativeMcp.ts";

/** A publisher that grew new identity fields. The daemon must accept the response and ignore them. */
const identityWithExtraFields = { subject: "google-subject", tid: "tenant", oid: "user", email: "person@example.invalid" };

function hostWith(accounts: ProviderAccount[], token: Record<string, unknown>) {
  const sent: { localState?: string | undefined } = {};
  const host = {
    cwd: "/",
    mcp: { serviceConnections: () => [] } as unknown as NativeMcpStore,
    publisher: {
      request: async (route: string, body?: unknown) => {
        if (route === "oauth/start") {
          sent.localState = typeof body === "object" && body !== null && "localState" in body && typeof body.localState === "string" ? body.localState : undefined;
          return { url: "https://accounts.google.com/o/oauth2/v2/auth?state=broker-state" };
        }
        if (route === "oauth/token") return token;
        throw new Error(`unexpected publisher route ${route}`);
      },
    } as unknown as CatalogClient,
    accounts: () => accounts,
    cloudUrl: () => "https://publisher.example",
    ready: async () => undefined,
    persist: () => undefined,
    provision: async () => undefined,
    serviceName: (account: ProviderAccount, serviceId: string) => `service-${account.id}-${serviceId}`,
    change: () => 1,
    release: () => undefined,
    authorizeMcp: async () => ({}),
    checkMcp: async () => undefined,
  };
  return { host, sent };
}

test("token refresh accepts a publisher identity with extra fields and keeps the grant usable", async () => {
  const accounts: ProviderAccount[] = [];
  const grant: Grant = {
    generation: "gen", accessToken: "stale", refreshToken: "refresh", expiresAt: Date.now() - 1_000,
    scopes: ["openid"], cloudUrl: "https://publisher.example", metadata: {},
  };
  const { host } = hostWith(accounts, {
    access_token: "fresh", refresh_token: "refresh-2", expires_in: 3600,
    identity: identityWithExtraFields, future_claim: "ignore-me",
  });
  const token = await new ProviderAccounts(host).token("google", grant);
  expect(token).toBe("fresh");
  expect(grant.accessToken).toBe("fresh");
  expect(grant.refreshToken).toBe("refresh-2");
});

test("authorization accepts a publisher identity with extra fields, ignores them, and still requires a subject", async () => {
  const accounts: ProviderAccount[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://openidconnect.googleapis.com") return Response.json({ sub: "google-subject", email: "person@example.invalid" });
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  try {
    const { host, sent } = hostWith(accounts, {
      access_token: "access", refresh_token: "refresh", expires_in: 3600,
      scope: "openid https://www.googleapis.com/auth/drive.readonly",
      identity: identityWithExtraFields,
    });
    const api = new ProviderAccounts(host);
    await api.authorize({ providerId: "google", returnUrl: "https://client.example/" });
    const finished = await api.finishAuthorization(new URL(`https://client.example/callback?state=${sent.localState}&code=code&brokerState=broker-state`));
    expect(finished.label).toBe("person@example.invalid");
    const stored = accounts[0]!.grant!.metadata.identity;
    expect(stored).toEqual({ subject: "google-subject" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { host, sent } = hostWith([], { access_token: "access", identity: { tid: "tenant" } });
  const strict = new ProviderAccounts(host);
  await strict.authorize({ providerId: "google", returnUrl: "https://client.example/" });
  await expect(strict.finishAuthorization(new URL(`https://client.example/callback?state=${sent.localState}&code=code&brokerState=broker-state`))).rejects.toThrow();
});
