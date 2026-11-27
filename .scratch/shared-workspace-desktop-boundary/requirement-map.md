# Current vs historical documentation

Status: current routing map (2026-09-06). Runtime tickets 01–07 describe the 2026-09-05 Cage implementation; Computer ADR 0009 selects the pending Sway target. Target-runtime conformance and mandatory human host acceptance remain open.

Read this map when an older specification, ticket, or research note appears to prescribe Changes, a single Shared Screen, nested Hyprland, per-Bot browser/profile/login policy, or four-stream capacity as current acceptance.

## Current authority

| Kind | Document | Role |
| --- | --- | --- |
| Implementation specification | [Shared Workspace and Bot Desktop Boundary Correction](spec.md) | Current accepted implementation contract. The original correction landed; Sway runtime migration and ticketed human acceptance remain unmet. |
| Product model | [workspace-redesign.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#shared-workspace-and-plugin-boundary) | Directory, ownership, Computer Surface, target desktop stack, host-safety/resource evidence, and implementation gaps. |
| Cross-context decisions | system ADR 0009, system ADR 0010 | Shared files vs isolated Screens; Web-to-Tauri reuse. |
| Routing | [CONTEXT-MAP.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/CONTEXT-MAP.md) | Context and current-vs-historical entry. |
| Glossaries | [Workspace](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md), [Agent Integration](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/agent-integration/CONTEXT.md), [Computer Control](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md) | Definitions only. |
| Target desktop stack | Computer ADR 0009 | Private pure-headless Sway, on-demand view-only WayVNC, existing Broker-authorized input, and native Sway IPC. Computer ADR 0008 is historical Cage evidence. |
| Deletion / Takeover | ADR 0006, ADR 0003 | Native-data survival; tool-scoped handoff. |

Do not change these product choices from older tickets. This documentation decision does not claim that the Sway adapter, target projection, runtime conformance, host-safety gate, measured savings, or human acceptance has landed.

## Vocabulary

Glossaries define terms. Specs and ADRs hold rules and acceptance.

| Term | Glossary | Avoid treating as |
| --- | --- | --- |
| Bot | [Workspace](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md) | Agent inventory, a desktop session |
| Agent | [Agent Integration](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/agent-integration/CONTEXT.md) | A user-created teammate |
| Thread | [Workspace](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md) | Native Session, Bot Screen |
| Native Session | [Agent Integration](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/agent-integration/CONTEXT.md) | Thread, Bot Desktop Session |
| Shared Workspace | [Workspace](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md) | Plugin checkout, Bot Screen, Git sandbox |
| Host Session | [Computer Control](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md) | A Bot Desktop Session |
| Bot Screen | [Computer Control](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md) | Hyprland workspace, security sandbox |
| Bot Desktop Session | [Computer Control](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md) | Native Session, viewer connection |
| Screen Projection | [Computer Control](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/computer-control/CONTEXT.md) | Desktop ownership, Shared Screen |
| Bot Client | [Workspace](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/contexts/workspace/CONTEXT.md) | Agent runtime, Host Session |

## Recoverability

No historical specification or ticket was deleted. Tracked `.scratch` files remain in git. Unique measurements, experiment notes, and ticket Answers stay in place as historical evidence. The parent specification under this directory was untracked at cutover and is the current implementation spec, not a deletion candidate.

## Document accounting

| Document | Disposition | Still-valid home / evidence fate |
| --- | --- | --- |
| [capability-panel spec](../workspace-capability-panel/spec.md) | Mixed; Changes retired | Composer, Computer Surface, layout, accessibility → [workspace-redesign](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md) and [parent spec](spec.md). Changes/Git/cwd-fallback → retired. Delivery Answer is historical; removal is still an implementation gap. |
| [capability-panel 01](../workspace-capability-panel/issues/01-extract-computer-surface-content.md) | Historical Computer extract | Computer Surface hostable content → workspace-redesign Computer, parent stories 29, 51–65. |
| [capability-panel 02](../workspace-capability-panel/issues/02-ship-compact-composer-dock.md) | Historical Composer delivery | Composer dock → workspace-redesign Composer/Voice, parent story 30. |
| [capability-panel 03](../workspace-capability-panel/issues/03-open-browser-in-capability-panel.md) | Mixed | Computer Surface, Bot Settings exclusivity, narrow one-panel, projection cleanup → current Computer/IA docs. “Browser” tab pairing with Changes → retired. |
| [capability-panel 04](../workspace-capability-panel/issues/04-show-working-tree-summary.md) | Fully superseded | No current product requirement. Historical delivery only. Do not preserve or reintroduce Changes. |
| [capability-panel 05](../workspace-capability-panel/issues/05-open-bounded-file-diff.md) | Fully superseded | No current product requirement. Do not replace Changes with a review or artifact panel. |
| [capability-panel 06](../workspace-capability-panel/issues/06-complete-refresh-and-responsive-acceptance.md) | Mixed | Composer, Computer, responsive/accessibility → current docs. Changes refresh/polling/diff state → retired. |
| [bot-screens spec](../bot-screens/spec.md) | Mixed; nested Hyprland retired | Per-Bot Screen identity, independent input, Preview/Web Control/Takeover, local deletion, non-adversarial isolation → Computer ADR 0009, system ADR 0009, workspace-redesign Computer, parent spec. Nested Hyprland mechanism and per-Bot application-profile policy → historical. Four-stream capacity → evidence only. |
| [bot-screens issues 01–11](../bot-screens/issues/) | Historical delivery | Resolved implementation record. Do not revive nested Hyprland, Shared Screen, or profile/login policy from their acceptance lines. |
| [media/desktop spec](../bot-screen-media-desktop/spec.md) | Mixed; Hyprland-until-Cage retired; Cage now transitional | Neutral Bot Desktop, viewer ≠ session lifetime, and projection safety → Computer ADR 0009, system ADR 0009, parent spec. Cage/H.264 details remain transitional implementation history. Per-Bot browser/profile/login → retired. Four-stream gate → historical evidence. |
| [media/desktop issues 01–08](../bot-screen-media-desktop/issues/) | Historical delivery | Cage/H.264 cutover record, not the new target. Sibling smoke and capacity rows are not current Host Session or target-runtime acceptance. |
| [capacity-report.json](../bot-screen-media-desktop/capacity-report.json) | Historical evidence | Baseline measurements only. Not an accepted normal-use budget or host-safety pass. |
| [ai-teammate-workspace spec](../ai-teammate-workspace/spec.md) | Mixed; Shared Screen retired | Bot/Agent identity, Composer, drafts, attachments, dictation, steering, migration, Computer glyph/Takeover, Astryx/a11y → workspace-redesign and related current specs. Global Shared Screen serialization and emergency control → retired. Archive/Activity already superseded elsewhere. Tauri exclusion superseded by ADR 0010. |
| [ai-teammate-workspace issues](../ai-teammate-workspace/issues/) | Historical conversation delivery | Still-valid conversation behavior lives in workspace-redesign. Shared Screen tickets are not current desktop instructions. |
| Computer ADR 0007 | Historical decision | Retained rationale: Bot-owned Surfaces, private sockets, independent input, non-adversarial isolation (now in Computer ADR 0009 and system ADR 0009). Nested Hyprland / parent-Wayland mechanism retired. Measurements are historical capacity evidence. |
| Computer ADR 0001 | Mixed | MCP computer-worker seam remains. Single-Shared-Screen backend is historical; Sway needs a native window adapter rather than the X11-shaped i3 parser. |
| Computer ADR 0004 | Mixed | Hide coordination details remains. Global Shared Screen serialization is historical. |
| Computer ADR 0005 | Fully superseded | Shared Screen projection model retired. Target compositor/projection: Computer ADR 0009. |
| [feasibility research](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/omarchy-bot-screen-feasibility.md) | Historical evidence | Nested-Hyprland probes retained. Cage became production under ADR 0008; Sway is now the accepted migration target under Computer ADR 0009. |
| [GitHub issues research](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/github-open-issues-implementation-details.md) | Historical notes | Dated 2026-09-04. Do not implement Changes from its #5 recommendation. Composer/Computer seams remain in current docs. |
| [multi-bot computer research](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/multi-bot-computer-control.md) | Historical evidence | Grok-style per-Bot screens and contextual Takeover informed ADR 0003/0009; not a Changes or profile-policy source. |

## Mixed-document requirement maps

### Capability-panel specification

| Source | Disposition | Current home |
| --- | --- | --- |
| Stories 1–13, 46; Composer implementation/testing | Retained | [workspace-redesign Composer and Voice](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#7-composer); parent stories 30, 33 |
| Stories 14, 17, 19; Bot Settings exclusivity; narrow one-panel | Retained | [workspace-redesign IA / Bot Settings](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#2-information-architecture); parent stories 31–32 |
| Stories 16, 39–42; Computer Surface not an iframe/webview | Retained | [workspace-redesign Computer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#10-computer); parent stories 29, 51–65 |
| Story 44 projection/selection cleanup (Computer) | Retained | Parent stories 51–54 |
| Story 45 compact rail, not an IDE | Retained as Computer constraint | Parent story 28; workspace-redesign plugin boundary |
| Astryx-only; no Board/Tailwind | Retained | [workspace-redesign visual system](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#12-visual-system); [technology-selection](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/technology-selection.md) |
| Sway/WayVNC target; no nested Hyprland revival | Retained | Computer ADR 0009, system ADR 0009 |
| Stories 15, 20–38, 43, 47–48; Git cwd fallback; Changes API/UI/polling | Retired | Do not reintroduce. Removal landed in ticket 02. |

### Bot Screens specification

| Source | Disposition | Current home |
| --- | --- | --- |
| One Bot Screen identity; many Threads; Bots sharing an Agent stay separate | Retained | ADR 0009; workspace-redesign Computer; parent stories 36–39 |
| Independent pixels, focus, pointer, keyboard; concurrent Bots | Retained | Computer ADR 0009; system ADR 0009; parent stories 40–41 |
| Preview read-only; Expanded Web Control; Takeover/return; incomplete Takeover stays unfinished | Retained | workspace-redesign Computer; ADR 0003; parent stories 57–65 |
| Switch projection without cancelling the other Bot | Retained | ADR 0009; parent stories 51–55 |
| Deletion removes plugin-owned runtime; Native Sessions survive | Retained | ADR 0006, ADR 0009; parent story 75 |
| Host Session stays one Omarchy/UWSM login; no child autostart/import-environment | Retained | Computer ADR 0009; system ADR 0009; parent stories 44, 68–73 |
| Isolation is routing, not an adversarial sandbox | Retained | Computer ADR 0009; system ADR 0009; parent story 76 |
| ADR 0004 unauthenticated-remote-access posture | Retained | ADR 0004 |
| Nested Hyprland / parent-Wayland bootstrap / `hyprctl` readiness | Retired | Historical in ADR 0007. Current target: Computer ADR 0009 |
| Per-Bot browser/Electron profile or login-sharing policy | Retired | System ADR 0009; parent story 7. Private runtime directories remain plugin-owned |
| Four concurrent 1080p streams as default capacity or host-safety proof | Historical evidence | [capacity-report.json](../bot-screen-media-desktop/capacity-report.json); current acceptance: [required evidence](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#required-host-safety-and-resource-evidence) |

### Media and desktop specification

| Source | Disposition | Current home |
| --- | --- | --- |
| Sway sole target compositor after conformance; no dual production runtime | Retained | Computer ADR 0009; parent desktop decisions |
| PNG Preview, target WayVNC Web Control, HTTP snapshot fallback | Retained | Computer ADR 0009; workspace-redesign Computer; parent stories 57–59, 65 |
| Neutral persistent Bot Desktop; app exit ≠ Screen death | Retained | workspace-redesign Computer; parent stories 42–43 |
| Stop expanded encoding when unused; Agent screenshots without a viewer | Retained | ADR 0009; parent stories 56, 60 |
| Independent per-Bot input; viewer switch ≠ session destroy | Retained | ADR 0009; parent stories 40, 51–55 |
| “Nested Hyprland remains production until Cage passes” | Historical | Cage cutover was recorded in media/desktop ticket 08 and ADR 0008; Sway migration now follows Computer ADR 0009 |
| Per-Bot browser/profile/Cookie/login policy | Retired | ADR 0009; story 20 already marked superseded |
| Four-Screen active-stream gate as normal-use cost | Historical evidence | capacity-report.json; parent stories 77–84 |
| JPEG/H.264/WayVNC/Cage/Sway prototype numbers in Further Notes or research | Historical evidence | Keep with stated limits; none alone is current target-runtime acceptance |

### AI teammate workspace specification

| Source | Disposition | Current home |
| --- | --- | --- |
| User-created Bots; immutable Agent; many Bots per Agent | Retained | workspace-redesign Bot and Agent; ADR 0002 |
| Sidebar, Header, Composer, drafts, attachments, dictation, steering | Retained | workspace-redesign §§2–8 |
| Native Agent capabilities and inventory | Retained | workspace-redesign Native Agent; [agents-integration](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/agents-integration.md) |
| Migration/provenance | Retained | workspace-redesign Migration boundary |
| Computer glyph; contextual Takeover; no lease UI | Retained | workspace-redesign Computer; ADR 0003 |
| Accessibility, themes, Astryx | Retained | workspace-redesign visual system |
| Stories 12–15 archive/restore | Already superseded | [bot-activity-lifecycle](../bot-activity-lifecycle/spec.md); ADR 0006 |
| Stories 60–62 compact Activity | Already superseded | [ordered-rich-transcript](../ordered-rich-transcript/spec.md); ADR 0007 |
| Stories 77–83 Shared Screen serialization / emergency control | Retired | Per-Bot Screens: ADR 0008/0009; parent stories 40, 61 |
| Out of scope “independent per-Bot Screens” | Historical exclusion | Now required by ADR 0009 and the parent spec |
| Out of scope “Tauri client” as permanent exclusion | Superseded | ADR 0010; no native scaffolding now |

## What this cutover does not claim

- Shared Workspace default is implemented.
- Changes is removed from the running product.
- Screen startup or host-disruption root causes are known.
- Host top-bar/shortcut safety or normal-use resource savings are proven.
- The user has completed hands-on acceptance.
- Tauri packaging, WebView codecs, or native lifecycle are verified.
