# Linux AppImage and WebKit smoke

Run from a Linux x86_64 checkout with Docker available:

```sh
bash scripts/build-linux-app.sh
bash scripts/smoke-linux-app.sh .lane/dist/omarchy-bot_0.1.0_amd64.AppImage
```

The installer smoke separately proves ordinary FUSE launch and installed URL dispatch:

```sh
bash scripts/linux-app/install-smoke.sh .lane/dist/omarchy-bot_0.1.0_amd64.AppImage
```

It requires `/dev/fuse` and a Docker runtime that permits the private container's FUSE mount (`SYS_ADMIN` and an unconfined container AppArmor profile). The container contains `fusermount`; no host package installation is needed. It uses a private HOME with spaces, XDG paths, Xvfb, D-Bus and keyring. The public CLI installs the actual checksum-verified AppImage, then a normal AppImage launch must produce a native process on a FUSE mount. A second CLI installation opens the pairing URL through `gio open`, which resolves the installed desktop entry and MIME default; the real Service must observe a new Paired Device and the private keyring must contain the connection. Uninstall must remove the app and registration while preserving seeded user data. Only systemd activation is a fixture inside this container. Results are in `.lane/linux-app/evidence/install-{smoke.log,results.json}`; private credentials and mounts are removed during teardown.

The build container pins Rust 1.93.1 by image digest, Debian packages to the 2026-10-20 snapshot, Bun 1.4.4 by checksum, tauri-cli 2.12.4 and tauri-driver 2.1.0 with their Cargo locks. The application's Cargo.lock and bun.lock fix its dependencies; `bundler.sha256` verifies AppRun and all linuxdeploy tools before packaging, including the upstream continuously published AppImage plugin. Initial image and dependency downloads need network. Toolchains stay in the image, and Cargo caches, build output and Bun caches stay under `.lane/linux-app`; no host package or global Cargo configuration is changed.

The build compiles the Local Sidecar with Bun for the build host's Tauri triple, embeds it as an external binary beside the native executable, embeds the shared production Web UI, and writes the AppImage and SHA-256 sidecar to `.lane/dist`. `bun scripts/build-sidecar.ts` also supports macOS arm64/x64 and Windows x64 hosts; their packaging and real WebView verification belong to their platform release tickets. The smoke script provisions the repository's checksum-pinned Sway runtime, fonts and browser pack through their existing scripts. It extracts the actual AppImage inside a fresh container, then drives that packaged AppRun through tauri-driver and the container's matching WebKitWebDriver. Extraction avoids a host FUSE requirement and keeps the executable path stable across the application's pairing restart.

Each smoke has its own temporary HOME, XDG directories, Xvfb display, D-Bus session and unlocked Secret Service. No host display, session bus, keyring, home, or graphical environment is mounted. Container root installs one ephemeral certificate in the disposable container trust store, then drops to the checkout's UID before running the application and Service. The real Service runs with the repository's scripted Agent worker; HTTP, event and projection WebSockets, Sway, Xwayland, noVNC and input execution are real. The fixture paints magenta at launch, cyan after a pointer event and yellow after a keyboard event; the smoke observes these pixels in the WebKit canvas.

Coverage includes Add Service on first run, a clear self-signed TLS error, startup and forwarded deep-link exchanges, OS keychain persistence across process restart, absence of the actual token in localStorage, useful unavailable-keychain errors with recovery of the original credential, paired-origin CSP violations, cross-origin re-pairing, a Bot reply over the event stream, Screen Projection, and keyboard and pointer Takeover reaching the Bot Screen. The forwarding assertion changes the currently controlled document and checks unchanged process/window identity before any restart. A real Markdown link click must reach a private system-opener recorder. A managed text attachment is staged through the UI, sent, clicked, and saved with its exact authenticated contents in the private Downloads directory; its URL must never reach that opener. A trusted HTTPS Service is paired, restarted with an unrelated untrusted certificate, and reopened from the stored connection to prove the TLS-specific screen. Actual Service revocation must delete the credential and preserve its explanatory notice and address. A second revocation makes the notice directory unwritable and proves secret deletion, Add Service recovery, and successful pairing again.

