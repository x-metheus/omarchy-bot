# 19: Every plugin authorization reports completion or failure

**What to build:** After the app opens a plugin authorization in the system browser, the user learns how it ended without checking by hand. Every authorization path the Plugins dialog can start emits a completion event over the event stream, including native MCP sign-in as well as provider accounts. A failure or cancellation emits a failed event. An authorization the user abandons in the browser expires after a bounded time and emits a failed (expired) event, and the dialog leaves its pending state and offers retry (stories 30 and 31).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md). Origin: PR #10 code review (Spec (a), stories 30–31).

- [ ] Native MCP authorization emits the same completion event shape as provider accounts; the dialog updates without a manual check
- [ ] Provider- or user-side failure emits a failed event with a reason
- [ ] An abandoned authorization expires after a documented bound and emits a failed (expired) event; a late callback after expiry is refused
- [ ] Integration tests cover success, failure and expiry for each authorization path; Chromium UI tests cover the dialog leaving its pending state
