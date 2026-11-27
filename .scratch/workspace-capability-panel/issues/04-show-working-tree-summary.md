# 04: Show a bounded working-tree summary

**What to build:** Add a real Changes tab that safely reports bounded Git working-tree state for the selected Thread’s effective workspace, including truthful status, counts, and empty/error states, without accepting arbitrary roots or claiming Agent authorship.

**Blocked by:** 03: Open Browser in the unified capability panel.

**Status:** resolved

> **Superseded on 2026-09-05:** ADR 0009 removes Changes from the product. This ticket is fully retired as a current instruction: no still-valid product requirement remains. The summary API, cwd fallback, UI, and acceptance tests are historical delivery only — do not preserve or reintroduce them. Removal is still an [implementation gap](https://github.com/x-metheus/omarchy-bot/blob/cddced5d11497f201d0d62dd94e6c8893fa2f08f/docs/workspace-redesign.md#implementation-gaps-in-the-2026-09-05-revision). Accounting: [requirement map](../../shared-workspace-desktop-boundary/requirement-map.md#capability-panel-specification).

- [x] Changes is an explicit capability tab alongside Browser and uses “Working tree changes” or “Uncommitted changes” language.
- [x] A Bot-scoped read-only daemon API resolves the effective root from the selected Thread and rejects missing or cross-Bot Thread identity.
- [x] The browser cannot submit an arbitrary filesystem root, absolute path, parent traversal, or NUL-containing value.
- [x] Summary state distinguishes loading, ready, clean, not-repository, unavailable, retryable failure, and truncated results.
- [x] File rows distinguish modified, added, deleted, renamed, conflicted, untracked, and binary/unknown state.
- [x] Each row shows repository-relative current path, optional previous path, truthful New treatment, and known per-file additions/deletions.
- [x] The summary shows changed-file count and known aggregate additions/deletions without fabricating zero counts for binary or unknown content.
- [x] Git runs directly without a shell, uses machine-stable NUL-delimited output, and enforces process timeout, stdout/stderr bounds, and maximum file count.
- [x] Opening or refreshing Changes performs only read-only repository operations and cannot stage, edit, commit, or invoke external diff drivers.
- [x] Daemon HTTP integration with temporary repositories covers clean, modified, staged, deleted, renamed, conflicted, untracked, binary, unborn, and non-repository states.
- [x] Integration coverage includes spaces, tabs, newlines, leading punctuation, rename pairs, timeout, Git failure, cross-Bot authorization, output truncation, and before/after proof of no repository mutation.
- [x] Browser coverage proves the summary, empty/loading/error states, New treatment, counts, retry action, and truncated notice are usable.
 
## Answer

Implemented the bounded Working Tree Changes summary across the validated protocol, Bot-scoped daemon API, direct read-only Git service, API client, and unified capability panel.

Focused verification:

- `bun test tests/integration/working-tree-changes.test.ts` — 5 passed, 42 assertions.
- `bunx playwright test -c tests/e2e tests/e2e/specs/16-working-tree-changes.spec.ts` — 1 passed.
- `bun run typecheck` — passed.
