# 04: Protocol version check

**What to build:** The health probe reports a protocol version (an integer owned by the protocol package, starting at 1) alongside the Service version. On connect, the UI compares it with the versions the app supports; outside that range it shows a blocking screen that names whether the app or the Service must be updated, with the app's update action when the app is behind.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] Health probe includes the protocol version, still without authentication and without Bot, Thread, or host data
- [x] A supported version connects normally
- [x] A Service ahead of the app shows "update Omarchy Bot"; a Service behind shows "update the Service"
- [x] No other screen is reachable while the mismatch screen is shown
- [x] Covered by a Service-boundary test and an e2e spec with a simulated mismatched Service

## Comments

Implemented the shared protocol-version health field (`protocol: 1`, owned by the protocol package), a root compatibility gate with update directions and shell updater, malformed-envelope recovery, and socket lifecycle cleanup, revalidation, and reconnect checks. Final review (`ProtocolFinalReview`) found the work correct with no actionable findings and confirmed all five behavioral criteria are implemented and covered; the boxes above are checked on that review evidence, not on a whole-suite pass.

Checks: typecheck passed. Full isolated Chromium: 94 passed, 0 skipped, 0 failed (17 protocol cases). Affected Bun suites: 77 passed, 3 skipped, 0 failed. The mandatory full `bun test` is **not** green: 807 passed, 17 skipped, 1 failed (825 tests / 122 files), because `tests/conformance/helpers.ts:110` requires a prepared `.lane/dist/sway` runtime that is absent in this environment. Earlier sibling asset-env overrides reached real Pi step 2 but returned empty assistant text instead of `CONFORM-STREAM-OK`; the provider cause is unproven, and a global browser override contaminated two fixture tests. No host actions and no source-level skips were used. Native WebView and the real updater remain unverified; both are later app efforts.

**Blocked on:** the prepared `.lane/dist/sway` conformance runtime (or an environment where the mandatory full suite can pass), then a clean full-suite run to resolve. Provider behavior behind the empty `CONFORM-STREAM-OK` response is unresolved. Revert to `ready-for-agent` once the prerequisite exists.

Integrator (merge into linux-service): resolved. The only full-suite failure is the real Pi conformance step, which depends on this machine's prepared `.lane/dist/sway` assets and a provider model setting (`kimi-k2.6`, now deprecated); ticket 05 passed it with worktree-local assets and a private model override. It is environmental, not a ticket 04 defect. After merging with ticket 05 (event-pump conflict resolved), typecheck and 168 targeted tests pass.
