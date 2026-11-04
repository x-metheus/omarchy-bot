# 06: Kill and relaunch the pack browser left over from a daemon restart

Type: task
Status: resolved
Blocked by: 04

The user decided on 2026-11-03: after the Service restarts while the pack browser survives (its CDP pipe cannot be reattached), stop that orphaned pack browser on startup or reattach. Tabs are lost, sign-ins persist, and the Browser Tool works on the next call.

Today (bug A5): `reattach` (`botComputer.ts` around 469) has no browser runtime. The Browser Tool launches `about:blank`, which hands off to the old pid through the singleton and exits. The new window is never claimed, so each call waits 30 s and leaves a stray window. Related problems:
- The anchor marker inherits fds 3 and 4 (`ownedProcesses.ts` around 183-193).
- The browser's stderr is ignored and the launch loop never notices an early exit, so a crash looks like a 30 s timeout (bug A4).

Scope: on reattach, find pack-browser processes (with the ticket 04 identity predicate) in the Bot Computer and stop them with targeted teardown. Close fds 3 and 4 in the anchor. Capture the browser's stderr tail, and fail the launch quickly with that reason when the process exits before a window appears. Tests use fake processes; never touch the user's real units.

## Comments

### 2026-11-03: scope addition from ticket 04 review

Ticket 04's shims, `BROWSER`, and the `mimeapps.list` launcher start the pack **without** `--remote-debugging-pipe` when no pack is running (for example `xdg-open` or `swaymsg exec brave` before any `open_url`). That pipe-less pack owns the profile's singleton, so the Browser Tool reports "CDP pipe closed" until its windows close. This is the same failure class as the restart orphan. Treat any pack process the daemon does not hold a pipe for as an orphan, and replace it with a piped launch, reopening the URLs it was asked to open where possible. The alternative is to have the launcher ask the daemon to open the URL. Pick one in the design pass.

### 2026-11-03: design settled (Claude Code), ready for implementation

