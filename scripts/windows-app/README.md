# Windows x64 preview

Windows is a preview until the packaged WebView2 suite passes and Authenticode signing is available. Static configuration and Chromium tests do not establish Windows support. The application embeds the shared Web UI; the Service and Bot Computer still run on Linux. Windows commands run through the bundled compiled Sidecar using Windows PowerShell 5.1, without WSL or Git Bash.

The four Windows Sidecar application-survival tests retain their process-exit waits and survival assertions. Their `[windows-launch-cleanup]` logs capture `Get-CimInstance Win32_Process` ancestry from the command and launched-child PIDs when the child reports readiness, before test cleanup kills recorded PIDs, and on the first and final fixture-removal failures. Each snapshot includes `ProcessId`, `ParentProcessId`, `Name` and `CommandLine`; witnessed descendants remain query seeds after their parents exit. A live launched child is expected before cleanup; descendants still present after recorded PID exit waits are unexpected. Ancestry identifies candidates, not open file handles. Diagnostic PowerShell runs outside the fixture, with a 2-second process timeout, a 1-second CIM operation timeout and a 256 KiB output limit; capture failures are logged without replacing the original removal error.

Fixture removal retries for 10 seconds from its first attempt, backing off from 100 ms through 200/400/800 ms to at most 1 second and counting the first failure snapshot against that deadline. Logs report the fixture path, lock error code, attempts, delay and elapsed time, then success or terminal failure. The final snapshot may add up to 2 seconds after the retry deadline; OS removal calls and scheduling add their own latency. A terminal failure rethrows the first removal error. These diagnostics do not establish the lock owner or fix an unobserved executor leak; the next Windows CI run supplies that evidence.

## Build and install checks

Use a disposable Windows x64 account with PowerShell 7, Bun 1.4.4, Rust 1.93.1 MSVC, Visual Studio C++ build tools, WebView2 and network access for Tauri's NSIS toolchain. Install tauri-cli 2.12.4 with its Cargo lock into a private tool directory and add its bin directory to this process's PATH, as the workflow does. From the repository root:

```powershell
bun install --frozen-lockfile
./scripts/windows-app/build.ps1
./scripts/windows-app/smoke.ps1 -InstallOnly
```

Build output and Cargo caches remain in `.lane/windows-app`; installers and checksums go to `.lane/dist`. The stable product name, version and `com.omarchy.bot` identity remain independent of preview labeling, preserving upgrade identity. Unsigned installers have `unsigned-preview` in their filename and preview bundle metadata. `WINDOWS_CERTIFICATE_THUMBPRINT` optionally enables an already-provisioned account's Authenticode certificate; the script fails if the resulting signature is invalid. No certificate is installed by these scripts. Updater signatures are separate and required for release builds even when Authenticode is absent.

NSIS uses a per-user install and registers `HKCU\Software\Classes\omarchy-bot`. The install smoke verifies its protocol marker, installed executable and `%1` argument, the bundled Sidecar, and removal of the scheme during silent uninstall. It refuses an account with an existing app scheme. `-InstallOnly` is deliberately a separate check and provides no WebView acceptance evidence.

Windows stores the connection in Credential Manager at `service-connection.com.omarchy.bot`, username `service-connection`. Linux continues to use Secret Service. The Windows smoke reads Credential Manager directly, compares the actual token against WebView localStorage, and verifies restart persistence. Credentials are captured privately and never written to evidence logs. Windows TLS diagnostics use Schannel's certificate chain and hostname validation; the smoke requires an untrusted HTTPS endpoint and asserts the visible certificate error. No trust bypass is used by the app.

## Full real WebView2 smoke

`.github/workflows/windows-webview-smoke.yml` is a manual/reusable workflow, not a pull-request workflow. Set up the protected `windows-smoke` environment with approval restricted to trusted refs, then provide:

