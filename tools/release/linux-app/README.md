# Linux AppImage and WebKit smoke

Dispatch the [Linux package workflow](../../../.github/workflows/linux-app.yml) to build and smoke the AppImage in GitHub Actions.

Run from a Linux x86_64 checkout with Docker available:

```sh
bash tools/release/build-linux-app.sh
bash tools/release/smoke-linux-app.sh .lane/dist/metheus_0.1.0_amd64.AppImage
```

The build container pins Rust 1.97.1 by image digest, Debian dependencies by snapshot, Bun 1.4.5 by checksum, and the locked Tauri tools. It builds the desktop and Agent Daemon with the native toolchain and verifies the pinned Recall files before bundling. `.lane/dist` receives the AppImage, standalone `metheus-agent-daemon_<version>_x86_64-unknown-linux-gnu.tar.gz`, and checksums. Toolchains stay in the image and caches stay inside `.lane/linux-app`.

The Agent Daemon smoke uses a temporary home, XDG directories, Xvfb, D-Bus, and Secret Service. It opens the AppImage's AppRun with WebKitWebDriver and launches the standalone archive separately. The test exercises autostart, attach, pairing, provider Settings, a Conversation, attachments, and offline Recall. It drives the native GTK file picker and tool approval in the private display. A loopback fixture supplies model responses.

`session.sh` requires the image-owned `/etc/metheus-linux-app` marker and Docker's `/.dockerenv` or Podman's `/run/.containerenv` when started as root. It validates the requested UID and GID, then drops privileges before setting up the private profile. `bun test tools/release/tests/linux-app-session.test.ts` exercises the entry point in a Bubblewrap user and mount namespace with a read-only host filesystem.

The shipped desktop runs the local file tool through its Tauri executor. The AppImage smoke checks the expected Agent Daemon executable is present before opening the WebView.

The native app restarts once after pairing or unpairing to load its connection policy. The smoke reconnects after that restart. Before pairing, the WebView can call `/api/pairing/exchange` on `http://localhost:*`, `http://127.0.0.1:*`, and `https://*:*`. After pairing, it connects to the stored daemon origin. Both states allow local application IPC.

