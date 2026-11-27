# 06: Complete refresh, isolation, and responsive acceptance

**What to build:** Finish the capability workspace as a coherent user experience: keep visible Changes current without background waste, isolate state across Bot and Thread switches, preserve same-workspace tab context, and verify the Composer, Changes, and Browser surfaces together across desktop, narrow, light, and dark environments.

**Blocked by:** 02: Ship the compact Astryx Composer dock; 05: Open a bounded read-only file diff.

**Status:** resolved

> **Partially superseded on 2026-09-05:** ADR 0009 removes the Changes UI, diff state, polling, and their product acceptance requirements. Still-valid homes: Composer → [workspace-redesign Composer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#7-composer) and parent story 30; Computer Surface selection/control → [workspace-redesign Computer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#10-computer) and parent stories 29, 51–65; responsive/accessibility and Bot Settings exclusivity → parent stories 31–33. Retired: Changes refresh, polling, and diff state. The checks below are historical; do not restore Changes to satisfy old snapshots or tests. Accounting: [requirement map](../../shared-workspace-desktop-boundary/requirement-map.md#capability-panel-specification).

- [x] Changes provides a manual refresh action that replaces summary and selected detail with current repository state.
- [x] Changes fetches on activation and refreshes at a modest interval only while the Changes tab is visible.
- [x] Polling stops when the capability panel closes, Browser is active, the component unmounts, or the workspace selection changes.
- [x] Switching Bot or Thread synchronously clears stale summary and diff state before any new asynchronous result can render.
- [x] Switching Bots also clears the previous Screen Projection and Computer control state before new Browser content appears.
- [x] Switching between Changes and Browser within the same Bot/Thread preserves the selected Changes file while preventing inactive polling.
- [x] Late responses from a previous Bot, Thread, file selection, or polling generation cannot overwrite the current workspace state.
- [x] Bot Settings and capabilities remain mutually exclusive through repeated open, close, and selection changes.
- [x] Desktop keeps conversation plus one right rail; narrow layout keeps one panel at a time with accessible return navigation.
- [x] Composer Attach, Mic, Send, draft, attachment, dictation, disabled, Steering, keyboard, focus, and reduced-motion behavior remain correct beside the final panel.
- [x] Browser Preview, Expanded Web Control, Takeover, Return to Bot, fallback, loading, error, and retry behavior remain correct beside Changes.
- [x] Browser end-to-end coverage exercises the full workspace flow, including manual refresh, visible-only polling, stale-response rejection, tab preservation, Bot/Thread switching, and right-region exclusivity.
- [x] Real browser verification covers desktop and narrow widths in light and dark themes and confirms a compact capability rail rather than a second IDE.
- [x] No Board, Tailwind, webview, filesystem watcher, Git mutation control, arbitrary repository selector, or host graphical-session change is introduced.
 
## Answer

Completed the capability workspace with one workspace-scoped Changes selection owner, abortable query generations, a manual refresh that updates both summary and selected detail, and a 15-second polling interval whose component lifetime is limited to the visible Changes tab. Browser/close/unmount and Bot or Thread changes stop the old observer and reject late summary or detail results, while same-workspace Changes/Browser switches retain the selected file.

Browser-first TDD reproduced the missing same-workspace selection after a Browser round trip, then passed after lifting selection to the capability owner. Controlled Playwright clock and network gates now cover activation, manual refresh, visible-only polling, close and Browser cleanup, stale polling/summary/detail responses, Bot and Thread isolation, selection preservation, and right-region exclusivity.

The actual isolated daemon UI was inspected at desktop and narrow widths in light and dark themes, including reduced motion. The Composer remained alongside one compact desktop rail, the narrow view retained one panel with accessible return navigation, and the real working-tree summary and refresh action rendered without introducing IDE controls. The Computer baseline was intentionally refreshed only after inspection to include the now-visible Changes tab.

Final focused validation:

- `bun run typecheck` — passed.
- `bun test tests/integration/working-tree-changes.test.ts` — 12 passed, 108 expectations.
- `bunx playwright test -c tests/e2e tests/e2e/specs/10-computer-sheet.spec.ts tests/e2e/specs/13-responsive-accessible-visual-qa.spec.ts tests/e2e/specs/16-working-tree-changes.spec.ts` — 32 passed.
