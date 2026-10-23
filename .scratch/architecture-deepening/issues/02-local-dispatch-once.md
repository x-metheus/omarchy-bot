# 02: Dispatch `local` once per Tool Call

**Type:** task
**Status:** resolved
**Blocked by:** —

**What to build:** `computer` and `plugin` refuse a second dispatch for the same `toolCallId` (`apps/daemon/src/modules/turns/turns.ts:496, 626`); `local` only checks that the Tool Call started (`turns.ts:562`), so repeated `local.request`s each create a Sidecar job.

- [x] Failing integration test first: two `local.request`s with one `toolCallId` produce exactly one Sidecar job; the second is rejected.
- [x] Add a dispatch-once guard for `local` matching the existing `plugin` guard.

Keep the change minimal; ticket 03 generalises it.

## Comments

## Answer

A second `local.request` for a Tool Call that already dispatched is rejected with `local tool call was already dispatched` and creates no Sidecar job. The dispatch is recorded only after the checks that can fail before a job exists, so a failed first request can be retried. The integration test reads the `local.result` the daemon writes back.
