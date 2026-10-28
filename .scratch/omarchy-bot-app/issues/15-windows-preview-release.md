# 15: Windows preview release

**What to build:** Omarchy Bot ships for Windows as an x64 NSIS installer, labeled preview until it is code-signed, with the windows-x64 Local Sidecar bundled. A `tauri-driver` smoke suite on WebView2 proves the packaged app.

**Blocked by:** 09 (Compiled Sidecar inside the app), 10 (Windows executor for the Sidecar), 11 (Releases and auto-update)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] The NSIS installer installs and registers the `omarchy-bot` URL scheme
- [ ] The build and release notes are labeled preview while unsigned
- [ ] Credential Manager token storage and deep links work on Windows
- [ ] The WebView2 smoke suite passes: deep-link pairing, event stream, Screen Projection, Takeover input, one approved `local.run`
- [ ] Windows builds are published with updater entries
