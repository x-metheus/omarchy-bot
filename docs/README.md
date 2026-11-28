# Project documentation

The [development guide](development.md) covers skill selection, GitHub specifications and tickets, repository documents, and verification commands. Coding agents start with the [project instructions](../AGENTS.md).

The [Agent Daemon guide](../apps/agent-daemon/README.md) covers standalone startup and an OpenAI smoke test.

## Code map

These paths are starting points. Follow imports, contracts, and tests when a change crosses packages.

| Area | Starting points | Read together when relevant |
| --- | --- | --- |
| Bots, Threads, attachments, and shared work files | `apps/daemon/`, `packages/domain/`, `packages/protocol/` | Affected web UI, API client, persistence, and integration tests |
| Desktop UI and native shell | `apps/omarchy-bot/src/`, `apps/omarchy-bot/src-tauri/` | [Frontend instructions](../apps/omarchy-bot/AGENTS.md), `packages/api-client/`, protocol, Sidecar integration, and platform WebView smoke tests |
| Local Sidecar | `apps/sidecar-rust/` | Native shell integration, Sidecar protocol, and conformance tests |
| Bot runtime, conversations, and Turns | `apps/daemon/src/modules/runtime/`, `apps/daemon/src/modules/turns/` | Runtime module tests and `tests/integration/runtime-parity.test.ts` |
| Bot Computer, screens, input, and capture | `apps/daemon/src/modules/computer/`, `packages/agent-contract/` | Protocol types, desktop helper scripts, and computer integration tests |
| CLI, Service installation, and Omarchy plugin | `apps/cli/`, `packages/omarchy-plugin/`, `scripts/` | Daemon startup, release packaging, and relevant `.github/workflows/` |
| Legacy public site | `apps/site/` | Its explicit workspace scripts, assets, and Vite configuration |
| Shared contracts and test support | `packages/domain/`, `packages/protocol/`, `packages/api-client/`, `packages/testkit/` | Affected callers, package tests, `tests/unit/`, and `tests/integration/` |

Code paths in this table are relative to the repository root. Root scripts in [package.json](../package.json) define shared commands; read each affected workspace's configuration and existing tests before changing behavior.
