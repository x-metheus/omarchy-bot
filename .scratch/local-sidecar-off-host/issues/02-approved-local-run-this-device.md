# 02: Run an approved command on this-device through `local`

**What to build:** Let a Bot run one approved host command on the Sidecar that belongs to the Omarchy Bot which sent this Turn’s user message. The plugin daemon stays the brain: a shared `local` tool fans a Turn-bound reverse-request to that Sidecar, the Sidecar asks with the exact command, Allow once executes it, and native shell plus `computer` stay on the plugin host and Bot Screen.

**Blocked by:** 01: Register an outbound Local Sidecar on the device channel

**Status:** resolved

- [x] A shared `local` tool definition (name `local`) exists beside `computer`, with `run` among its actions and a target of `this-device` or an explicit online device identity; Agent adapters map that definition rather than inventing a private dialect.
- [x] Fake Agent workers invoke `local` the way they invoke `computer` and `send_bot_message`, with immutable Turn context (Bot, Turn, worker session, Tool Call).
- [x] The daemon accepts `local.request` only for that authoritative active Turn and returns `local.result`; it does not execute the command itself.
- [x] Missing target resolves to the online Sidecar belonging to the requesting client when one exists; otherwise the tool fails closed rather than falling back to native shell.
- [x] Sidecar policy defaults to Ask every time: the command does not spawn until Allow once, and the approval frame shows the device hostname and exact command.
- [x] Allow once runs the exact approved command in an isolated temp directory; Docker, compose, package installs, and starting or stopping a host application are ordinary `run` commands, not Host Session compositor IPC, screenshots, or nested desktop.
- [x] Tool Call summaries name the device and a safe command target; output is bounded and redacted of obvious credential forms; the originating Bot and Turn remain attributable.
- [x] Native Agent shell, files, MCP, and Skills still execute on the plugin host and are not proxied onto the Sidecar.
- [x] An unqualified graphical request still goes to this Bot’s Bot Screen through `computer`; `computer` never falls back to the Host Session; the Sidecar rejects screenshot, pointer, and Host compositor actions.
- [x] Sidecar approval is distinct from Agent-native (Pi/Claude) approvals and does not replace them.
- [x] `local` is offered only when an online Sidecar exists for the session under test.
- [x] Integration coverage stays on the public daemon harness plus the outbound fixture; no live Docker daemon, real Sway, or physical Host Session is required.

## Answer

Shared `AGENT_LOCAL_TOOL` (name `local`) is mapped by the Pi adapter. Fake workers invoke `local.run:<command>` with Turn-bound `local.request`. The daemon fans the job to the single online Sidecar (`this-device`); the fixture holds the process until Allow once and runs it in an isolated temp directory. Native `bash` and `computer:screenshot` stay on the plugin host / Bot Screen. Output is bounded and credential-redacted. `local` context is attached on `message.send` only while a Sidecar is online.

Validation:

- `bun test packages/protocol/src/devices.test.ts packages/agent-contract/src/local-protocol.test.ts workers/pi/src/local-tool.test.ts tests/integration/local-sidecar.test.ts`
- `bun run typecheck`
