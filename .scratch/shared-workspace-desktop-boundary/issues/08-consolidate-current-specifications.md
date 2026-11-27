# 08: Consolidate current specifications and retire superseded requirements

**What to build:** A fresh implementer reaches one consistent current model and set of requirements, rather than reconstructing the product by subtracting conflicting older specifications. Still-valid behavior and original evidence survive; fully superseded normative documents no longer compete with the approved contract.

**Blocked by:** None (can start immediately).

**Status:** resolved

**Source specification:** [Shared Workspace and Bot Desktop Boundary Correction](../spec.md).

**Specification coverage:** Stories 6–8, 86–89, 91–96.

- [x] The current context vocabulary consistently separates Bot, Agent, Thread, Native Session, Shared Workspace, Host Session, Bot Screen, Bot Desktop Session, Screen Projection, and Bot Client. Glossaries contain definitions, while implementation rules and acceptance live in the appropriate specifications/decisions.
- [x] The approved parent specification, current product model, and accepted decisions remain the authority. Cleanup does not change their product choices, loosen acceptance, or portray pending implementation as completed.
- [x] Inventory fully superseded versus mixed-purpose normative material. Map every still-valid requirement in mixed documents to its retained current home before retiring the duplicate; do not use a generic superseded notice as a substitute for that accounting.
- [x] Changes-only requirements and tickets no longer remain active instructions to preserve or reintroduce the capability. Unrelated Composer, conversation, layout, accessibility, and Computer requirements are retained in current documentation before old mixed material is removed.
- [x] Old single-shared-input and nested-Hyprland prescriptions do not override on-demand Cage Sessions with per-Bot input. Historical per-Bot browser/profile/login policy is not reintroduced as a desktop responsibility.
- [x] Shared Workspace ownership, native Agent behavior, lack of plugin file/task locks or worktree management, and shared-file/native-data preservation during Bot deletion are explicit and consistent.
- [x] The future Tauri agreement is reachable from the documentation routing entry: reuse Web UI/business behavior, retain execution on Omarchy, and do not introduce native scaffolding or claim WebView compatibility now.
- [x] ADR rationale and primary research/measurement evidence are preserved with clear historical scope and limits. Capacity results and sibling-only smoke claims are not presented as current Host Session or normal-use-cost acceptance.
- [x] Verify recoverability before deleting old specifications or tickets. Local scratch files are not assumed to be tracked; preserve unique requirement, discussion, or experimental evidence that would otherwise be lost.
- [x] Update incoming documentation references and anchors when retiring documents, without leaving dead navigation or competing active specifications. Distinguish current requirement pointers from historical evidence references.
- [x] Pending implementation, unresolved failure causes, unmeasured savings, and pending human acceptance remain truthful. This ticket can run before runtime changes because it consolidates the accepted requirements, not because it declares their implementation done.
- [x] Validate local links, heading anchors, vocabulary/authority consistency, and the explicit preservation/retirement accounting. Documentation verification is not a substitute for running the desktop or proving a bug fix.
- [x] Do not delete runtime code/tests, alter shared work or application data, change host configuration, or scaffold Tauri in this documentation slice. Runtime capability removal and behavior acceptance remain owned by their corresponding tickets.

## Scope

This is an independently verifiable documentation cutover requested by the user, not a horizontal prerequisite for runtime implementation. Preserve the approved specification and these implementation obligations; historical source belongs in recoverable history/evidence, while current documents give a single answer. No extra product interview is needed to re-decide the confirmed boundaries.

Tickets 01–07 remain open implementation work. This ticket only consolidates documentation.

## Answer

Current authority is unchanged: [the parent specification](../spec.md), [the product boundary](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#shared-workspace-and-plugin-boundary), ADR 0009, ADR 0010, [CONTEXT-MAP](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/CONTEXT-MAP.md), and the three glossaries. Pending Shared Workspace default, Changes removal, Screen startup, host-safety, resource evidence, and human acceptance remain unmet. No runtime code, tests, host config, or Tauri scaffold was changed.

Full document → home / retired / evidence accounting: [requirement-map.md](../requirement-map.md).

**Retired as current instructions (files kept; unique evidence preserved):**

- Changes API/UI/polling and daemon-cwd fallback in the capability-panel spec and tickets 04–05 (ticket 06 Changes half). Composer, Computer Surface, layout, and accessibility stay in workspace-redesign and the parent spec.
- Nested Hyprland / parent-Wayland as production (Computer ADR 0007 body; bot-screens spec Further Notes; media/desktop “Hyprland until Cage passes”). Current compositor is ADR 0008.
- Single Shared Screen serialization (ai-teammate stories 77–83; Computer ADR 0004/0005 bodies). Current model is on-demand Cage with per-Bot input.
- Per-Bot browser/profile/Cookie/login policy as a desktop requirement.
- Four-stream capacity and sibling-only smoke as Host Session or normal-use-cost acceptance. [capacity-report.json](../../bot-screen-media-desktop/capacity-report.json) and feasibility research remain historical evidence.
- Research note recommending implementation of Changes ([github-open-issues-implementation-details.md](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/research/github-open-issues-implementation-details.md)).

**Nothing deleted.** Tracked `.scratch` specs and the capacity report stay in git. Old specs were not assumed safely disposable; they now carry requirement maps instead of competing as active contracts.

**Documents that could still be misread if banners are ignored:** historical bodies of the capability-panel, bot-screens, media/desktop, and ai-teammate specs, plus Computer ADR 0004/0005. Their banners and the requirement map are the current reading order. Tickets 01–07 and 09 under this effort were not marked resolved.
