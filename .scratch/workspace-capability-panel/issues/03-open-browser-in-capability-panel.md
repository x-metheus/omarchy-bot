# 03: Open Browser in the unified capability panel

**What to build:** Replace the standalone Computer right-panel mode with one capability panel that opens the existing Computer Surface under Browser, remains mutually exclusive with Bot Settings, and preserves the workspace’s desktop and narrow-screen layout behavior.

**Blocked by:** 01: Extract reusable Computer Surface content.

**Status:** resolved

> **Current boundary:** ADR 0009 removes Changes but retains the Computer Surface. The “Browser” tab label is historical pairing with Changes; it is not plugin ownership of browser profiles, Cookies, or logins. Still-valid homes: Computer Surface, Bot Settings exclusivity, narrow one-panel, and projection cleanup → [workspace-redesign Computer](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#10-computer) and [parent spec](../../shared-workspace-desktop-boundary/spec.md) stories 29, 31–32, 51–65. Accounting: [requirement map](../../shared-workspace-desktop-boundary/requirement-map.md#capability-panel-specification).

- [x] The workspace right region has explicit closed, Bot Settings, and capabilities modes, with only one mode rendered at a time.
- [x] Capability mode owns an active tab state and can host the extracted Computer Surface content under Browser.
- [x] The existing Computer/globe action opens capability mode with Browser selected.
- [x] Closing capability mode returns the conversation to full width and performs existing Computer-control cleanup.
- [x] Browser preserves Preview, Expanded Web Control, Takeover, Return to Bot, fallback, loading, unavailable, retry, and failure behavior.
- [x] Desktop shows conversation and capability panel together without nested LayoutPanels.
- [x] Narrow screens retain the existing one-panel-at-a-time interaction and provide an accessible way back to the conversation.
- [x] Bot changes clear the previous Screen Projection and any Browser-owned control before rendering the new selection.
- [x] Browser is the current Computer Surface, not an iframe, arbitrary URL webview, second preview runtime, or new Computer protocol.
- [x] Existing Computer and responsive browser coverage proves the relocated surface behaves identically.
- [x] A real browser smoke check verifies open, close, Bot Settings exclusivity, desktop layout, and narrow navigation.
 
## Answer

Replaced the independent Bot Settings and Computer booleans with one discriminated right-region state for closed, Bot Settings, or capabilities. The sole capability `LayoutPanel` exposes Browser as its active tab and mounts the extracted `ComputerSurface` directly, retaining its projection, fallback, retry, Takeover, Return to Bot, Expanded Web Control, close cleanup, focus restoration, and Bot-selection cleanup without nested panel chrome. The existing Computer action still opens Browser, narrow layouts still replace the conversation until the panel is dismissed, and mailbox `unreadThreadId` routing remains unchanged.

Focused validation:

- Refreshed the five intentional ticket-13 baselines for desktop light/dark, Computer Surface dark, narrow light, and reduced-motion dark. The update run completed 26 tests and encountered one transient dark reduced-motion axe contrast result.
- `bunx playwright test -c tests/e2e tests/e2e/specs/10-computer-sheet.spec.ts tests/e2e/specs/13-responsive-accessible-visual-qa.spec.ts`: 27 passed in Chromium.
- `bunx tsc --noEmit -p tsconfig.json`: passed with no diagnostics.
