# Local Sidecar only off the plugin host

Status: ready-for-agent

## Problem Statement

I use Omarchy Bot as teammates on a machine that stays on. I also want those same Bots to search files, run commands, start or stop applications, and create Docker work on a laptop or other computer in front of me. The plugin Agents live on Omarchy, so they cannot see that other machine. A browser tab cannot host a durable local executor, and projecting my Host Session into chat is the wrong kind of “local computer.”

If Omarchy Bot is installed next to the plugin, starting another executor would duplicate the Agent’s existing OS access and blur my Host Session with the Bot Computer. I need one named Bot Client for other machines, a Local Sidecar only when that client is not talking to this machine’s plugin daemon, and no second Agent runtime on the laptop.

## Solution

Keep the plugin daemon bound to Omarchy Shell. Agents, Native Sessions, Shared Workspace, the Bot Computer, and `computer` input stay there. Omarchy Bot is the named Bot Client (a future Tauri application). It is not called Desktop, Desktop Client, Omarchy Bot Desktop, or Bot Desktop.

Conversation, Bot selection, Computer Surface, and daemon-facing HTTP/WebSocket contracts stay shared. Omarchy Bot on the plugin host is a viewer: it does not start a Local Sidecar; native Agent tools already see that OS.

When Omarchy Bot is not connected to the plugin daemon on the same machine, it starts a Bun Local Sidecar from plugin-runtime TypeScript. The Sidecar only connects outbound, registers a device, and runs host OS command, search, and file work. Off-host OS work is a plugin-owned `local` tool mapped like `computer`, not a relocation of native shell, MCP, or Screen control. Unqualified GUI still targets the owning Bot Screen. `computer` never falls back to the Host Session.

A browser tab is not a Sidecar host. `local` is offered only for an online Sidecar. Sidecar approval (Ask / Always / Never, exact command on the card) is per Omarchy Bot install and distinct from Agent-native approvals.

This spec delivers the daemon device channel, same-host skip, `local` Agent tool, and a scripted Sidecar that proves the contract on the public daemon. It does not ship Tauri packaging, WebView proof, remote pairing, or a compiled Sidecar binary.

## User Stories

