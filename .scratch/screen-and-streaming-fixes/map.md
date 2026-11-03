# Bot Screen and chat streaming fixes (2026-11-03)

Diagnosed by Claude Code on 2026-11-03 from a user report and the Pi Bot Screen self-report. Each ticket runs in its own herdr worktree under `~/storage/Projects/omarchy-bot-worktrees/fix-NN-slug` on branch `fix/NN-slug`, based on `main` at `456a97d`.

| # | Ticket | Status |
|---|--------|--------|
| 01 | [Chat stalls on the first letter while streaming](issues/01-chat-stream-stall.md) | resolved |
| 02 | [One slow capture permanently ends the live Bot Screen](issues/02-projection-capture-resilience.md) | resolved |
| 03 | [Bot Screen launches leak host apps and steal other Surfaces' windows](issues/03-screen-launch-isolation.md) | resolved |
| 04 | [Bots use only the pack browser (Browser Supply)](issues/04-browser-supply-pack-only.md) | open |
| 05 | [One large page breaks the Browser Tool for every Screen](issues/05-oversized-cdp-frame.md) | open |
| 06 | [Kill the pack browser left over from a daemon restart](issues/06-orphan-pack-browser-after-restart.md) | open, blocked by 04 |
| 07 | [Pop-ups open on the opener Bot's own Screen](issues/07-popups-follow-opener.md) | open, blocked by 04, needs design |

None of these tickets blocks another. Tickets 02 and 03 both live in `apps/daemon/src/modules/computer/`, but each changes different files: 02 changes `screenProjection.ts`, and 03 changes `swayBotScreenRuntime.ts` and `botComputer.ts`.

Tickets 04-07 come from the 2026-11-03 browser architecture review and branch from `fix/integration`, which contains 01-03 and ADR 0013.
