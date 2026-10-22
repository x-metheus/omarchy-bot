# 08: Retire the computer worker

**Type:** task
**Status:** ready-for-agent
**Blocked by:** 07

**What to build:** Implement [Computer ADR 0010](../../../docs/contexts/computer-control/adr/0010-daemon-owns-bot-computer-input.md): delete `workers/computer` (worker + MCP client), `Supervisor.startComputerWorker`/`stopComputerWorker`, the runtime spawn sites, the `computerWorker` readiness field and the `computer-worker-exited` outcome. Remove the `notify` action from the `computer` tool (`packages/domain/src/computer.ts`, `workers/pi/src/computer-tool.ts`).

- [ ] `workers/pi/src/computer-tool.ts` derives its action union from `packages/domain` instead of hand-copying it.
- [ ] Input authority validated at the lease only (not four layers).
- [ ] Tests referencing `notify` or the worker updated or deleted.

## Comments
