# 05: ScreenInputLease

**Type:** task
**Status:** resolved
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

- [x] Tests at the lease interface, in-process: stale epoch rejected, cross-Screen wait and abort, Takeover phases, held-input release on revoke, capture not blocked.
- [x] Fix `agent-computer-tool.test.ts:256` expectations to reflect seat serialization.

## Answer

`ScreenInputLease` owns who may type into a Bot Screen: one controller epoch per Screen, one shared-seat queue, the Takeover phases, Web Control ownership, and held key/button release. `tests/integration/screen-input-lease.test.ts` runs the whole thing in-process (14 tests).

Settled decisions, as built:

- **Stale epoch rejected everywhere.** The Sway runtime no longer rewrites `Math.max(controllerEpoch, lastInputEpoch + 1)`; `sendAgentInput` delivers only the epoch the lease already armed through `setInputAuthority` and rejects any other, and the helper's event sequence continues instead of restarting.
- **`controller_epoch` dropped** by migration `0020-drop-controller-epoch`; restarts are fenced by runtime generation.
- **Broker ⇄ Projection cycle broken**: `ComputerBroker` takes the projection service in its constructor.
- **Cross-Screen wait**: a Bot action on Screen B waits on the shared seat while the user holds Screen A, bound to the Turn `signal`; the wait leaves the queue on Steering/abort. No new UI.
- **Capture never waits**: `capture` goes straight to delivery.
- **Duplicate queues folded**: the lease's own per-surface tail is gone — one shared-seat queue in the lease orders Bot input and Web Control by call order. `BotScreenManager.#serialize` and `Broker.#serializeSurfaceOperation` stay: they serialize runtime lifecycle and the Broker's per-Screen tool entry, which the seat does not cover.

Review findings across four rounds, all fixed: seat held across `delivery.grant` and through an in-flight release; one queue for Web Control and Bot input; settling removes a requested tool; a failed action settles its lease tool; `beginCompletion`/`failCompletion` replace an unrestricted phase setter; cancellation rejects its deferreds in a `finally` and drops the tool before the revoke; a second Takeover request for the same pending tool reports Takeover. Final verdict: APPROVED.

Commits: `56903ea`, `d1a2bf0`, `2674996`, `3c827d5`, `8e4188e`.

## Comments
