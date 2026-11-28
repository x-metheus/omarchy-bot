# Project documentation

The [development guide](development.md) covers skill selection, GitHub specifications and tickets, repository documents, and verification commands. Coding agents start with the [project instructions](../AGENTS.md).

The [Agent Daemon guide](../apps/agent-daemon/README.md) covers standalone startup and an OpenAI smoke test.

## Code map

These paths are starting points. Follow imports, contracts, and tests when a change crosses packages.

| Area | Starting points | Read together when relevant |
| --- | --- | --- |
| Bot identity, Conversations, events, attachments, and pairing | `apps/agent-daemon/src/api.rs`, `apps/agent-daemon/src/api/`, `apps/agent-daemon/src/store/` | Daemon [protocol tests](../apps/agent-daemon/tests/conversation.rs) and `apps/omarchy-bot/src/lib/agentDaemon.ts` |
| Rig execution, work control, and memory | `apps/agent-daemon/src/agent/`, `apps/agent-daemon/src/user_memory.rs`, `apps/agent-daemon/src/recall.rs` | [Agent Daemon guide](../apps/agent-daemon/README.md) and Conversation scenarios in `apps/agent-daemon/tests/` |
| Desktop UI and native shell | `apps/omarchy-bot/src/`, `apps/omarchy-bot/src-tauri/` | [Frontend instructions](../apps/omarchy-bot/AGENTS.md), native tests, and [shell integration tests](../tests/integration/native-shell.test.ts) |
| Platform packaging and updates | `.github/workflows/app-release.yml`, `scripts/linux-app/`, `scripts/windows-app/`, `scripts/build-macos-app.sh` | Platform WebView release checks and [release manifest tests](../tests/integration/app-release.test.ts) |
| Legacy public site | `apps/site/` | Its explicit workspace scripts, assets, and Vite configuration |
| Public site publisher contracts | `packages/protocol/`, `apps/site/server/` | Publisher protocol and route tests |

Code paths in this table are relative to the repository root. Root scripts in [package.json](../package.json) define shared commands; read each affected workspace's configuration and existing tests before changing behavior.
