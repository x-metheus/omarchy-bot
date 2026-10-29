# 05: Plugin sign-in through the system browser

**What to build:** Connecting a plugin account opens the provider page through the shell's system browser instead of a popup or page navigation. The callback stays on the Service and tells the user to return to Omarchy Bot, offering an `omarchy-bot://` link. Completion and failure are published on the existing event stream, scoped to the plugin and account, so every connected app refreshes plugin state. Authorization no longer accepts or validates a return URL.

**Blocked by:** 02 (Web UI runs behind the `shell` seam)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] Starting authorization calls the shell's open-browser capability with the provider URL
- [x] Authorization requests no longer carry a return URL, and the Service no longer validates one
- [x] A completed callback emits a completion event and the UI shows the account connected without refresh
- [x] A failed or cancelled authorization emits a failure event and the UI offers retry
- [x] The callback page offers an `omarchy-bot://` link back to the app
- [x] Covered by Service-boundary plugin tests and an e2e spec

## Answer

Plugin and native MCP authorization open provider consent through `shell.browser.open`. Authorization no longer carries a return URL; callbacks use the Service origin and offer an `omarchy-bot://` return link. Durable, scoped completion and failure events refresh connected apps and preserve failure/retry feedback, including expired reconnects and callbacks arriving before the initial request settles. Native manual completion and no-browser-URL outcomes retain their existing behavior.

## Comments

Independent final re-review by TicketReReview is clean. Final-source full `bun test`: **814 pass, 17 skip, 0 fail**, 5,135 assertions, 831 tests across 122 files (540.40s), including all eleven real Pi conformance steps and private-HOME cleanup. The executed temporary runner command was `bun .lane/ticket05-verify.ts`; it launched `PI_CODING_AGENT_DIR=<worktree>/.lane/ticket05-agent bun test` with private copies of the existing auth/model files (directory mode 0700, files 0600) and settings selecting `opencode-go/kimi-k2.7-code`. It removed the private copies in `finally`; the temporary runner and diagnostic probe were then removed.

The original provider fallback selected `opencode-go/kimi-k2.6`, which returned HTTP 410 `ModelDeprecated` and explicitly requested `kimi-k2.7-code`. A direct real-worker probe reproduced that failure; the private settings override returned exactly `CONFORM-STREAM-OK`, then passed full conformance. This was an external model configuration prerequisite, requiring no production source or host-setting changes. Required Sway, fonts, and browser assets were prepared inside this worktree using the repository provisioning scripts. The earlier `bg_17` job had no surviving process or final recorded delivery after the interrupted agent was disposed; no outcome is claimed for it. The last recoverable older-source suite was 812 pass, 17 skip, 2 fail (445.23s): the deprecated-model conformance failure and the subsequently fixed expiry-event regression.

Final-source focused command `bun test tests/integration/plugin-services.test.ts tests/integration/remote-access.test.ts tests/integration/publisher-contract.test.ts tests/integration/publisher-identity-additive.test.ts`: **56 pass, 1 skip, 0 fail**, 459 assertions (8.52s); the existing skip requires `apps/web/dist/index.html`. `bun run typecheck` passed. `bun run lint:boundaries`: **2 pass, 0 fail**. `OMARCHY_BOT_E2E_OAUTH=1 OMARCHY_BOT_E2E_WEB_URL=http://127.0.0.1:19198 OMARCHY_BOT_E2E_SERVICE_URL=http://127.0.0.1:19199 bun run test:e2e -- 17-plugin-oauth`: **2 passed (8.0s)**, covering shell/native consent and manual completion, event-driven account refresh and retry, and the actual Service HTTP callback/WebSocket path. Chromium evidence does not establish native WebView support.

