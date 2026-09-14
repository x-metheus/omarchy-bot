# Start a Local Sidecar only off the plugin host

Status: accepted on 2026-09-14.

The plugin daemon stays bound to Omarchy Shell. Agents, Native Sessions, Shared Workspace, the Bot Computer, and `computer` input execution remain there. **Omarchy Bot** is the named [Bot Client](../contexts/workspace/CONTEXT.md): a Tauri application for machines other than the plugin host. It reuses the Web UI over the existing HTTP and WebSocket contracts rather than a new transport or a second business-logic implementation ([ADR 0010](0010-reuse-web-client-in-tauri.md)). It is not a "Desktop" product; do not call it Desktop, Desktop Client, Omarchy Bot Desktop, or Bot Desktop (the last is the Bot Screen application surface).

Omarchy Bot starts a Bun Local Sidecar only when it is not connected to the plugin daemon on the same machine. Omarchy Bot on the plugin host is a viewer; native Agent tools already see that OS, so a Sidecar would duplicate execution and blur Host versus Bot Computer. The Sidecar is an outbound TypeScript process from the plugin runtime, not a compiled binary, listener, Agent worker, or daemon. Off-host OS work (commands, search, files, transfer) uses a plugin-owned `local` tool mapped like `computer`, not a relocation of native shell, MCP, or Screen control onto the client. Unqualified GUI still targets the owning Bot Screen; `computer` never falls back to the Host Session.

This ADR records architecture for Omarchy Bot on other machines. Sidecar execution is TypeScript run by the plugin-runtime Bun. It does not ship Tauri or pairing, and it does not weaken [ADR 0004](0004-defer-web-control-transport-security.md): non-loopback access needs a breaking auth/pairing cutover, not `OMARCHY_BOT_HOST=0.0.0.0`.

## Considered Options

- **Start a Sidecar whenever Omarchy Bot is installed**, including next to the plugin: rejected because the plugin Agent already executes on that OS.
- **Move the daemon into Tauri**: rejected; Omarchy would stop being the always-on computer, and plugin lifecycle would split.
- **Compile the Sidecar to a native binary in v1**: rejected while the client can use a plugin runtime that already has Bun; compile when a client machine has no plugin runtime.
- **Proxy native `bash` / files / `computer` onto the Sidecar**: rejected; that rewrites Agent capabilities and can target the Host Session.
- **Replace REST/WebSocket with gRPC or Tauri IPC for conversation and projection**: rejected; Sidecar needs a new outbound device channel, not a protocol rewrite.
- **Name the client Desktop / Desktop Client**: rejected; the application is Omarchy Bot.

## Consequences

- A browser tab is not a Sidecar host. Local Docker, file search, and host app start/stop require Omarchy Bot on another machine.
- `local.*` is offered only for an online Sidecar. Omarchy Bot on the plugin host and mobile-class clients have no `this-device`.
- Sidecar approval (Ask / Always / Never, exact command on the card) is per Omarchy Bot install and distinct from Agent-native approvals.
