# 03: Pairing without a browser; the Service serves no UI

**What to build:** A user with no stored token sees an Add Service screen, enters the Service address and one-time code, and is paired. An `omarchy-bot://pair?service=…&code=…` link delivered through the shell pairs the same way. A request answered with 401 returns the user to Add Service with a message that this device was revoked. Pairing-code issuance returns the code and the deep link instead of a `/pair` URL, and `omarchy-bot pair` prints the Service address, the code, and the deep link. The Service stops serving the static UI, its single-page fallback, and the `/pair` page, and the runtime archive no longer contains the Web build.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] Add Service pairs with a valid address and code and shows a clear error for a wrong code or unreachable address
- [ ] A pairing request from the shell's pairing intake pairs without typing
- [ ] Revocation of the device returns the UI to Add Service with a revoked message
- [ ] Pairing-code issuance returns a deep link with the Service origin and code
- [ ] `omarchy-bot pair` prints address, code, and deep link
- [ ] Former static, fallback, and `/pair` routes return 404
- [ ] The runtime archive no longer includes the Web build
- [ ] Covered by Service-boundary tests, CLI tests, and e2e specs with the in-memory shell
