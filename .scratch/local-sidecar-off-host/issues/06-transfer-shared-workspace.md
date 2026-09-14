# 06: Transfer files between Sidecar and Shared Workspace

**What to build:** Let a Bot copy a file between the named Sidecar and Shared Workspace so a laptop document can enter plugin-host teammate work without treating the Host Session as a Screen. Shared Workspace stays on the plugin host; a copy onto the laptop needs an explicit destination.

**Blocked by:** 02: Run an approved command on this-device through `local`

**Status:** resolved

- [x] `local.transfer` copies bytes between a Sidecar path and Shared Workspace (plugin-host work files) in both directions, proven with a sentinel in the harness.
- [x] Transfer into Shared Workspace lands in the existing shared work directory so another Bot can use the file without a new ownership model.
- [x] Transfer onto a Sidecar requires an explicit destination path; plugin-host files are not silently copied into the user’s home directory.
- [x] Shared Workspace location remains on the plugin host; this ticket does not rewrite that directory onto the laptop.
- [x] Transfer is not attachment-draft reuse, Bot mail, or Bot Screen file ownership.
- [x] Ask still names the device hostname and the exact source and destination paths; deny does not copy bytes.

## Answer

`local.transfer` copies a sentinel from the Sidecar sandbox into Shared Workspace and the reverse onto an explicit Sidecar destination. Missing destination fails closed and copies nothing. Deny copies nothing. Shared Workspace stays on the plugin host (`h.svc.cfg.sharedWorkspaceDir`).

Validation:

- `bun test tests/integration/local-sidecar-transfer.test.ts` — 3 passed
