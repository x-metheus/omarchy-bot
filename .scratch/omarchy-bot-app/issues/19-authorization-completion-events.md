# 19: Every plugin authorization reports completion or failure

**What to build:** After the app opens a plugin authorization in the system browser, the user learns how it ended without checking by hand. Every authorization path the Plugins dialog can start emits a completion event over the event stream, including native MCP sign-in as well as provider accounts. A failure or cancellation emits a failed event. An authorization the user abandons in the browser expires after a bounded time and emits a failed (expired) event, and the dialog leaves its pending state and offers retry (stories 30 and 31).

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md). Origin: PR #10 code review (Spec (a), stories 30–31).

- [x] Native MCP authorization emits the same completion event shape as provider accounts; the dialog updates without a manual check
- [x] Provider- or user-side failure emits a failed event with a reason
- [x] An abandoned authorization expires after a documented bound and emits a failed (expired) event; a late callback after expiry is refused
- [x] Integration tests cover success, failure and expiry for each authorization path; Chromium UI tests cover the dialog leaving its pending state

## Comments

Implemented a shared completion/failure event publisher used by provider accounts, the native provider, and standalone MCP; failure reasons are redacted. Abandoned authorizations expire after a documented 15-minute bound (sweep at most 2 seconds late) and emit a failed (expired) event; the adapter's pre-existing 5-minute timeout also yields expired, and a late callback after expiry is refused. Native isolated consent cancellation refuses late callbacks, and attempt correlation plus terminal deduplication cover auto/manual races and Check during consent. Plugin expansion is isolated while skills are preserved. The dialog leaves its pending state via events and offers retry; README and spec were updated. The supervision test helper now drains coalesced stdout lines and cleans up its child on readiness failure.

Final source full `bun test`: 852 pass, 31 skip, 0 fail (5,505 assertions, 883 tests across 127 files, 513.16s), using a private `PI_CODING_AGENT_DIR` copy and running all eleven real Pi conformance steps without exception; private auth/model/settings copies were deleted. `bun run typecheck` passed and `bun run lint:boundaries` reported 2 pass, 0 fail. Chromium (`OMARCHY_BOT_E2E_OAUTH=1` with web 19198/service 19199) `bun run test:e2e -- 17-plugin-oauth`: 2 passed (8.6s). Affected-file integration tests: 68 pass, 0 fail (608 assertions); final real-adapter lifecycle regression: 1 pass (56 assertions). No packaged WebView/platform smoke was run, so packaged native WebView support is not established by this evidence. Independent final review is clean.
