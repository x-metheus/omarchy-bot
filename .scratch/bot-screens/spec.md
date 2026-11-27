# Per-Bot Bot Screens and Web Control

Status: implemented

> **Current authority:** Computer ADR 0008 replaces the nested-Hyprland runtime below with pure-headless Cage. System ADR 0009 and the [product model](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#shared-workspace-and-plugin-boundary) govern shared work files, on-demand desktop sessions, independent input, and viewer lifetime. Requirements below prescribing per-Bot browser/application profiles are superseded: application-internal state is outside the desktop contract. Historical completion does not establish current host top-bar/shortcut safety or acceptable normal-use resource cost. Requirement homes: [requirement map](../shared-workspace-desktop-boundary/requirement-map.md#bot-screens-specification).

## Requirement map (2026-09-05)

Still-valid (use the current homes, not nested Hyprland as the instruction):

- One Bot Screen identity; many Threads; Bots sharing an Agent stay separate → ADR 0009; [workspace-redesign Computer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#10-computer); [parent spec](../shared-workspace-desktop-boundary/spec.md) stories 36–39.
- Independent pixels, focus, pointer, keyboard; concurrent Bots → ADR 0008/0009; parent stories 40–41.
- Preview, Expanded Web Control, Takeover, incomplete Takeover stays unfinished → workspace-redesign Computer; ADR 0003; parent stories 57–65.
- Switch projection without cancelling the other Bot → ADR 0009; parent stories 51–55.
- Deletion removes plugin-owned runtime; Native Sessions survive → ADR 0006, ADR 0009; parent story 75.
- Host Session stays one Omarchy login; no child autostart or environment import → ADR 0008/0009; parent stories 44, 68–73.
- Isolation is routing, not an adversarial sandbox → ADR 0008/0009; parent story 76.

Retired or historical evidence only:

- Nested Hyprland, parent-Wayland bootstrap, and `hyprctl` readiness → historical in Computer ADR 0007. Current compositor is ADR 0008.
- Per-Bot browser/Electron profile or login-sharing policy → ADR 0009. Private runtime directories remain plugin-owned.
- Four concurrent 1080p streams as default capacity or host-safety proof → [historical capacity report](../bot-screen-media-desktop/capacity-report.json); current acceptance is [required host/resource evidence](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#required-host-safety-and-resource-evidence).

## Problem Statement

omarchy-bot currently presents a Computer Surface for the selected Bot, but every Computer path targets one physical Shared Screen: the daemon owns one `ComputerBroker`, one fixed lease row, one computer worker, one screenshot cache, and unscoped control/snapshot routes. Agent-native desktop tools also bypass the Broker. The UI can observe still images and orchestrate a nominal Takeover, but it cannot stream or accept browser input, cannot enforce Bot–human exclusion, and cannot isolate one Bot's pixels, focus, cursor, or input from another Bot.

The required product is different: each Bot needs its own persistent independent desktop surface, multiple Bots must be able to operate those surfaces concurrently, and the user must be able to observe and take over the selected Bot's surface from the web. A Bot Screen is not a Hyprland workspace, a virtual output inside the host compositor, a projection of the user's physical desktop, or one screen per Agent backend.

## Proven Platform Basis

The feasibility investigation is recorded in [omarchy-bot-screen-feasibility.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/omarchy-bot-screen-feasibility.md). The nested-Hyprland decision in Computer ADR 0007 is historical; current compositor and lifetime are ADR 0008 and system ADR 0009.

On the target Hyprland 0.56.2/Aquamarine 0.14.0 workstation, executable probes proved:

1. Two nested Hyprland compositor processes ran concurrently under the one physical Omarchy session and exposed separate child sockets, `wayland-2` and `wayland-3`.
2. Separate Alacritty clients, targeted keyboard input, and `grim` captures remained isolated between the two children.
3. A child created a 1920×1080@60 headless output, removed its parent-visible `WAYLAND-*` output, remained alive and disappeared from the host client list, then accepted targeted keyboard input and capture on the headless output.
4. An output-bound `wlr-virtual-pointer` probe independently moved A to `(100,120)` and B to `(700,400)` while the host pointer remained `(1280,720)`; click changed focus only inside A, scroll changed only A's terminal, and press–move–release visibly selected text only inside A.
5. Two concurrent stress clients each submitted 5,000 absolute pointer events and a compositor round trip in 0.07 seconds, settling at distinct requested positions while the host pointer remained unchanged.

The pointer probe proves protocol routing and compositor isolation, not production browser latency. Two idle child Hyprland processes each reported about 112 MiB proportional set size and 0.1% CPU. Incremental GPU memory was not resolved by the probe.

## Solution

Each Bot owns one persistent **Bot Screen**. The host keeps exactly one normal Omarchy/UWSM graphical session. The daemon provisions each Bot Screen as a separately supervised, minimal nested Hyprland application process with a private runtime directory, independent Wayland socket, headless output, capture/input helper, computer worker, per-Screen Computer Broker state, and WebRTC media lifecycle.

A child compositor bootstraps through the host Wayland backend to obtain a working allocator, creates its Bot-owned headless output, and removes the parent-visible `WAYLAND-*` output. It never imports its environment into the user's global systemd or D-Bus activation environment and never starts the full Omarchy autostart configuration.

The Bot Screen belongs to the Bot, not its Agent. Multiple Bots may use the same Agent backend while retaining different screens. Different Bot Screens never contend for input; concurrent turns belonging to the same Bot serialize through that Bot Screen's Broker.

The selected Bot's Computer Surface has two levels:

- **Computer Preview**: a low-frequency, read-only view in the existing desktop drawer or narrow BottomSheet. It never installs input handlers.
- **Expanded Web Control**: a desktop-browser full-screen view backed by WebRTC. Entering it while the selected Bot has a Broker-owned computer tool pending performs Takeover after the current atomic desktop action quiesces. “I'm done” captures a fresh screenshot and window context and resolves that same tool invocation so the same Agent turn can continue.

Because a Bot Screen is headless and independent from the physical desktop, its preview is useful even when the web app is opened locally. The existing open/close Computer control remains the display switch; there is no local-browser auto-hide rule.

## User Stories

1. As a user, I want every Bot to retain its own desktop state, so that its windows and applications do not appear in another Bot's Screen.
2. As a user, I want different Bots to operate their Bot Screens concurrently, so that one Bot's desktop work does not queue behind another Bot.
3. As a user, I want multiple Bots using the same Agent backend to retain separate Bot Screens, so that runtime implementation identity does not leak into product identity.
4. As a user, I want the selected Bot's Computer entry in the conversation Header, so that screen context stays attached to the Bot I am viewing.
5. As a user, I want a low-frequency read-only Computer Preview, so that I can understand the selected Bot's desktop state without spending continuous encoding resources or accidentally sending input.
6. As a user, I want only the expanded view to accept pointer, click, drag, scroll, keyboard, shortcuts, and one-way plain-text paste, so that observation and control cannot be confused.
7. As a user, I want entering expanded control during a pending computer tool to Takeover that Bot Screen, so that my input cannot interleave with the Bot's input.
8. As a user, I want “I'm done” to re-observe the same Bot Screen and continue the same pending Agent turn, so that I do not need to send a separate chat message.
9. As a user, I want closing, navigating away, or disconnecting during Takeover to leave the Bot waiting, so that an incomplete password, CAPTCHA, payment, or verification step does not resume automatically.
10. As a user, I want a new browser control connection to replace the old control connection for the same Bot Screen, so that refreshing a stale page recovers control without an exposed lease panel.
11. As a user, I want switching Bots to atomically replace preview, media, input and control state, so that no frame or input from the previous Bot leaks into the new Bot's Computer Surface.
12. As a user, I want one-way text paste without remote clipboard reads, so that I can enter text without exposing the Bot Screen's ambient clipboard.
13. As a user, I want desktop-browser Web Control first; mobile clients may retain preview but do not promise control gestures in this release.
14. As a user, I want deleting an active Bot to cancel its active turn and tear down its Screen before removing the Bot, so that no compositor, worker, helper, socket, artifact, or persisted Surface remains.
15. As a user, I want Bot Screen deletion to remain local to Omarchy Bot and never delete Agent-owned Native Sessions.
16. As a user, I want a failure in one Bot Screen to affect only that Bot, so that other Bots continue operating.
17. As a maintainer, I want seven days of local, structured, redacted semantic input diagnostics, so that routing and coordinate failures can be investigated without storing typed or pasted text.
18. As a maintainer, I want capacity exhaustion to reject or defer one Bot Screen explicitly, so that starting another compositor cannot destabilize the user's physical desktop.

## Domain and Persistence

Introduce an opaque `SurfaceId` and a persistent one-to-one Bot–Bot Screen relationship. `SurfaceId` is mandatory across persistence, public protocol, worker protocol, events, leases, artifacts, streams and input. Callers never parse or derive it from a Bot ID.

Persist product state, not process trivia:

- `surfaceId`;
- owning `botId`;
- lifecycle state: `stopped | starting | ready | failed`;
- runtime generation;
- desired logical width, height, scale and refresh rate;
- last failure summary and transition timestamp.

Wayland socket names, Hyprland instance signatures, PIDs, WebRTC peer state and lease tokens are runtime facts owned by the supervising module. They are discovered and reconciled, not treated as durable identity.

Replace the fixed `computer_leases.id = 1` model with surface-scoped coordination. Different Surface IDs have independent authority and queues. A single Surface may still coordinate multiple turns belonging to its Bot. Screenshot caches, preview timestamps, artifacts and audit records are keyed by Surface ID; a missing or stale key fails closed rather than returning another Screen's cached pixels.

Bot lifecycle owns Bot Screen lifecycle:

- create: persist Bot and Bot Screen identity atomically; provision lazily on first computer use or preview;
- delete: cancel active turns, stop and remove the complete runtime tree and Bot-owned Screen data, then remove the Bot row;
- daemon restart: reconcile existing transient units when possible; otherwise recreate the runtime and increment its generation;
- machine reboot: recreate a clean compositor runtime from retained Bot profile/state; no claim is made that in-memory application processes survive reboot.

Bots have no archive or disabled lifecycle. Per ADR 0006, deletion never removes Agent-owned Native Sessions.

## Runtime Module

Create one deep `BotScreenManager` module. Its interface exposes only Bot-owned lifecycle and operation results; callers do not manage systemd units, process IDs, sockets, output transitions or environment variables.

The implementation owns:

- mode-0700 runtime directories;
- one uniquely named transient user application unit per Bot;
- explicit environment without global `systemctl --user import-environment`;
- minimal Hyprland configuration with no Omarchy autostart;
- readiness discovery from the child runtime directory;
- headless-output creation and parent-output removal;
- capture/input helper and computer-worker process trees;
- runtime-generation invalidation;
- restart reconciliation and complete teardown;
- resource accounting and configured capacity.

Initial environment shape:

```text
XDG_RUNTIME_DIR=<private Bot runtime>
WAYLAND_DISPLAY=<absolute host Wayland socket during bootstrap>
PIPEWIRE_RUNTIME_DIR=<host runtime only when sharing host PipeWire>
XDG_CONFIG_HOME=<Bot profile>
XDG_STATE_HOME=<Bot profile>
XDG_CACHE_HOME=<Bot profile>
```

The child receives a purpose-built configuration. It does not run another UWSM session. Full Omarchy autostart, global portal activation, monitor/power services, shell provisioning and host environment import are prohibited inside children.

Historical implementation: Bot applications received per-Bot config/state/cache directories to avoid Chromium/Electron singleton collisions; the ordinary filesystem remained shared under the host user. This is not a current requirement to manage application profiles or login sharing: ADR 0009 leaves those behaviors to Agents and applications while retaining private desktop runtime and explicit input/display routing.

## Capture and WebRTC

Capture connects directly to the assigned child Wayland socket and named headless output through wlr-screencopy or ext-image-copy-capture. Do not rely on the shared user XDG Portal: the portal frontend and XDPH own singleton D-Bus names and naturally bind one `WAYLAND_DISPLAY`.

The capture helper emits versioned geometry:

```text
surfaceId
runtimeGeneration
geometryGeneration
logicalWidth / logicalHeight
videoWidth / videoHeight
scale
```

The daemon forwards video through WebRTC and owns signaling/session association. The compact Computer Preview uses a low-frequency stream or fresh snapshots and remains read-only. Continuous encoding starts only for active Bot work that requires observation or an expanded viewer; an idle unopened Screen does not encode continuously.

The expanded target is 1080p, at least 15 FPS, and no more than 200 ms median input-to-visible-feedback latency on the defined LAN reference setup. Sustained load measurements establish any additional percentile bound.

## Input and Web Control

The input helper connects only to the assigned child Wayland socket:

- output-bound `wlr-virtual-pointer` for absolute/relative motion, buttons, drag and axes;
- virtual-keyboard protocol for key-down/key-up and modifiers;
- constrained one-way plain-text injection for user paste.

Browser coordinates map through the rendered video's content rectangle into logical output coordinates. Every absolute event carries `surfaceId`, runtime generation, geometry generation, controller epoch and monotonically increasing sequence. The helper rejects wrong-Surface, stale-generation, stale-epoch, duplicate and out-of-order input.

Pointer motion may coalesce to the newest unsent position. Button transitions, key transitions and control-state transitions never coalesce. Revocation, blur, visibility loss, navigation, disconnect and helper failure release every held key and button before accepting a new controller.

One Web Controller may own one Bot Screen. A new connection replaces the old connection and increments the controller epoch; all late messages from the old connection fail. Other Bot Screens remain independent.

Typed and pasted text is never persisted in diagnostics, events or Agent transcripts. Diagnostics record only timestamps, coarse actor kind, surface, semantic action category, redacted length where useful, outcome and latency. Raw mousemove and video frames are not logged. Records expire after seven days and are available only as local diagnostic data in this release.

## Agent Tool Integration and Takeover

Every Agent desktop action must pass through an Omarchy-owned sequential computer tool bound from the authoritative `{botId, turnId, workerSessionId, toolCallId}` context to the Bot's Surface ID. Native Agent approvals remain unchanged; routing to a Bot Screen is coordination, not a new Agent permission policy.

Takeover is tool-scoped because supported Agents do not expose arbitrary turn pause/resume:

1. Agent invokes the Bot-bound computer tool.
2. The per-Screen Broker grants or queues that invocation.
3. Takeover requests quiescence and waits for any already-dispatched atomic input action to settle.
4. The same Agent tool invocation remains pending.
5. Web Control receives a new controller epoch and becomes active.
6. “I'm done” revokes Web input and releases held input state.
7. The worker captures a fresh screenshot plus relevant window context.
8. The pending tool invocation resolves exactly once with that observation.
9. The Agent continues the same native turn.

Closing or disconnecting does not resolve the pending tool. Agent cancellation cancels the waiter through its native cancellation path. Daemon or Agent-worker restart cannot reconstruct an in-memory pending tool and must fail the affected turn honestly.

The existing Emergency Control state and Sidebar Stop/Resume affordance are removed according to ADR 0006. Operational process termination remains available outside the Computer Surface for a hung worker or compositor.

## Public Protocol and UI

Every Computer route and event resolves the selected Bot to a Surface ID before accessing state. There are no global fallback snapshot, control or cache paths.

The selected-Bot Computer Surface shows plain-language states such as:

- Screen starting;
- Screen ready;
- Bot using screen;
- Needs you;
- You have control;
- Control interrupted;
- Screen unavailable.

Lease token, queue depth, PID, socket, TTL, runtime generation and controller epoch remain implementation details.

Changing selected Bot closes the old WebRTC peer and input channel, revokes any non-Takeover standalone controller, clears decoded frames and geometry, then connects the new Surface. A Takeover belonging to another Bot remains attached to that Bot and never transfers merely because navigation changed.

## Resource and Capacity Policy

The first productized release must demonstrate four concurrent 1080p Bot Screens on the target workstation before advertising a default capacity of four. Capacity is configured from measured compositor, application, capture and encoder cost; it is not inferred only from theoretical output-buffer size.

The load matrix covers 1, 2, 4 and 8 Screens at 1080p/15 FPS where capacity permits, plus a 720p fallback. Scenarios include idle compositors, static previews, active browser scrolling, simultaneous input, concurrent WebRTC encoding, Takeover, reconnect churn, helper crash, compositor crash and repeated provision/destroy cycles.

Collect per-Screen and total:

- PSS/RSS and CPU;
- GPU utilization and VRAM where attributable;
- actual encoded/displayed FPS and dropped frames;
- capture-to-browser latency;
- input-to-visible-feedback p50/p95;
- startup/readiness time;
- teardown time and residual process/socket/memory state.

Capacity exhaustion returns an explicit unavailable/busy result and does not partially provision a Screen. Idle Screens retain compositor/application state but do not continuously encode without a viewer or active observation need.

## Testing Decisions

Tests exercise the same module interfaces used by production callers.

- Domain tests defend opaque Surface identity, Bot ownership and surface-scoped coordination.
- Migration tests replace the singleton lease row and verify repeat-boot idempotence.
- Daemon integration tests use a fake BotScreen runtime adapter to verify lifecycle, routing, restart generation, direct deletion and failure isolation.
- Computer-worker contract tests reject missing, stale or mismatched Surface IDs and generations.
- Agent conformance proves a real Bot-bound computer tool reaches the correct Screen and that Takeover holds/resolves the exact tool invocation.
- Real Hyprland platform smoke tests prove two different Screens have different pixels, independent cursor/focus/key state, correct click/drag/scroll, no host pointer movement, and complete cleanup.
- Web E2E proves preview is read-only, expanded control maps coordinates, switching Bots cannot leak frames/input, disconnect releases held input, and “I'm done” resumes only the owning Bot.
- Load tests establish the supported capacity and latency envelope; unit tests do not substitute for those measurements.

No test asserts private SQL text, process command construction, React component structure or internal class call order.

## Security Posture

Per ADR 0004, the first release may be reachable from arbitrary networks without application authentication, authorization or an HTTPS/WSS requirement. This mode is explicitly not secure remote access. Surface identity prevents accidental routing but does not authenticate a caller.

Separate child sockets and per-Bot profiles are not a security boundary between mutually hostile Bots running under the same Unix user. Strong confidentiality requires separate UIDs, namespaces or sandboxing and is out of scope.

## Out of Scope

- One full Omarchy/UWSM graphical session per Bot.
- Treating a host Hyprland workspace or additional output in the host compositor as a Bot Screen.
- Keying screens by Agent identity.
- Adversarial isolation between Bots sharing one Unix user.
- Mobile Web Control gestures and soft-keyboard behavior.
- Bidirectional clipboard synchronization, file transfer, audio or USB forwarding.
- Preserving running GUI processes across a machine reboot.
- Portal-dependent per-Bot ScreenCast/RemoteDesktop as the primary capture/input path.
- Claiming arbitrary Agent pause/resume outside a pending computer tool invocation.
- Claiming secure remote access before authentication and transport-security work replaces ADR 0004.

## Acceptance Criteria

1. Two Bots can concurrently run independent graphical applications with distinct pixels, focus, pointer and keyboard state.
2. Input and frames addressed to Bot A cannot affect or appear in Bot B or the physical Shared Screen.
3. Each selected-Bot Computer Preview is read-only and never installs an input authority.
4. Expanded Web Control supports pointer motion, click, drag, scroll, keyboard transitions, shortcuts and one-way plain-text paste.
5. Every frame and input is checked against Surface ID, runtime generation, geometry generation and controller epoch.
6. Takeover quiesces the current desktop action, holds the exact Agent tool call, and “I'm done” resolves it with a fresh observation in the same turn.
7. Disconnect, navigation and revocation release all held keys/buttons and never auto-resume an incomplete Takeover.
8. Switching selected Bots cannot display a stale frame or send input to the previous Bot.
9. Direct Bot deletion, daemon restart and child-process failure produce explicit, Bot-scoped lifecycle outcomes with no orphaned resources; deletion never removes Agent-owned Native Sessions.
10. Four concurrent 1080p/15 FPS Screens meet the measured capacity gate before four is used as the default limit.
11. On the LAN reference setup, expanded control achieves at least 15 FPS and no more than 200 ms median input-to-visible-feedback latency.
12. Seven-day diagnostics contain no typed text, pasted text, screenshots, raw key characters, lease tokens or raw controller identifiers.
13. Product copy never presents the first unauthenticated/plaintext release as secure remote access.

## Further Notes

- [omarchy-bot-screen-feasibility.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/omarchy-bot-screen-feasibility.md) is the platform evidence source.
- [CONTEXT.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md) supplies canonical vocabulary.
- Nested-Hyprland ADR 0007 is historical evidence for why Shared Screen ADR 0005 and global-arbitration portions of ADR 0004 were replaced. Current compositor, transport, and lifetime are Computer ADR 0008 and system ADR 0009.
- ADR 0003 defines the cross-context Agent continuation seam.
- ADR 0006 is authoritative for direct deletion: Bots have no archive lifecycle and Native Sessions are Agent-owned.
- The clean cutover is implemented through the eleven resolved tickets in `.scratch/bot-screens/issues/`; the measured production envelope is published in [omarchy-bot-screen-feasibility.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/omarchy-bot-screen-feasibility.md).