1. As an Omarchy user, I want the always-on computer to remain the Omarchy plugin host, so that closing a client does not stop Bot work.
2. As an Omarchy user, I want the plugin daemon to stay owned by Omarchy Shell, so that Agents, Native Sessions, Shared Workspace, and the Bot Computer do not move into a viewer.
3. As an Omarchy user, I want the application I install on other machines to be named Omarchy Bot, so that I am not asked to learn a Desktop SKU.
4. As an Omarchy user, I want Omarchy Bot on the plugin host to be a viewer, so that conversation and Computer Surface work without a second executor on that OS.
5. As an Omarchy user, I want Omarchy Bot on the plugin host not to start a Local Sidecar, so that native Agent tools remain the only OS hand on that machine.
6. As an Omarchy user, I want Omarchy Bot on another machine to start a Local Sidecar, so that Bots can reach that machine’s files and processes.
7. As an Omarchy user, I want Sidecar start to depend on whether the client is connected to this machine’s plugin daemon, so that pairing a plugin-host Omarchy Bot to a different host still gets a Sidecar.
8. As an Omarchy user, I want a browser tab never to act as a Sidecar host, so that Docker, file search, and host app control are not promised from the Web client.
9. As an Omarchy user, I want conversation to keep using the existing HTTP and event WebSocket contracts, so that switching the client shell does not rewrite how I talk to Bots.
10. As an Omarchy user, I want Computer Surface projection and Web Control to keep using the existing preview/control and view-only RFB WebSockets, so that looking at a Bot Screen is not a new transport project.
11. As an Omarchy user, I want the Local Sidecar to connect outbound to the plugin daemon, so that my laptop does not open a listener the daemon must punch into.
12. As an Omarchy user, I want a Sidecar to register a stable device identity, hostname, online state, and capabilities, so that Bots know which machine can run local work.
13. As an Omarchy user, I want a disconnected Sidecar to leave the executable roster, so that Bots cannot pretend to control a closed laptop.
14. As an Omarchy user, I want `local` tools offered only when an online Sidecar exists, so that a plugin-host viewer and a phone-class client have no `this-device`.
15. As an Omarchy user, I want an unqualified graphical request to keep targeting this Bot’s Bot Screen, so that talking about my laptop does not retarget `computer` at the Host Session.
16. As an Omarchy user, I want `computer` never to fall back to Host Session compositor IPC, global display sockets, or host process inspection, so that the Bot Computer stays separate from my own desktop.
17. As an Omarchy user, I want native Agent shell, files, MCP, and Skills to keep executing on the plugin host, so that installing Omarchy Bot does not relocate Native Sessions.
18. As an Omarchy user, I want off-host file search through `local`, so that a Bot can find a document in that machine’s folders without ingesting the whole home directory.
19. As an Omarchy user, I want off-host commands through `local.run`, so that Docker, compose, package installs, and scripts can run on the machine in front of me.
20. As an Omarchy user, I want starting or stopping a host application to be a command on that Sidecar, so that process control does not become Host Session computer-use.
21. As an Omarchy user, I want off-host read and write of explicit paths, so that a Bot can inspect or save a file on that machine.
22. As an Omarchy user, I want transfer between a Sidecar and Shared Workspace, so that a laptop file can enter plugin-host work without treating the Host Session as a Screen.
23. As an Omarchy user, I want Docker work to be an ordinary approved command rather than a separate Docker product surface, so that v1 stays a narrow tool face with a wide OS execution face.
24. As an Omarchy user, I want local work routed by this Turn’s context, so that browser login stays on the Bot Computer while “the PDF in my downloads” can hit the Sidecar that sent the message.
25. As an Omarchy user, I want “this device” to mean the Sidecar belonging to the Omarchy Bot that sent the current user message, so that another online machine is not chosen silently.
26. As an Omarchy user, I want an explicit device identity to be required before targeting a Sidecar that is not `this-device`, so that Bots do not guess among laptops.
27. As an Omarchy user, I want an offline or unknown device target rejected clearly, so that local work fails honestly instead of running on Omarchy by surprise.
28. As an Omarchy user, I want Shared Workspace paths to stay on the plugin host, so that `~/.omarchy-bot/workspace` is not rewritten onto the laptop.
29. As an Omarchy user, I want ambiguous location to stop for a question or an approval card that names the target, so that the Bot does not silently pick a machine.
30. As an Omarchy user, I want Sidecar commands to default to Ask every time, so that I see the exact command before it runs.
31. As an Omarchy user, I want Allow once, Always allow for a narrow remembered rule, and Never, so that local policy matches one Omarchy Bot install rather than an account-wide grant.
32. As an Omarchy user, I want Sidecar approval distinct from Agent-native approvals, so that Pi or Claude permission behavior is not replaced by a second omarchy-bot gate on native tools.
33. As an Omarchy user, I want a denied or never-allowed local command to fail the Tool Call without running, so that policy is enforcement rather than a UI hint.
34. As an Omarchy user, I want local Tool Call summaries to name the device and a safe command/path target, so that the transcript shows where work happened without dumping secrets.
35. As an Omarchy user, I want search results bounded and path-oriented, so that a home-directory search cannot flood the model with raw file bodies.
36. As an Omarchy user, I want command output bounded and redacted of obvious credential forms, so that Sidecar results follow existing Tool Call error-summary safety.
37. As an Omarchy user, I want a Sidecar crash or disconnect during local work to fail that Tool Call honestly, so that the Agent cannot claim success without a result.
38. As an Omarchy user, I want plugin-host Agent work to continue when a Sidecar is offline, so that Bot Computer and native tools do not depend on my laptop.
39. As a maintainer, I want the Sidecar to be TypeScript run by Bun from the plugin runtime, so that v1 does not add a compiled Sidecar binary or a second language for OS execution.
40. As a maintainer, I want the Sidecar never to be an Agent worker, daemon, or Bot Screen, so that Omarchy Bot cannot become a second execution host.
41. As a maintainer, I want same-host Omarchy Bot to skip Sidecar even if the binary could spawn one, so that tests and later Tauri delivery share one skip rule.
42. As a maintainer, I want a scripted outbound Sidecar fixture to prove the device channel, so that Tauri and WebView are not required to accept this contract.
43. As a maintainer, I want Agent adapters to map a shared `local` tool definition the same way they map `computer`, so that Pi does not own a private local-tool dialect.
44. As a maintainer, I want native `bash` and file tools left unproxied, so that adding `target` to native tools cannot retarget Omarchy work onto a laptop.
45. As a maintainer, I want worker reverse-requests for `local` to carry immutable Turn context, so that a Sidecar cannot run work for a Turn it does not own.
46. As a maintainer, I want the device WebSocket kept separate from `/api/events` and projection sockets, so that UI replay and RFB are not overloaded with OS execution.
47. As a maintainer, I want loopback device-channel tests to remain valid under the current unauthenticated listener policy, so that this spec does not quietly bind `0.0.0.0`.
48. As a maintainer, I want non-loopback pairing and authentication left as a later breaking cutover, so that ADR 0004 is not weakened by a trusted-LAN shortcut.
49. As an Omarchy user, I want multiple online Sidecars to appear as distinct devices, so that two laptops logged into the same plugin host are not merged.
50. As an Omarchy user, I want a second connection with the same device identity to replace the previous Sidecar session, so that reconnect does not leave two executable copies of one machine.
51. As an Omarchy user, I want Sidecar capabilities advertised as shell, search, files, and transfer, so that a Bot does not claim screenshot or Takeover on my laptop.
52. As an Omarchy user, I want no second Bot Screen on the laptop, so that GUI Takeover stays on the Bot Computer.
53. As an Omarchy user, I want Host Session pixels and physical input left untouched by `local`, so that starting Docker is not clicking my Omarchy top bar.
54. As an Omarchy user, I want Computer Surface on a plugin-host viewer to keep projecting Bot Screens only, so that “better local display” does not nest the Host Session.
55. As an Omarchy user, I want closing Omarchy Bot on another machine to stop only that Sidecar, so that Omarchy work continues.
56. As an Omarchy user, I want a local command that mutates the laptop to remain attributable to the originating Bot and Turn, so that I can see who asked to run it.
57. As an Omarchy user, I want transfer into Shared Workspace to land in the existing shared work directory, so that another Bot can use the file without a new ownership model.
58. As an Omarchy user, I want transfer onto a Sidecar to require an explicit destination path, so that plugin-host files are not silently copied into my home directory.
59. As an Omarchy user, I want `local.write` not to follow Shared Workspace defaults, so that a laptop write cannot be mistaken for Bot Computer work.
60. As an Omarchy user, I want search roots to be explicit or a small documented default (for example the user’s home, excluding obvious secret directories), so that a Bot cannot scan `/` by accident in v1.
61. As an Omarchy user, I want Never allowed to still permit Bot Computer and native plugin-host tools, so that blocking laptop execution does not disable teammates.
62. As an Omarchy user, I want the approval card to show the device hostname and exact command or path, so that I can refuse work I cannot identify.
63. As a maintainer, I want fake Agent workers to invoke `local` the way they invoke `computer` and `send_bot_message`, so that adapter-specific SDKs are not required to prove daemon routing.
64. As a maintainer, I want public HTTP to expose enough device roster for a client to know whether `local` is available, so that UI can hide this-device without reading Sidecar internals.
65. As a maintainer, I want existing Chromium Computer Surface tests left as Web proof only, so that this spec cannot claim Tauri WebView RFB compatibility.
66. As an Omarchy user, I want vocabulary in product copy to keep Host Session, Bot Computer, Bot Screen, Omarchy Bot, and Local Sidecar distinct, so that “local computer” never means nested desktop projection.

