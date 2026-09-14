# 03: Fail closed and keep Sidecars distinct

**What to build:** Make local work honest about where it runs. If the target Sidecar is missing, offline, unknown, or not this Turn’s device, the Tool Call fails instead of executing on Omarchy or the Host Session. Two online laptops stay two machines, and a drop mid-job cannot be reported as success.

**Blocked by:** 02: Run an approved command on this-device through `local`

**Status:** resolved

- [x] With no online Sidecar, `local` is not offered and a `this-device` call fails clearly; plugin-host Agent work, Bot Computer, and native tools continue.
- [x] Targeting an unknown or offline device identity fails clearly and never runs on native shell, Shared Workspace cwd, or another Sidecar.
- [x] A Sidecar that is not `this-device` requires an explicit online device identity; Bots do not guess among laptops.
- [x] `this-device` means the Sidecar belonging to the Omarchy Bot that sent the current user message, not some other online machine.
- [x] Ambiguous location stops for a question or an approval card that names the target rather than silently picking a machine.
- [x] A Sidecar crash or disconnect during in-flight local work fails that Tool Call honestly; reconnect with the same identity replaces the session and does not complete the old job as success.
- [x] Two online Sidecars remain distinct devices; closing one stops only that Sidecar.
- [x] Native session working directory remains Shared Workspace on the plugin host.
- [x] There is no second Bot Screen, Takeover, or Host Session pixel/input path on the laptop; Computer Surface on a plugin-host viewer still projects Bot Screens only.
- [x] Native `bash` and file tools stay unproxied: adding a target to those tools cannot retarget Omarchy work onto a laptop.

## Answer

With no online Sidecar, `message.send` omits `local` and a `this-device` call fails; native `bash` still completes. Two online Sidecars stay distinct: unqualified `this-device` fails closed as ambiguous, and `local.run@DEVICE_B` executes only on B. Unknown and disconnected identities fail without running on another machine. Disconnect during Ask fails the Tool Call; reconnect with the same identity does not complete the old job. Native session `options.cwd` remains Shared Workspace; `computer:screenshot` stays on the Bot Screen.

Validation:

- `bun test tests/integration/local-sidecar-fail-closed.test.ts` — 5 passed
