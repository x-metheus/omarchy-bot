# Omarchy Bot app

**Status:** ready-for-agent

Architecture sources: [ADR 0015](../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md) (Omarchy Bot is the only Bot Client), which amends [ADR 0010](../../docs/adr/0010-reuse-web-client-in-tauri.md), [ADR 0011](../../docs/adr/0011-local-sidecar-only-off-host.md), [ADR 0013](../../docs/adr/0013-run-a-standalone-linux-service.md), and [ADR 0014](../../docs/adr/0014-require-paired-device-tokens.md). ADR 0009, Computer ADR 0011, and the This Device rules of ADR 0011 remain in force.

## Problem Statement

The only way to use Omarchy Bot today is a browser tab opened on a page the Service itself serves. Nothing installs on the user's own machines: a Mac or Windows user cannot get an application for their Bots, and a laptop cannot offer its own files and commands to a Bot, because the Local Sidecar only runs where the plugin runtime's Bun exists and only connects to a Service on loopback. The Web UI assumes it shares the Service's origin for pairing, token storage, projection endpoints, and plugin authorization, so it cannot run anywhere else. Service-side dictation records the Service Host's microphone, which is the wrong machine whenever the user is remote and does not exist on most non-Omarchy hosts. There is also no path to a phone client later.

## Solution

**Omarchy Bot** is a Tauri 2 application for Linux, macOS, and Windows and the only Bot Client. It embeds the existing Web UI and talks to one paired Service directly over the existing HTTP and WebSocket contracts, cross-origin. The Service stops serving any UI: it serves the API, WebSockets, the plugin OAuth callback, and the health probe. Several installs on different machines may use the same Service at once.

The user installs the app, enters the Service address and a one-time pairing code (or clicks a `omarchy-bot://pair` deep link), and the token is kept in the operating system keychain. On a graphical Service Host the installer, including the Omarchy plugin, installs the app too and opens that deep link, so local setup stays one click. If the app and the Service disagree on protocol version, the app says which one to update.

When the app is on another machine, it starts its bundled, compiled Local Sidecar so Bots can run commands, search, and move files on that machine after the user approves each action in the app. The Sidecar works natively on Linux and macOS (POSIX `sh`) and Windows (PowerShell 5.1), and tells the Agent which one it is.

Plugin account authorization opens in the system browser and completes back into the app automatically. Dictation is left to each operating system's own dictation, which types into the composer. On macOS, ⌘ acts as Ctrl inside a taken-over Bot Screen. The app updates itself.

Every native capability sits behind one `shell` interface, so a phone shell can be chosen later without touching the UI.

## User Stories