| Configuration | Required value |
| --- | --- |
| Runner | One dedicated, disposable Linux x64 runner labeled `windows-smoke-service`, Docker available; only one runner with this label so cleanup uses the same checkout |
| `WINDOWS_SMOKE_HOST_SECRET` secret | Random pairing-host secret dedicated to this disposable fixture |
| `WINDOWS_SMOKE_SERVICE_ORIGIN` variable | Publicly trusted HTTPS origin reverse-proxied to that runner's `127.0.0.1:7431`; proxy HTTP and WebSocket upgrades without buffering, connect from loopback |
| `WINDOWS_SMOKE_UNTRUSTED_ORIGIN` variable | Reachable HTTPS origin/port to the runner's `7432`, retaining the fixture's untrusted certificate (TCP passthrough, no terminating trusted TLS) |
| Windows runner | `windows-2022`, WebView2 runtime and Edge installed; workflow downloads the Edge-matching WebDriver and privately installs tauri-driver 2.1.0 |

The workflow starts real disposable Linux Services, the checksum-pinned Sway runtime, browser pack, fonts and X11 color fixture inside the ticket 07 container. Only the Agent worker is scripted to issue deterministic tool requests; Service HTTP/WebSockets, projection, input and Sidecar execution are real. No host compositor, display, home or session bus is mounted. The protected runner must be externally reachable through the pre-provisioned HTTPS proxy; the workflow never edits DNS, firewall, certificates or host services. The untrusted port must be reachable by the Windows runner. Only pairing issuance uses the host secret; the app uses its real exchanged device token. Protect and restrict network access to this test environment.

The Service fixture uses Docker host networking on the dedicated Linux runner so pairing-host authorization sees the proxy's loopback peer. The app still pairs to the external HTTPS origin, which starts its off-host Sidecar; the harness reconstructs that configured public origin from the real issued code. A Docker bridge proxy peer would fail the Service's same-host issuance check. The fixture does not relax production pairing authorization or CORS.

Never expose the self-hosted runner to untrusted fork/PR code or use `pull_request_target`. Use a dedicated runner checkout and ephemeral account; stop/remove leftovers after a force-cancelled job (the container name is `omarchy-windows-smoke-<GITHUB_RUN_ID>`). Normal success/failure invokes cleanup. GitHub job cancellation can prevent any cleanup job from running. Provisioning this remote runner/proxy is an explicit external prerequisite, not an automatic skip. Missing URLs, secret, driver, Service or any assertion fails the full smoke. The ordinary PR workflow builds and checks NSIS only.

The harness sets `OMARCHY_BOT_SMOKE_DIR` for native application-directory isolation in addition to WebView2's user-data folder. Windows Known Folder APIs do not honor `APPDATA` environment overrides by themselves; use the native smoke directory seam when executing on a developer checkout, and retain the disposable Windows account requirement for Credential Manager and URL-scheme registration.

For an already-running private Linux fixture, set the four smoke variables (`WINDOWS_SMOKE_X11_FIXTURE=/src/.lane/windows-app/x11-fixture`) then run `./scripts/windows-app/smoke.ps1`. It launches the installed executable under tauri-driver with private WebView2/local application data. It covers cold URL-scheme pairing, forwarding into the same running process/window, Credential Manager and token absence, the event stream delivering a Bot reply, actual magenta Sway pixels, pointer turning them cyan, keyboard turning them yellow, and an exact approved PowerShell `local.run` whose output and outgoing `dev_` tag match the real registered Windows Sidecar. Screenshots, artifact hash, installer/uninstaller assertions and concise results are uploaded. A partial result never reports the full suite successful.

## Cross-platform release

An `app-vX.Y.Z` tag runs `app-release.yml`, which calls `windows-app-release.yml` to require the matching stable version and run the complete packaged WebView2 gate. Windows builds and smoke must succeed alongside Linux and both macOS architectures before the publication job runs. The Windows workflow can also be dispatched on the matching tag to validate release artifacts; it never independently publishes or alters a manifest. Its concurrency groups differ from the caller, avoiding a reusable-workflow deadlock.

`windows-webview-smoke.yml` separates the native build from execution: release compilation selects the protected `app-release` environment for `TAURI_UPDATER_PUBKEY` and Tauri private key/password; the Service fixture and WebView2 jobs retain `windows-smoke` for their URLs and pairing-host secret. Only the build step receives updater signing secrets. The signed NSIS bytes and build metadata are uploaded as `windows-app-build`, downloaded under `.lane` on the smoke runner, and installed after rebasing the recorded installer path. No private keys, keychains or smoke credentials are uploaded. The same artifact is downloaded by publication; no second Windows build occurs.

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
