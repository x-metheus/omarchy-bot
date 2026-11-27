# Project documentation

The [development guide](development.md) covers skill selection, GitHub specifications and tickets, repository documents, and verification commands. Coding agents start with the [project instructions](../AGENTS.md).

## Code map

These paths are starting points. Follow imports, contracts, and tests when a change crosses packages.

| Area | Starting points | Read together when relevant |
| --- | --- | --- |
| Bots, Threads, attachments, and shared work files | `apps/daemon/`, `packages/domain/`, `packages/protocol/` | Affected web UI, API client, persistence, and integration tests |
| Web UI and interaction | `apps/web/` | [Frontend instructions](../apps/web/AGENTS.md), `packages/api-client/`, protocol types, and `tests/e2e/` |
| Native application and Local Sidecar | `apps/omarchy-bot/`, `apps/sidecar-rust/` | Web UI integration, Sidecar protocol, native build and smoke scripts |
| Bot runtime, conversations, and Turns | `apps/daemon/src/modules/runtime/`, `apps/daemon/src/modules/turns/` | Runtime module tests and `tests/integration/runtime-parity.test.ts` |
| Bot Computer, screens, input, and capture | `apps/daemon/src/modules/computer/`, `packages/agent-contract/` | Protocol types, desktop helper scripts, and computer integration tests |
| CLI, Service installation, and Omarchy plugin | `apps/cli/`, `packages/omarchy-plugin/`, `scripts/` | Daemon startup, release packaging, and relevant `.github/workflows/` |
| Website | `apps/site/` | Its workspace scripts, assets, and Vite configuration |
| Shared contracts and test support | `packages/domain/`, `packages/protocol/`, `packages/api-client/`, `packages/testkit/` | Affected callers, package tests, `tests/unit/`, and `tests/integration/` |

Code paths in this table are relative to the repository root. Root scripts in [package.json](../package.json) define shared commands; read each affected workspace's configuration and existing tests before changing behavior.
