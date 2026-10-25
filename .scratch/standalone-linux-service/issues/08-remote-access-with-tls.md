# 08: Remote access with TLS

**What to build:** A Service can be reached from another machine: binding a non-loopback address requires an operator certificate or a declared trusted TLS-terminating proxy, and startup is refused otherwise. A remote Paired Device can use every feature, including plugin account OAuth.

**Blocked by:** 06

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] Non-loopback bind without certificate or declared proxy fails startup with a clear error (Seam 1).
- [x] With a certificate, HTTPS and WSS serve all routes and sockets and still require tokens.
- [x] Behind a declared proxy, the Service trusts forwarded scheme and host only from that proxy.
- [x] Plugin OAuth started from a remote client origin completes and returns to that origin.
- [x] Two Paired Devices on different origins arbitrate Web Control through Takeover and input leases.

## Answer

A non-loopback bind requires existing files in `OMARCHY_BOT_TLS_CERT` and `OMARCHY_BOT_TLS_KEY`, or one canonical proxy IP in `OMARCHY_BOT_TRUSTED_PROXY`; otherwise startup names the address and required settings before creating data directories. The existing server serves HTTPS and WSS with the certificate, and forwarded scheme and host are trusted only from the declared socket peer. Token checks and unauthenticated health are unchanged. Projection keeps `authentication: "none"` and `httpsRequired: false`: TLS protects transport, while the Paired Device token identifies the client.

Remote plugin OAuth returns to the initiating client: `returnUrl` must match the request Origin, or the public origin when Origin is absent, and its path must be `/`. Origin is the Paired Device's client, not a bind-address allowlist. The publisher accepts HTTPS callbacks on remote hosts and HTTP only for its existing local-host predicate. OAuth return pages and SPA documents suppress referrers; SPA documents also disable caching. Two Paired Devices can hand off the projection input lease and Takeover a pending computer tool; stale input closes, held buttons release, repeated Takeover is idempotent, and return-to-bot ends it. Device identity remains the token rather than browser Origin.

## Comments

`bun run typecheck` (`tsc --noEmit`) clean. Remote access, bot-screen config, plugin services, remote-control arbitration, device pairing, and daemon suites: 83 pass, 1 skip, 0 fail; 589 `expect()` calls across 84 tests. The skipped SPA referrer-policy test needs `apps/web/dist/index.html`, which is absent. Not run: `tests/integration/service-supervision.test.ts` (pinned Sway bundle unpublished), `tests/conformance/pi.test.ts` (real model), and Playwright. Implementation committed on this branch before this ticket-record amendment, not pushed.