1. As a Linux user, I want to install Omarchy Bot as a single AppImage, so that it runs on any distribution without a package manager.
2. As a macOS user, I want a notarized dmg for Apple Silicon and Intel, so that the app opens without security warnings.
3. As a Windows user, I want an installer for Omarchy Bot, so that I can use my Bots from a Windows machine.
4. As a Windows user, I want the build labeled a preview until its WebView checks pass and it is signed, so that I know what is supported.
5. As an Omarchy user, I want enabling the Omarchy plugin to install both the Service and the app, so that I get a working client without a browser.
6. As a user installing the Service on a desktop distribution, I want the installer to install the app and open it already pairing, so that first use is one click.
7. As a user installing the Service on a headless host, I want only the Service installed, so that a server does not get a GUI it cannot run.
8. As a user, I want `omarchy-bot pair` to print the Service address and a one-time code, so that I can pair an app on another machine.
9. As a user, I want an Add Service screen that takes an address and a code, so that pairing works without any browser.
10. As a user, I want clicking an `omarchy-bot://pair` link to open the app and pair, so that I do not need to type the code.
11. As a user, I want a pairing deep link that arrives while the app is already running to be handled by the running app, so that I never get two windows fighting over pairing.
12. As a user, I want my device token kept in the operating system keychain, so that another program reading app files cannot steal it.
13. As a user, I want the app to reopen connected to my Service after a restart, so that I pair once.
14. As a user, I want to unpair and pair with a different Service, so that I can move to another host.
15. As a user, I want to know when my device has been revoked and be taken back to pairing, so that I am not left with a broken window.
16. As a user with a laptop and a desktop, I want both apps connected to the same Service at the same time, so that I can continue the same Threads from either machine.
17. As a user with two apps open, I want Takeover and input leases to keep arbitrating Bot Screen control, so that two machines never interleave input.
18. As a user, I want the app to refuse to connect to a Service whose protocol it does not support and tell me whether to update the app or the Service, so that I never get half-working screens.
19. As a user, I want the app to update itself from signed releases, so that I stay compatible with my Service without manual downloads.
20. As a remote user, I want to connect to a Service with a publicly trusted certificate, so that I can use a cloud Service directly.
21. As a remote user, I want to connect through an SSH tunnel to a loopback address, so that I have a safe path without a certificate.
22. As a remote user, I want a clear error when the Service presents an untrusted certificate, so that I know to fix TLS rather than retry.
23. As a user, I want the conversation UI, Bot Settings, attachments, and Bot Screens to behave the same as the Web UI did, so that nothing is lost in the move.
24. As a user, I want Screen Projection and Takeover to work in the app on every supported operating system, so that I can watch and control Bot Screens anywhere.
25. As a macOS user taking over a Bot Screen, I want ⌘C, ⌘V, and other ⌘ shortcuts to act as Ctrl shortcuts, so that Linux apps feel native.
26. As a macOS user, I want ⌥ to act as Super in a Bot Screen, so that I can still reach Super shortcuts.
27. As a macOS user who prefers the physical mapping, I want to override the ⌘ mapping for this device, so that ⌘ sends Super.
28. As a user, I want to paste text from my machine into a taken-over Bot Screen, so that clipboard text still flows in.
29. As a user connecting a plugin account, I want the provider page to open in my normal browser, so that I can use my existing logins and password manager.
30. As a user, I want the app to notice when plugin authorization completes, so that I do not need to return manually or refresh.
31. As a user, I want a failed or cancelled authorization to show in the app, so that I can retry.
32. As a user on a laptop paired with a remote Service, I want my Bots to run commands on my laptop when I allow them, so that they can work with my local tools.
33. As a user, I want Bots to search, read, and write files on my laptop with my approval, so that local files are reachable without manual copying.
34. As a user, I want Bots to transfer files between my laptop and the Shared Workspace, so that results land where I need them.
35. As a user, I want each local action shown with its exact command or path and a choice of Ask, Always, or Never, so that I control what runs on my machine.
36. As a user, I want my Always and Never choices remembered for this install, so that I am not asked repeatedly.
37. As a user, I want local actions available only while the app is running, so that nothing runs on my machine when I have closed it.
38. As a user, I want pending local actions to fail clearly when I quit the app, so that a Bot does not wait forever.
39. As a user, I want only the install that sent a message to be that Turn's This Device, so that a Bot never acts on a different machine of mine.
40. As a user running the app on the Service Host, I want no Local Sidecar, so that local actions never duplicate the Service's own tools.
41. As a Windows user, I want local commands to run in PowerShell natively, so that I do not need WSL or Git Bash.
42. As a Windows user, I want cancelling a local command to stop it and everything it started, so that nothing is left running.
43. As an Agent, I want the `local` tool to tell me the device's operating system and shell, so that I write commands in the right syntax.
44. As a user, I want my credential and key folders refused on every operating system, so that secrets on a Mac or Windows machine are protected like on Linux.
45. As a user, I want screenshots, pointer, and compositor actions refused by the Local Sidecar on every operating system, so that it never controls my own screen.
46. As a user, I want to dictate into the composer with my operating system's dictation, so that voice input uses my own microphone wherever I am.
47. As a user, I want no microphone button that records some other machine, so that the UI does not offer a broken feature.
48. As a developer, I want to run the Web UI in a browser against a local Service, so that UI work does not need a native build.
49. As a developer, I want UI tests to run in Chromium against a fake shell, so that UI behavior is covered without Tauri.
50. As a maintainer, I want a smoke suite in the real WebView of each operating system, so that projection and input are proven where they ship.
51. As a maintainer, I want the Local Sidecar's tests to run against the compiled binary on each operating system, so that the shipped artifact is what is tested.
52. As a future phone-client developer, I want every native capability behind one shell interface, so that a phone shell only implements that interface.
53. As an operator, I want unpaired requests and WebSockets from any origin still rejected, so that allowing the app's origins does not weaken pairing.
54. As an operator, I want WebSocket upgrades from origins other than the app's to be refused, so that a malicious web page cannot reach the Service through a user's browser.

