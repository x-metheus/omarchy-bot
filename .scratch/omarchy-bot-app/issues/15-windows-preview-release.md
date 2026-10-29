# 15: Windows preview release

**What to build:** Omarchy Bot ships for Windows as an x64 NSIS installer, labeled preview until it is code-signed, with the windows-x64 Local Sidecar bundled. A `tauri-driver` smoke suite on WebView2 proves the packaged app.

**Blocked by:** 09 (Compiled Sidecar inside the app), 10 (Windows executor for the Sidecar), 11 (Releases and auto-update)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] The NSIS installer installs and registers the `omarchy-bot` URL scheme
- [ ] The build and release notes are labeled preview while unsigned
- [ ] Credential Manager token storage and deep links work on Windows
- [ ] The WebView2 smoke suite passes: deep-link pairing, event stream, Screen Projection, Takeover input, one approved `local.run`
- [ ] Windows builds are published with updater entries

## Comments

Implementation is complete and the ticket is resolved; actual Windows runner acceptance was not performed and all five criteria above remain unchecked. The user explicitly authorized this deferred acceptance for missing local Windows/macOS runner evidence. Nothing here claims a Windows app compile, Windows runtime pass, or publication.

Implemented platform seams for the Windows build: target-specific Windows Credential Manager and Schannel dependencies, retaining Linux Secret Service and GIO TLS dependencies; exact WebView origins and native platform detection in `shell.js`; a per-user NSIS installer with `icon.ico` and `omarchy-bot` deep-link registration (`tauri.windows.conf.json`, generated `windows-schema.json`); private Windows app smoke directories; portable `pwsh` scripts in `scripts/windows-app/` (full smoke, build and install) driven by `.github/workflows/windows-app.yml`, `windows-app-release.yml`, and `windows-webview-smoke.yml`; preview artifact labeling and notes plus a signed updater artifact and dual-platform manifest seam; and `tests/integration/windows-app-release.test.ts`. The release job refuses to run without the updater plugin.

Checks actually run: final native Linux build and smoke (`scripts/build-linux-app.sh && scripts/smoke-linux-app.sh .lane/dist/omarchy-bot_0.1.0_amd64.AppImage`) exit 0, 107.09s, 26 checks passed, SHA256 `bf101738c111e528d3669dbb44d9d2fa4d07fae29b3d3c0b77230f5096948038`. Shell regression went from 7 pass/1 fail to 8 pass/46 assertions; release CLI from missing to 1 pass/7 assertions. `bun run typecheck` plus strict scripts `tsc` exit 0 (6.75s). Full `bun test`: 833 pass, 23 skip, 1 fail, 5321 assertions, 857 tests, 438.46s — the sole failure is real Pi conformance step 2: expected `CONFORM-STREAM-OK`, received empty output after the session opened. The run used private `PI_CODING_AGENT_DIR` settings selecting `opencode-go/deepseek-v4.1-flash` and provisioned worktree assets. The root cause is not established. This observed failure is covered by the user’s explicit exception and does not require needs-info. Windows Sidecar Bun cross-compile passed. Portable `pwsh` scripts parsed and passed Linux guard checks; YAML and shell syntax checks passed; a real Linux Service launcher issued and exchanged pairing with targeted teardown. The Windows Rust check stopped at missing `llvm-rc`/Windows SDK, so there is no Windows app compile claim.

Runner-only acceptance remains for each criterion: (1) NSIS install/uninstall and scheme registry — Windows run; (2) unsigned preview artifact and build labeling — Windows run; (3) Credential Manager persistence across restart with cold and running deep links, plus Schannel — Windows run; (4) full WebView2 suite on `windows-2022` with the protected `windows-smoke` environment and a dedicated Linux runner labeled `windows-smoke-service`, trusted HTTPS proxy loopback port 7431, untrusted TLS endpoint 7432, pairing-host secret, and matching Edge driver; (5) publication requires ticket 11's updater runtime integration (not ported here), same-version Linux `app-vX.Y.Z` and `app-latest` manifests, updater signing keys, protected release permissions, and a Windows release run. No publication or push was performed.