## Implementation Decisions

- System [ADR 0011](../../docs/adr/0011-local-sidecar-only-off-host.md) is the architecture source of truth. [ADR 0010](../../docs/adr/0010-reuse-web-client-in-tauri.md) still forbids a second business-logic client and moving execution into the viewer. [ADR 0004](../../docs/adr/0004-defer-web-control-transport-security.md) still forbids treating a reachable unauthenticated listener as pairing. [ADR 0003](../../docs/contexts/agent-integration/adr/0003-preserve-native-agent-capabilities.md) still forbids filtering or proxying native Agent tools to invent laptop execution.
- The plugin daemon remains the only SQLite writer, Agent supervisor, Computer Broker, and Bot Computer owner. Omarchy Bot is a Bot Client. The Local Sidecar is neither.
- Same-host means the Bot Client’s daemon connection is the plugin daemon on this machine (loopback to this instance is the v1 detector). Off-host means any other connection. The skip rule is “connected to this plugin daemon,” not “this OS is Omarchy.”
- Conversation and projection keep current REST plus `/api/events` plus projection control/RFB WebSockets. Do not introduce gRPC, QUIC, or Tauri IPC as the business protocol.
- Add one new daemon WebSocket device channel for Sidecar registration, heartbeat, approval, and `local` job frames. It is not `/api/events` and not a projection socket. The Sidecar is outbound-only and never listens.
- Device roster is daemon-owned process state for v1: device identity, hostname, capabilities, online/offline, and the connected socket. Reconnect with the same device identity replaces the prior socket. Persistence of Always/Never rules is per device identity on that Omarchy Bot install, not an account-synchronized policy.
- Shared `AGENT_LOCAL_TOOL` (name `local`) follows the `computer` pattern: one plugin-owned definition with description and system-prompt guidelines; adapters map it into official tool surfaces. Actions are `run`, `search`, `read`, `write`, and `transfer`. Target is `this-device` or an explicit online device identity. Missing target with an online Sidecar belonging to the requesting client may resolve to that Sidecar; otherwise the tool fails closed rather than falling back to native shell.
- Worker reverse-request type is `local.request` with the same immutable Turn binding shape as `computer.request` (Bot, Turn, worker session, Tool Call). The daemon fans the job to the chosen Sidecar and returns `local.result`. Native `bash`/file/MCP paths are unchanged.
- `computer` guidelines stay mandatory: unqualified GUI is the owning Bot Screen; failure is reported; Host Session fallback is forbidden. `local` guidelines must say the inverse: OS commands on the named Sidecar are not Screen control and must not open, click, or screenshot the Host Session.
- Approval is Sidecar-side and default Ask every time. The daemon does not run the command itself. Always/Never is consulted by the Sidecar before execution. Agent-native approval cards are not reused as this policy.
- Search and command results are bounded. Use the existing Tool Call summary redaction for errors. Search returns paths and short snippets, not full file bodies.
- Transfer copies bytes between a Sidecar path and Shared Workspace (plugin-host work files). It is not attachment-draft reuse, not Bot mail, and not Bot Screen file ownership.
- v1 Sidecar is Bun running TypeScript from the plugin runtime layout. Do not `bun --compile` and do not reimplement execution in Rust. Tauri, when later built, only supervises this process off-host.
- Public protocol additions stay in the existing protocol package: device roster DTOs, device channel frames, and `local` tool argument/result shapes. ApiClient may add roster reads; it does not spawn Sidecars.
- Loopback remains the default daemon bind. This spec must not document or implement `OMARCHY_BOT_HOST=0.0.0.0` as the way other machines connect.
- Do not add native scaffolding, a Tauri crate, or WebView claims in this delivery. The Web frontend remains the reused UI source; this spec does not delete it and does not make it a Sidecar host.