## Implementation Decisions

### Service

- The Service no longer serves the Web UI's static files, its single-page fallback, or the `/pair` page. Unmatched non-API routes return 404. The Service runtime archive no longer carries the Web build.
- The Service answers CORS for a fixed allowlist of the app's origins on every platform (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`), plus loopback development origins only when started in development mode. Preflight requests are answered without authentication; actual requests still require a device token. Credentials (cookies) are never allowed.
- Every WebSocket upgrade (events, projection, RFB, and the device channel) checks the `Origin` header: an absent Origin (non-browser callers such as the Local Sidecar) or an allowlisted origin passes; any other origin is refused before authentication.
- The health probe reports a `protocol` version alongside the Service version. The protocol version is a single integer owned by the protocol package and raised on every breaking change to the client-facing contract. The app declares the protocol versions it supports and compares on connect.
- Pairing code issuance returns the code and a deep link (`omarchy-bot://pair?service=<origin>&code=<code>`) instead of a `/pair?code=` URL. The pairing exchange contract is unchanged.
- Plugin authorization no longer accepts or validates a return URL. The OAuth callback page tells the user to return to Omarchy Bot and offers an `omarchy-bot://` link. Completion or failure of an authorization is published as an event on the existing event stream, scoped to the plugin and account, so every connected app refreshes plugin state.
- Service-side dictation is removed: the dictation module, its routes, its configuration, its DTOs and events, and its Voxtype detection in `doctor`.

### Local Sidecar

- The Sidecar takes a Service URL (`ws`, or `wss` for TLS Services) instead of a loopback port. The device token still travels as `access_token`.
- The `register` frame gains `os` (`linux`, `macos`, `windows`) and `shell` (`posix-sh`, `powershell-5.1`). The Service stores them on the roster entry and includes them in the `local` tool's description of This Device, so the Agent writes matching syntax.
- Command execution is split behind one executor interface with two implementations: POSIX (current process-group leader and SIGTERM/SIGKILL escalation, used on Linux and macOS) and Windows (Windows PowerShell 5.1, the job assigned to a Job Object that is closed with kill-on-close on cancel or timeout). The rest of the job handler (approval, confinement, search, read, write, transfer, result truncation) is shared.
- The secret-directory denylist is defined per operating system: the current POSIX list on Linux, plus `Library/Keychains` and other credential stores on macOS, plus `AppData` credential and key stores on Windows.
- The compositor and screenshot refusal applies on every operating system.
- The Sidecar is a small standalone Rust program built for each target (`linux-x64`, `darwin-arm64`, `darwin-x64`, `windows-x64`) and bundled in the app as a Tauri external binary. It replaces the `bun build --compile` TypeScript Sidecar and no longer carries a Bun runtime. It remains a separate child process, isolating its lifetime and failures from the Tauri app and preserving the shipped-binary test boundary (ADR 0015).
- The app starts the Sidecar as a child when it connects to a Service not on the same machine (the existing same-host check is unchanged), and terminates it on quit or unpair. Ask, Always, and Never decisions keep the existing stdin/stdout JSON line contract; the app renders the prompts and persists Always/Never per install.

