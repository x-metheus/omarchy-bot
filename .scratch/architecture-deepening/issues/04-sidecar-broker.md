# 04: SidecarBroker for `local` jobs

**Type:** task
**Status:** resolved
**Blocked by:** 03

**What to build:** Give `local` a deep `SidecarBroker` mirroring `ComputerBroker`, and register it as the `local` executor on the ToolChannel. It owns This Device resolution, capability checks, job ids, cancel, liveness, output bounds and redaction, and Shared Workspace transfer I/O behind one signal-aware call. `TurnService` stops doing file I/O for `local`.

Today: `turns.ts:541-618`, `apps/daemon/src/modules/devices/deviceRoster.ts`, device frame switch in `apps/daemon/src/api/http.ts`, `packages/protocol/src/{devices,same-host}.ts`, `apps/sidecar/src/{main,execute}.ts`, `tests/integration/helpers/localSidecar.ts`.

Decisions (settled):
- The `local` job schema is declared once (TypeBox, `agent-contract`, from ticket 03) and embedded in the `local.job` device frame; the five duplicate declarations and limits go away.
- Split `apps/sidecar` into an importable job handler (policy + execution, taking an approver port for Ask) and a thin WebSocket/stdin shell. Device port has two adapters: WebSocket (production) and in-process real handler + scripted approver (tests). Delete the 363-line test Sidecar twin.
- Liveness: a device with no heartbeat for 30 s is offline and its jobs fail. No separate job timeout: a job lives as long as the Turn `signal`; abort sends a new `local.cancel` server frame that dismisses the Ask card, and the Sidecar refuses to run a cancelled job.
- **This Device** (glossary) = the Sidecar of the Omarchy Bot install that sent the user message starting the Turn. The client tags `message.send` with its device id; trust the claimed id until the ADR 0004 auth/pairing cutover. No tag → no This Device (fail closed). Replace the "only device online" rule in `DeviceRoster.resolve`.
- One path-confinement helper in `packages/domain` replaces the six variants (`nativeSkills.ts:29`, `mcpPackages.ts:28`, `sharedWorkspace.ts:47`, `sidecar/execute.ts:9`, `helpers/localSidecar.ts`, `attachments.ts:265`): rejects blank, `/`, and escapes; accepts the root itself; callers needing strict-inside add an equality check.
- Sidecar parses incoming frames with the schemas instead of casting; imports via the workspace package, not relative paths.
- Wire `shouldStartLocalSidecar` into its real caller or delete it; the same-host test must exercise real behaviour.

- [x] Abort/cancel test: cancelling a Turn during Ask dismisses the card and a later Allow does not run.
- [x] Heartbeat liveness test.
- [x] This Device resolution tests (tagged sender, untagged, two Sidecars).
- [x] Tests run through the in-process adapter with the real handler; twin deleted.

## Comments

`SidecarBroker` is the `local` executor on the `ToolChannel`. This Device is resolved from the device id tagged on the user message that started the Turn; untagged requests fail closed, and explicit targets can name another online Sidecar. Cancellation sends `local.cancel`, dismisses the Ask card, and tears down the command's private POSIX process group (including descendants and SIGKILL escalation). A Sidecar with no heartbeat for 30 seconds is marked offline and its jobs fail. The real Sidecar handler owns policy and execution, the test fixture is an adapter over it, and `confinedPath` is the shared path-confinement helper. Assembled workspace-transfer frames are validated before dispatch with bounds errors on oversized payloads. Local dispatch validates active Turn identity (agentId, botId, turnId, workerSessionId) before execution.

Review approved commit range `d305ec1..004935c` (`REVIEW.md`: `APPROVED`).
