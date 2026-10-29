# 09: Compiled Sidecar inside the app

**What to build:** The Local Sidecar is compiled with `bun build --compile` for each target and bundled in the app. When the app connects to a Service that is not on the same machine, it starts the Sidecar as a child with the install's `dev_` identity, Service URL, and token, and stops it on quit or unpair. The Sidecar's approval requests appear in the UI through the shell with the exact command or path and Ask / Always / Never; Always and Never are remembered per install. Pending local jobs fail clearly when the app quits.

**Blocked by:** 07 (Omarchy Bot app on Linux), 08 (Sidecar connects by URL and reports its OS and shell)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] The compiled linux-x64 binary passes the Local Sidecar integration suite
- [x] No Sidecar starts when the Service is on the same machine
- [x] Quitting or unpairing terminates the Sidecar, and the Service reports pending local jobs as failed
- [x] Approval prompts render with the exact command or path; Always/Never persist across restarts for this install
- [x] Messages sent from this install carry its `dev_` tag; the identity matches the Sidecar's registration
- [x] The Linux smoke suite runs one approved `local.run` end to end

## Comments

Superseded by [ticket 16](16-sidecar-same-machine-check.md): the loopback-only detector and tunnel limitation described in this historical implementation record are replaced by authenticated salted machine identity. Same-machine Services suppress the Sidecar at every address; different machines reached through loopback tunnels can run local actions.

The app now builds the Local Sidecar with `bun build --compile` for the build host's target and bundles it, supervising it natively over a stdio bridge. Only the install's cryptographically generated `dev_` identity is persisted in the Sidecar identity file; the Service connection and token remain in the OS keychain and are passed to the child through its environment. Quit and unpair terminate the Sidecar, and the Service fails pending local jobs. A loopback gate skips the Sidecar for `localhost`, IPv4 loopback and IPv6 loopback Service addresses. The shell renders required approvals with the exact command or path and four choices: Allow once, Always allow, Never allow and Deny. Always/Never policies live in app-local data and survive restarts, as does the `dev_` identity; messages carry the same tag the Sidecar registered. Cancellation and child disconnection dismiss matching queued or displayed approvals.

Verification: full `bun test` 832 pass, 23 skip, 0 fail (5,311 assertions, 855 tests / 124 files), including 11 real Pi conformance steps run against worktree assets with private `kimi-k2.7-code` settings removed afterward; `bun run typecheck` and `bun run lint:boundaries` pass. Compiled linux-x64: Local Sidecar process suite 5 pass, focused integrations 41 pass / 7 platform skips, approval E2E 9 pass, Shell 7 pass. Container AppImage build passes with WebKit's 26 packaged-native checks; artifact `.lane/dist/omarchy-bot_0.1.0_amd64.AppImage` SHA256 `40e4b4a767df01f6db4fcd4699bc84685587022c53c5e010ab394a09e86ab565`, evidence in `.lane/linux-app/evidence/{results.json,smoke.log,local-approval.png}`. The Linux-app workflow input paths were updated; the existing platform compiled workflow is reused.

Review was clean after three fixes. Limits: real macOS/Windows packaging and WebViews, and GitHub runners, were not executed (no push); the loopback-only detector suppresses tunneled remote services and treats a local nonloopback address as offhost per the ADR rule. An earlier full Chromium run gave 111 pass / 1 OAuth skip / 1 existing create-bot initial-navigation timeout; a traced targeted diagnostic passed without source changes, cause unobserved.