The Sidecar smoke gives the app and Service explicit machine-ID fixtures: equal identities suppress the child over loopback and LAN HTTPS, while a distinct identity reached through loopback starts one. The fixture extends Bun's certificate roots with `NODE_EXTRA_CA_CERTS`; production code never bypasses TLS verification. It executes one approved `local.run`, checks its exact command and output, compares the outgoing message's `dev_` tag to the registered Sidecar identity, and exercises Always/Never across an application restart. Sidecar disconnection dismisses a required approval and fails its job; reopening permits a fresh Ask. Quit and unpair must each remove the child and fail a pending local Tool Call at the real Service boundary. Native stdio requests remain queued until the WebView subscribes; cancellation removes matching queued or displayed approvals. Sidecar identity is stored in app configuration; policies are stored under app-local data, independently of the paired credential. The Service host identity exposes only a salted digest to Paired Devices; an unavailable identity suppresses local actions with a recovery notice.

The native app restarts once after pairing or unpairing to load the CSP from the stored connection. The smoke reconnects after that restart. While unpaired, the Add Service screen must be able to contact a supplied Service address; after pairing only that Service's HTTP and WebSocket origins are allowed alongside local IPC.

The smoke's artifact SHA-256, runtime versions, concise results, Service/driver logs and final Takeover screenshot are saved to `.lane/linux-app/evidence/`. Screenshots capture only the container's private Xvfb display. CI runs these same scripts and uploads the packaged artifact and evidence. This suite proves Linux WebKitGTK behavior; Chromium UI tests remain separate.

## Signed builds and updater smoke

Unsigned developer builds keep the default `0.1.0` version and cannot install updates. A signed build requires all of `APP_VERSION` (stable `X.Y.Z`, no leading zeros), `TAURI_UPDATER_PUBKEY` (the public key contents), `TAURI_UPDATER_ENDPOINT` (the HTTPS manifest URL), and `TAURI_SIGNING_PRIVATE_KEY` (the private key contents). `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` supplies the key's password, or is empty for an unencrypted test key. The wrapper forwards these through the container environment; do not put signing values in shell arguments, source files, `.env` files, logs, or workflow artifacts.

The build embeds the version, public key, and endpoint in the AppImage, enables Tauri updater artifacts, and writes these files to `.lane/dist`:

```text
omarchy-bot_VERSION_amd64.AppImage
omarchy-bot_VERSION_amd64.AppImage.sha256
omarchy-bot_VERSION_amd64.AppImage.sig
```

To exercise native updates with disposable signing material, run:

```sh
bash scripts/linux-app/updater-smoke.sh
```

This uses the same pinned container flow, builds signed `0.1.0` and `0.1.1` images with an ephemeral key, and serves a private loopback updater endpoint. The packaged WebKitGTK checks cover finding the newer version, refusing a tampered AppImage without replacing the installed image, installing the genuine signed image, and restarting into it. The insecure-HTTP override belongs only to this smoke; release endpoints require HTTPS. Run this before a production signed build because the smoke writes its own build outputs. Neither test keys nor release keys belong in uploaded evidence.

## Release setup

Create one Tauri updater keypair using the CLI already in the repository's container. After the ordinary build above has prepared `omarchy-bot-linux-app`, use a private directory and the CLI's interactive password prompt:

```sh
mkdir -p .lane/linux-app/release-signing
chmod 700 .lane/linux-app/release-signing
docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/.lane/linux-app/release-signing:/keys" \
  omarchy-bot-linux-app cargo tauri signer generate -w /keys/omarchy-bot.key
chmod 600 .lane/linux-app/release-signing/omarchy-bot.key
```

Keep the private key and password in the maintainer's secret storage with a recoverable backup. Losing the key prevents updates for apps that trust its public half. Provision GitHub through repository Settings → Secrets and variables → Actions:

| Location | Name | Value |
| --- | --- | --- |
| Repository variable | `TAURI_UPDATER_PUBKEY` | Entire contents of `omarchy-bot.key.pub`, not its path |
| Environment `app-release` secret | `TAURI_SIGNING_PRIVATE_KEY` | Entire contents of `omarchy-bot.key`, not its path |
| Environment `app-release` secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password chosen during generation |

Create the `app-release` environment, restrict its deployment tags to `app-v*`, and protect release tags against replacement. The public key is safe to distribute; it must match the private key. Release builds inject it into the app, so no generated key file needs to be committed. The existing `.lane/` and private-key ignores are safeguards, not permission to publish signing material. Keep the same public key for already installed apps; replacing only the GitHub keypair does not rotate their trust.

