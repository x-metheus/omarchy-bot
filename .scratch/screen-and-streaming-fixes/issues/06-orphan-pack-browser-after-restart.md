# 06: Kill and relaunch the pack browser left over from a daemon restart

Type: task
Status: open
Blocked by: 04

The user decided on 2026-11-03: after the Service restarts while the pack browser survives (its CDP pipe cannot be reattached), stop that orphaned pack browser on startup or reattach. Tabs are lost, sign-ins persist, and the Browser Tool works on the next call.

Today (bug A5): `reattach` (`botComputer.ts` around 469) has no browser runtime. The Browser Tool launches `about:blank`, which hands off to the old pid through the singleton and exits. The new window is never claimed, so each call waits 30 s and leaves a stray window. Related problems:
- The anchor marker inherits fds 3 and 4 (`ownedProcesses.ts` around 183-193).
- The browser's stderr is ignored and the launch loop never notices an early exit, so a crash looks like a 30 s timeout (bug A4).

Scope: on reattach, find pack-browser processes (with the ticket 04 identity predicate) in the Bot Computer and stop them with targeted teardown. Close fds 3 and 4 in the anchor. Capture the browser's stderr tail, and fail the launch quickly with that reason when the process exits before a window appears. Tests use fake processes; never touch the user's real units.

## Comments

### 2026-11-03: scope addition from ticket 04 review

Ticket 04's shims, `BROWSER`, and the `mimeapps.list` launcher start the pack **without** `--remote-debugging-pipe` when no pack is running (for example `xdg-open` or `swaymsg exec brave` before any `open_url`). That pipe-less pack owns the profile's singleton, so the Browser Tool reports "CDP pipe closed" until its windows close. This is the same failure class as the restart orphan. Treat any pack process the daemon does not hold a pipe for as an orphan, and replace it with a piped launch, reopening the URLs it was asked to open where possible. The alternative is to have the launcher ask the daemon to open the URL. Pick one in the design pass.
