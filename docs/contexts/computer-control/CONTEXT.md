# Computer Control

The context for coordinating Bots and the user across the Bot Computer and, when one exists, the Host Session.

## Language

Definitions only. Rules and acceptance live in [Computer ADR 0009](adr/0009-adopt-sway-bot-desktops.md), [Computer ADR 0011](adr/0011-bundle-one-sway-bot-computer.md), [Computer ADR 0012](adr/0012-agent-browser-control-over-cdp.md), historical [Computer ADR 0008](adr/0008-run-cage-bot-desktops.md), [system ADR 0009](../../adr/0009-share-work-files-isolate-bot-screens.md), and [the current implementation specification](../../../.scratch/shared-workspace-desktop-boundary/spec.md). Related terms: [Bot](../workspace/CONTEXT.md), [Bot Client](../workspace/CONTEXT.md), [Agent](../agent-integration/CONTEXT.md), [Native Session](../agent-integration/CONTEXT.md), [Shared Workspace](../workspace/CONTEXT.md).

**Host Session**:
The user's own graphical environment on the Service Host (Omarchy or any other desktop), including its desktop, top bar, shortcuts, and physical input. It is distinct from the graphical work surfaces provided to Bots. A headless Service Host has no Host Session.
_Avoid_: Bot Computer, shared Bot desktop

**Shared Screen**:
The real screen and physical input seat of the Host Session. “Shared” is the historical name for the user's screen, not a screen all Bots should operate together.
_Avoid_: Bot sandbox, Bot Screen, security boundary

**Screen Projection**:
A viewing connection that mirrors one Bot Screen into a Computer Surface. It is distinct from the Bot's ongoing work and from the lifetime of the shared Bot Computer.
_Avoid_: Shared Screen, desktop clone

**Computer Surface**:
The Bot Client interface through which the user observes a selected Bot's Bot Screen and enters Web Control.
_Avoid_: Computer, Bot Screen, machine view

**Computer Preview**:
The read-only compact view of a Bot Screen in the Computer Surface. It never accepts user input.
_Avoid_: Web Control, miniature computer

**Web Control**:
Human control of a Bot Screen through the Computer Surface, distinct from the owning Bot's automated input.
_Avoid_: Bot control, Shared Screen control

**Computer Broker**:
The public coordinator that prevents a Bot and the user from interleaving input on one Bot Screen. The shared Bot Computer runtime additionally serializes mutations across Screen workspaces because Sway has one effective seat. It is neither an Agent permission authority nor a coordinator for Shared Workspace files.
_Avoid_: File lock manager, task scheduler, permission manager, visible lease panel

**Browser Tool**:
The structure-first Agent interface to the pack Chromium on a Bot Screen, driven over the Service's private CDP pipe. It exposes the accessibility tree and acts through refs and real input; it is distinct from `computer` pixels and raw input, and unavailable while a launched host browser is in use.
_Avoid_: automation bridge, headless browser, DevTools port, page scripting

**Element Ref**:
A snapshot-scoped identifier for one accessibility-tree element on the active tab, accepted by click, type, and select until the next snapshot, navigation, tab change, or document replacement. A stale ref requires a new snapshot.
_Avoid_: CSS selector, XPath, DOM id, persistent element handle

**Takeover**:
A contextual handoff of one Bot Screen from its Bot to the user, either because the Bot needs human input or the user chooses to intervene. It returns control after that Screen is observed again.
_Avoid_: Permanent human lease, general approval

**Bot Screen**:
A Bot-owned visual surface implemented as one output and workspace within the Bot Computer. It owns routed windows, pixels, projection identity, and controller epochs; it does not own a compositor, application profile, or physically independent input seat.
_Avoid_: Agent Screen, Host workspace, Shared Screen, separate computer, security sandbox

**Bot Computer**:
The one private headless Sway environment, shipped with the Service and identical on every Service Host, shared by all active Bot Screens. It owns the Wayland/Sway/D-Bus runtime, application processes, persistent home/XDG profile, browser session, and serialized input seat. It also owns the portable browser and font supply: the browser comes from the separate checksum-pinned browser pack that the installer places in the runtime directory (never a run-time download) and is the default on every Service Host, while the fonts ship inside the runtime archive. A host browser is used only on the explicit `OMARCHY_BOT_BROWSER=host` opt-in. It is distinct from the Host Session, Agent Native Sessions, and viewer projections.
_Avoid_: Full Omarchy session, Host Session, per-Bot computer

**Bot Desktop**:
The neutral application surface on one Bot Screen workspace. Closing an ordinary application leaves the Screen routable; viewing it does not confer ownership of shared files or application-internal state on the plugin.
_Avoid_: Full Omarchy session, terminal placeholder, Shared Screen
