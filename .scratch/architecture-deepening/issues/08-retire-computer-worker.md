# 08: Retire the computer worker

**Type:** task
**Status:** resolved
**Blocked by:** 07

**What to build:** Implement [Computer ADR 0010](../../../docs/contexts/computer-control/adr/0010-daemon-owns-bot-computer-input.md): delete `workers/computer` (worker + MCP client), `Supervisor.startComputerWorker`/`stopComputerWorker`, the runtime spawn sites, the `computerWorker` readiness field and the `computer-worker-exited` outcome. Remove the `notify` action from the `computer` tool (`packages/domain/src/computer.ts`, `workers/pi/src/computer-tool.ts`).

- [x] `workers/pi/src/computer-tool.ts` derives its action union from `packages/domain` instead of hand-copying it.
- [x] Input authority validated at the lease only (not four layers).
- [x] Tests referencing `notify` or the worker updated or deleted.

## Comments

## Answer

Deleted `workers/computer`, the supervisor computer-worker spawn, `notify`, and the `computerWorker` readiness / `computer-worker-exited` outcome. The Pi tool's action union comes from `COMPUTER_ACTION_NAMES`. ScreenInputLease remains the only authority check. Commit `8f9a04d`. Review APPROVED.
