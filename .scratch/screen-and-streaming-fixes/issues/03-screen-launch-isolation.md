# 03: Bot Screen launches leak host apps and steal other Surfaces' windows

Type: task
Status: resolved
Blocked by: None

**What to build:** Apps in a Bot Screen come only from the Bot Computer's own runtime. Each launch routes only its own windows to the launching Surface, and a launch whose window does not end up visible on that Surface does not report success.

## Evidence

Source: a Pi Bot's self-report while using the Bot Screen on 2026-11-02, re-checked by Claude Code. Line numbers refer to the installed runtime at `~/.local/share/omarchy-bot/runtime/current/apps/daemon/src/`, whose `modules/computer` matches `main`. Verify each claim before fixing it; the report has errors (see "Not in scope").

1. **Host apps reachable inside the Bot Screen.** The Bot Screen systemd units (compositor, session-bus, application, input) get the host's full `PATH` (`/usr/bin`, `~/.local/bin`, mise shims and so on). This can be seen in `systemctl --user list-units | grep omarchy-bot-screen`. The agent ran `swaymsg exec brave`, and the user's host Brave (and its profile under the screen's `config/BraveSoftware`) started inside the Bot Screen instead of the bundled Chrome for Testing. Check how `childEnv`/`PATH` is built in `apps/daemon/src/modules/computer/botComputer.ts` (around line 258) and the helper env in `botScreenWaylandHelpers.ts:465`.
2. **Launch claims any new window.** `#launchApplication` (`swayBotScreenRuntime.ts` around lines 991-1011) snapshots `before` = all application toplevels across **all** workspaces. It then moves every new toplevel to `session.workspaceName`. A window that appears for another Surface during the wait is stolen. The Pi report saw Brave windows jump between HEADLESS-1/2/3.
3. **False success.** The same function returns success both when it routed a window and when it timed out. It never re-reads the tree to confirm the window is on `session.workspaceName` and `visible`.
4. **Bot Desktop is hidden only on launch.** `hideBotDesktop` runs only inside `launch` (`swayBotScreenRuntime.ts` around lines 663-670). If `#launchApplication` throws, the full-screen floating Bot Desktop (`botComputer.ts:171` `floating enable`) is never hidden.
5. **Output geometry (verify first).** `OUTPUT_SLOT_WIDTH = 8_192` and `x: (outputIndex - 1) * OUTPUT_SLOT_WIDTH` (around lines 85 and 297-315). The Pi report saw `swaymsg -t get_outputs` with HEADLESS-1 and HEADLESS-4 both at x=0. Confirm whether the runtime asserts output positions after configuring them and whether `listWindows` rebasing uses the real `rect.x`. Fix only if confirmed.

## Required fix

- Bot Screen child processes get a minimal, explicit `PATH`: the bundled runtime `sway/bin`, the bundled browser directory, and only the system directories the runtime truly needs (justify each in a comment). Host user directories (`~/.local/bin`, mise shims/installs, `~/.cargo/bin`, `~/.lmstudio/bin` and so on) must not be included. Keep host-browser mode (`OMARCHY_BOT_BROWSER=host`, `hostBrowser.ts`) working by resolving the absolute path on the daemon side.
- `#launchApplication` only routes windows that belong to the launched process: match by `pid` of the toplevel being the spawned process or a descendant (read `/proc/<pid>/stat` ppid chain), or by another unambiguous marker. Windows from other processes are left alone.
- After routing, re-read the tree and require the window to be on `session.workspaceName`. On timeout or misplacement, report a failure (or an explicit warning result type, if the tool contract has one) instead of success.
- Run `hideBotDesktop` in a `finally` so it also runs when the launch fails.
- Item 5 only if confirmed, with the evidence recorded in Comments.

## Acceptance criteria

- [ ] A unit test for the env builder shows host user directories are absent from the Bot Screen `PATH`, and the bundled `sway/bin` is present.
- [ ] A unit test (fake sway IPC tree) shows a concurrently appearing foreign window is not moved, while the launched process's window is.
- [ ] A unit test shows that a launch whose window never appears on the Surface workspace reports failure.
- [ ] A unit test shows Bot Desktop is hidden even when the launch throws.
- [ ] Existing computer/sway tests and `bun run typecheck` pass. Where this repo has a private Bot Screen integration/conformance harness (see `.scratch/sway-bot-desktop-runtime/`), run the relevant subset and record the results.

## Not in scope

- The Pi report's `list_windows` returning `{"backend":"gnome-shell-introspect","windows":[]}` came from Pi's own computer-use tool. That string does not exist in this repo. Do not change anything for it.

## Constraints

- Host safety per `AGENTS.md`: never import, modify or terminate the user's running `omarchy-bot.service`, its Bot Screen units, or the host graphical session. Use private runtime dirs and targeted teardown in tests.

## Comments

### 2026-11-03 — implemented on `fix/03-screen-launch-isolation`

Branch/worktree: `fix/03-screen-launch-isolation` (this ticket file remains in the main checkout). Reviewer approved the final diff. Status set to `resolved`.

**What changed**

- **Minimal Screen PATH.** `explicitEnvironment` no longer copies the host `process.env.PATH`; the child PATH is the bundled runtime `bin` (prepended by `bundleEnvironment`), the resolved pack browser directory, and `/usr/bin:/bin` only (`botComputer.ts`, `botScreenWaylandHelpers.ts`). Host user dirs cannot reach the Screen. Host-browser mode still works: `hostBrowser.ts` resolves the absolute browser executable from the daemon's own PATH (including `env NAME=value` wrappers) before building the child env.
- **Pid-owned routing.** `#launchApplication` only moves windows that are new since the pre-launch snapshot, not already routed to any Surface, and owned by the launched leader (pid or descendant, with captured process-identity check). Non-browser `open_app` stays strict; shared browser launches (`open_url`, or `open_app` resolving to a browser executable) may claim exactly one unambiguous forwarded window; 0 or >1 candidates fail closed. Windows owned by another Surface are never moved.
- **Verified routing.** Claimed ids are re-read in a poll until the existing launch deadline and must be on `session.workspaceName` and `visible: true`; otherwise launch throws with a distinct reason (never appeared / not on workspace / not visible). Claimed windows are focused after routing (required on the bundled Sway 1.10.1, which keeps the tabbed container at 0x0 while the floating Bot Desktop holds focus).
- **Hide in `finally`.** `hideBotDesktop` runs on every path; a hide error no longer masks the original launch error.
- **Item 5 (output geometry): not changed.** Evidence: `#configureOutput` trusts `wlr-randr` exit status; `swayIpc` exposes no `get_outputs`; and `listWindows` rebases from the computed slot origin, not real `rect.x` — so the ticket's premise for 5c is false. Recorded per ticket instead of a speculative change.

**Verification** (worktree, private temp dirs; no host units/session touched)

- `bun test tests/integration/bot-computer.test.ts tests/integration/bot-screen-sway-runtime.test.ts tests/integration/bot-screen-sway-control.test.ts tests/integration/bot-screen-sway-cutover.test.ts tests/integration/bot-screen-runtime-contract.test.ts tests/integration/bot-screen-sway-layout.test.ts tests/integration/service-supervision.test.ts` → **84 pass, 5 skip, 0 fail**, 386 `expect()`, 89 tests / 7 files, 164 s. The 5 skips are `OMARCHY_BOT_REAL_SWAY`-gated.
- `bun run typecheck` → exit 0. `bun run lint:boundaries` → 3 pass, 0 fail.
- `OMARCHY_BOT_REAL_SWAY=1 bun test tests/integration/bot-screen-sway-layout.test.ts` → **1 pass, 0 fail**, 22 expects (bundled sway 1.10.1).
- Acceptance/routing tests each pass individually: PATH shape; foreign window not moved; missing window fails; hidden-on-workspace window fails; Bot Desktop hidden on throw; hide error does not mask launch error; shared-browser claim across Screens; forwarded no-window leaves the other window in place; forwarded one-window moves only it; `open_app` shared-browser forward; dead-leader pid not attributed; host bare command resolved to an absolute path; delayed-visible window succeeds.

**Conformance caveat (unverified end-to-end)**

`OMARCHY_BOT_REAL_SWAY=1 bun test tests/integration/bot-screen-sway-conformance.test.ts` is **not green**, but it now passes the launch/forwarding checks (two real Sway sessions, distinct apps/shared state, host-session isolation) and then aborts with `Bot Screen input requires the input lease`: a pre-existing harness drift at `bot-screen-sway-conformance.test.ts:111` calls `screens.act()` without the required third `send` argument (lease added in 3520375; call sites predate it). A diagnostic through the documented `agentToolAct` path reaches the next blocker — Unicode typing into ghostty on sway 1.10.1 (committed baseline used sway 1.12/alacritty). Not caused by this change; no conformance test edits are in the diff, and the tracked `.scratch/sway-bot-desktop-runtime/conformance-report.*` files were restored after each run. Real-Sway conformance remains red pending a harness update, and host-browser/Chromium reuse beyond fake-tree coverage remains unverified on this host.

**Host safety:** no `omarchy-bot.service`, Bot Screen unit, `systemctl --user`, or host graphical-session interaction; no package manager or system updates. Tests ran in `mkdtemp` runtime/profile roots; only process-local fixtures were created and cleaned up.
