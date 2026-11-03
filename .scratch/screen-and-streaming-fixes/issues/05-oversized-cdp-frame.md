# 05: One large page breaks the Browser Tool for every Screen

Type: task
Status: resolved
Blocked by: None

**What to build:** A snapshot (or any CDP reply) of a very large page fails only that call, with a clear message. The shared CDP pipe and every other Screen's browser keep working.

## Diagnosis (verified)

- `cdpPipe.ts:10` sets `MAX_FRAME_BYTES = 8 MiB`. Any incoming frame over that limit throws in the reader (around line 90), which calls `#fail` and destroys the pipe for every Screen. Daemon restarts have no reconnect.
- `browserRuntime.ts:333` `#snapshot` requests the whole `Accessibility.getFullAXTree` and trims to about 300 nodes / 16 KiB only afterwards. A large article or web app easily exceeds 8 MiB of JSON.

## Required fix

1. Keep the reply small at the source: bound the snapshot request (for example `Accessibility.getFullAXTree` with `depth`, or walk with `getPartialAXTree` / `queryAXTree` / `getChildAXNodes` up to the existing node and byte caps). Report truncation exactly as today.
2. Make an oversized frame fail only its own request. Drop the frame, settle the matching pending request with "page too large for a snapshot; narrow with read_text/wait_for or take a smaller snapshot", and keep the pipe alive. Use a separate higher hard limit, which closes the pipe, only for frames that cannot be associated with a request or are absurdly large.
3. Review the other unbounded replies (`read_text`, `Runtime.evaluate` results, `Target.getTargets`) for the same risk.

## Acceptance criteria

- [ ] A unit test feeding an oversized reply frame shows that the matching request rejects with the actionable message, other pending requests resolve, and the pipe stays open.
- [ ] A test shows a snapshot of a large fixture tree stays within the caps and reports truncation.
- [ ] Existing browser suites and `bun run typecheck` pass.

## Constraints

Host safety per `AGENTS.md`. Never touch the user's running service or Bot Screen units, and never run host browsers.

## Comments

### 2026-11-03

Implemented on branch `fix/05-oversized-cdp-frame` (commit 2675efb, worktree `omarchy-bot-worktrees/fix-05-oversized-cdp-frame`).

Changes:
- `cdpPipe.ts`: frames over the 8 MiB soft limit are not buffered. The pipe keeps a 256-byte prefix, reads the leading `"id"` (Chromium serializes it first), rejects only that pending request with `CdpReplyTooLargeError` ("page too large for a snapshot; narrow with read_text/wait_for or take a smaller snapshot" for `Accessibility.*`, a method-named variant otherwise), discards the rest up to the NUL, and stays open. Late oversized replies and oversized events (e.g. `Accessibility.nodesUpdated`) are dropped. Oversized frames with no leading `id`/`method`, or any frame over the 128 MiB hard limit, still close the pipe. Optional `CdpPipeLimits` constructor arg for tests. NUL framing and fd 3/4 unchanged.
- `browserRuntime.ts` snapshot: no more `getFullAXTree`. It runs `Accessibility.enable` (ref-counted per tab, `disable` afterwards), then `getRootAXNode` + `getChildAXNodes` depth-first in declared child order, stopping at 300 lines / 16 KiB (same output format and `truncated` flag), with budgets of 4000 visited nodes and 1000 child fetches. A single oversized child list marks the snapshot truncated; if nothing fits it throws the actionable message. An "Invalid ID" mid-walk asks for a new snapshot.
- Item 3 review: `read_text` is already capped in-page at 32769 chars (about 128 KiB max reply), and the `Runtime.evaluate` calls return booleans or small objects. The `select` option list was unbounded (the whole option array came back), so matching now happens in the page and only the index returns. `Target.getTargets`, `Page.getNavigationHistory` and `Page.getFrameTree` stay unbounded in theory (huge data: URLs or many tabs). Left as-is: with the new pipe behavior they fail only their own call.

Tests (deps linked from the main checkout through temporary node_modules symlinks, removed afterwards, because the worktree has no install):
- `bun test tests/integration/browser-cdp.test.ts tests/integration/browser-runtime.test.ts tests/integration/browser-pack.test.ts tests/integration/browser-tool.test.ts tests/integration/browser-pipe-spawn.test.ts tests/integration/agent-browser-tool.test.ts tests/integration/browser-real-conformance.test.ts tests/integration/bot-computer.test.ts tests/conformance/pi-browser-tool.test.ts`: 71 pass, 1 skip (env-gated real conformance), 0 fail.
- New: an oversized reply (>8 MiB, split across chunks, with coalesced neighbours) rejects only its request and the pipe stays usable. Oversized events and late replies are dropped. Hard-limit and unroutable oversized frames close the pipe. A huge AX fixture (about 200k nodes, more than 8 MiB as a full tree) stays within 300 lines / 16 KiB, reports `truncated`, never calls `getFullAXTree`, and every reply stays under 256 KiB. An oversized child list only truncates that snapshot and other Screens keep working. These failed on the old source.
- `bun test tests/unit`: 50 pass, 0 fail. `bun run lint:boundaries`: 3 pass.
- `bun run typecheck`: the worktree has no node_modules (`tsc` not found). Ran the main checkout's `tsc --noEmit` with symlinked deps. That setup reports many unrelated resolution errors, but the error output is identical with and without this change (247 errors both ways, no diff).

Unverified: the `getRootAXNode`/`getChildAXNodes` walk has not been run against real Chromium. `browser-real-conformance` is gated on `OMARCHY_BOT_REAL_PORTABLE_BROWSER=1` plus a Sway bundle and was skipped. Assumed from Chromium's implementation: the walk needs `Accessibility.enable`, and the returned children include ignored nodes. Run the real conformance suite before merging.

### 2026-11-03: verification follow-up (Claude Code)

- After `bun install --frozen-lockfile` in the worktree, `bun run typecheck` exits 0 with no diagnostics.
- Real browser-tool conformance against the actual pack Chromium, run in a private Sway Bot Computer with the installed runtime's Sway bundle, fonts and browser pack used read-only. The user's service and units were not touched. `OMARCHY_BOT_REAL_PORTABLE_BROWSER=1 … bun test tests/integration/browser-real-conformance.test.ts` → **1 pass, 0 fail, 41 expects** (3.83 s). This confirms the `getRootAXNode`/`getChildAXNodes` walk produces working Element Refs, stale-ref failure, type/select, two-Screen tab separation, and Takeover on real Chromium.
- Still not exercised on real Chromium: a page large enough to trip the oversized-reply path. That path is covered only by the unit tests.
- Note: `.lane/dist/sway` is absent and `.lane/browser` is not a valid pack layout in the main checkout. The run used `~/.local/share/omarchy-bot/runtime/{current/sway,current/fonts,browser}` instead.
