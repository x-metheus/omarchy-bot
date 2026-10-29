# Windows x64 preview

Windows is a preview until the packaged WebView2 suite passes and Authenticode signing is available. Static configuration and Chromium tests do not establish Windows support. The application embeds the shared Web UI; the Service and Bot Computer still run on Linux. Windows commands run through the bundled compiled Sidecar using Windows PowerShell 5.1, without WSL or Git Bash.

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

## Release seam with ticket 11

Ticket 11 is a separate branch and is **not integrated into this base**. The existing Shell updater remains unavailable here. Creating a signed artifact does not install or prove an updater. `build.ps1 -Release` explicitly refuses to proceed until the native updater dependency is present and public key/endpoint/private signing key are configured. No updater implementation was copied into this ticket.

`windows-app-release.yml` extends ticket 11's `app-vX.Y.Z` release and rolling `app-latest/latest.json` contract. After ticket 11 lands, dispatch it **on the immutable app-vX.Y.Z tag** with the same version, after the Linux release exists. The preflight requires its updater build config and a Linux manifest of the same version with no existing Windows entry. The workflow requires the complete WebView2 run, downloads the NSIS updater `.exe` and `.exe.sig`, preserves the Linux entry and release notes, adds `windows-x86_64`, publishes installer/signature/checksum, labels unsigned release notes preview and the release prerelease, then promotes only when `app-latest` has exactly that version. It downloads the published files and verifies checksums and both manifests. The `app-release` concurrency group matches ticket 11's workflow. Windows publication of an already-present entry fails, preserving immutable artifact identity.

Set `TAURI_UPDATER_PUBKEY` in `windows-smoke`, and `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` there for release build jobs. Protect both `windows-smoke` and `app-release` environments; publication uses the workflow's scoped `contents: write` token. The updater endpoint is `https://github.com/<owner>/<repo>/releases/download/app-latest/latest.json`. Release versions stay stable `X.Y.Z`; preview is an artifact/release label, not a conflicting semver channel. The provided release workflow intentionally publishes unsigned previews; optional Authenticode provisioning can later supply the build script's certificate thumbprint without changing the updater interface.

The merge CLI is independently runnable and tested at the CLI seam:

```sh
APP_VERSION=1.2.3 GITHUB_REPOSITORY=owner/repo bun scripts/windows-app/release.ts linux-latest.json setup.exe output-directory
```

It requires a nonempty installer and sibling `.sig`, rejects version mismatch or duplicate Windows publication, and preserves all existing platform entries. Cryptographic verification is performed by Tauri when installing updates; the CLI cannot authenticate a signature without the integrated updater. Actual Windows compilation, NSIS install/deep-link/Credential Manager behavior, WebView2 pixels/input and GitHub publication remain runner-only acceptance until the corresponding jobs run. Linux cross-compiling a Sidecar or parsing PowerShell cannot close these criteria.

## Local implementation evidence

The final ticket 15 Linux regression rebuilt the AppImage with the pinned container and Cargo `--locked`, then passed all 26 packaged WebKit smoke checks after the native smoke-directory isolation change (107.09 seconds for build and smoke). Artifact SHA-256: `bf101738c111e528d3669dbb44d9d2fa4d07fae29b3d3c0b77230f5096948038`; evidence stays under `.lane/linux-app/evidence/`. The release CLI test, native Shell platform test, repository typecheck, explicit Windows-script TypeScript check, portable PowerShell parser/platform guards, workflow YAML parsing and actual Linux fixture start/pair/exchange/stop were exercised. Windows Sidecar cross-compilation succeeded. A Windows Rust cross-check reached Tauri's resource build but needs `llvm-rc` and the Windows SDK in its build environment; it does not establish a Windows build.

The final full `bun test` run used private Pi settings selecting `opencode-go/deepseek-v4.1-flash`: **833 passed, 23 skipped, 1 failed**, 5,321 assertions, 857 tests across 125 files. The sole failure is real Pi conformance step 2: expected `CONFORM-STREAM-OK`, received an empty response after a successful real session open. No test was weakened or skipped to hide it. Windows runtime/release acceptance has not been executed locally; run the protected workflows with the prerequisites above before marking those criteria complete.
