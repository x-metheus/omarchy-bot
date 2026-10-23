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
| 05 | [ScreenInputLease](./issues/05-screen-input-lease.md) | task | — | resolved |
| 06 | [Narrow the Bot Screen runtime seam](./issues/06-narrow-runtime-seam.md) | task | 05 | resolved |
| 07 | [Extract BotComputer from the Sway runtime](./issues/07-bot-computer-module.md) | task | 06 | resolved |
| 08 | [Retire the computer worker](./issues/08-retire-computer-worker.md) | task | 07 | resolved |
| 09 | [PublisherContract and PluginsService split](./issues/09-publisher-contract.md) | task | — | ready-for-agent |
| 10 | [Shared NativeMcpConfig module](./issues/10-native-mcp-config.md) | task | — | resolved |

## Lanes

- **Agent tools:** 01 → 02 → 03 → 04
- **Computer Control:** 05 → 06 → 07 → 08
- **Plugins:** 09, 10 (independent)

## Cross-cutting rules

- Tests are written at the deepened module's interface; old tests on the replaced shallow modules are deleted, not layered.
- Host safety (AGENTS.md) applies: no host package managers, no host compositor/session changes; real-Sway tests stay behind their existing flags.
- Every ticket ends with the relevant integration suites green and `bun run typecheck` (or the repo's equivalent) clean.

## Integration verification

- After ticket 10, repaired two existing Shared Workspace fixtures to cover startup reuse and inaccessible-directory failure without removing user files. The explicit plugin cwd now uses `workers/pi`, which survives ticket 08.
- Repaired the profile test's `WorkerClient` Proxy receiver so private-field getters work; removed Bun's ignored `test.timeout` setting and gave the two-Turn scenario an explicit timeout.
- Full-suite verification exposed active Turn timers surviving daemon teardown. Both stop paths now drain pending starts and in-flight timeout work and cancel active timers before closing persistence; a daemon shutdown/restart regression covers this lifecycle.
- Shutdown rejects new Turn admission and pauses mailbox dispatch first, preserving unclaimed durable mail for restart; the existing queued-mail recovery regression now triggers readiness during teardown.
- After tickets 05–08, the Vite smoke setup probes HTTP readiness instead of depending on startup log formatting; its child-process startup has an explicit bounded deadline.
- Real-model Pi conformance is blocked: the installed SDK reports no authenticated models and `No API key found for the selected model`. The user authorized continuing steps 1–3 with this explicit exception; the test remains unchanged.
- Credential-free verification uses `bun test --timeout 20000 --path-ignore-patterns 'tests/e2e/**' --path-ignore-patterns 'tests/conformance/pi.test.ts'`; this does not constitute real-model or real-Sway acceptance.
