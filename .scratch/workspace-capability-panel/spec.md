# Composer dock and workspace capability panel

Status: resolved

> **Scope correction accepted 2026-09-05:** System ADR 0009 and the [current product boundary](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#shared-workspace-and-plugin-boundary) supersede this spec's Changes capability, Git-backed workspace assumptions, and daemon-cwd fallback. Remove Changes rather than restoring its UI/API/tests or replacing it with a review/artifact panel. The Computer Surface and unrelated Composer improvements remain; the body, tickets, and delivery results below record the historical implementation, not authority to reintroduce Changes. Removal has landed in tickets 02 and 09 of the Shared Workspace correction; this notice is not authority to reintroduce Changes. Requirement homes: [requirement map](../shared-workspace-desktop-boundary/requirement-map.md#capability-panel-specification).

## Requirement map (2026-09-05)

Still-valid (use the current homes, not this spec's body as the instruction):

- Composer dock stories 1–13, 46 → [workspace-redesign Composer and Voice](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#7-composer); [parent spec](../shared-workspace-desktop-boundary/spec.md) stories 30, 33.
- Right-region exclusivity, closed-by-default, narrow one-panel: stories 14, 17, 19 → [workspace-redesign IA / Bot Settings](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#2-information-architecture); parent stories 31–32.
- Computer Surface through the Computer entry: stories 16, 39–42 → [workspace-redesign Computer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#10-computer); parent stories 29, 51–65.
- Astryx-only, no Board/Tailwind: story 46 → [workspace-redesign visual system](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#12-visual-system); [technology-selection](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/technology-selection.md).
- Cage/H.264 remains; do not revive nested Hyprland → Computer ADR 0008, ADR 0009.

Retired (not instructions to preserve or reintroduce):

- Changes tab, Git summary/detail, daemon-cwd fallback, polling, authorship language: stories 15, 20–38, 43, 47–48.
- “Browser” as a capability-tab label that pairs Changes with Computer. The Computer Surface itself is retained.

The Answer below records historical delivery. Changes removal remains an [implementation gap](https://github.com/x-metheus/omarchy-bot/blob/cddced5d11497f201d0d62dd94e6c8893fa2f08f/docs/workspace-redesign.md#implementation-gaps-in-the-2026-09-05-revision).

## Problem Statement

Omarchy Bot’s conversation workspace already provides a rich Astryx Composer and a contextual Computer Surface, but the Composer reads as stacked chrome rather than a compact dock, and workspace capabilities are split across isolated right-side panels. Users cannot inspect the selected Thread’s working-tree changes beside the conversation, open a bounded file diff, or switch between changes and the existing Computer Surface through one coherent capability region.

The GitHub request leaves important product questions open: whether changes come from Agent events or Git, whether Browser means a new webview or the existing Computer Surface, whether the rail opens by default, and how it behaves on narrow screens. Adding a second design system, a second layout model, or an unbounded IDE would increase complexity while weakening the existing Workspace and Computer Control decisions.

## Solution

Refine the existing Astryx Composer into a compact stadium dock and add one contextual right-side capability panel with Changes and Browser tabs.

The Composer keeps all current draft, attachment, dictation, send, Steering, focus, and accessibility behavior while moving Attach into the footer beside circular Mic and Send actions. The capability panel is closed by default. Changes shows bounded Git working-tree state for the selected Thread’s effective working directory, with summary counts, file state, and read-only diff detail. Browser hosts the existing Computer Surface, including Preview, Expanded Web Control, Takeover, and fallback behavior; it is not a new iframe or webview.

The workspace continues using Astryx Layout and LayoutPanel, semantic theme tokens, and the existing narrow-screen one-panel-at-a-time interaction.

## User Stories

1. As an Omarchy user, I want the Composer to read as one compact rounded dock, so that conversation remains the visual focus.
2. As an Omarchy user, I want Attach, Mic, and Send presented as circular footer actions, so that primary composition controls are easy to scan.
3. As an Omarchy user, I want the empty Composer header chrome removed, so that the input does not look like stacked cards.
4. As an Omarchy user, I want the dock to use a quiet light elevation, so that it separates from the transcript without combining a heavy border and shadow.
5. As an Omarchy user, I want the dock to remain legible in light and dark themes, so that visual refinement does not depend on hard-coded colors.
6. As an Omarchy user, I want Enter and Shift+Enter to retain their current behavior, so that the redesign does not change writing mechanics.
7. As an Omarchy user, I want staged attachments to remain visible and removable in the Composer drawer, so that compact chrome does not hide pending files.
8. As an Omarchy user, I want drag-and-drop attachment behavior preserved, so that the dock redesign does not remove existing workflows.
9. As an Omarchy user, I want dictation state and insertion behavior preserved, so that the Mic action remains a real control rather than decoration.
10. As an Omarchy user, I want the normal Send action to remain present during ordinary work, so that a permanent Stop control does not replace conversational correction.
11. As an Omarchy user, I want messages sent during active work to retain current Steering semantics, so that the visual change does not alter Agent lifecycle behavior.
12. As a keyboard user, I want visible focus and predictable tab order across Attach, input, Mic, and Send, so that the compact dock remains operable without a pointer.
13. As a motion-sensitive user, I want reduced-motion preferences respected, so that any meaningful busy or send motion remains accessible.
14. As an Omarchy user, I want a right-side capability panel that is closed by default, so that a new conversation remains uncluttered.
15. As an Omarchy user, I want explicit Changes and Browser tabs, so that code inspection and Computer control share a clear contextual region.
16. As an Omarchy user, I want opening the Computer globe action to select Browser, so that existing Computer entry points continue to work.
17. As an Omarchy user, I want Bot Settings and workspace capabilities to remain mutually exclusive right-region modes, so that stacked side panels do not consume the conversation.
18. As a desktop user, I want the conversation and capability panel visible together, so that I can inspect work without leaving the Thread.
19. As a narrow-screen user, I want the existing one-panel-at-a-time behavior preserved, so that the panel remains usable without compressing chat into an unreadable column.
20. As an Omarchy user, I want Changes to describe working-tree state rather than claim Agent authorship, so that shared checkout changes are not falsely attributed.
21. As an Omarchy user, I want Changes resolved from the selected Thread’s effective working directory, so that the panel reflects the same workspace the Agent uses.
22. As a security-conscious user, I want the daemon to resolve that directory instead of accepting arbitrary browser filesystem paths, so that the API cannot browse unrelated host locations.
23. As an Omarchy user, I want a clean repository shown as an intentional empty state, so that an empty list is not confused with loading or failure.
24. As an Omarchy user, I want a non-repository working directory shown as a specific empty state, so that setup problems are understandable.
25. As an Omarchy user, I want unavailable and retry states shown distinctly, so that Git failures do not silently look clean.
26. As an Omarchy user, I want a summary of changed-file count and known additions/deletions, so that I can understand the scale of current work quickly.
27. As an Omarchy user, I want every file row to show repository-relative path and status, so that modified, added, deleted, renamed, conflicted, and untracked files are distinguishable.
28. As an Omarchy user, I want newly added and untracked files to receive a New treatment, so that newly introduced work is immediately visible.
29. As an Omarchy user, I want per-file additions and deletions when Git can determine them, so that I can choose where to inspect first.
30. As an Omarchy user, I want binary or unknown counts left unspecified rather than shown as false zeros, so that the UI remains truthful.
31. As an Omarchy user, I want selecting a file to open bounded read-only detail, so that I can inspect the patch without turning the panel into an editor.
32. As an Omarchy user, I want rename detail to preserve both previous and current paths, so that file movement is understandable.
33. As an Omarchy user, I want unusual valid filenames parsed correctly, so that spaces, tabs, newlines, and rename records cannot corrupt the file list.
34. As an Omarchy user, I want truncated results disclosed, so that bounded output is never mistaken for the complete repository state.
35. As an Omarchy user, I want a manual refresh action, so that I can request current Git state immediately.
36. As an Omarchy user, I want visible Changes to refresh modestly while open, so that external file changes appear without constant manual interaction.
37. As an Omarchy user, I want Changes polling stopped while the panel is closed or Browser is active, so that an inactive capability does not consume resources.
38. As an Omarchy user, I want switching Bot or Thread to clear stale selected diff content immediately, so that one workspace’s code never appears under another conversation.
39. As an Omarchy user, I want Browser to reuse the selected Bot’s existing Computer Surface, so that Preview and Web Control remain one authoritative capability.
40. As an Omarchy user, I want Browser to retain Preview, Expanded Web Control, Takeover, Return to Bot, and read-only fallback behavior, so that moving the surface does not reduce control.
41. As an Omarchy user, I want switching Bots to clear the old Screen Projection before the new one appears, so that no stale Bot Screen leaks across selection.
42. As an Omarchy user, I want Browser loading, unavailable, fallback, and retry states to remain explicit, so that surface lifecycle is understandable.
43. As an Omarchy user, I want Changes selection preserved when temporarily switching to Browser within the same Thread, so that tab switching does not discard local inspection context.
44. As an Omarchy user, I want capability state scoped to the selected workspace context, so that returning to a different Bot or Thread does not restore unrelated detail.
45. As an Omarchy user, I want the panel to remain a compact capability rail rather than a full IDE, so that Omarchy Bot stays a conversation workspace.
46. As a project maintainer, I want the feature implemented entirely with Astryx and existing styling primitives, so that no Board, Tailwind, or Pro-template dependency enters the repository.
47. As a project maintainer, I want Git commands invoked without a shell and with strict output/time bounds, so that repository inspection remains safe and predictable.
48. As a project maintainer, I want Changes to perform read-only Git operations, so that opening the panel can never stage, edit, commit, or alter repository state.

## Implementation Decisions

- Astryx remains the only component and layout system. Board is visual/product reference material only; no Board source, registry package, Tailwind dependency, or Pro asset is introduced.
- The Composer uses compact density, its existing concentric rounded geometry, and low elevation. It does not add a second hand-built outer shell.
- Attach moves from the header action area to footer actions. Dictation remains a send-side action, the existing default Send control remains authoritative, and the staged attachment drawer stays inside the Composer.
- Existing draft scoping, refresh restoration, attachment ownership, drop handling, voice insertion, disabled/readiness behavior, Enter/Shift+Enter, Steering, transcript attention, and focus behavior are unchanged.
- Styling uses Astryx props and semantic theme tokens. The dock surface may be one semantic step lighter than the transcript, but light/dark colors are not hard-coded.
- The workspace owns one right-region state with three mutually exclusive modes: closed, Bot Settings, or capabilities. Capability mode owns an active tab of Changes or Browser.
- The capability panel is closed by default. Existing Computer/globe entry opens capability mode with Browser selected. Closing the panel returns the conversation to full width.
- One LayoutPanel owns the capability region. Existing Computer Surface content is embedded inside Browser rather than nesting another LayoutPanel.
- Desktop preserves conversation plus right rail. Narrow layouts preserve the existing rule that an open right region replaces the conversation until dismissed; no second responsive navigation model is added.
- Browser v1 is the existing Computer Surface. It preserves PNG Computer Preview, H.264 Expanded Web Control, Takeover authority, Return to Bot, Surface lifecycle, and HTTP read-only fallback. It is not an iframe, arbitrary URL browser, or separate lightweight webview.
- The accepted Cage Bot Desktop and Screen Projection architecture remains authoritative. This feature does not revive nested Hyprland, VNC, DataChannel image frames, or host graphical-session integration.
- Changes v1 reports Git working-tree truth. It does not infer file details from Tool Calls because current Tool summaries contain only optional aggregates and a shared checkout cannot prove Bot or Turn authorship.
- User-facing language is “Working tree changes” or “Uncommitted changes,” never “changes made by this Agent.”
- The daemon resolves the effective root from the selected Thread’s working directory, falling back to the daemon working directory under the same rule used for Agent sessions. The client may identify a Thread but may not submit an arbitrary root path.
- The daemon verifies that the requested Thread belongs to the route Bot before resolving Git state. A missing Thread, cross-Bot Thread, absolute path attempt, parent traversal, or NUL is rejected.
- Changes summary is exposed through a read-only Bot-scoped API with optional Thread identity. File detail is exposed through a separate read-only endpoint accepting only a repository-relative path present in the current summary.
- Summary state distinguishes ready, clean, not-repository, and unavailable. It includes generated time, known aggregate additions/deletions, bounded file records, and an explicit truncated flag.
- File records distinguish modified, added, deleted, renamed, untracked, and conflicted state. They contain repository-relative current path, optional previous path, optional known additions/deletions, and binary/unknown truth.
- Detail contains the selected repository-relative path, bounded patch text, and an explicit truncated flag. The UI never silently clips detail.
- Git is spawned directly with argument arrays. No shell command construction is used. Script-stable NUL-delimited porcelain and numstat formats are required so unusual filenames and rename records parse safely.
- Detail commands disable external diff drivers and color and place pathspecs after `--`. Only read-only status/diff operations are permitted.
- The Git service enforces short process timeouts, bounded stdout and stderr, maximum file count, bounded diff bytes, and safe failure mapping. Process output cannot grow without limit.
- Tracked staged and unstaged state is compared against HEAD. Unborn repositories receive explicit handling. Untracked detail and line counts use bounded reads or bounded no-index diff behavior. Binary counts remain unknown rather than fabricated as zero.
- Changes fetches on initial tab activation, manual refresh, and a modest interval while visible. Polling stops when capability mode closes, Browser is active, or the selected workspace changes.
- Selected detail is local UI state keyed to Bot and Thread. Bot or Thread change clears it synchronously before new asynchronous content can render. Switching tabs within the same workspace may retain the selection.
- The panel presents explicit loading, clean, not-repository, unavailable, retry, and truncated states. File detail is read-only using existing Astryx code presentation primitives.
- V1 adds no staging, committing, editing, terminal, branch picker, repository switcher, IDE tree, model picker, effort picker, context ring, or permanent Stop replacement.
- Git working-tree events are not added to the daemon event log because arbitrary external filesystem mutation has no reliable product event source. Visible-only polling is the bounded consistency mechanism.

## Testing Decisions

- Tests protect external behavior and user-visible state, not implementation details. They assert public API responses, real browser interaction, responsive presentation, preserved Computer authority, and safe Git results; they do not assert private React component boundaries, StyleX class names, exact internal command assembly, or arbitrary pixel snapshots.
- The highest UI seam is the existing browser end-to-end workspace harness against the real web application and daemon. It exercises Composer controls, right-region state, Changes/Browser switching, Bot/Thread changes, and Computer Surface entry as a user would.
- Composer browser coverage verifies Attach, Mic, and Send footer placement and circular affordances in light and dark themes, while behavior checks preserve Enter/Shift+Enter, staged attachment removal, drop, dictation insertion, disabled/readiness state, and Steering.
- Composer visual verification uses real browser rendering at desktop and narrow widths. It confirms compact dock hierarchy, one quiet edge treatment, visible focus, semantic contrast, and reduced-motion behavior without pinning incidental pixel coordinates.
- Capability browser coverage verifies closed-by-default state, explicit Changes and Browser tabs, Bot Settings exclusivity, close behavior, desktop side-by-side layout, and the existing narrow one-panel-at-a-time interaction.
- Changes browser coverage verifies usable loading, clean, not-repository, unavailable, retry, list, detail, New, binary/unknown, and truncated presentation. Selecting a file opens detail; switching Bot or Thread clears stale content before the next response.
- Browser coverage reuses the existing Computer Surface end-to-end prior art. Opening the globe selects Browser, and Preview, Expanded Web Control, Takeover, Return to Bot, fallback, and selection cleanup remain functional after relocation.
- The highest Changes-service seam is daemon HTTP integration against temporary real Git repositories. This validates route authorization, effective-root resolution, process execution, parsing, DTO mapping, and bounds together instead of unit-testing a parser in isolation.
- Temporary-repository scenarios cover clean, tracked modified, staged, deleted, renamed, conflicted, untracked, binary, and unborn states; aggregate and per-file counts; and previous-path handling.
- Filename scenarios include spaces, tabs, newlines, leading punctuation, and rename pairs so only NUL-safe parsing can pass.
- Security and resilience scenarios cover cross-Bot Thread rejection, absolute and parent-traversal paths, NUL rejection, requested files absent from the summary, non-repository roots, Git failure, timeout, stdout/stderr caps, file-count truncation, and diff-byte truncation.
- Read-only proof snapshots repository status before and after summary/detail requests and asserts no mutation. No test relies on the host repository’s current working tree.
- Polling behavior is tested with controlled time: fetch while Changes is visible, no repeated fetch while Browser or closed, manual refresh on demand, and cleanup on workspace switch.
- Existing chat, managed attachment, dictation, Steering, responsive/accessibility visual QA, Computer sheet, Screen Projection, and daemon integration suites are the prior art. New coverage extends those seams rather than creating a second test harness.
- Product verification requires running the actual browser surface after implementation. Automated tests alone do not prove the dock’s hierarchy or the desktop/narrow capability layout.

## Out of Scope

- Migrating away from Astryx or adding Board UI, Tailwind, Board registry components, Pro templates, or liquid-glass effects.
- Rebuilding the Composer, changing draft persistence, changing managed attachments, changing dictation, changing send/Steering semantics, adding model or effort controls, or replacing Send with a permanent Stop action.
- A full IDE, file editor, staging UI, commit UI, terminal, branch manager, repository browser, repository selector, or arbitrary filesystem explorer.
- Agent- or Turn-level authorship claims for Git changes. The selected working tree may contain edits from users, multiple Bots, tools, or external processes.
- Capturing detailed patches from Agent Tool Calls or introducing causal file-change instrumentation.
- Arbitrary URL browsing, iframe/webview integration, a second preview runtime, or a second Computer protocol.
- Reworking Cage, the neutral Bot Desktop, PNG/H.264 Screen Projection, Takeover arbitration, HTTP fallback, or Bot Screen capacity policy.
- Nested right panels, a second responsive navigation model, or multiple simultaneous capability rails.
- Real-time filesystem watching or a daemon event for every external Git mutation.
- Unbounded diffs, unbounded file lists, external diff drivers, shell execution, or repository mutation.
- Wholesale rewrite of the existing workspace design guidance.

## Further Notes

- Originating product request: GitHub Issue #5, “UI: Composer dock + right Changes/Browser panel (Astryx, inspired by Board).”
- The issue’s open questions are resolved here: Changes uses Git working-tree state; Browser reuses Computer Surface; the panel defaults closed; narrow screens retain one-panel-at-a-time behavior.
- The Board AI Chat and Composer pages are references for visual hierarchy and capability grouping only. The implementation remains native to the repository’s Astryx stack.
- Git porcelain is selected because its machine format is stable and can be NUL-delimited. Human-oriented Git output must not be parsed.
- Git state is workspace truth, not Agent provenance. A future product that promises “changes made by this Bot” will need explicit causal instrumentation at the Turn/tool boundary.
- The existing Bot Screen GitHub issue is superseded by the accepted Cage/H.264 implementation. Browser depends on that current implementation, not on the older nested-Hyprland or DataChannel-frame wording.

## Answer

Delivered the complete Composer dock and workspace capability panel across tickets 01–06. The workspace now has one mutually exclusive right region for Bot Settings or capabilities, explicit Changes and Browser tabs, bounded read-only Git summary and file detail, the authoritative Computer Surface under Browser, and the established compact Composer behavior.

The final refresh model fetches Changes on activation and manual refresh, polls every 15 seconds only while Changes is mounted and visible, aborts obsolete requests, scopes summary and detail queries to Bot and Thread, clears selection on workspace changes, and preserves the selected file across same-workspace Changes/Browser switches. Controlled browser races prove late polling, summary, detail, Bot, Thread, and file-selection responses cannot replace the active workspace state.

Final acceptance covered Composer, Changes, Browser, Settings, Bot and Thread switching, Computer cleanup, desktop and narrow layouts, light and dark themes, focus, and reduced motion. Actual browser inspection confirmed a compact capability rail rather than a second IDE, and the only intentional baseline update adds the visible Changes tab to the desktop Computer capability render.

Final focused validation:

- `bun run typecheck` — passed.
- `bun test tests/integration/working-tree-changes.test.ts` — 12 passed, 108 expectations.
- `bunx playwright test -c tests/e2e tests/e2e/specs/10-computer-sheet.spec.ts tests/e2e/specs/13-responsive-accessible-visual-qa.spec.ts tests/e2e/specs/16-working-tree-changes.spec.ts` — 32 passed.
