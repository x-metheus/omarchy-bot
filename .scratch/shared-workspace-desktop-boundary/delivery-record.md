# Delivery record: Shared Workspace and Bot Desktop Boundary

Status: implementation landed; mandatory human acceptance open (2026-09-05).

This is not a “done” claim. Automated and real-runtime evidence are recorded separately from the user’s host-and-Bot check.

## Accepted design

Unchanged: [parent spec](spec.md), [product boundary](https://github.com/x-metheus/omarchy-bot/blob/6750011404c8032470a169e52bf7ebe362a88e4c/docs/workspace-redesign.md#shared-workspace-and-plugin-boundary), ADR 0009, ADR 0010, [requirement map](requirement-map.md).

## Implemented behavior

| Slice | What changed |
| --- | --- |
| 01 Shared Workspace | Implicit Agent sessions, mailbox, avatar recipes, and `open_app` use `~/.omarchy-bot/workspace`. Explicit Thread cwd preserved. Access failure does not fall back to launch/source. |
| 02 Changes removed | UI, daemon Git service, protocol DTOs, and client methods removed. Retired routes 404. Computer Surface and Composer remain. |
| 03 Screen startup | Cage retries `wlr-randr` while alive. Projection `releaseInput` / snapshot capture no longer destroy a ready desktop. Public errors expose the failing stage. |
| 04 On-demand desktops | Unused Bots have no running stack; first view/action provisions one session; concurrent first-use converges; same-Agent Bots stay independent. |
| 05 Projection lifetime | A→B replaces that client’s projection only. Last viewer stops capture/encode. Remaining viewers kept. Apps and Agent screenshots survive. |
| 06 Recover / delete | Failure and deletion stay on the owning runtime. Shared files, explicit cwd dirs, and Native Sessions survive. Cage adapter stops owned children after detach. |
| 07 Unused-Bot cost | [normal-use-resource-report.json](normal-use-resource-report.json). Unused Bots add no Cage/encode stack (combined daemon/harness ~242 MiB PSS in that census). Selected-view / one-projection windows were **not** in the checked-in JSON. |
| 08 Docs | One current reading order. Historical specs kept and mapped. |

## Automated results

- `bun run typecheck` — pass
- `bun test` — 313 pass, 3 skip, 2 fail (environment, not restored Changes):
  - Pi real-model conformance: computer tool completed 1 of 2 (`mise ERROR` on the computer worker). Steps 1–9 passed.
  - Vite DiceBear runtime: Playwright pointed at a missing sandbox browser cache (`PLAYWRIGHT_BROWSERS_PATH`).
- Focused Playwright (real browsers at `~/.cache/ms-playwright`): chat, Computer (simulated peers), deletion, Changes-absent, and visual QA — 47 pass, 1 fail.
  - Remaining fail: selected Sidebar row contrast in dark reduced-motion (`#a3a3a3` / `#fafafa` on selected Item grey). Computer/Changes/Composer flows were not the failure.
- Computer e2e uses simulated peers. That is UI/state coverage, not Cage pixels.

## Real-runtime evidence

- Ticket 03: private-runtime Cage reached compositor/desktop/capture/input, PNG snapshot, 1280×720 frame.
- Ticket 05: injectable Screens plus real ffmpeg PID release on last viewer / A→B.
- Ticket 07: unused-Bot census only in the checked-in JSON. Historical 4-stream ~2 GiB / 4.13 cores is a baseline, not a budget. Selected-view windows remain unmet in that artifact.
- Two-Cage `zenity` smoke not run. System `cage` / `wlr-randr` not on PATH; portable bundle used. Live plugin daemon was not restarted onto this tree.

## Startup cause vs host disruption

- Startup: `wlr-randr` once too early, plus cleanup that treated `releaseInput` as fatal. Not a wording-only bug.
- Host top-bar/shortcut breakage: not shown to share that cause. User-manager env stayed Host Session in read-only checks. Not an Agent permission sandbox.

## Human acceptance

**Not confirmed.** The user has not recorded a pass or fail. Automatic tests cannot close this gate.

Hands-on check (ticket 09):

1. With the corrected plugin in use, the original Omarchy top bar stays clickable through Bot desktop start, work, switch, failure, and cleanup.
2. Existing Omarchy shortcuts still fire in the Host Session through that lifecycle.
3. Ordinary host focus and physical pointer/keyboard stay independent of Bot-generated input.
4. View and switch Bots while one continues useful background work: selected pixels/input belong to the correct Bot; background work is not cancelled or forced onto one shared input state.

## Tauri

Web UI and daemon-facing contracts remain the shared client. Execution stays on Omarchy. No Tauri scaffold. Chromium/e2e results are not WebView proof.

## Preservation

No shared work files, Native Sessions, or application data were deleted or migrated for acceptance. No host package update, compositor restart, or graphical-session restart was used as a repair.

## Remaining limitations

- Human host gate open.
- Live plugin daemon not on this tree until the user restarts it.
- Native `session.resume` cwd is requested, not proven relocated by the Agent backend.
- Compact preview native data-channel frames were 0 in the ticket 07 sample (daemon capture was observed).
- Selected Sidebar contrast in dark reduced-motion is an unmet accessibility item.
- Pi conformance computer-tool step and sandbox Playwright path are environmental.
