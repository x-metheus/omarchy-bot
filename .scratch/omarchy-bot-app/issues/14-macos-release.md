# 14: macOS release

**What to build:** Omarchy Bot ships for macOS as a signed, notarized dmg for arm64 and x64, with the darwin Local Sidecar binaries bundled, published through the release workflow and updater. A written WKWebView release checklist covering pairing by deep link, event stream, Screen Projection, Takeover input with ⌘ mapping, and one approved `local.run` is run before the release is marked supported.

**Blocked by:** 09 (Compiled Sidecar inside the app), 11 (Releases and auto-update), 13 (⌘ key mapping during Takeover)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] Notarized dmgs for arm64 and x64 open without Gatekeeper warnings
- [ ] darwin Sidecar binaries pass the Local Sidecar suite on a macOS CI runner
- [ ] Keychain storage and deep links work on macOS
- [ ] The WKWebView checklist exists and its run is recorded under this ticket's Comments
- [ ] macOS builds are published with updater entries
