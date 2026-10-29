# Workspace

The end-user context for creating AI teammates, working with them through conversations, and identifying their shared work files. The context name is not itself a filesystem directory.

## Language

Definitions only. Rules and acceptance live in [the product boundary](../../workspace-redesign.md#shared-workspace-and-plugin-boundary), [ADR 0011](../../adr/0011-local-sidecar-only-off-host.md), [ADR 0013](../../adr/0013-run-a-standalone-linux-service.md), [ADR 0014](../../adr/0014-require-paired-device-tokens.md), [ADR 0015](../../adr/0015-omarchy-bot-app-is-the-only-bot-client.md), and [the current implementation specification](../../../.scratch/shared-workspace-desktop-boundary/spec.md). Related terms: [Agent](../agent-integration/CONTEXT.md), [Native Session](../agent-integration/CONTEXT.md), [Host Session](../computer-control/CONTEXT.md), [Bot Computer](../computer-control/CONTEXT.md), [Bot Screen](../computer-control/CONTEXT.md), [Screen Projection](../computer-control/CONTEXT.md).

**Bot**:
A persistent assistant created and named by the user, with its own job instructions, configuration, and identity. Each Bot uses one Agent; multiple Bots may use the same Agent, and Agent inventory is not itself a Bot.
_Avoid_: Agent Bot, runtime Bot, Agent instance

**Bot Client**:
The user-facing application for conversations with Bots and observation or human control of their Bot Screens. It is distinct from the Agents and graphical sessions that execute the work.
_Avoid_: Bot Desktop, Agent runtime, Host Session, Desktop Client

**Omarchy Bot**:
The named and only Bot Client: the Tauri application for Linux, macOS, and Windows that embeds the Web UI. The Service is not this application, and a browser is not a Bot Client. Use on the Service Host is a viewer only.
_Avoid_: Desktop, Desktop Client, Omarchy Bot Desktop, Bot Desktop, daemon, second plugin, web client

**Local Sidecar**:
A compiled process bundled in Omarchy Bot and run only while the application runs and is not connected to a Service on the same machine. It registers outbound with its operating system and shell, and runs that machine's command, search, and file tools for the remote Agent. It is not an Agent, a daemon, or a Bot Screen.
_Avoid_: Agent worker, Bot Computer, Host Session, background agent

**Service**:
The headless Omarchy Bot daemon that owns Bots, Threads, Agent workers, the Shared Workspace, and the Bot Computer on one Linux host. Bot Clients connect to it; it needs no graphical desktop.
_Avoid_: plugin (for the process itself), server app, backend, Desktop

**Service Host**:
The Linux machine running the Service: an Omarchy laptop, another distribution's desktop, or a headless cloud machine. Its user desktop, if any, is the Host Session.
_Avoid_: plugin host, Bot Computer, This Device

**Launcher**:
What starts, stops, and reports on the Service: a systemd unit or a container entrypoint. Launchers share one entry and own no business behavior. The Omarchy plugin is not a Launcher; it only installs the Service on Omarchy.
_Avoid_: Service, Omarchy plugin, second daemon

**Paired Device**:
An Omarchy Bot install that exchanged a one-time pairing code for a revocable device token. Every request to the Service comes from a Paired Device; one install pairs with one Service, and one Service may have many Paired Devices.
_Avoid_: This Device, user account, trusted network

**This Device**:
The Local Sidecar of the Omarchy Bot install that sent the user message starting the current Turn. A Turn started from a future mobile-class client or from Omarchy Bot on the Service Host has no This Device.
_Avoid_: the only online Sidecar, default device, any laptop

**Shared Workspace**:
The common working-file space used by all Bots, distinct from the Omarchy Bot plugin's source, installation, and conversation data. Its files belong to the user's work rather than to an individual Bot, Thread, or Bot Screen.
_Avoid_: Per-Bot workspace, plugin repository, Bot Screen, Hyprland workspace

**Bot Activity**:
Whether a Bot has at least one Active Turn in any of its Threads. A Bot is `active` or `inactive`; Agent readiness, selection, unreadness, and ambient avatar motion are separate concepts.
_Avoid_: Online status, presence, availability

**Bot Lifecycle**:
A Bot exists from creation until permanent deletion. It has no disabled or archived form.
_Avoid_: Bot enablement, archived Bot, offline Bot

**Bot Deletion**:
Irreversible removal of a Bot and the data Omarchy Bot owns for it. Shared Workspace files and Agent-owned Native Sessions are outside this boundary.
_Avoid_: Archive, disable, Agent data erasure


**Bot Provenance**:
Internal evidence for why a persisted Bot exists: `user_created`, `legacy_conversation`, or `legacy_inventory`. Provenance makes migration conservative: only proven `legacy_inventory` rows may be removed, while ambiguous rows are preserved.
_Avoid_: Agent type, user-facing Bot category

**Bot Profile**:
The identity presented for a Bot: its editable name, job instructions, and avatar, plus the immutable Agent identity shown as read-only context. The avatar may be a locally uploaded image or an animated DiceBear avatar generated from a prompt interpreted by the Bot's Agent. Runtime readiness and technical diagnostics are settings, not editable profile fields.
_Avoid_: Role contract, capability manifest, editable Agent

**Bot Display Settings**:
Per-Bot preferences that control whether tool calls and Thinking are shown across all of the Bot's Threads. They affect presentation only: hidden content is still received and retained, and the preferences follow the Bot across application windows.
_Avoid_: Bot Profile, Agent permission, retention policy

**Bot Settings**:
The per-Bot configuration surface containing its Bot Profile and Bot Display Settings. The Profile remains the identity portion rather than a synonym for the whole surface.
_Avoid_: Bot Profile for the whole surface, Application Settings

**Avatar Recipe**:
A validated set of DiceBear style options for the application's sole current renderer. The Agent produces recipe data rather than executable SVG; Omarchy Bot renders it deterministically. Product upgrades replace recipes from retired renderers with deterministic current defaults.
_Avoid_: Agent-generated SVG, avatar capability, multiple active renderer versions

**Thread**:
A conversation between the user and one Bot. A Bot may have multiple Threads; selecting a Bot opens its most recently active Thread.
_Avoid_: Bot, Agent, task

**Response Block**:
One contiguous segment of Bot-authored text within a Turn. A Turn may contain several Response Blocks interleaved in their original order with Thinking Blocks, Tool Calls, Native Events, and Steering.
_Avoid_: Final answer, merged response, text delta

**Active Turn**:
A Turn that has not completed, been cancelled, or failed. Waiting for user input or computer access remains active.
_Avoid_: Online Bot, currently selected Thread

**Composer Draft**:
Unsent text and staged attachments belonging to one Thread within one application window. Switching Bots or Threads hides the draft without moving it; returning restores it. Drafts do not synchronize between windows.
_Avoid_: Message, shared Bot draft

**Steering**:
A user message sent while a Bot is working that redirects the active Agent session after its current atomic tool action reaches a safe boundary. Steering continues the same work context and replaces a dedicated Stop control.
_Avoid_: Follow-up, hard abort, queued chat
