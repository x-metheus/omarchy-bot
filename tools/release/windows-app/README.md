# Windows x64 preview

Windows x64 builds a preview NSIS installer and a standalone Agent Daemon archive with verified Recall files. The desktop uses WebView2 and runs authorized desktop tools through its Tauri executor.

## Build and install checks

Dispatch the [Windows package workflow](../../../.github/workflows/windows-app.yml) to build and run the install-only smoke in GitHub Actions.

Use a disposable Windows x64 account with PowerShell 7, Bun 1.4.5, Rust 1.97.1 MSVC, Visual Studio C++ build tools, WebView2, and network access for Tauri's NSIS toolchain and the pinned model. Run the builder from the repository root. It installs the locked release tools and desktop dependencies, including the pinned Tauri CLI.

```powershell
./tools/release/windows-app/build.ps1
./tools/release/windows-app/smoke.ps1 -InstallOnly
```

Build output and Cargo caches remain in `.lane/windows-app`; installers and checksums go to `.lane/dist`. The stable product name, version and `com.omarchy.bot` identity remain independent of preview labeling, preserving upgrade identity. Unsigned installers have `unsigned-preview` in their filename and preview bundle metadata. `WINDOWS_CERTIFICATE_THUMBPRINT` optionally enables an already-provisioned account's Authenticode certificate; the script fails if the resulting signature is invalid. No certificate is installed by these scripts. Updater signatures are separate and required for release builds even when Authenticode is absent.

NSIS uses a per-user install and registers `HKCU\Software\Classes\omarchy-bot`. The install smoke verifies the protocol marker, installed executable, `%1` argument, bundled Agent Daemon and Recall files, and scheme removal during silent uninstall. It requires a disposable account without an existing app scheme. `-InstallOnly` verifies the installation boundary.

Windows stores the daemon connection in Credential Manager at `agent-daemon-connection.com.omarchy.bot`. The packaged WebView2 smoke checks that the app attaches to its local daemon and retains pairing after reopen. Credentials stay out of evidence logs.

## Full real WebView2 smoke

The [manual and reusable workflow](../../../.github/workflows/windows-webview-smoke.yml) builds and installs the real NSIS package, then drives its WebView2 using tauri-driver and the matching Edge WebDriver. The runner supplies a scripted loopback model endpoint. The actual desktop and standalone daemon exercise launch, pairing, provider Settings, Conversation messages, attachments, and offline Recall. No off-host fixture is required.

The harness sets `OMARCHY_BOT_SMOKE_DIR` for native application-directory isolation in addition to WebView2's user-data folder. Windows Known Folder APIs do not honor `APPDATA` environment overrides by themselves; use the native smoke directory seam when executing on a developer checkout, and retain the disposable Windows account requirement for Credential Manager and URL-scheme registration.

Install tauri-driver 2.1.0 and a matching Edge WebDriver, put both on `PATH`, and run `./tools/release/windows-app/smoke.ps1` in the disposable account. The workflow uploads the installed test results, screenshot, and driver logs. Verify desktop tool approval, execution, and denial from the installed app with a disposable local file and directory in a separate native acceptance run.

## Cross-platform release

An `app-vX.Y.Z` tag runs `app-release.yml`, which calls `windows-app-release.yml` to require the matching stable version and run the complete packaged WebView2 gate. Windows builds and smoke must succeed alongside Linux and both macOS architectures before the publication job runs. The Windows workflow can also be dispatched on the matching tag to validate release artifacts; it never independently publishes or alters a manifest. Its concurrency groups differ from the caller, avoiding a reusable-workflow deadlock.

Release compilation uses the protected `app-release` environment for the updater public key and signing credentials. The Windows smoke job downloads the build artifact and installs those same NSIS bytes. Publication uses that installer and the verified standalone archive from `windows-app-build`.

Set `TAURI_UPDATER_PUBKEY` and `TAURI_SIGNING_PRIVATE_KEY` / optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `app-release`. The same key is used on Linux, both macOS architectures and Windows. Protect `app-release` for trusted release refs. `build.ps1 -Release` embeds `APP_VERSION`, public key and `https://github.com/<owner>/<repo>/releases/download/app-latest/latest.json`, enables Tauri updater generation, and requires the installer `.exe.sig`. Tauri 2 uses the NSIS installer `.exe` as the updater payload. Installers are `omarchy-bot_<version>_x64-unsigned-preview-setup.exe`, with sibling `.sig` and `.sha256`. The local build script supports an already-provisioned Authenticode certificate thumbprint. CI produces unsigned previews.

The publication caller assembles all four platform entries and includes both macOS dmgs and updater archives. It downloads `windows-app-build` into a separate directory (its paths include `dist/` and `windows-app/`), copies only `dist/*` into the flat release directory, and validates every payload/installer checksum and updater signature's key/version metadata. It creates a private draft with the complete map and assets, verifies downloaded bytes, then publishes and promotes one complete manifest. Only this job has `contents: write`. Windows is labeled unsigned preview in filenames, release notes and prerelease metadata. App release versions use stable `X.Y.Z` tags.

The shared assembler is independently runnable at the CLI seam after downloading all platform assets into one directory:

```sh
APP_VERSION=1.2.3 GITHUB_REPOSITORY=owner/repo TAURI_UPDATER_PUBKEY='<public key>' bun tools/release/app-release.ts asset-directory
```

Missing platforms, installers, signatures, bad checksums or mismatched signed version/public-key metadata fail before manifest emission. Cryptographic verification remains Tauri's installation responsibility, exercised by the Linux signed updater smoke; this assembler checks release identity and integrity, not the signature's cryptography. Failed builds publish nothing. Rerun failed jobs to reuse successful build artifacts. Interrupted draft uploads may be replaced while private; public versioned bytes and manifest platform entries are immutable and must match on retry. A changed rebuild needs a new version. The rolling `app-latest` advances only to a numerically newer complete stable app version; publication of an older tag cannot roll it back.

The Windows workflows exercise native compilation, NSIS installation and deep-link registration, Credential Manager, and WebView2. Publication runs in the app release workflow after its platform jobs pass. macOS support requires the recorded WKWebView checklist on both architectures.
