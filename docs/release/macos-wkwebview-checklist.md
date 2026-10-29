# macOS WKWebView release checklist

Run for each **arm64 and x64** release on real Macs using the signed, notarized dmg from the release workflow. A platform is supported only after its own WebView run passes (ADR 0015). Use a disposable app profile and a test Service on Linux; never test against a user's graphical session or use production credentials in evidence. The Service must have a publicly trusted certificate for off-host testing. A loopback SSH tunnel is valid for pairing but deliberately suppresses the Local Sidecar, so it cannot establish `local.run` acceptance.

Record one result per architecture under `.scratch/omarchy-bot-app/issues/14-macos-release.md` → Comments. Include date/operator, macOS version, CPU architecture, app version, dmg SHA-256, Service version and protocol, workflow run URL, each result, and redacted evidence paths. An unchecked item means not run; a failed item keeps the release unsupported. Do not record tokens or live pairing codes. No native run has been recorded by merely adding this checklist.

- [ ] Download the dmg through the release URL (retaining quarantine). Verify its checksum; run `xcrun stapler validate <dmg>` and `spctl --assess --type open --context context:primary-signature --verbose=2 <dmg>`. Mount it, copy the app to Applications, validate the app ticket and run `codesign --verify --deep --strict`, then `spctl --assess --type execute --verbose=2`. First open has no Gatekeeper warning. Record command results and first-open evidence.
- [ ] With no stored connection, launch the installed app via a fresh `omarchy-bot pair` deep link (`open 'omarchy-bot://pair?...'`). Add Service pairs without entering address/code; a Bot reply arrives through the event stream. Quit and reopen: the Service connection survives in Keychain (`com.omarchy.bot` / `service-connection`). Inspect WebView storage without copying secrets: the actual token is absent from localStorage and other file-backed WebView storage.
- [ ] While running and minimized, open a fresh same-Service pairing link. The app focuses one window and consumes the link. Repeat before the UI has subscribed during cold start. Open a link to a different test Service: restart safely applies the new CSP and pairing without replaying a consumed code; confirm no extra live app or Sidecar remains. Invalid/expired links show a recoverable error, never silently replace a stored credential.
- [ ] Pairing and reconnect to a self-signed/untrusted HTTPS Service show the TLS-specific certificate message over IPv4 and IPv6; no exception is offered and no device token reaches that Service. A publicly trusted Service and HTTP loopback SSH tunnels at `localhost`, `127.0.0.1`, another `127.0.0.0/8` address, and `[::1]` still work (include macOS 14+ ATS). Confirm unreachable Services report a connection failure, not a certificate error. Lock/deny access to the test Keychain entry: an actionable error preserves the original credential; unlock and recover.
- [ ] Create a Bot, send a message and observe a streamed reply without refreshing. Open its Computer Surface: Screen Projection renders and updates. Save a redacted screenshot or recording of the real WKWebView and Bot Screen.
- [ ] Take over the Bot Screen; pointer clicks and keyboard input reach it. In a Linux editor on that Bot Screen, verify ⌘C/⌘V and ⌘A behave as Ctrl shortcuts and ⌥ sends Super. Verify paste from the Mac clipboard. Enable physical ⌘→Super mapping in settings, verify it on the Bot Screen and across app restart, then reset it. Release Takeover and confirm the Bot can resume input.
- [ ] Connect via a **non-loopback** trusted HTTPS Service address. The bundled darwin Sidecar registers `macos` / `posix-sh`. Ask the Bot for one exact harmless `local.run` (for example `printf macos-release-ok`), approve once in the app and observe the exact output. Refusing an Ask runs nothing. Always/Never decisions persist across app restart; credential paths such as `~/Library/Keychains` remain refused. Quitting/unpairing terminates the child and fails pending local jobs; no command survives app exit.
- [ ] With ticket 11 integrated, publish both architecture assets with signed updater entries (`darwin-aarch64`, `darwin-x86_64`). An older installed app detects, downloads, verifies and restarts into the new release; a tampered payload is refused. Verify the protocol-mismatch update action. Record the release and update evidence separately from installation evidence.

Run record format (fill with observed results, no prefilled passes):

```text
date/operator:
macOS/architecture:
app version/dmg SHA-256:
Service version/protocol:
workflow/release URL:
Gatekeeper/first open:
startup/running/cross-Service deep links:
Keychain/restart/no WebView token:
TLS rejection/trusted Service/loopback tunnel:
event stream:
projection:
Takeover/pointer/keyboard/command mapping/paste:
local.run/approval persistence/quit cleanup:
updater (ticket 11):
evidence paths/blockers:
support decision:
```
