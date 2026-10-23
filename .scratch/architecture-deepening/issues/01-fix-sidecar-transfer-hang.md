# 01: Fix the Sidecar transfer hang

**Type:** task
**Status:** resolved
**Blocked by:** —

**What to build:** A `local` transfer of a file larger than 16 KiB currently never completes. `apps/sidecar/src/execute.ts:72` returns the whole file, `DeviceLocalResultFrame.text` is `max(16_384)` (`packages/protocol/src/devices.ts:40`), and `DeviceRoster.complete` drops the failed parse (`apps/daemon/src/modules/devices/deviceRoster.ts:142`) so the pending job never settles.

- [x] Failing integration test first: transfer a >16 KiB file to the Shared Workspace and assert the Tool Call settles.
- [x] The Sidecar bounds transfer output to the frame limit (and reports truncation or fails clearly; it never sends an oversize frame).
- [x] `DeviceRoster.complete` fails the pending job with a clear error when a `local.result` frame for a known `jobId` does not parse, instead of returning silently.
- [x] The unreachable `text.slice(0, 65_536)` transfer branch is reconciled with the actual frame limit.

Keep the change minimal; ticket 04 replaces this module.

## Comments

## Answer

A to-workspace transfer larger than `LOCAL_RESULT_TEXT_MAX` (16,384) is refused by the production Sidecar before it sends a frame, so the Tool Call settles with that error and nothing is written into Shared Workspace. `DeviceRoster.complete` rejects a pending job when a `local.result` for its `jobId` does not parse. The transfer text cap is the frame limit, not 65,536.
