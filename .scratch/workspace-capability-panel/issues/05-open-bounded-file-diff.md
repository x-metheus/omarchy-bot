# 05: Open a bounded read-only file diff

**What to build:** Let the user open a changed file from Changes and inspect a safe, bounded, read-only patch or code detail for that repository-relative path, including rename, untracked, binary, unborn, and truncation behavior.

**Blocked by:** 04: Show a bounded working-tree summary.

**Status:** resolved

> **Superseded on 2026-09-05:** ADR 0009 removes Changes, including this file-diff capability. This ticket is fully retired as a current instruction: no still-valid product requirement remains. The historical delivery below does not authorize retaining a review or artifact panel; removal is still an [implementation gap](https://github.com/x-metheus/omarchy-bot/blob/cddced5d11497f201d0d62dd94e6c8893fa2f08f/docs/workspace-redesign.md#implementation-gaps-in-the-2026-09-05-revision). Accounting: [requirement map](../../shared-workspace-desktop-boundary/requirement-map.md#capability-panel-specification).

- [x] Selecting a file row opens a readable detail view within the capability panel without introducing an editor or IDE tree.
- [x] The detail API accepts only a repository-relative path present in the current Bot/Thread summary and revalidates Thread ownership.
- [x] Absolute paths, parent traversal, NUL, cross-Bot Threads, and paths absent from the current summary are rejected with bounded safe errors.
- [x] Tracked staged and unstaged changes are compared against HEAD and rendered without color or external diff drivers.
- [x] Added, deleted, renamed, conflicted, untracked, binary, and unborn-repository cases have explicit truthful detail behavior.
- [x] Rename detail preserves previous and current paths.
- [x] Untracked text detail uses a bounded read or bounded no-index diff; binary and unknown counts remain unspecified rather than fabricated.
- [x] Git runs directly without a shell, places pathspecs after `--`, and enforces timeout, stdout/stderr bounds, and maximum diff bytes.
- [x] Truncated detail sets and displays an explicit truncated state rather than silently clipping output.
- [x] Switching the selected file replaces prior detail without flashing content for the wrong path.
- [x] Daemon HTTP integration with temporary repositories covers every supported file state, unusual filenames, authorization, traversal, timeout, failure, and diff truncation.
- [x] Browser coverage proves file selection, detail readability, rename attribution, binary/unknown treatment, error recovery, and truncated notice.
- [x] Before/after repository status proves summary and detail requests never mutate the worktree or index.

## Answer

Implemented bounded read-only changed-file detail across the validated protocol, Bot-scoped daemon route and Git service, API client, and Changes capability panel. Detail authorization is anchored to a fresh summary for the route Bot/Thread, direct Git output is time- and byte-bounded, and text, binary, unknown, rename, error, and truncation states are explicit.

Focused verification:

- `bun test tests/integration/working-tree-changes.test.ts` — 12 passed, 108 assertions.
- `bunx playwright test -c tests/e2e tests/e2e/specs/16-working-tree-changes.spec.ts` — 2 passed.
- `bun run typecheck` — passed.
- Browser-driven live daemon verification opened `apps/web/src/components/ChangesPanel.tsx` from the public Changes panel and rendered its real bounded diff in the Astryx code surface.
