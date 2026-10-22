# 05: ScreenInputLease

**Type:** task
**Status:** claimed
**Blocked by:** —

**What to build:** One in-process `ScreenInputLease` module that owns "who may type into Screen X": a single controller epoch per Screen, the shared-seat queue, Takeover phases, Web Control ownership, and held key/button release. Screen Projection keeps only wire-protocol translation and the key-code table; runtimes only deliver events. The Computer Broker keeps the Agent `computer` tool entry, per-Screen state DTO, and the user-facing Takeover request.

Today: `apps/daemon/src/modules/computer/broker.ts:16, 79-84, 140-154`, `screenProjection.ts:221, 715-1053`, `swayBotScreenRuntime.ts:428-430, 990, 1477, 1567-1598`, `botScreenWaylandHelpers.ts:470-487`, `fakeBotScreenRuntime.ts:400`, `bootstrap/main.ts:~160-175`.

Decisions (settled):
- Stale epoch rule everywhere: **reject**. Remove the Sway `Math.max(controllerEpoch, lastInputEpoch + 1)` rewrite.
- Drop the persisted `computer_surface_coordination.controller_epoch` (migration); restarts are fenced by runtime generation.
- Break the Broker ⇄ Projection callback cycle (`let projections!`).
- A Bot input action on Screen B while the user holds Web Control on Screen A **waits**, bound to the Turn `signal` (Steering/abort ends the wait). No new UI (ADR 0004; no visible lease panel).
- Capture (screenshot, Computer Preview) never waits on the input lease.
- Fold the duplicate per-Surface queues (`botScreenManager.ts:685`, `broker.ts:498`) where the lease makes them redundant.

- [ ] Tests at the lease interface, in-process: stale epoch rejected, cross-Screen wait and abort, Takeover phases, held-input release on revoke, capture not blocked.
- [ ] Fix `agent-computer-tool.test.ts:256` expectations to reflect seat serialization.

## Comments