The workflow derives `APP_VERSION` from the tag and sets `TAURI_UPDATER_ENDPOINT` to `https://github.com/OWNER/REPO/releases/download/app-latest/latest.json` for the current repository. It fails before signing when the version, public key, endpoint, or private key is missing. Private signing values are available only in the signed-build step, never in the updater test, smoke, manifest, or publication steps.

## Publishing and rollback

The [app release workflow](../../.github/workflows/app-release.yml) runs for `app-vX.Y.Z` tags, independently of Service `runtime-*` releases. A maintainer creates and publishes the tag after reviewing the intended commit; no workflow dispatch or version change in the Service is needed. Only stable numeric versions are accepted; prerelease and build-metadata tags are rejected.

Before publication CI runs the ephemeral-key updater smoke, builds with the release key, smokes that release AppImage, and verifies its SHA-256 sidecar. It also requires signed/notarized macOS arm64 and x64 builds and the full Windows x64 WebView2 preview smoke. Only after every platform succeeds does publication create a draft containing all installers, checksums, signed updater payloads and the complete `latest.json`, then publish and promote it. The versioned release stays prerelease while its Windows installer is an unsigned preview. A failed private draft upload can be retried; already published assets must match the retained build artifacts byte for byte and are never replaced. Do not move an app version tag or replace its binaries.

The manifest has `version`, RFC 3339 `pub_date`, and exactly four platform entries: `linux-x86_64` points to the AppImage, `darwin-aarch64` and `darwin-x86_64` to their `.app.tar.gz` updater archives, and `windows-x86_64` to its NSIS installer. macOS dmgs are installers, not updater payloads. Each entry contains an immutable `app-vX.Y.Z` artifact URL and its actual `.sig` contents. In the ticket's phrase “signed updater manifest,” signing means Tauri's artifact signature carried by this manifest; there is no separate JSON signature format. The updater verifies the downloaded payload against the embedded public key and requires its signed version to match the advertised version. Every platform uses the same updater keypair; updater signatures remain required for unsigned Windows preview installers. SHA-256 sidecars are useful for manual downloads, but do not replace this signature check. See the [Tauri updater format](https://v2.tauri.app/plugin/updater/#static-json-file).

After the versioned release is published, CI uploads its manifest to the rolling `app-latest` release only when the version increases. That channel release is marked prerelease solely to keep it separate from GitHub's global latest-release selection; it serves stable app versions. The updater always uses `/releases/download/app-latest/latest.json`, because Service releases also use GitHub Releases and `/releases/latest/` may resolve to a Service release. App releases also opt out of GitHub's global latest selection. Release jobs are serialized so an older concurrent release cannot overwrite a newer channel manifest.

If promotion fails after the immutable release has published, rerun failed jobs so publication reuses the successful platform artifacts, compares every published byte, and retries promotion with the original manifest. Rebuilding different bytes requires a new version; a rerun cannot overwrite public assets. A maintainer can also upload the release's existing `latest.json` to `app-latest` after checking its version and artifact URLs. To stop rollout, restore the previous release's exact manifest at `app-latest`; apps already running a newer version do not downgrade. To recover those installs, release the corrected or reverted application under a higher app version with the same signing key. Never relabel an old signature with a higher version.

GitHub secret provisioning, protected-tag/environment behavior, public asset downloads, and promotion at the real endpoint require a real GitHub release run and remain pending until a maintainer performs it. No tag push is part of local verification. The general container smoke runs an extracted AppRun; the updater smoke launches a writable AppImage through its own extract-and-run mode and exercises replacement and restart of that actual AppImage without FUSE. The installer smoke above separately proves ordinary FUSE-mounted installed-app launch and scheme dispatch in the disposable Linux container. macOS WKWebView/notarization and Windows WebView2/signing/restart checks remain native-runner acceptance; cross-platform publication wiring does not establish platform support. See the [macOS contract](../macos-app/README.md) and [Windows preview prerequisites](../windows-app/README.md).

Service stdout and stderr use separate `service-<port>.log` and `service-<port>-stderr.log` files so one stream cannot overwrite startup errors from the other. On failure, `lifecycle-failure.json` retains only Surface lifecycle/generation/failure timestamps and coordination authority before the private session is deleted; the database, pairing credentials, keyring and runtime profiles are never copied. A passing rerun does not establish the cause of an earlier intermittent startup failure.

The lifecycle snapshot is cleared when each run starts, so a passing run cannot inherit another session's failure. Failure snapshots also include the existing persisted lifecycle event times, Surface identities and states, allowing startup retries to be distinguished without retaining whole event payloads.
