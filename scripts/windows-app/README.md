# Windows x64 preview

Windows x64 builds a preview NSIS installer and a standalone Agent Daemon archive with verified Recall files. The desktop uses WebView2 and runs authorized desktop tools through its Tauri executor.

The compiled Sidecar process suite checks that a successfully launched application survives normal PowerShell completion, with root and descendant PIDs recorded before the result is accepted. It also checks command-tree cancellation, readable diagnostics, credential-directory refusal and authenticated TLS through the shipped executable. Run that suite on Windows to verify Job Objects, handle inheritance and temporary-file cleanup; Linux results do not establish Windows behavior.

## Build and install checks

Use a disposable Windows x64 account with PowerShell 7, Bun 1.4.5, Rust 1.97.1 MSVC, Visual Studio C++ build tools, WebView2, and network access for Tauri's NSIS toolchain and the pinned model. The frozen Bun install supplies the Tauri CLI.

```powershell
bun install --frozen-lockfile
./scripts/windows-app/build.ps1
./scripts/windows-app/smoke.ps1 -InstallOnly
```

Build output and Cargo caches remain in `.lane/windows-app`; installers and checksums go to `.lane/dist`. The stable product name, version and `com.omarchy.bot` identity remain independent of preview labeling, preserving upgrade identity. Unsigned installers have `unsigned-preview` in their filename and preview bundle metadata. `WINDOWS_CERTIFICATE_THUMBPRINT` optionally enables an already-provisioned account's Authenticode certificate; the script fails if the resulting signature is invalid. No certificate is installed by these scripts. Updater signatures are separate and required for release builds even when Authenticode is absent.

NSIS uses a per-user install and registers `HKCU\Software\Classes\omarchy-bot`. The install smoke verifies the protocol marker, installed executable, `%1` argument, bundled Agent Daemon and Recall files, and scheme removal during silent uninstall. It requires a disposable account without an existing app scheme. `-InstallOnly` verifies the installation boundary.

Windows stores the daemon connection in Credential Manager at `agent-daemon-connection.com.omarchy.bot`. The packaged WebView2 smoke checks that the app attaches to its local daemon and retains pairing after reopen. Credentials stay out of evidence logs.

## Full real WebView2 smoke

The [manual and reusable workflow](../../.github/workflows/windows-webview-smoke.yml) builds and installs the real NSIS package, then drives its WebView2 using tauri-driver and the matching Edge WebDriver. The runner supplies a scripted loopback model endpoint. The actual desktop and standalone daemon exercise launch, pairing, provider Settings, Conversation messages, attachments, and offline Recall. No off-host fixture is required.

The harness sets `OMARCHY_BOT_SMOKE_DIR` for native application-directory isolation in addition to WebView2's user-data folder. Windows Known Folder APIs do not honor `APPDATA` environment overrides by themselves; use the native smoke directory seam when executing on a developer checkout, and retain the disposable Windows account requirement for Credential Manager and URL-scheme registration.

Install tauri-driver 2.1.0 and a matching Edge WebDriver, put both on `PATH`, and run `./scripts/windows-app/smoke.ps1` in the disposable account. The workflow uploads the installed test results, screenshot, and driver logs. Verify desktop tool approval, execution, and denial from the installed app with a disposable local file and directory in a separate native acceptance run.

## Cross-platform release

An `app-vX.Y.Z` tag runs `app-release.yml`, which calls `windows-app-release.yml` to require the matching stable version and run the complete packaged WebView2 gate. Windows builds and smoke must succeed alongside Linux and both macOS architectures before the publication job runs. The Windows workflow can also be dispatched on the matching tag to validate release artifacts; it never independently publishes or alters a manifest. Its concurrency groups differ from the caller, avoiding a reusable-workflow deadlock.

Release compilation uses the protected `app-release` environment for the updater public key and signing credentials. The Windows smoke job downloads the build artifact and installs those same NSIS bytes. Publication uses that installer and the verified standalone archive from `windows-app-build`.

