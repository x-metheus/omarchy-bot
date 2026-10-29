# Active technology selection

> Accepted stack for the user-created-Bot workspace. Historical dashboard, Role/Routine, and Agent-as-Bot assumptions are intentionally excluded.

## Stack

```text
Runtime:               Bun + TypeScript
Daemon:                Bun.serve + SQLite (single writer)
Agent integrations:    isolated Bun workers around official SDK/protocol surfaces
Web UI:                React 19 + Vite
Design system:         Astryx through an omarchy-bot semantic adapter
Styling:               Astryx tokens with product-owned layout styles
Frontend data:         TanStack Router + Query + Virtual where needed
Launchers:             systemd user unit or container entrypoint (scripts/serve.sh)
Computer backend:      daemon Sway runtime; no computer worker
Bot Screen runtime:    one on-demand pure-headless Sway Bot Computer; output/workspace per Screen
Screen Projection:     selected-view PNG preview + Broker control and view-only RFB over separate WebSockets
Voice input:           client OS dictation into the focused Composer
Persistence:           SQLite + daemon-managed local media
```

## Runtime boundary

The Service owns product state, SQLite, the REST/WebSocket API, process supervision, attachments, and Computer coordination. Bot-completion notifications belong to the Bot Client, and startup diagnostics are the Service log plus `status` and `doctor`. Agent workers isolate vendor SDKs, native processes, crashes, and version changes. Workers never open product SQLite or import web code.

Workers start on demand by Agent, not by visible Bot. Several user-created Bots may share one Agent worker/runtime while retaining independent native sessions.

