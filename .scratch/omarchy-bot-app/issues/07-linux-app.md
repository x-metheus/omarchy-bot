# 07: Omarchy Bot app on Linux

**What to build:** A Tauri 2 Omarchy Bot app embeds the Web UI production build and implements the `shell` interface with a thin Rust layer: token in the operating system keychain, the `omarchy-bot` URL scheme with single-instance forwarding of deep links to the running app, and opening the system browser. Its Content Security Policy allows connections only to the paired Service origin. Connecting to a Service with an untrusted certificate shows a clear TLS error. It builds as an x86_64 AppImage, and a `tauri-driver` smoke suite on WebKitGTK proves the packaged app works.

**Blocked by:** 03 (Pairing without a browser; the Service serves no UI), 04 (Protocol version check)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] The AppImage launches and shows Add Service on first run
- [ ] The token is stored in the OS keychain, not in WebView storage, and survives restart
- [ ] A deep link opens the app and pairs; a second deep link while running is forwarded to the existing window
- [ ] CSP blocks connections to any origin other than the paired Service
- [ ] An untrusted certificate produces a TLS-specific error, not a generic failure
- [ ] Only Tauri plugins with mobile support are used, or desktop-only ones are isolated behind the shell
- [ ] The WebKitGTK smoke suite passes: deep-link pairing, event stream delivering a Bot reply, Screen Projection rendering, Takeover keyboard and pointer input reaching the Bot Screen
