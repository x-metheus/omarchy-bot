# Start a Local Sidecar only off the plugin host

Status: accepted on 2026-09-14; amended on 2026-10-24 by [ADR 0013](0013-run-a-standalone-linux-service.md), which replaces "the plugin daemon stays bound to Omarchy Shell" with a standalone Service started by interchangeable Launchers, and by [ADR 0014](0014-require-paired-device-tokens.md), which replaces the ADR 0004 posture below. Read "plugin host" as **Service Host** and "plugin daemon" as **Service**; the Local Sidecar, This Device, and client-side device identity rules are unchanged. Amended on 2026-10-28 by [ADR 0015](0015-omarchy-bot-app-is-the-only-bot-client.md): the Local Sidecar is a compiled binary bundled in Omarchy Bot for Linux, macOS, and Windows, connects to a Service URL, and the client shell lives in this repository.

Amended on 2026-10-29 by [ADR 0015](0015-omarchy-bot-app-is-the-only-bot-client.md): the Local Sidecar is a standalone Rust program built and bundled with Omarchy Bot as a Tauri external binary, launched as a separate child process. This replaces the plugin-runtime Bun and interim `bun build --compile` TypeScript packaging; the off-host-only start rule and behaviour contract are unchanged.

The plugin daemon stays bound to Omarchy Shell. Agents, Native Sessions, Shared Workspace, the Bot Computer, and `computer` input execution remain there. **Omarchy Bot** is the named [Bot Client](../contexts/workspace/CONTEXT.md): a Tauri application for machines other than the plugin host. It reuses the Web UI over the existing HTTP and WebSocket contracts rather than a new transport or a second business-logic implementation ([ADR 0010](0010-reuse-web-client-in-tauri.md)). It is not a "Desktop" product; do not call it Desktop, Desktop Client, Omarchy Bot Desktop, or Bot Desktop (the last is the Bot Screen application surface).

Omarchy Bot starts a Rust Local Sidecar only when it is not connected to the Service on the same machine. Omarchy Bot on the Service Host is a viewer; native Agent tools already see that OS, so a Sidecar would duplicate execution and blur Host versus Bot Computer. The Sidecar is an outbound Rust program bundled in Omarchy Bot and launched as a separate child process, not a listener, Agent worker, or daemon. Off-host OS work (commands, search, files, transfer) uses a plugin-owned `local` tool mapped like `computer`, not a relocation of native shell, MCP, or Screen control onto the client. Unqualified GUI still targets the owning Bot Screen; `computer` never falls back to the Host Session.

This ADR records architecture for Omarchy Bot on other machines. Sidecar execution is a standalone Rust program shipped inside Omarchy Bot; the Sidecar itself does not ship Tauri. Rust removes the bundled Bun runtime (about 110 MB of the 150 MB AppImage) and provides direct POSIX process-group and Windows Job Object control. It stays outside the Tauri process to isolate Sidecar panics and runaway execution, preserve independent teardown on quit or unpair, and test the shipped binary through its process boundary. The environment variables, WebSocket protocol, OS/shell registration, stdin/stdout JSON approval contract, and refused paths remain unchanged. ADR 0015 defines the shared JSON fixtures and TypeScript/Rust consumer checks that keep protocol types aligned. The pairing cutover it anticipated shipped in [ADR 0014](0014-require-paired-device-tokens.md): every client is a Paired Device, and non-loopback binding requires TLS. Setting `OMARCHY_BOT_HOST=0.0.0.0` alone neither authenticates nor encrypts anything.

## Considered Options

- **Start a Sidecar whenever Omarchy Bot is installed**, including next to the plugin: rejected because the plugin Agent already executes on that OS.
- **Move the daemon into Tauri**: rejected; Omarchy would stop being the always-on computer, and plugin lifecycle would split.
- **Compile the Sidecar to a native binary in v1**: originally rejected while the client could use a plugin runtime that already had Bun; superseded by ADR 0015 and its 2026-10-29 amendment. The only client is now Omarchy Bot, which bundles a standalone Rust Sidecar.
- **Proxy native `bash` / files / `computer` onto the Sidecar**: rejected; that rewrites Agent capabilities and can target the Host Session.
- **Replace REST/WebSocket with gRPC or Tauri IPC for conversation and projection**: rejected; Sidecar needs a new outbound device channel, not a protocol rewrite.
- **Name the client Desktop / Desktop Client**: rejected; the application is Omarchy Bot.

## Consequences

- A browser tab is not a Sidecar host. Local Docker, file search, and host app start/stop require Omarchy Bot on another machine.
- `local.*` is offered only for an online Sidecar. Omarchy Bot on the plugin host and mobile-class clients have no `this-device`.
- Sidecar approval (Ask / Always / Never, exact command on the card) is per Omarchy Bot install and distinct from Agent-native approvals.

## Client-side device identity

A Turn's **This Device** is the Sidecar of the install that sent the message starting it, so the client that starts a Sidecar must state that identity on every send. The client shell in this repository owns the contract:

- It starts the Sidecar with `OMARCHY_BOT_DEVICE_ID` set to a `dev_<32hex>` identity (the Sidecar also requires `OMARCHY_BOT_DEVICE_TOKEN`, `OMARCHY_BOT_SERVICE_URL`, and `OMARCHY_BOT_SIDECAR_ROOT`; `OMARCHY_BOT_HOSTNAME` is optional) and registers that same identity with the Service over the device channel. `OMARCHY_BOT_SERVICE_URL` replaced the old loopback-port variable under ADR 0015; the Rust replacement preserves this current environment contract.
- It installs the identical value as `globalThis.__OMARCHY_BOT_DEVICE_ID__` before the Web UI bundle loads. The Web client reads it once at load time and tags each `message.send` with it; `ApiClient` accepts the same identity as `localSidecarDeviceId`.
- The tag is a claim, not a registration: the daemon resolves it against the online Sidecar roster when a `local` job is dispatched. A Sidecar that has not finished registering yet is "offline or unknown" and the job fails closed; nothing waits for it, and no other device is substituted.
- The claim and the registered identity must match exactly. `ApiClient` refuses a malformed identity, and it is the only tag authority: a body claim cannot override the client's own identity, and a client without one sends no tag at all.
- A browser tab, a mobile-class client, and Omarchy Bot on the plugin host install nothing and send no tag, so their Turns have no This Device and unqualified `local` fails closed.
