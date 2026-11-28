# macOS dmg release

On a native Apple Silicon or Intel Mac, install the Xcode command line tools and the Bun and Rust versions pinned in the [macOS build workflow](../../.github/workflows/macos-app.yml). The frozen Bun install provides the pinned Tauri CLI.

```sh
bun install --frozen-lockfile
bash scripts/build-macos-app.sh --unsigned
```

The desktop application and bundled Agent Daemon require macOS 13.0 or later and build with Rust 1.97.1.

The builder verifies the pinned Recall model and emits the desktop dmg and standalone Agent Daemon archive for the native host architecture. It exercises the unpacked daemon through pairing, provider configuration, Conversation, attachments, host tools, and offline Recall. Output and checksums go to `.lane/dist`. Cargo, Bun, and evidence stay in `.lane/macos-app`. Unsigned builds use ad-hoc signing. The app uses macOS Keychain and system certificate trust.

The merged `src-tauri/Info.plist` permits plaintext HTTP for `localhost`, IPv4 loopback `127.0.0.0/8`, and IPv6 `::1` in App Transport Security. Verify those forms on the native checklist, particularly macOS 14+ numeric-IP behavior.

For distribution, run `bash scripts/build-macos-app.sh --signed`. Supply `APPLE_SIGNING_IDENTITY` as a **Developer ID Application** identity, `APPLE_ID`, the app-specific `APPLE_PASSWORD`, and `APPLE_TEAM_ID`. Local signing uses the installed identity; CI additionally requires the base64 `.p12` `APPLE_CERTIFICATE` and its `APPLE_CERTIFICATE_PASSWORD`, which Tauri imports into a temporary build keychain. Missing credentials, failed signing, failed notarization or failed Gatekeeper/stapler assessment stop the job. This path deliberately supports one notarization credential method (Apple ID) rather than ambiguous partial alternatives. Never add credentials to the repository or evidence. See [Tauri signing prerequisites](https://v2.tauri.app/distribute/sign/macos/).

Tauri signs the app and the embedded Agent Daemon with hardened runtime and notarizes and staples the app. The script also notarizes and staples the dmg, verifies both executable signatures, and assesses the application and outer download.

The [macOS workflow](../../.github/workflows/macos-app.yml) runs natively on `macos-15` (Apple Silicon) and `macos-15-intel` (Intel).

## Cross-platform publication

An `app-vX.Y.Z` tag runs `.github/workflows/app-release.yml`, which calls this workflow with `signed: true`, `updater: true`, `version: X.Y.Z` and `environment: app-release`. Both native architectures must succeed alongside Linux and the full Windows WebView2 gate before publication. The reusable/manual workflow accepts these inputs plus optional `updater-public-key`; otherwise it reads `TAURI_UPDATER_PUBKEY` from the selected environment. Manual dispatch defaults to unsigned validation with no environment. Protect `app-release` for trusted app tags and configure its eight declared Apple/Tauri secrets and `TAURI_UPDATER_PUBKEY` variable. Environment secrets are resolved inside the native job; `secrets: inherit` alone does not select an environment.

Updater builds require an explicit `APP_VERSION`, `TAURI_SIGNING_PRIVATE_KEY` and matching `TAURI_SIGNING_PUBLIC_KEY` (the workflow maps the public key input/variable). The password is optional for an unencrypted updater key. The builder uses the shared updater build-config CLI to embed that version, public key, stable endpoint and `requireSignedVersion`; filenames and signed-version metadata use the same version. It requests `app,dmg`, checks the archive signature's key/version metadata, and uploads these assets in `macos-app-aarch64` and `macos-app-x64`:

- `omarchy-bot_<version>_<arch>.dmg` and `.dmg.sha256`
- `omarchy-bot_<version>_<arch>.app.tar.gz`, `.app.tar.gz.sig` and `.app.tar.gz.sha256`
- `omarchy-agent-daemon_<version>_<target>.tar.gz` and `.tar.gz.sha256`

The caller downloads both asset sets into one release directory. It verifies the installers, daemon archives, checksums, and updater signature metadata, then writes the four-platform manifest. macOS entries point to `.app.tar.gz` updater payloads. The workflow uploads the assets to a draft `app-vX.Y.Z` release, verifies the downloaded bytes, publishes the complete release, and promotes `app-latest/latest.json` when the stable version increases. The unsigned Windows installer keeps the combined release labeled preview.

Build failure publishes nothing. Rerun failed jobs to reuse successful Actions artifacts; an interrupted draft upload can be resumed. Public versioned assets are never overwritten: publication retry must match their existing bytes and platform map before finishing promotion. A rebuild that differs requires a new version. Workflow evidence is separate (`macos-app-evidence-<arch>`), records build mode and explicitly says WKWebView was not run. Native checklist and GitHub publication evidence remain required; integration alone closes no ticket 14 acceptance criterion.

## Support gate

On both Apple Silicon and Intel, install the dmg in a disposable account. Open it in WKWebView and check that the app autostarts the bundled daemon, locally pairs, opens a Conversation, and reattaches after relaunch. Configure the provider in Settings. Send, view, and reuse a neutral attachment. Choose a local fixture directory and confirm that **Allow once** runs the selected file tool, then confirm **Deny** leaves the fixture unchanged. Ask the Bot to use Recall on a known earlier message while the model source is unavailable. Save the architecture, artifact digest, steps, and results in the release evidence. These are manual checks on macOS.
