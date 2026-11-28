# Project documentation

The [development guide](development.md) covers skill selection, GitHub specifications and tickets, repository documents, and verification commands. Coding agents start with the [project instructions](../AGENTS.md).

The [Agent Daemon guide](../apps/agent-daemon/README.md) covers standalone startup, pairing, and smoke tests for both model protocols. The [Rig Agent Daemon decision](agents/adr/0017-rig-agent-daemon.md) explains how the daemon and Tauri desktop share responsibility.

The [Provider Settings specification](specs/provider-settings.md) covers the desktop Settings page, custom providers, model discovery, and Rig's OAuth support.

## Code map

These paths are starting points. Follow imports, contracts, and tests when a change crosses packages.

| Area | Starting points | Read together when relevant |
| --- | --- | --- |
| Bot identity, Conversations, events, attachments, and pairing | `apps/agent-daemon/src/api.rs`, `apps/agent-daemon/src/api/`, `apps/agent-daemon/src/store/` | Daemon [protocol tests](../apps/agent-daemon/tests/conversation.rs) and `apps/metheus/src/lib/agentDaemon.ts` |
| Rig execution, work control, and memory | `apps/agent-daemon/src/agent/`, `apps/agent-daemon/src/user_memory.rs`, `apps/agent-daemon/src/recall.rs` | [Agent Daemon guide](../apps/agent-daemon/README.md) and Conversation scenarios in `apps/agent-daemon/tests/` |
| Desktop UI and native shell | `apps/metheus/src/`, `apps/metheus/src-tauri/` | [Frontend instructions](../apps/metheus/AGENTS.md) and the native and shell integration tests in the desktop project |
| Runtime logging | `crates/logging/` | App and Agent Daemon log destinations in their respective `src/logging.rs` files |
| Platform packaging and updates | `.github/workflows/app-release.yml`, `tools/release/` | Platform WebView release checks and release manifest tests |
| Public site | `apps/site/` | Site scripts, assets, publisher contract, route tests, and Vite configuration |

Code paths in this table are relative to the repository root. The [Cargo workspace](../Cargo.toml) defines the native crates. Read the affected Bun package's configuration and existing tests for frontend, site, or release-tool changes.