Set `TAURI_UPDATER_PUBKEY` and `TAURI_SIGNING_PRIVATE_KEY` / optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in `app-release`. The same key is used on Linux, both macOS architectures and Windows. Protect both environments for trusted release refs. `build.ps1 -Release` embeds `APP_VERSION`, public key and `https://github.com/<owner>/<repo>/releases/download/app-latest/latest.json`, enables Tauri updater generation, and requires the installer `.exe.sig`. Tauri 2's NSIS updater payload is the installer `.exe` itself; there is no invented zip payload. Installers are `omarchy-bot_<version>_x64-unsigned-preview-setup.exe`, with sibling `.sig` and `.sha256`. Authenticode remains independent; the local build script supports an already-provisioned certificate thumbprint, while CI currently produces unsigned previews.

The publication caller assembles all four platform entries and includes both macOS dmgs and updater archives. It downloads `windows-app-build` into a separate directory (its paths include `dist/` and `windows-app/`), copies only `dist/*` into the flat release directory, and validates every payload/installer checksum and updater signature's key/version metadata. It creates a private draft with the complete map and assets, verifies downloaded bytes, then publishes and promotes one complete manifest. Only this job has `contents: write`. Windows is labeled unsigned preview in filenames, release notes and prerelease metadata; app versions remain stable `X.Y.Z` and independent of Service runtime versions.

The shared assembler is independently runnable at the CLI seam after downloading all platform assets into one directory:

```sh
APP_VERSION=1.2.3 GITHUB_REPOSITORY=owner/repo TAURI_UPDATER_PUBKEY='<public key>' bun scripts/app-release.ts asset-directory
```

Missing platforms, installers, signatures, bad checksums or mismatched signed version/public-key metadata fail before manifest emission. Cryptographic verification remains Tauri's installation responsibility, exercised by the Linux signed updater smoke; this assembler checks release identity and integrity, not the signature's cryptography. Failed builds publish nothing. Rerun failed jobs to reuse successful build artifacts. Interrupted draft uploads may be replaced while private; public versioned bytes and manifest platform entries are immutable and must match on retry. A changed rebuild needs a new version. The rolling `app-latest` advances only to a numerically newer complete stable app version; publication of an older tag cannot roll it back.

Actual Windows compilation, NSIS install/deep-link/Credential Manager behavior, WebView2 pixels/input, and GitHub publication remain native-runner acceptance until their jobs run. Linux cross-compilation or parsing PowerShell cannot close ticket 15 criteria. macOS also requires its recorded WKWebView checklist on both architectures.

## Local implementation evidence

The final ticket 15 Linux regression rebuilt the AppImage with the pinned container and Cargo `--locked`, then passed all 26 packaged WebKit smoke checks after the native smoke-directory isolation change (107.09 seconds for build and smoke). Artifact SHA-256: `bf101738c111e528d3669dbb44d9d2fa4d07fae29b3d3c0b77230f5096948038`; evidence stays under `.lane/linux-app/evidence/`. The release CLI test, native Shell platform test, repository typecheck, explicit Windows-script TypeScript check, portable PowerShell parser/platform guards, workflow YAML parsing and actual Linux fixture start/pair/exchange/stop were exercised. Windows Sidecar cross-compilation succeeded. A Windows Rust cross-check reached Tauri's resource build but needs `llvm-rc` and the Windows SDK in its build environment; it does not establish a Windows build.

The final full `bun test` run used private Pi settings selecting `opencode-go/deepseek-v4.1-flash`: **833 passed, 23 skipped, 1 failed**, 5,321 assertions, 857 tests across 125 files. The sole failure is real Pi conformance step 2: expected `CONFORM-STREAM-OK`, received an empty response after a successful real session open. No test was weakened or skipped to hide it. Windows runtime/release acceptance has not been executed locally; run the protected workflows with the prerequisites above before marking those criteria complete.