### Web UI

- A `shell` interface is the only way the Web UI reaches native capability. Its surface:
  - Service connection: read and store the Service base URL and device token, and clear them on unpair.
  - Pairing intake: subscribe to incoming pairing requests (deep links, including those delivered to an already running app).
  - System browser: open an external URL.
  - Updates: check, download, and restart.
  - Local Sidecar: report whether one is running and its device identity, and exchange approval prompts and decisions.
  - Key mapping: report the platform and the per-device ⌘ mapping preference.
- The Tauri implementation lives in the app. An in-memory implementation exists for tests and for the browser development harness.
- `ApiClient` is constructed from the shell's base URL and token getter. Every place that currently derives an address from `window.location` (pairing, projection and RFB endpoints, plugin authorization, browser-loaded attachment URLs) uses the base URL instead.
- The Local Sidecar device identity comes from the shell rather than a page global. The ADR 0011 identity contract (tag every `message.send` with the install's `dev_` identity when a Sidecar runs, no tag otherwise) is unchanged.
- The `/pair` route and its query-string exchange are replaced by an Add Service screen (address and code) and the shell's pairing intake. With no stored token, the app shows Add Service. A 401 on any request returns to Add Service with a "this device was revoked" message.
- On connect the UI reads the health probe; outside the supported protocol range it shows a blocking screen naming which side to update, with the app's update action when the app is behind.
- Plugin authorization opens the provider URL through the shell's system browser and waits for the completion event; no popup and no `window.location` navigation.
- The composer's microphone button, voice settings, and dictation state are removed.
- Takeover keyboard handling maps ⌘ to Ctrl and ⌥ to Super on macOS by default, with a per-device override stored by the shell. Other platforms are unchanged. The existing paste path is unchanged.
- The Vite development server remains a developer harness: it runs the bundle in a browser with the in-memory shell pointed at a local Service.

### App (Tauri 2 shell)

- A new app in this monorepo, Omarchy Bot, embeds the Web UI production build. The Rust side is kept thin: keychain (via the operating system credential store), deep-link registration with single-instance forwarding, opening the system browser, the updater, Sidecar process lifetime and stdio bridging, and nothing else. It uses only plugins that also exist for Tauri mobile, or isolates those that do not behind the `shell` interface.
- Content Security Policy allows connections only to the paired Service origin (`https`/`wss`, or `http`/`ws` for loopback).
- Packaging: Linux AppImage (x86_64), macOS dmg signed and notarized (arm64 and x64), Windows NSIS (x64), signed when a certificate is available and labeled preview until then. Release artifacts and the signed updater manifest are published to GitHub Releases. App versions are independent of Service runtime versions; compatibility is decided only by the protocol version.

### Installer and Omarchy plugin

- On a host with a graphical session, the installer downloads the checksum-verified Omarchy Bot AppImage, installs it with a desktop entry and the `omarchy-bot` URL scheme registered for the user, and finishes by opening the pairing deep link instead of a browser URL. Without a graphical session it installs only the Service and prints the address and code.
- `omarchy-bot pair` prints the Service address, the code, and the deep link.
- `uninstall` removes the app along with the Service, keeping user data.
- The Omarchy plugin keeps calling the same installer, so it now installs both.
- `doctor` reports the app installation and URL-scheme registration on graphical hosts, and drops dictation checks.

## Testing Decisions

Good tests drive external behavior through the highest available seam and never assert on internal structure. These are the only seams for this work, confirmed before writing.

- **Service HTTP and WebSocket boundary.** Uses the existing in-process daemon harness, extending the device-pairing, daemon, and plugin tests. It covers:
  - CORS preflight and response headers for allowlisted origins, and their absence for others.
  - WebSocket upgrades refused for foreign origins and accepted with no origin or an allowlisted one.
  - 404 for the former static and `/pair` routes.
  - The protocol version on the health probe.
  - Pairing codes returned as deep links.
  - Plugin authorization started without a return URL, and its completion and failure arriving as events.
  - Dictation routes gone.

  The existing dictation integration test and e2e spec are deleted.
- **Local Sidecar process boundary.** Uses the existing Local Sidecar helper and the local-sidecar integration tests. It covers:
  - Connecting by URL (including `wss` against a TLS harness).
  - `os` and `shell` on registration, and their appearance in the `local` tool description.
  - Per-OS denylists.
  - Cancel tearing down a process tree on each operating system.
  - Protocol wire types stay aligned through the shared canonical JSON fixtures in `packages/protocol/fixtures/sidecar/` defined by ADR 0015. TypeScript derives coverage requirements from the authoritative device-frame schemas and `LOCAL_SCHEMA`, failing if a frame variant, action, or property lacks a fixture, including both presence and absence for every optional property. It validates each fixture against those schemas with an unchanged JSON round-trip; Rust deserializes the same fixtures with unknown fields rejected and re-serializes equal JSON values. Adding an optional field or variant must fail coverage until the corpus and both consumers are updated.

  The suite selects the compiled Rust binary through `OMARCHY_BOT_TEST_SIDECAR_BINARY` in CI on Linux, macOS, and Windows runners; both protocol-fixture consumers also run there. Windows-only cases (PowerShell syntax, Job Object teardown) run only there.
- **The `shell` interface.** The existing Chromium Playwright suite moves from the Service-served UI to the Vite-served bundle with the in-memory shell, pointed at the harness Service. New specs cover:
  - Add Service.
  - Deep-link pairing intake.
  - Revocation returning to Add Service.
  - The protocol-mismatch screen.
  - OAuth through the system-browser call and completion event.
  - Local approval prompts.
  - ⌘ mapping on a simulated macOS platform.

  Prior art is the existing e2e fixtures and specs.
- **WebView smoke suite.** The packaged app under `tauri-driver` on Linux (WebKitGTK) and Windows (WebView2), and a written checklist run on macOS (WKWebView) before each release. Each run covers:
  - Pairing by deep link.
  - The event stream delivering a Bot reply.
  - Screen Projection rendering.
  - Takeover keyboard and pointer input reaching the Bot Screen.
  - One approved `local.run`.

  A platform is supported only after this suite passes there. Chromium results never stand in for it.
- **CLI and installer.** Extends the existing CLI lifecycle tests. They cover:
  - Installing the AppImage and URL scheme when a graphical session is present, and skipping both when it is not.
  - Opening the deep link through the opener.
  - `pair` output.
  - Uninstall removing the app.
  - `doctor` checks.

## Out of Scope

- A phone client and the choice between Tauri mobile and Capacitor; only the `shell` interface is prepared for it.
- One install switching between or merging several Services.
- A browser client of any kind, including a fallback.
- Desktop notifications, a tray icon, launch at login, and global shortcuts.
- Certificate-fingerprint pinning or any self-signed certificate exception.
- Client-side audio capture or any replacement dictation feature.
- Running the Local Sidecar in the background after the app quits.
- WSL or Git Bash execution on Windows, and PowerShell 7 as the Windows shell.
- Linux arm64 and Windows arm64 builds.
- macOS or Windows as Service Hosts.

## Further Notes

- There are no installed Services yet, so the browser UI is removed immediately with no migration or release hold. Until a platform's app passes its smoke suite, that platform has no client; Linux is expected first, then macOS, then Windows.
- The macOS dmg needs an Apple Developer account for notarization, and the signed Windows installer needs a code-signing certificate; the Tauri updater needs its own signing key held as a release secret.
- The protocol version starts at 1 with this cutover, since removing static serving, the return URL, and dictation are all breaking changes.
- The vertical-slice tickets for this spec are under `issues/`. Tickets 01, 06, and 08 start immediately.