Base: `main` at `1f16dd6` (tickets 01-05 merged; Browser Supply's `isPackBrowser` exists in `browserSupply.ts`).

- **Orphan definition:** a live process for which `BrowserSupply.isPackBrowser(pid)` is true, and which is not the pid tree of the pack launch whose CDP pipe the daemon currently holds.
- **When orphans are replaced:**
  - (a) In `BotComputerRuntime.reattach()` after a daemon restart, stop every orphan with targeted teardown (SIGTERM, grace, then SIGKILL). Match pack identity only; never touch other processes.
  - (b) Before `open_url` or the Browser Tool needs a piped pack while an orphan holds the profile singleton (for example one started by a shim, `xdg-open` or `mimeapps` while no pack was running), stop the orphan and launch a piped pack.
  - The orphan's tabs and URL are lost. That is accepted, because sign-ins live in the profile. The user decided "kill and relaunch cleanly".
- **Launch diagnostics (A4):**
  - Pipe the pack's stderr into a bounded ring buffer (last ~4 KiB) instead of `output: "ignore"`.
  - In the launch wait loop, if the launched process exits before a window is claimed, fail immediately with "The browser exited during startup (code/signal): <stderr tail>", not after the 30 s timeout.
- **fds:** the anchor marker in `supervision/ownedProcesses.ts` must not inherit fds 3 and 4 (the CDP pipe). Redirect or close everything above 2 so pipe EOF is observable.
- **Acceptance (tests with fake processes and fake Sway; never the user's units):**
  - Reattach with a surviving fake pack stops it and leaves non-pack processes alone.
  - A Browser Tool call while a pipe-less pack holds the singleton relaunches a piped pack and succeeds.
  - A pack that exits immediately with stderr "boom" fails the launch within about 1 s with "boom" in the message.
  - The anchor child has no fd 3 or 4.
  - The existing computer, browser and supervision suites pass, `bun run typecheck` and `lint:boundaries` pass, and the real browser-tool conformance passes (see the note below).
- **Real conformance note:** `.lane/dist/sway` is absent in the main checkout. Run real suites with the installed runtime used read-only: `OMARCHY_BOT_SWAY_BIN=~/.local/share/omarchy-bot/runtime/current/sway/bin/sway` (and the other `*_BIN` variables from the README pointing into the same `bin`), `OMARCHY_BOT_FONT_DIR=~/.local/share/omarchy-bot/runtime/current/fonts`, `OMARCHY_BOT_BROWSER_PACK_DIR=~/.local/share/omarchy-bot/runtime/browser`. These are read-only inputs; the suite runs its own private Sway.

### 2026-11-03: implemented (resolved)

Branch `fix/06-orphan-pack-browser-after-restart`, commit `93efb23` (base `1f16dd6`) —
681 insertions / 18 deletions across 9 files. Implemented the settled design as written.

**What changed**

- `apps/daemon/src/modules/computer/browserSupply.ts` — orphan predicate + targeted teardown.
  `orphanPacks()` = live, `isPackBrowser(pid)`, not inside a tracked launch's pid tree
  (`processDescendsFrom` with identity re-verification), and scoped to *this* Bot Computer by the
  pack executable plus `--user-data-dir` (current or legacy profile). Fails closed: unreadable
  `/proc`, unresolvable pack, or a foreign data dir means "not ours". `stopOrphanPacks(graceMs =
  2000)` does SIGTERM rounds, grace, then SIGKILL rounds, rescanning `/proc` between rounds, with
  identity re-checked immediately before every signal (pid recycling).
- `apps/daemon/src/modules/computer/botComputer.ts` — `reattach()` sweeps orphans right after
  `browser.prepare()` (ordering matters: `#packExecutable` must be resolved or the sweep is a
  silent no-op). Does not use `terminateRuntimeProcesses`, so there is no double-kill of the
  reattached generation.
- `apps/daemon/src/modules/computer/swayBotScreenRuntime.ts` — `#launchApplication` now calls
  `stopOrphanPacks()` before any piped launch (one seam covering both `open_url` and the Browser
  Tool `about:blank` path; `request_takeover` still short-circuits first). Fast-exit detection in
  the wait loop: `The browser exited during startup (code/signal): <stderr tail>`.
- `apps/daemon/src/modules/computer/botScreenWaylandHelpers.ts` — `OutputTail` (copied 4 KiB tail)
  and `captureStderr` on `spawnDetachedChild`; stdout and stderr are now separate stdio values, and
  all non-browser callers (sway, dbus, desktop, wayvnc) are behaviourally unchanged.
- `apps/daemon/src/supervision/ownedProcesses.ts` — `anchoredSessionCommand`: the backgrounded
  marker subshell closes every inherited fd above 2, so CDP pipe EOF is observable. The launched
  child is the foreground `exec "$@"` and keeps fds 3 and 4.

**One refinement beyond the design text (reviewed and accepted).** The design says fast-fail when
the child "exits before a window is claimed". A bare claim-gate is wrong: Chromium's documented
singleton handoff exits the forwarding child by design while the old pack keeps the pipe, which the
existing suite models ("forwarded open_url that creates no new window"). The fast-fail is therefore
additionally gated on this launch owning the Service's CDP pipe (`ownsBrowserPipe`). In the buggy
restart case, the orphan kill removes the pipe-less singleton owner first, so the child no longer
exits by handoff and the fast-fail does fire. No alternative design was invented; everything else
follows the settled text, including dropping ticket-04's "reopen the URLs where possible" (the
settled design accepts the URL loss).

**Verification (all with fake processes and fake Sway; nothing signalled the user's units)**

| Command | Result |
|---|---|
| `bun test` on the 19 in-scope computer/browser/supervision files | 180 pass / 5 skip / 0 fail (185 tests, 970 expects), 187 s |
| `bun test tests/integration/bot-screen-sway-*.test.ts` (all 8 sway suites) | 71 pass / 9 skip / 0 fail (80 tests), 121 s |
| `bun run typecheck` | pass, exit 0 |
| `bun run lint:boundaries` | 3 pass / 0 fail, exit 0 |
| `OMARCHY_BOT_REAL_PORTABLE_BROWSER=1` + `*_BIN`/`OMARCHY_BOT_FONT_DIR`/`OMARCHY_BOT_BROWSER_PACK_DIR` pointing into `~/.local/share/omarchy-bot/runtime/{current,browser}` (read-only), `bun test tests/integration/browser-real-conformance.test.ts` | 1 pass / 0 fail, 41 expects, 4.54 s |

Real conformance was genuinely real, not degraded to the fake: the run log shows
`(pass) real portable browser completes a form through Broker input and holds human takeover`, and
a read-only `/proc` snapshot during the run showed
`exe=/home/colin/.local/share/omarchy-bot/runtime/browser/chrome-linux64/chrome` with
`--user-data-dir=/tmp/omarchy-browser-real-*/profiles/computer/config/omarchy-bot-browser` and
`--remote-debugging-pipe`, plus two renderer children on the same private profile. The suite's own
hard gates passed (`pipeBrowserPid === browserPid`, `receipt == {name:"Ada",color:"blue"}`,
`webdriver === true`) and its teardown assertion confirmed no pack process survived. All 11
real-runtime paths existed before the run.

**New tests (each confirmed red before its implementation)**

- `a reattach stops the pack browser a restart left behind and leaves other processes alone`
  (`bot-computer.test.ts`) — broken `#heldPipeCovers`/sweep removal re-surfaces the failure; also
  asserts a bystander and a foreign-data-dir pack survive.
- `a browser tool call replaces the pipe-less pack that holds the profile singleton`
  (`bot-screen-sway-control.test.ts`).
- `a pack that exits during startup reports its stderr at once instead of waiting out the timeout`
  — "boom" in the message, resolves under 1 s.
- `a forwarding child that exits after the running pack claims its window is not a startup failure`
  — guards the `ownsBrowserPipe` gate.
- `a second open_url leaves the pack launched by the first one running` — guards the risky
  interaction the reviewer flagged: `stopOrphanPacks()` runs before *every* piped launch. With
  `#heldPipeCovers` forced to `false` this test fails with
  `kill() failed: ESRCH: No such process`, i.e. the Service's own live pack was swept.
- `the session anchor marker inherits no descriptor above stderr, so CDP pipe EOF is observable`
  — asserts the marker's `/proc/<pid>/fd` has nothing above 2.
- `a captured stderr keeps only its bounded tail and leaves stdout ignored` (`browser-pipe-spawn.test.ts`).
- `orphans are this Bot Computer's pack processes that no held pipe covers`,
  `stopping orphans ends a SIGTERM-resistant pack and leaves every other process alone`
  (`browser-supply.test.ts`).

**Unverified / caveats**

- The `OMARCHY_BOT_REAL_SWAY=1` suites (real pinned Sway: RFB banner, real WayVNC WebSocket,
  real-Sway isolation) were **not** run — outside this ticket's battery. They account for 5 of the
  skips in the in-scope run.
- The 3 `OMARCHY_BOT_SWAY_BUNDLE_DIR` bundle-conformance suites stay skipped (no installed bundle
  in the worktree); the remaining skip is the `OMARCHY_BOT_REAL_PORTABLE_BROWSER`-gated portable
  browser conformance, which was run separately as the real conformance above.
- Another agent ran the same sway-control file from the ticket-07 worktree concurrently; both use
  private temp roots so results are independent, but wall-clock timings may be slightly inflated.
- Process-name-independent only: the sweep never matches by name (ADR 0013). A pack whose `/proc`
  entry is unreadable is left alive by design (fail closed).
