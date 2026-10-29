# 03: Pairing without a browser; the Service serves no UI

**What to build:** A user with no stored token sees an Add Service screen, enters the Service address and one-time code, and is paired. An `omarchy-bot://pair?service=…&code=…` link delivered through the shell pairs the same way. A request answered with 401 returns the user to Add Service with a message that this device was revoked. Pairing-code issuance returns the code and the deep link instead of a `/pair` URL, and `omarchy-bot pair` prints the Service address, the code, and the deep link. The Service stops serving the static UI, its single-page fallback, and the `/pair` page, and the runtime archive no longer contains the Web build.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] Add Service pairs with a valid address and code and shows a clear error for a wrong code or unreachable address
- [x] A pairing request from the shell's pairing intake pairs without typing
- [x] Revocation of the device returns the UI to Add Service with a revoked message
- [x] Pairing-code issuance returns a deep link with the Service origin and code
- [x] `omarchy-bot pair` prints address, code, and deep link
- [x] Former static, fallback, and `/pair` routes return 404
- [x] The runtime archive no longer includes the Web build
- [x] Covered by Service-boundary tests, CLI tests, and e2e specs with the in-memory shell

## Answer

Implemented Add Service, shared manual/shell pairing exchange, connection persistence, clear wrong-code/unreachable messages, and revoked-device recovery. Every API-client and projection HTTP fetch handles 401 for its original connection; a delayed response cannot revoke replacement credentials. Leaving the workspace stops the event socket and reconnect timer and clears cached queries. Service issuance and CLI output use `omarchy-bot://pair?service=…&code=…`; the CLI prints address/code/link. Former UI routes return 404, and runtime packaging neither requires nor includes the Web build. Existing CLI/lifecycle/container fixtures, developer/conformance UI hosts, and README instructions were migrated. Native registration, protocol versions, and OAuth remain in their later tickets.

## Comments

- Service/CLI/archive coverage passes: deep-link origin/code and one-time exchange, address/code/link output including TLS, former static/fallback/`/pair` 404s, and archives with or without a pre-existing Web build. Chromium covers manual pairing/reload, wrong/unreachable errors, shell intake, revoked-token cleanup/no reconnect/re-pairing, and projection HTTP 401 recovery. Delayed old-credential 401 regressions preserve replacement connections.
- Final repository verification: `env PI_CODING_AGENT_DIR=/tmp/ob-ticket03-model-1Rkwjm bun test --timeout 30000` → **809 pass, 16 skip, 0 fail, 5101 assertions; 825 tests across 121 files, 533.76 seconds** (raw `artifact://153`). All eleven real-model Pi conformance steps passed; nested run: 1 pass, 1 skip, 0 fail, 66 assertions, 108.62 seconds. Skipped optional scenarios remain skipped; this is not a claim that every hardware/native scenario passed.
- Environment: private `opencode-go/kimi-k2.7-code` configuration replaces the deprecated configured `opencode-go/kimi-k2.6` (HTTP 410), without editing user settings. Ignored worktree `.lane` links to `/home/colin/storage/Projects/omarchy-bot/.lane`; its `dist/sway`, `fonts`, and `browser` assets supply normal conformance paths. No global asset overrides were passed in the final run: earlier overrides leaked into container/installer fixture environments. The 30-second Bun timeout follows an observed TLS installer timeout at 5003.52 ms and the application's existing 30-second health window; assertions and application deadlines are unchanged.
- Final `bun run typecheck` passed after the last test migration (6.44 seconds). `bun run lint:boundaries` passed after production fixes: 2 tests, 3 assertions (also included in the final full suite). Focused API/projection/sidebar suite: 24 pass, 115 assertions. Final fetch-stub/container/installer regressions: `bun test tests/unit/web-local-sidecar-device-id.test.ts tests/integration/container-launcher.test.ts tests/integration/service-install.test.ts --timeout 30000` → 47 pass, 0 fail, 370 assertions, 15.31 seconds. The Sidecar network stub now spans each request and restores fetch afterward; the sidebar regression observes recorded transitions instead of a transient HTTP snapshot.
- Full Chromium after production fixes: `env TMPDIR=/tmp/ob-ticket03-e2e OMARCHY_BOT_E2E_WEB_URL=http://127.0.0.1:29318 OMARCHY_BOT_E2E_PORT=29319 bun run test:e2e` → **82 passed, 0 failed, 3.7 minutes** (raw `artifact://130`; 220.46 seconds). `bun run --filter=@omarchy-bot/web build` passed. Actual Chromium against the built test-only bundle host loaded an authenticated workspace and Computer Preview while the upstream Service root returned 404.
- Clean production re-review (`PairingReReview`) and final test-lifecycle review (`PairingFinalReview`) found no actionable defects. The final review confirmed production patches unchanged; all eight acceptance criteria are satisfied. Branch remains `app/03-pairing-without-browser`. No feature map exists to update.
- Verification limit: the optional standalone real-Sway scenario was attempted but stopped before its UI step with the existing `Bot Screen input requires the input lease` helper error; its host-isolation check passed and generated reports were restored. Native WebView support was not tested or claimed. No commit, push, merge, accepted ADR edit, host package installation, or graphical-session change was made.
