# 01: Chat stalls on the first letter while a response streams

Type: task
Status: resolved
Blocked by: None

**What to build:** While a Bot response streams, the chat shows text continuously as it arrives. Today, in a long thread, the user sees only the first character ("I") for several seconds, and then everything appears at once with a smoothed animation.

## Diagnosis (verified by reading code)

- For each `response.delta`, the daemon (`apps/daemon/src/modules/turns/turns.ts:724-735`) appends the text in SQLite and emits a `response.updated` event whose payload is the **complete updated `MessageDto`**. `thinking.delta` → `thinking.updated` works the same way.
- The web event router (`apps/web/src/lib/events.ts`, `route()`, cases `response.updated` / `thinking.updated` / `tool.updated` / `agent.native`) ignores that payload and calls `invalidate("messages", threadId)`, which runs `qc.invalidateQueries({queryKey: ["messages", threadId]})` (`apps/web/src/routes/index.tsx:98-102`).
- Each invalidation refetches the **whole, unpaginated** thread: `GET /api/threads/:id/messages` → `threads.listMessages` (`apps/daemon/src/modules/threads/threads.ts:540`).
- In TanStack Query v5 (5.102.8), `invalidateQueries` defaults to `cancelRefetch: true`, so each new delta cancels the refetch still in flight. Once a thread is long enough that one refetch takes longer than the gap between deltas, no refetch finishes until the stream pauses. The UI stays on the first rendered state, and then Astryx `useStreamingText` animates the whole backlog.

## Required fix

- For `response.updated` and `thinking.updated` (and `tool.updated` if its payload is also a full `MessageDto`; check it), apply the payload directly to the `["messages", threadId]` cache with `queryClient.setQueryData`: replace by `id` if present, otherwise invalidate as a fallback. Do not refetch the thread for each delta.
- Keep structural events (`message.appended`, `*.removed`, snapshot-required) on invalidation.
- The router currently receives only an `Invalidate` callback. Extend the seam minimally, for example with an optional `applyMessage(threadId, message)` handler passed from `index.tsx`, and keep `events.ts` testable without React.
- Validate the payload shape defensively (it is untrusted input over the WebSocket). On mismatch, fall back to invalidation.

## Acceptance criteria

- [ ] A unit test for the router shows that N consecutive `response.updated` events cause zero invalidations of `messages` and N cache patches, and that the final cached text equals the last payload's text.
- [ ] A unit test shows a malformed payload falls back to invalidation.
- [ ] Existing tests for `events.ts` / transcript still pass; `bun run typecheck` passes.
- [ ] Optional but preferred: a Playwright e2e under `tests/e2e/specs/` (follow existing spec patterns) that streams a response in a thread with many prior messages and asserts the streaming bubble's text length grows across several samples before completion.

## Constraints

- Host safety per `AGENTS.md`: do not install host packages or restart the host compositor/bar.
- The main checkout has unrelated uncommitted edits in `apps/web/src/components/*`, `globals.css` and `routes/index.tsx`. Work only in your worktree. Keep edits to `routes/index.tsx` minimal so they merge cleanly.

## Comments

### 2026-11-03 — resolved (branch `fix/01-chat-stream-stall`)

Root cause confirmed in the worktree: every `response.updated` / `thinking.updated` / `tool.updated` / `agent.native` event invalidated `["messages", threadId]`, refetching the whole unpaginated transcript. Repeated invalidation with TanStack Query v5 `cancelRefetch: true` cancelled each in-flight refetch, so text appeared only once the stream paused.

Changes (5 files, web only; no daemon/protocol changes):
- `apps/web/src/lib/messageStream.ts` (new): pure, React-free cache patch + fetch reconciliation. Patches full `MessageDto` payloads by `id` (ordered insert by `seq` when absent), ignores replayed payloads via the monotonic `EventEnvelope.cursor` per message, merges rows patched/received while a transcript fetch was in flight so a stale snapshot cannot overwrite newer text, and buffers deltas while the transcript is unloaded so the first refetch cannot drop the start of a stream. Never seeds a one-message cache.
- `apps/web/src/lib/events.ts`: `route()` exported with an optional `applyMessage` seam. `response.updated` / `thinking.updated` / `tool.updated` patch the cache when the payload validates, otherwise invalidate. `tool.updated` is a `{threadId, messageId, toolCall}` patch, **not** a full `MessageDto` (contrary to the ticket's "check it"), so it patches the cached tool row's `toolCall` by `messageId`. Structural events (`message.appended`, `*.removed`, snapshot-required) still invalidate.
- `apps/web/src/routes/index.tsx`: minimal wiring (stream seam + messages `queryFn`); `refetchInterval: 15_000` retained as the safety net.
- Tests: `apps/web/src/lib/events.test.ts` (new) and `apps/web/src/lib/messageStream.test.ts` (new).

Verification (final pass by a fresh worker; each command exit 0):
- `bun test apps/web/src/lib/` — 60 pass / 0 fail (8 files, 215 expect calls); the new router/cache tests alone are 32 pass.
- `bun test tests/integration/response-blocks.test.ts tests/integration/thinking-blocks.test.ts tests/integration/ordered-transcript-qa.test.ts` — 14 pass / 0 fail.
- `bun run lint:boundaries` — 3 pass / 0 fail.
- `bun run typecheck` — clean (no diagnostics).
- Acceptance: N consecutive `response.updated` / `thinking.updated` / `tool.updated` events produce N cache patches, zero `messages` invalidations, and the final cached text equals the last payload; malformed payloads (wrong type/state/threadId, missing `messageId`) fall back to exactly one invalidation with the cache untouched.
- Review: three rounds. Round 1 found 2 blockers + 2 majors + 1 minor (unloaded cache, stale in-flight refetch, stale same-state payloads, `tool.updated` refetch, non-array cache); round 2 found one remaining dropped-first-deltas race; round 3 **APPROVE**, no actionable findings.

Not verified / waived:
- Optional Playwright e2e was not added and not run: no ticket-specific spec exists and no Playwright browser is installed (`~/.cache/ms-playwright` absent); installing one is out of scope under host safety. The e2e harness itself is hermetic (temp dirs, dedicated ports 7398/7399, `useHostApplicationUnits: false`), so the waiver is browser availability, not host risk.
- No live manual GUI check of streaming against a running service (host safety: the user's `omarchy-bot.service` and Bot Screen units were not touched).
- Accepted residual risks: a replayed payload older than a `snapshot_required` snapshot can briefly regress one row until replay advances; `appliedCursors`/`revisions` live for the pump session; buffered deltas are discarded when the resolving snapshot already contains that row (by design, newest fetch owns the queue).
