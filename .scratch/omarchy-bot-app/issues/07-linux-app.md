# 07: Omarchy Bot app on Linux

**What to build:** A Tauri 2 Omarchy Bot app embeds the Web UI production build and implements the `shell` interface with a thin Rust layer: token in the operating system keychain, the `omarchy-bot` URL scheme with single-instance forwarding of deep links to the running app, and opening the system browser. Its Content Security Policy allows connections only to the paired Service origin. Connecting to a Service with an untrusted certificate shows a clear TLS error. It builds as an x86_64 AppImage, and a `tauri-driver` smoke suite on WebKitGTK proves the packaged app works.

**Blocked by:** 03 (Pairing without a browser; the Service serves no UI), 04 (Protocol version check)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] The AppImage launches and shows Add Service on first run
- [x] The token is stored in the OS keychain, not in WebView storage, and survives restart
- [x] A deep link opens the app and pairs; a second deep link while running is forwarded to the existing window
- [x] CSP blocks connections to any origin other than the paired Service
- [x] An untrusted certificate produces a TLS-specific error, not a generic failure
- [x] Only Tauri plugins with mobile support are used, or desktop-only ones are isolated behind the shell
- [x] The WebKitGTK smoke suite passes: deep-link pairing, event stream delivering a Bot reply, Screen Projection rendering, Takeover keyboard and pointer input reaching the Bot Screen

## Answer

The Tauri 2 app embeds the Web UI production build and implements the `shell` seam in a thin Rust layer: a native Secret Service keychain for the device token, `omarchy-bot://` handling with single-instance forwarding of running deep links, and system-browser opening. The CSP names exactly the paired Service origin, pairing and stored connections require explicit TLS verification (an untrusted certificate yields a TLS-specific message), and managed attachment links save their authenticated content without exposing the token to the WebView. It builds as an x86_64 AppImage; the `tauri-driver`/WebKitGTK smoke suite and the repository-pinned container/CI jobs exercise the packaged app.

## Comments

Implemented the native app (`apps/omarchy-bot/`), the `scripts/build-linux-app.sh` and `scripts/smoke-linux-app.sh` flows, and `.github/workflows/linux-app.yml`. The container build and smoke run use a repository-pinned image with a private session, keychain, and Xvfb; no host packages, graphical session, or `~/.cargo` state are touched.

Checks: `bun install --frozen-lockfile` clean; `bun run typecheck` exit 0; the temporary private `PI_CODING_AGENT_DIR` runner (selecting `kimi-k2.7-code`) ran the full `bun test` → **828 pass, 23 skip, 0 fail**, 5288 assertions, 851 tests across 124 files (511.11s), including all eleven real Pi conformance steps with no test weakening. Full Chromium `bun run test:e2e`: 106 passed, 1 existing default-OAuth skip (252.60s); `OMARCHY_BOT_E2E_OAUTH=1 bun run test:e2e -- 17-plugin-oauth` → 2 passed (7.3s). The private Pi workaround succeeded; the earlier asset-env pollution was fixed by removing global overrides rather than changing tests.

Artifact: `.lane/dist/omarchy-bot_0.1.0_amd64.AppImage`, SHA256 `568f4bb1864bf935ad76d8f7ea5811aebd341445855d8f58d4467c90d46da510` (`scripts/build-linux-app.sh` exit 0). `scripts/smoke-linux-app.sh <AppImage>` exit 0: all 19 real WebKit checks passed, including deep-link pairing, Bot reply over the event stream, Sway Screen Projection, separate keyboard and pointer Takeover, keychain/no-token-storage, paired-origin CSP, TLS, links and managed download, and revoke. Evidence: `.lane/linux-app/evidence/` (`results.json`, `environment.txt`, driver/smoke logs, screenshots). Final review (`FixesReview`) is clean at 0.97 confidence with no findings across all seven criteria and the four previous P2 fixes.

Verification limit: the smoke suite runs the AppImage's extracted filesystem; ordinary FUSE mounting and activation of the installed `omarchy-bot://` scheme are not proved here and remain with ticket 12.
