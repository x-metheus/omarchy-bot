# 07: Remember Always/Never per Omarchy Bot install

**What to build:** Let the person at the Sidecar remember a narrow Always rule or Never for that Omarchy Bot install, so repeated local work is not an endless Ask while a refusal still blocks execution. Policy is Sidecar-side and must not disable Bot Computer or native plugin-host tools.

**Blocked by:** 02: Run an approved command on this-device through `local`

**Status:** resolved

- [x] Always allow records a narrow remembered rule for that device identity on that Omarchy Bot install and skips a later matching Ask.
- [x] Never or deny fails the Tool Call without running a process; policy is enforcement, not a UI hint.
- [x] Remembered rules are not account-synchronized and are not reused as Agent-native (Pi/Claude) approvals.
- [x] Never on the Sidecar still permits Bot Computer and native plugin-host tools.
- [x] The approval card continues to show hostname and exact command or path for Ask and for the rule being remembered.
- [x] Allow once remains a one-shot grant and does not persist as Always.

## Answer

Sidecar Always/Never is per Omarchy Bot install: the fixture persists narrow `action:command|path|query` rules in `sandbox/.omarchy-bot-local-policy.json` and consults them before execution. Always runs a matching `local.run` without a second Allow once. Never and denyOnce fail the Tool Call with no process. Allow once does not write Always. Never does not disable Bot Computer (`computer:screenshot`) or native plugin-host `bash`. Policy is not stored under daemon HOME, state, or Shared Workspace, and is not reused as Agent-native approval.

Validation:

- `bun test tests/integration/local-sidecar-policy.test.ts` — 5 passed
