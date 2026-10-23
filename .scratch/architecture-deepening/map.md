# Architecture deepening

**Status:** in progress

## Authority

- [Computer ADR 0010 — runtime owns input; retire the computer worker](../../docs/contexts/computer-control/adr/0010-daemon-owns-bot-computer-input.md)
- [System ADR 0012 — publisher contract only grows](../../docs/adr/0012-publisher-contract-is-additive.md)
- [ADR 0011 — Local Sidecar only off host](../../docs/adr/0011-local-sidecar-only-off-host.md)
- [Computer ADR 0009 — one Sway Bot Computer](../../docs/contexts/computer-control/adr/0009-adopt-sway-bot-desktops.md)
- Glossaries: [Workspace](../../docs/contexts/workspace/CONTEXT.md) (incl. **This Device**), [Agent Integration](../../docs/contexts/agent-integration/CONTEXT.md), [Computer Control](../../docs/contexts/computer-control/CONTEXT.md)

Origin: architecture review and grilling session on 2026-10-22. Each ticket records the decisions taken there; do not re-litigate them.

## Tickets

| # | Ticket | Type | Blocked by | Status |
|---|---|---|---|---|
| 01 | [Fix the Sidecar transfer hang](./issues/01-fix-sidecar-transfer-hang.md) | task | — | ready-for-agent |
| 02 | [Dispatch `local` once per Tool Call](./issues/02-local-dispatch-once.md) | task | — | ready-for-agent |
| 03 | [Deepen the turn-bound ToolChannel](./issues/03-tool-channel.md) | task | 01, 02 | ready-for-agent |
| 04 | [SidecarBroker for `local` jobs](./issues/04-sidecar-broker.md) | task | 03 | ready-for-agent |
| 05 | [ScreenInputLease](./issues/05-screen-input-lease.md) | task | — | ready-for-agent |
| 06 | [Narrow the Bot Screen runtime seam](./issues/06-narrow-runtime-seam.md) | task | 05 | ready-for-agent |
| 07 | [Extract BotComputer from the Sway runtime](./issues/07-bot-computer-module.md) | task | 06 | ready-for-agent |
| 08 | [Retire the computer worker](./issues/08-retire-computer-worker.md) | task | 07 | ready-for-agent |
| 09 | [PublisherContract and PluginsService split](./issues/09-publisher-contract.md) | task | — | resolved |
| 10 | [Shared NativeMcpConfig module](./issues/10-native-mcp-config.md) | task | — | ready-for-agent |

## Lanes

- **Agent tools:** 01 → 02 → 03 → 04
- **Computer Control:** 05 → 06 → 07 → 08
- **Plugins:** 09, 10 (independent)

## Cross-cutting rules

- Tests are written at the deepened module's interface; old tests on the replaced shallow modules are deleted, not layered.
- Host safety (AGENTS.md) applies: no host package managers, no host compositor/session changes; real-Sway tests stay behind their existing flags.
- Every ticket ends with the relevant integration suites green and `bun run typecheck` (or the repo's equivalent) clean.