## Testing Decisions

- A good test fails on observable misrouting: Sidecar started on same-host, `local` offered with no online Sidecar, native tools hitting a Sidecar, `computer` aimed at Host Session, an offline device succeeding, unapproved `run` executing, or unbounded search dumping a home directory. Tests do not assert private class names, SQL, Tauri process trees, or CSS.
- Confirmed seam (one primary seam): the existing daemon integration harness against the real public HTTP/WebSocket listener, plus a scripted outbound Local Sidecar fixture. Observe Agent `local.request` frames through the existing worker reverse-request path the way mailbox and computer tests observe `bot-message.request` and `computer.request`. Do not require Tauri, WebView, or a real Omarchy Bot window.
- Same-host skip is proven by a client/fixture that connects to this harness daemon on loopback and asserts no device registration and no `local` tool on session open. Off-host is proven by a fixture that registers on the device channel as a distinct machine even if it physically uses loopback.
- Off-host scenarios: register capabilities; `run` with Ask requires an approval frame and does not spawn until allowed; Allow once executes the exact command in an isolated temp directory; Never/deny returns a tool error and no process; `search` returns bounded path hits; `read`/`write` stay inside the fixture sandbox; `transfer` copies a sentinel into Shared Workspace and back; disconnect removes the device from roster and fails an in-flight job; reconnect replaces the session; a second device identity stays distinct; `this-device` from a Turn whose client has no Sidecar fails; targeting an unknown id fails; native session cwd remains Shared Workspace.
- `computer` regression: an unqualified GUI action still goes to the Bot Screen adapter and never to the Sidecar. A Sidecar must not accept screenshot, pointer, or Host compositor actions.
- Fake Agent workers invoke `local` with Turn-bound context. Production Pi mapping can be a focused adapter test that the shared definition is installed, not a live laptop Docker run.
- Protocol tests cover device-channel and `local` DTO validation the way existing protocol tests cover projection and Bot mail.
- Do not use the real Sway seam, physical Host Session, or live Docker daemon for acceptance of this spec. Fixture commands are enough to prove routing and approval. Real-app start/stop and compose are later Omarchy Bot delivery.
- Prior art: daemon integration harness; fake workers; Bot mailbox reverse-request tests; computer-tool Turn-context binding; public HTTP 404-for-missing-interface style for unreadiness; event WebSocket cursor tests (do not overload them).