Deployment follows the [Omarchy plugin contract](../README.md#installation): the Service's lifecycle belongs to its systemd user unit, and the Omarchy plugin only installs, starts, and stops it. The Bot Computer is a separately supervised application runtime, not an additional host graphical login session.

Bot Screens do not inherit the user's Wayland display. The daemon provisions one private Sway runtime with headless outputs, one private D-Bus bus and persistent application profile, and workspace-scoped Screen routing. No runtime selector or fallback compositor is supported. The HTTP PNG snapshot remains a read-only recovery path and never substitutes an interactive live transport.

The [accepted product boundary](workspace-redesign.md#shared-workspace-and-plugin-boundary) separates Shared Workspace files, Agent-owned execution, the shared Bot Computer, routed Bot Screens, and client projections. [System ADR 0009](adr/0009-share-work-files-isolate-bot-screens.md) governs on-demand lifetime, shared application state, serialized input, deletion, and resource acceptance. [ADR 0013](adr/0013-run-a-standalone-linux-service.md) defines the standalone Service and Launchers, [ADR 0014](adr/0014-require-paired-device-tokens.md) pairing and remote access, and [Computer ADR 0011](contexts/computer-control/adr/0011-bundle-one-sway-bot-computer.md) the bundled Bot Computer runtime.

## Agent integration rule

Use the richest official interface for each Agent. Every installed version must pass the inventory and conformance policy in [`agents-integration.md`](agents-integration.md). Never fall back silently to PTY scraping, one-shot headless output, or an omarchy-bot permission shim.

## Web UI

Use React 19 because Astryx and the stable TanStack React adapters cover the required accessible conversation interactions. Streaming updates are buffered, transcript rows subscribe selectively, and long histories may use TanStack Virtual. Computer frames do not flow through ordinary React message state.

The Web frontend is embedded in the Linux Tauri application at `apps/omarchy-bot`, as recorded in [ADR 0010](adr/0010-reuse-web-client-in-tauri.md) and [ADR 0015](adr/0015-omarchy-bot-app-is-the-only-bot-client.md). UI and Service-facing HTTP/WebSocket behavior stay shared; native capabilities remain behind `shell` and execution stays in the Service. The packaged AppImage has a dedicated WebKitGTK smoke suite; Chromium tests cover the shared UI only. See the [Linux build and smoke commands](../README.md#linux-application).

### Astryx policy

Use Astryx primitives discovered through its CLI. Feature code consumes product-semantic wrappers rather than duplicating SideNav, Sheet/Dialog, ChatComposer, ChatMessageList, Avatar, selectable cards, focus management, or accessibility behavior.

Do not introduce a second component system. Product-specific composition may use React and Astryx tokens, but should not copy shadcn or another registry.

Required update checks include:

- type and build compatibility;
- keyboard and focus behavior;
- axe/screen-reader smoke tests;
- light/dark visual regression;
- streaming and reduced-motion behavior.

## State ownership

```text
TanStack Query
  REST snapshots, point reads, mutations, reconnect reconciliation

Ordered event projection
  WebSocket cursor, Bot/Thread/activity/computer state, streaming deltas

Window-local state
  Composer drafts, staged attachments, focus, open Sheets
```

Token deltas update the projection directly and do not trigger query refetches.

## Persistence and privacy

- SQLite is written only by the daemon.
- Managed attachments and avatar uploads stay under the local product data directory.
- The client OS dictates into the Composer; the Service never captures audio. Use macOS's Dictation key or configured shortcut (commonly `Fn` / Globe twice), Windows `Win+H`, Omarchy Voxtype `Super+Ctrl+X` or hold `F9`, or a phone keyboard's microphone key.
- The API binds to `127.0.0.1` by default; a non-loopback bind requires operator TLS or a declared TLS-terminating proxy (`apps/daemon/src/bootstrap/config.ts`).
- Uploaded images are re-encoded; Agent-generated Avatar Recipes are validated data, never executable SVG.

## Rejected choices

- Client-side audio capture or a built-in speech-to-text engine: the client OS already dictates into focused text fields ([ADR 0015](adr/0015-omarchy-bot-app-is-the-only-bot-client.md)).
- Multiple design systems: Astryx is the sole component system.
- TanStack Start: the Bun daemon already owns the server/API.
- Public network listener or desktop runtime inside the browser: a public listener requires pairing plus TLS; the unauthenticated mode is retired ([ADR 0014](adr/0014-require-paired-device-tokens.md)).

## Primary references

- Context routing and vocabulary: [`../CONTEXT-MAP.md`](../CONTEXT-MAP.md)
- Accepted workspace: [`workspace-redesign.md`](workspace-redesign.md)
- Current implementation specification: [`../.scratch/shared-workspace-desktop-boundary/spec.md`](../.scratch/shared-workspace-desktop-boundary/spec.md)
- Historical vs current requirement homes: [`../.scratch/shared-workspace-desktop-boundary/requirement-map.md`](../.scratch/shared-workspace-desktop-boundary/requirement-map.md)
- Shared files / isolated Screens: [`adr/0009-share-work-files-isolate-bot-screens.md`](adr/0009-share-work-files-isolate-bot-screens.md)
- Standalone Service and install-only plugin: [`adr/0013-run-a-standalone-linux-service.md`](adr/0013-run-a-standalone-linux-service.md)
- Paired device tokens and remote access: [`adr/0014-require-paired-device-tokens.md`](adr/0014-require-paired-device-tokens.md)
- One bundled Sway Bot Computer: [`contexts/computer-control/adr/0011-bundle-one-sway-bot-computer.md`](contexts/computer-control/adr/0011-bundle-one-sway-bot-computer.md)
- Omarchy Bot (Tauri): [`adr/0010-reuse-web-client-in-tauri.md`](adr/0010-reuse-web-client-in-tauri.md)
- Local Sidecar only off-host: [`adr/0011-local-sidecar-only-off-host.md`](adr/0011-local-sidecar-only-off-host.md)
- Agent inventory: [`agents-integration.md`](agents-integration.md)
- Astryx: <https://astryx.atmeta.com/> and <https://github.com/facebook/astryx>
- React: <https://react.dev/>
- TanStack: <https://tanstack.com/>
- Bun: <https://bun.sh/docs>
- Computer coordination: [`research/multi-bot-computer-control.md`](research/multi-bot-computer-control.md)
