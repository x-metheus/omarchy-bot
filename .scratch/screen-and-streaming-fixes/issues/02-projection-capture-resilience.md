# 02: One slow capture permanently ends the live Bot Screen

Type: task
Status: resolved
Blocked by: None

**What to build:** A transient compositor stall does not end the live Bot Screen preview. Today one slow `grim` capture turns the panel into "Read-only snapshot — The Bot Screen capture helper stopped producing frames." until the user reopens it.

## Evidence

- `~/.local/state/omarchy-bot/service.log` lines 46-47 (2026-11-03):
  `Screen Projection capture-failed for surf_5ba031… session …: Screen capture did not produce a frame within its latency bound`
- `CAPTURE_TIMEOUT_MS = 2_000` (`apps/daemon/src/modules/computer/screenProjection.ts:31`). `withinProjectionDeadline` races the capture against it.
- Measured on the live Bot Screen when idle: `grim -o HEADLESS-1 -` takes about 55 ms (5 samples). The compositor uses `WLR_RENDERER=pixman` (CPU rendering), so heavy Chrome rendering or bursts of `swaymsg` commands can stall it past 2 s.
- `#projectFrame` (`screenProjection.ts:620-659`) calls `#fail(session, "capture-failed", …)` on the **first** error. `#fail` (line 1242) sets the session to `failed` and the snapshot fallback, with no retry.
- The `grim` process spawned in `swayBotScreenRuntime.ts` `#capture` (line ~1331) is **not killed** when the deadline fires, so slow captures can pile up. `captureInFlight` is reset in `finally`, so the next capture can start while the previous grim is still running.

## Required fix

1. Tolerate transient failures: count consecutive capture failures per session and call `#fail(…"capture-failed")` only after a small threshold (for example 3 consecutive) or a total stall window (for example 6 s), with backoff between attempts. Reset the counter on a good frame. Keep the existing diagnostic counters and add one for transient capture failures.
2. Make a timed-out capture cancellable: thread an `AbortSignal` (or equivalent) from the projection deadline into `BotScreenSource.capture()` / the sway runtime's `#capture`, and kill the `grim` child on abort. Do not start a new capture while the previous `grim` is still alive.
3. Keep the hard failure for non-transient errors such as "Bot Desktop is not running" and "compositor is not running". Classify them so they still fail fast.

## Acceptance criteria

- [ ] A unit test with a fake source shows that 1–2 consecutive timeouts followed by a good frame keep the session in preview and deliver the frame, while N consecutive timeouts still produce `projection-failure` with `capture-failed`.
- [ ] A unit test shows that a timed-out capture aborts its underlying operation (fake source observes the abort signal), and that no overlapping capture starts.
- [ ] A non-transient error still fails on the first occurrence.
- [ ] Existing projection tests (`bun test` for files matching `screenProjection`) pass; `bun run typecheck` passes.

## Constraints

- Host safety per `AGENTS.md`. Do not touch the user's running `omarchy-bot.service` or its Bot Screen units. Use the repository's private test harnesses only.

## Comments

- 2026-11-03 — Resolved on branch `fix/02-projection-capture-resilience`, commit `0600c58`.
  - Implementation: capture retries tolerate up to 3 consecutive transient failures with 250 ms backoff and reset on a good frame; `transientCaptureFailures` is exposed in `ProjectionLoadMetrics` and reconciled with shortfall accounting. An `AbortSignal` is threaded from the projection deadline through `BotScreenProjectionSource.capture()` into the sway runtime `#capture`; `grim` is SIGTERM/SIGKILLed and reaped before the capture settles, and the serialized capture holds the next attempt until the child exits. "Bot Desktop is not running" / "Bot Computer compositor is not running" are classified as `BotScreenUnavailableError` and still fail on first occurrence.
  - Acceptance evidence:
    - `bun test tests/integration/screen-projection.test.ts` — 13 pass / 0 fail (2 stalls then good frame stays in `preview` and delivers; 3 stalls yield `projection-failure`/`capture-failed`; timed-out capture observes abort with no overlap; non-transient errors fail first).
    - `bun test tests/unit` — 50 pass / 0 fail (includes `tests/unit/bot-screen-capture-child.test.ts`, 4 teardown/SIGKILL tests).
    - `bun test tests/integration/bot-screen-sway-projection.test.ts` — 12 pass / 0 fail (scripted `grim` ignored SIGTERM; child gone before settle, `signalCode: "SIGKILL"`).
    - `bun test tests/integration/bot-screen-lifecycle.test.ts` — 37 pass / 0 fail.
    - `bun test apps/web/src/lib/screenProjection.test.ts` — 4 pass / 0 fail (the literal `screenProjection` match; unrelated client mapping).
    - `bun run typecheck` — exit 0, no diagnostics.
  - Unverified: the env-gated `tests/integration/bot-screen-capacity.load.test.ts` (`OMARCHY_BOT_REAL_SCREEN_LOAD=1`) was not run; it needs the real host runtime, which host safety forbids. The retry behavior is covered by the integration suite via `FakeBotScreenRuntime` rather than a pure unit test; process teardown is covered by unit tests.
  - Host safety: no host package manager, service restart, compositor/Omarchy Shell action, or Bot Screen unit interaction; no merge or push.
