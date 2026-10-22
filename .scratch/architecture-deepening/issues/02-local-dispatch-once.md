# 02: Dispatch `local` once per Tool Call

**Type:** task
**Status:** claimed
**Blocked by:** —

**What to build:** `computer` and `plugin` refuse a second dispatch for the same `toolCallId` (`apps/daemon/src/modules/turns/turns.ts:496, 626`); `local` only checks that the Tool Call started (`turns.ts:562`), so repeated `local.request`s each create a Sidecar job.

- [ ] Failing integration test first: two `local.request`s with one `toolCallId` produce exactly one Sidecar job; the second is rejected.
- [ ] Add a dispatch-once guard for `local` matching the existing `plugin` guard.

Keep the change minimal; ticket 03 generalises it.

## Comments