For plaintext SSH tunnels, enter `localhost` or `127.0.0.1`. CSP host-source matching cannot express the entire `127/8` loopback range or bracketed IPv6 literals. Use a canonical loopback tunnel address or a trusted HTTPS hostname. [CSP issue 224](https://github.com/w3c/webappsec-csp/issues/224)

The Tauri development and packaged applications install the native shell before rendering. A missing or malformed bridge shows a startup error.

`.lane/linux-app/evidence/` contains the artifact checksum, native runtime versions, results, screenshot, and driver and lifecycle logs. CI uploads these files alongside the build outputs. The screenshot records the private AppImage WebView.

## Signed builds and updater smoke

Unsigned developer builds keep the default `0.1.0` version and cannot install updates. A signed build requires all of `APP_VERSION` (stable `X.Y.Z`, no leading zeros), `TAURI_UPDATER_PUBKEY` (the public key contents), `TAURI_UPDATER_ENDPOINT` (the HTTPS manifest URL), and `TAURI_SIGNING_PRIVATE_KEY` (the private key contents). `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` supplies the key's password, or is empty for an unencrypted test key. The wrapper forwards these through the container environment; do not put signing values in shell arguments, source files, `.env` files, logs, or workflow artifacts.

The build embeds the version, public key, and endpoint in the AppImage, enables Tauri updater artifacts, and writes these files to `.lane/dist`:

```text
metheus_VERSION_amd64.AppImage
metheus_VERSION_amd64.AppImage.sha256
metheus_VERSION_amd64.AppImage.sig
```

To exercise native updates with disposable signing material, run:

```sh
bash tools/release/linux-app/updater-smoke.sh
```

This uses the same pinned container flow, builds signed `0.1.0` and `0.1.1` images with an ephemeral key, and serves a private loopback updater endpoint. The packaged WebKitGTK checks cover finding the newer version, refusing a tampered AppImage without replacing the installed image, installing the genuine signed image, and restarting into it. The insecure-HTTP override belongs only to this smoke; release endpoints require HTTPS. Run this before a production signed build because the smoke writes its own build outputs. Neither test keys nor release keys belong in uploaded evidence.

## Release setup

Create one Tauri updater keypair using the CLI already in the repository's container. After the ordinary build above has prepared `metheus-linux-app`, use a private directory and the CLI's interactive password prompt:

```sh
mkdir -p .lane/linux-app/release-signing
chmod 700 .lane/linux-app/release-signing
docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/.lane/linux-app/release-signing:/keys" \
  metheus-linux-app cargo tauri signer generate -w /keys/metheus.key
chmod 600 .lane/linux-app/release-signing/metheus.key
```

Keep the private key and password in the maintainer's secret storage with a recoverable backup. Losing the key prevents updates for apps that trust its public half. Provision GitHub through repository Settings → Secrets and variables → Actions:

| Location | Name | Value |
| --- | --- | --- |
| Repository variable | `TAURI_UPDATER_PUBKEY` | Entire contents of `metheus.key.pub`, not its path |
| Environment `app-release` secret | `TAURI_SIGNING_PRIVATE_KEY` | Entire contents of `metheus.key`, not its path |
| Environment `app-release` secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen during generation |

Create the `app-release` environment, restrict its deployment tags to `app-v*`, and protect release tags against replacement. The public key is safe to distribute; it must match the private key. Release builds inject it into the app, so no generated key file needs to be committed. The existing `.lane/` and private-key ignores are safeguards, not permission to publish signing material. Keep the same public key for already installed apps; replacing only the GitHub keypair does not rotate their trust.

The workflow derives `APP_VERSION` from the tag and sets `TAURI_UPDATER_ENDPOINT` to `https://github.com/OWNER/REPO/releases/download/app-latest/latest.json` for the current repository. It fails before signing when the version, public key, endpoint, or private key is missing. Private signing values are available only in the signed-build step, never in the updater test, smoke, manifest, or publication steps.

## Publishing and rollback

The [app release workflow](../../../.github/workflows/app-release.yml) runs for stable `app-vX.Y.Z` tags. It requires signed desktop updater payloads and verifies the standalone Agent Daemon archives before publication.

Before publication CI runs the ephemeral-key updater smoke, builds with the release key, smokes that release AppImage, and verifies its SHA-256 checksum. It also requires signed/notarized macOS arm64 and x64 builds and the full Windows x64 WebView2 preview smoke. Only after every platform succeeds does publication create a draft containing all installers, checksums, signed updater payloads and the complete `latest.json`, then publish and promote it. The versioned release stays prerelease while its Windows installer is an unsigned preview. A failed private draft upload can be retried; already published assets must match the retained build artifacts byte for byte and are never replaced. Do not move an app version tag or replace its binaries.

The manifest has `version`, RFC 3339 `pub_date`, and exactly four platform entries. `linux-x86_64` points to the AppImage, `darwin-aarch64` and `darwin-x86_64` to their `.app.tar.gz` updater archives, and `windows-x86_64` to its NSIS installer. macOS users install from the dmg. Each entry contains an immutable `app-vX.Y.Z` artifact URL and the contents of its Tauri `.sig` file. The updater verifies the downloaded payload against the embedded public key and requires its signed version to match the advertised version. Every platform uses the same updater keypair, including unsigned Windows preview installers. SHA-256 checksums are available for manual downloads. See the [Tauri updater format](https://v2.tauri.app/plugin/updater/#static-json-file).

After the versioned release is published, CI uploads its manifest to the rolling `app-latest` release only when the version increases. The updater uses `/releases/download/app-latest/latest.json`. Release jobs are serialized so an older concurrent release cannot overwrite a newer manifest.

If promotion fails after the immutable release has published, rerun failed jobs so publication reuses the successful platform artifacts, compares every published byte, and retries promotion with the original manifest. Rebuilding different bytes requires a new version; a rerun cannot overwrite public assets. A maintainer can also upload the release's existing `latest.json` to `app-latest` after checking its version and artifact URLs. To stop rollout, restore the previous release's exact manifest at `app-latest`; apps already running a newer version do not downgrade. To recover those installs, release the corrected or reverted application under a higher app version with the same signing key. Never relabel an old signature with a higher version.

The general container smoke runs an extracted AppRun. The updater smoke launches a writable AppImage in extract-and-run mode to exercise replacement and restart. macOS WKWebView and Windows WebView2 checks run on their respective platforms. [macOS](../macos-app/README.md) · [Windows](../windows-app/README.md)
