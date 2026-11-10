# Project documentation

`docs/` contains the project's documentation for developers and coding agents. Start with [Development workflow](development.md) for the Agent Skills process, verification commands, and locations for specifications, plans, task checklists, quality requirements, and architecture decisions.

Coding agents enter through [AGENTS.md](../AGENTS.md). The code map below helps locate relevant source and tests; load only the material needed for the current task.

## Code map

These paths are starting points. Follow imports, contracts, and tests when a change crosses packages.

| Area | Starting points | Read together when relevant |
| --- | --- | --- |
| Bots, Threads, attachments, and shared work files | `apps/daemon/`, `packages/domain/`, `packages/protocol/` | Affected web UI, API client, persistence, and integration tests |
| Web UI and interaction | `apps/web/` | [Frontend instructions](../apps/web/AGENTS.md), `packages/api-client/`, protocol types, and `tests/e2e/` |
| Native application and Local Sidecar | `apps/omarchy-bot/`, `apps/sidecar/`, `apps/sidecar-rust/` | Web UI integration, sidecar protocol, native build and smoke scripts |
| Agent adapters, sessions, and worker behavior | `workers/pi/`, `packages/agent-contract/`, daemon agent supervision | `tests/conformance/` and related integration tests |
| Bot Computer, screens, input, and capture | `workers/computer/`, daemon computer modules, protocol types | Desktop helper scripts and computer integration tests |
| CLI, Service installation, and Omarchy plugin | `apps/cli/`, `packages/omarchy-plugin/`, `scripts/` | Daemon startup, release packaging, and relevant `.github/workflows/` |
| Website | `apps/site/` | Its workspace scripts, assets, and Vite configuration |
| Shared contracts and test support | `packages/domain/`, `packages/protocol/`, `packages/api-client/`, `packages/testkit/` | All affected callers and `tests/unit/`, `tests/integration/`, or `tests/conformance/` |

Code paths in this table are relative to the repository root. Root scripts in [package.json](../package.json) define shared commands; read each affected workspace's configuration and existing tests before changing behavior.
