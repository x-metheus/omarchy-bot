# macOS dmg release

On a native Apple Silicon or Intel Mac with Xcode command line tools, Bun 1.4.4 and Rust 1.93.1, install Tauri CLI 2.12.4 into the worktree (never a global Cargo directory):

```sh
export CARGO_HOME="$PWD/.lane/macos-app/cargo"
export CARGO_INSTALL_ROOT="$PWD/.lane/macos-app/tools"
cargo install tauri-cli --version 2.12.4 --locked
export PATH="$CARGO_INSTALL_ROOT/bin:$PATH"
bash scripts/build-macos-app.sh --unsigned
```

The minimum macOS version is 13.0, matching the `LC_BUILD_VERSION` in both shipped Bun 1.4.4 darwin Sidecars; the shell must not advertise an older version than its bundled executable supports.

The script compiles and exercises the native bundled Sidecar, embeds the production Web UI, and builds the host architecture only. PR builds use ad-hoc signing for Apple Silicon execution; they are validation artifacts and cannot establish Gatekeeper acceptance. Output is `.lane/dist/omarchy-bot_<version>_<aarch64|x64>.dmg` and `.dmg.sha256`. Cargo and Bun caches, target output and evidence stay in `.lane/macos-app`. The app uses the macOS Keychain and system certificate trust; untrusted TLS has no exception. The bundle's entitlements enable Bun's JavaScriptCore JIT in the signed Sidecar.

The merged `src-tauri/Info.plist` permits HTTP only for `localhost`, IPv4 loopback `127.0.0.0/8` and IPv6 `::1` in App Transport Security, matching the Service-origin validator and SSH-tunnel path. It adds no arbitrary-load or broad local-network exception. Verify all three forms on the native checklist, particularly macOS 14+ numeric-IP ATS behavior.

For distribution, run `bash scripts/build-macos-app.sh --signed`. Supply `APPLE_SIGNING_IDENTITY` as a **Developer ID Application** identity, `APPLE_ID`, the app-specific `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Local signing uses the installed identity; CI additionally requires the base64 `.p12` `APPLE_CERTIFICATE` and its `APPLE_CERTIFICATE_PASSWORD`, which Tauri imports into a temporary build keychain. Missing credentials, failed signing, failed notarization or failed Gatekeeper/stapler assessment stop the job. This path deliberately supports one notarization credential method (Apple ID) rather than ambiguous partial alternatives. Never add credentials to the repository or evidence. See [Tauri signing prerequisites](https://v2.tauri.app/distribute/sign/macos/).

Tauri signs the app and embedded executables with hardened runtime and notarizes/staples the app. The script also signs, notarizes and staples the dmg, verifies the app and Sidecar signatures, and assesses both the application and outer download. The checked-in `.icns` wraps the existing 128px PNG losslessly; replace both assets together when higher resolution product artwork exists.

`.github/workflows/macos-app.yml` runs natively on `macos-15` (Apple Silicon) and `macos-15-intel` (Intel). The Sidecar conformance workflow also runs both architectures, including real TLS rejection, approved execution and process-tree cancellation. No macOS execution is implied by Linux cross-compilation.

## Ticket 11 publication seam

The workflow accepts `workflow_call` with `signed` and `updater` inputs (both default true for release callers), `updater-public-key` (the public key matching the updater secret), and the eight named Apple/Tauri secrets in its declaration. A manual dispatch defaults to unsigned validation. Requested updater artifacts require both `TAURI_SIGNING_PRIVATE_KEY` and `updater-public-key`; the local script receives the public key as `TAURI_SIGNING_PUBLIC_KEY`. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional for an unencrypted key. The builder requests `app,dmg` so Tauri retains the app and creates its updater archive, and enables `createUpdaterArtifacts` with `plugins.updater.pubkey` for packaging. It uploads these architecture-specific assets in `macos-app-aarch64` and `macos-app-x64`:

- `omarchy-bot_<version>_<arch>.dmg` and `.dmg.sha256`
- `omarchy-bot_<version>_<arch>.app.tar.gz` and `.app.tar.gz.sig`

Ticket 11 owns the release caller, downloading these two Actions artifacts, GitHub Release publication, updater endpoint/public key/runtime implementation and manifest entries `darwin-aarch64` / `darwin-x86_64`. Entries must point to the corresponding `.app.tar.gz` URL and contain its `.sig` contents. The dmg is the installer, not the updater payload. Ticket 14 does not publish a second manifest or ship a pretend updater. Workflow evidence is separate (`macos-app-evidence-<arch>`), records build mode and explicitly says WKWebView was not run.

## Support gate

Complete [the WKWebView checklist](../../docs/release/macos-wkwebview-checklist.md) on **both** architectures and record the runs under ticket 14 before marking macOS supported. Tauri has no macOS WebDriver, so the manual WKWebView run is required; Linux WebKitGTK and Chromium results do not replace it. Distribution also requires Apple credentials and ticket 11 publication. Until those native checks and publication pass, this branch supplies the implementation and CI gate only.