## Out of Scope

- Tauri packaging, window/tray/autostart, WebView RFB/noVNC proof, auto-update, and platform installers.
- Remote pairing, TLS identity, device certificates, and any non-loopback authenticated cutover.
- Compiling the Sidecar to a native binary, bundling a second Bun on the plugin host, or rewriting Sidecar in Rust.
- Moving the daemon, Agent workers, Native Sessions, or Bot Computer into Omarchy Bot.
- Proxying native `bash`, files, MCP, or Skills onto a Sidecar.
- Host Session projection, nested desktop, accessibility overlay, or laptop Bot Screens / Takeover.
- Per-app, per-compose, or per-systemd sugar tools; v1 is `run`/`search`/`read`/`write`/`transfer`.
- Mobile Sidecar, iOS/Android local execution, and account-synchronized local policy.
- Opening the control API on `0.0.0.0` as a substitute for pairing.
- Deleting the Web client; it remains the reusable UI and a non-Sidecar viewer.
- Changing Shared Workspace location, Bot deletion, or Computer Broker seat rules.

## Further Notes

- Originating decisions: conversation on abandoning a browser-only local executor; [ADR 0010](../../docs/adr/0010-reuse-web-client-in-tauri.md); [ADR 0011](../../docs/adr/0011-local-sidecar-only-off-host.md).
- Grok’s documented split is the product analogy only: hosted computer stays on, local execution is desktop-app commands/files/transfer with Ask every time. Do not copy unverified Grok transports.
- “Viewer” means Omarchy Bot (or the Web client) on the plugin host shows Threads and Bot Screens and does not register a Sidecar. It does not mean the Host Session is projected.
- Test seam confirmed with the user: public daemon plus fixture Sidecar; no Tauri in this spec’s automated proof.
