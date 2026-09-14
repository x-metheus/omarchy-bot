# 04: Skip Local Sidecar when connected to this plugin daemon

**What to build:** Treat Omarchy Bot on the plugin host as a viewer: conversation and Computer Surface work, but this client does not start a Local Sidecar and does not offer `local`, because native Agent tools already see that OS. Start a Sidecar only when the same client is connected to a different plugin daemon.

**Blocked by:** 02: Run an approved command on this-device through `local`

**Status:** resolved

- [x] A client/fixture that connects to this harness daemon on loopback as this instance does not register a device and does not offer `local` on session open.
- [x] An off-host fixture still registers on the device channel as a distinct machine even if the transport physically uses loopback.
- [x] The skip rule is “connected to this plugin daemon,” not “this OS is Omarchy”: pairing a plugin-host Omarchy Bot to a different host still gets a Sidecar.
- [x] A browser tab is not a Sidecar host: the Web client remains a non-Sidecar viewer and does not promise Docker, file search, or host app control.
- [x] Same-host skip is a single shared rule that later Omarchy Bot delivery can reuse; this ticket does not add a Tauri crate or WebView proof.
- [x] Closing the viewer does not stop plugin-host Bot work; Agents, Native Sessions, Shared Workspace, and the Bot Computer stay owned by the plugin daemon.

## Answer

Shared `shouldStartLocalSidecar({ clientKind, daemonHost, daemonPort, thisDaemonHost, thisDaemonPort })` lives in `@omarchy-bot/protocol`. Web is always a non-Sidecar viewer. Omarchy Bot skips Sidecar when both hosts are loopback (`127.0.0.1`, `localhost`, `::1`) and the ports match this plugin daemon; a different port or non-loopback host starts a Sidecar. The harness viewer does not register a device (`GET /api/devices` is `[]`); native `bash` still runs and pi stays ready. An off-host decision (same loopback host, different port) still allows a fixture to register over loopback transport.

Validation:

- `bun test packages/protocol/src/same-host.test.ts tests/integration/local-sidecar-same-host.test.ts`
