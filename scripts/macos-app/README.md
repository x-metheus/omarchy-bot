# macOS dmg release

On a native Apple Silicon or Intel Mac with Xcode command line tools, Bun 1.4.4 and Rust 1.93.1, install Tauri CLI 2.12.4 into the worktree (never a global Cargo directory):

```sh
export CARGO_HOME="$PWD/.lane/macos-app/cargo"
export CARGO_INSTALL_ROOT="$PWD/.lane/macos-app/tools"
cargo install tauri-cli --version 2.12.4 --locked
export PATH="$CARGO_INSTALL_ROOT/bin:$PATH"
bash scripts/build-macos-app.sh --unsigned
```

The minimum macOS version is 13.0 for both the app and its bundled Rust Sidecar.

The script builds and exercises the native Rust Sidecar, embeds the production Web UI, and builds the host architecture only. PR builds use ad-hoc signing for Apple Silicon execution; they are validation artifacts and cannot establish Gatekeeper acceptance. Output is `.lane/dist/omarchy-bot_<version>_<aarch64|x64>.dmg` and `.dmg.sha256`. Cargo and Bun caches, target output and evidence stay in `.lane/macos-app`. The app uses the macOS Keychain and system certificate trust; untrusted TLS has no exception.

The merged `src-tauri/Info.plist` permits HTTP only for `localhost`, IPv4 loopback `127.0.0.0/8` and IPv6 `::1` in App Transport Security, matching the Service-origin validator and SSH-tunnel path. It adds no arbitrary-load or broad local-network exception. Verify all three forms on the native checklist, particularly macOS 14+ numeric-IP ATS behavior.

For distribution, run `bash scripts/build-macos-app.sh --signed`. Supply `APPLE_SIGNING_IDENTITY` as a **Developer ID Application** identity, `APPLE_ID`, the app-specific `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Local signing uses the installed identity; CI additionally requires the base64 `.p12` `APPLE_CERTIFICATE` and its `APPLE_CERTIFICATE_PASSWORD`, which Tauri imports into a temporary build keychain. Missing credentials, failed signing, failed notarization or failed Gatekeeper/stapler assessment stop the job. This path deliberately supports one notarization credential method (Apple ID) rather than ambiguous partial alternatives. Never add credentials to the repository or evidence. See [Tauri signing prerequisites](https://v2.tauri.app/distribute/sign/macos/).

Tauri signs the app and embedded executables with hardened runtime and notarizes/staples the app. The script also signs, notarizes and staples the dmg, verifies the app and Sidecar signatures, and assesses both the application and outer download. The checked-in `.icns` wraps the existing 128px PNG losslessly; replace both assets together when higher resolution product artwork exists.

`.github/workflows/macos-app.yml` runs natively on `macos-15` (Apple Silicon) and `macos-15-intel` (Intel). The Sidecar conformance workflow also runs both architectures, including real TLS rejection, approved execution and process-tree cancellation. No macOS execution is implied by Linux cross-compilation.

## Cross-platform publication

An `app-vX.Y.Z` tag runs `.github/workflows/app-release.yml`, which calls this workflow with `signed: true`, `updater: true`, `version: X.Y.Z` and `environment: app-release`. Both native architectures must succeed alongside Linux and the full Windows WebView2 gate before publication. The reusable/manual workflow accepts these inputs plus optional `updater-public-key`; otherwise it reads `TAURI_UPDATER_PUBKEY` from the selected environment. Manual dispatch defaults to unsigned validation with no environment. Protect `app-release` for trusted app tags and configure its eight declared Apple/Tauri secrets and `TAURI_UPDATER_PUBKEY` variable. Environment secrets are resolved inside the native job; `secrets: inherit` alone does not select an environment.

Updater builds require an explicit `APP_VERSION`, `TAURI_SIGNING_PRIVATE_KEY` and matching `TAURI_SIGNING_PUBLIC_KEY` (the workflow maps the public key input/variable). The password is optional for an unencrypted updater key. The builder uses the shared updater build-config CLI to embed that version, public key, stable endpoint and `requireSignedVersion`; filenames and signed-version metadata use the same version. It requests `app,dmg`, checks the archive signature's key/version metadata, and uploads these assets in `macos-app-aarch64` and `macos-app-x64`:

- `omarchy-bot_<version>_<arch>.dmg` and `.dmg.sha256`
- `omarchy-bot_<version>_<arch>.app.tar.gz`, `.app.tar.gz.sig` and `.app.tar.gz.sha256`

The caller downloads both asset sets into one flat release directory; architecture suffixes prevent collisions. It validates every payload, installer, checksum and updater signature's key/version metadata, then writes one manifest containing exactly `linux-x86_64`, `darwin-aarch64`, `darwin-x86_64` and `windows-x86_64`. macOS entries point to `.app.tar.gz` and contain the matching `.sig` contents. The dmg remains the installer. It uploads all assets to a draft `app-vX.Y.Z` release, verifies the downloaded bytes, publishes the complete release, and promotes `app-latest/latest.json` only when its numeric stable version increases. App releases remain separate from Service runtime releases. Windows currently makes the combined release a prerelease with explicit unsigned preview notes; this does not change stable app versioning.

Build failure publishes nothing. Rerun failed jobs to reuse successful Actions artifacts; an interrupted draft upload can be resumed. Public versioned assets are never overwritten: publication retry must match their existing bytes and platform map before finishing promotion. A rebuild that differs requires a new version. Workflow evidence is separate (`macos-app-evidence-<arch>`), records build mode and explicitly says WKWebView was not run. Native checklist and GitHub publication evidence remain required; integration alone closes no ticket 14 acceptance criterion.

## Support gate

Complete [the WKWebView checklist](../../docs/release/macos-wkwebview-checklist.md) on **both** architectures and record the runs under ticket 14 before marking macOS supported. Tauri has no macOS WebDriver, so the manual WKWebView run is required; Linux WebKitGTK and Chromium results do not replace it. Distribution also requires Apple credentials and ticket 11 publication. Until those native checks and publication pass, this branch supplies the implementation and CI gate only.
