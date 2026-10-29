# Omarchy Bot is the only Bot Client

Status: accepted on 2026-10-28. Amends [ADR 0010](0010-reuse-web-client-in-tauri.md) (Omarchy Bot is now delivered, and the browser stops being a client), [ADR 0011](0011-local-sidecar-only-off-host.md) (the Local Sidecar is a compiled, cross-platform binary inside this repository's client), [ADR 0013](0013-run-a-standalone-linux-service.md) (the installer and Omarchy plugin also install Omarchy Bot on graphical hosts; Service-side dictation is retired), and [ADR 0014](0014-require-paired-device-tokens.md) (pairing ends in a deep link instead of a browser URL). Implementation is tracked by [the Omarchy Bot app specification](../../.scratch/omarchy-bot-app/spec.md).

**Omarchy Bot**, a Tauri 2 application for Linux, macOS, and Windows, is the only Bot Client. The browser is no longer a client: the Service serves the HTTP API, WebSockets, the plugin OAuth callback, and the health probe, and no static UI or `/pair` page. The Web UI remains the client's whole user interface, embedded in the application bundle rather than loaded from the Service, so the client talks to the Service cross-origin. The Service therefore allows the client's fixed origins through CORS and checks the Origin of every WebSocket upgrade; the device token travels in a header or `access_token`, never a cookie. Every native capability (token store, Service address and startup status, certificate diagnosis, deep links, system browser, attachment downloads, updater, Local Sidecar control and approvals, Bot Screen key mapping) sits behind one `shell` interface in the Web UI, so a future phone shell (Tauri mobile or Capacitor, chosen when phone work starts) replaces only that interface.

One install pairs with one Service; many installs may be paired with the same Service at once, as ADR 0014 already allows. The client checks the Service's protocol version on connect and names the side to update instead of running against a mismatched contract. Remote Services need a publicly trusted certificate or an SSH tunnel to loopback, because WebViews offer no self-signed certificate exception.

## Local Sidecar

The Local Sidecar ships in the first release. It is compiled with `bun build --compile` per target and bundled in the application, replacing ADR 0011's "run by the plugin-runtime Bun", which client machines do not have. It runs only while the application runs, connects outbound to its install's Service URL (not only a loopback port), and is still never started when the Service is on the same machine. Linux and macOS run commands through POSIX `sh` with process-group teardown; Windows runs Windows PowerShell 5.1 with Job Object teardown. The Sidecar declares its operating system and shell at registration so the Agent writes the right syntax, and its secret-directory denylist is defined per operating system. The client shell, now part of this repository, owns the approval prompts and the This Device identity contract of ADR 0011.

## Pairing and installation

`omarchy-bot pair` and installation print the Service address and a one-time code; the client's Add Service screen accepts both. On a host with a graphical session the installer, including through the Omarchy plugin, also installs the Omarchy Bot AppImage and finishes by opening `omarchy-bot://pair?service=…&code=…`. Headless hosts receive only the Service. Plugin OAuth opens the provider in the system browser; the callback stays on the Service and completion reaches the client over the event stream, so authorization no longer carries a return URL.

## Considered Options

- **Keep the browser as a supported client**: rejected; two clients would need separate pairing, OAuth return, and origin handling for one bundle, and there are no installed Services to migrate.
- **Load the UI from the Service URL inside the WebView**: rejected; it couples client and Service releases, restricts native IPC for remote content, and offers no path for a phone.
- **Proxy all traffic through the Rust shell**: rejected; noVNC and the event stream would need a second transport per shell.
- **Switch between several Services in one install**: rejected for now; repairing to another Service covers moving, and several installs per Service covers working from several places.
- **Require WSL or Git Bash on Windows**: rejected; a native PowerShell executor works on every Windows install.
- **Record dictation in the client and transcribe on the Service**: rejected; the Service Host usually has no speech engine, and every client operating system already dictates into a focused text field. Service-side Voxtype dictation is retired.

## Consequences

- There is no client on a platform until its WebView smoke suite passes. Chromium tests remain UI coverage only, as ADR 0010 required.
- macOS ⌘ sends Ctrl and ⌥ sends Super in Takeover by default, with a per-Paired-Device override.
- The client ships as an AppImage, a notarized macOS dmg (arm64 and x64), and a signed Windows NSIS installer (a preview until signed), updated through the Tauri updater from GitHub Releases.
- Notifications, a tray, launch at login, global shortcuts, and certificate-fingerprint pinning are deferred.
