# 05: Plugin sign-in through the system browser

**What to build:** Connecting a plugin account opens the provider page through the shell's system browser instead of a popup or page navigation. The callback stays on the Service and tells the user to return to Omarchy Bot, offering an `omarchy-bot://` link. Completion and failure are published on the existing event stream, scoped to the plugin and account, so every connected app refreshes plugin state. Authorization no longer accepts or validates a return URL.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] Starting authorization calls the shell's open-browser capability with the provider URL
- [ ] Authorization requests no longer carry a return URL, and the Service no longer validates one
- [ ] A completed callback emits a completion event and the UI shows the account connected without refresh
- [ ] A failed or cancelled authorization emits a failure event and the UI offers retry
- [ ] The callback page offers an `omarchy-bot://` link back to the app
- [ ] Covered by Service-boundary plugin tests and an e2e spec
