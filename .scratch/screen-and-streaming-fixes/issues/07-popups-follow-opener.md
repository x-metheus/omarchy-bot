# 07: Pop-ups open on the opener Bot's own Screen

Type: task
Status: resolved
Blocked by: None (04 merged in main)

The user decided on 2026-11-03: a pop-up or new window opened by a page (`window.open`, an OAuth login) belongs to the Bot whose browser opened it, never to whichever Screen has focus.

Today (bug A6): nothing routes windows that appear outside a launch. A pop-up maps on the focused Screen, and that Screen's Browser Tool `#scope` (`browserRuntime.ts` around 229-249) can bind it as its own tab, so one Bot can read and act on another Bot's page. Bug A7: the ambiguous-ownership error tells the Agent to "give the page a unique title", which an Agent cannot do.

Scope (architecture candidate 3 in the review):
- Subscribe to Sway `window::new` events.
- Attribute new pack windows to a Screen via the CDP opener target (`Target.targetCreated` `openerId`) or the launch claim.
- Route them to that Screen's workspace.
- Keep one ownership registry shared by Sway routing and the Browser Tool.
- Replace the title-and-size heuristic described in ADR 0012. This needs an ADR 0012 amendment.
- Fix A7's message.

Design settled 2026-11-03; see the Comments section.

## Comments

### 2026-11-03: design settled (Claude Code), ready for implementation

Base: `main` at `1f16dd6`. The overriding invariant is the user's rule: **a pop-up belongs to the Bot whose page opened it, and another Bot's Browser Tool must never bind it.** When attribution is uncertain, fail closed: do not guess.

1. **Sway window events.** Add a subscription to `swayIpc.ts` (a second IPC connection; `SUBSCRIBE ["window"]`) and handle `window::new` for application toplevels where `BrowserSupply.isPackBrowser(pid)` is true and that are not yet in `#routedWindows` or claimed by a launch.
2. **CDP opener attribution.** On the shared pipe, enable `Target.setDiscoverTargets({discover:true})` and track `Target.targetCreated` / `targetInfoChanged` of type `page` with an `openerId`. When the opener target belongs to Screen X (via the existing `#owners` / `screen.windows` registry), record a pending pop-up for X with its targetId and creation time.
3. **Correlation.** Correlate a new pack window with a pending pop-up:
   - Use the newest unclaimed pending pop-up created within a short window (for example 5 s), and require exactly one candidate.
   - Confirm with `Browser.getWindowForTarget(targetId)` that the target sits in a window distinct from all known windows, and that the window count increased by one.
   - On a match, move the Sway window to X's workspace (same move and verify code as `#launchApplication`) and register the window and target as X's in the single ownership registry, so the Browser Tool on X sees it as a tab and no other Screen can.
   - With zero or several candidates, move the window to the Sway scratchpad and mark it **unowned**. An unowned window is never bound by any Screen's `#scope`.
4. **One registry.** Consolidate Sway routing ownership (`#routedWindows` / `#applicationOwners`) and Browser Tool ownership (`BR.#owners`) behind one small ownership module used by both. Keep the Element Ref / visibility rules of ADR 0012. Replace the title-and-size inference as the means to adopt windows that were not registered: windows now enter ownership only through launch claims or opener attribution.
5. **A7 message.** Replace "give the Screen browser a unique page title" with guidance the Agent can act on: "open the page with `browser tabs open` or `open_url` from this Screen".
6. **ADR.** Amend ADR 0012's ownership paragraph (and its Consequences bullet) to describe opener-attributed routing with the fail-closed scratchpad. Add a dated amendment note at the top.
7. **Acceptance (fake Sway with events, fake CDP; never the user's units):**
   - A pop-up opened from Screen A while Screen B has focus lands on A's workspace and appears in A's `tabs`, never in B's.
   - Two simultaneous pop-ups from A and B each land on their own Screen.
   - An ambiguous pop-up goes to the scratchpad, and neither Screen's `#scope` binds it.
   - A launched window is still claimed by its launch.
   - The A7 message is updated.
   - The existing computer and browser suites, `bun run typecheck` and `lint:boundaries` pass, and the real browser-tool conformance passes with the installed runtime used read-only, exactly as described in ticket 06's design note.

### 2026-11-03: recovery feasibility check — needs-info, simultaneous acceptance conflicts with settled correlation

STATUS: DESIGN_INFEASIBLE. Implementation stopped; this ticket is not resolved. The settled correlation rule at lines 30–33 requires exactly one pending target and mandates scratchpad/unowned for several candidates, while simultaneous acceptance at line 39 requires two pending pop-ups from A and B to land on their own Screens. The retained ADR 0012 amendment repeats the exactly-one/fail-closed rule (`docs/contexts/computer-control/adr/0012-agent-browser-control-over-cdp.md:9`). Satisfying both requires an approved design decision; neither serializing the test nor inventing a new discriminator resolves this contract as written.

Concrete identity evidence, all inspected read-only:

- `apps/daemon/src/modules/computer/browserSupply.ts:232–237` launches every Screen against the same private profile. `swayBotScreenRuntime.ts:1002–1008` adopts one live `BrowserRuntime` pipe and discards later forwarding-launch pipes. `browserRuntime.ts:163–168` requires exactly one `SystemInfo.getProcessInfo` browser pid; it does not expose a per-target browser pid.
- The actual pack version is Chrome for Testing 156.0.8078.47 (`botComputerAssets.ts:23,177`). Its version-specific [BrowserHandler source](https://github.com/chromium/chromium/blob/156.0.8078.47/chrome/browser/devtools/protocol/browser_handler.cc#L92), lines 92–126, shows `Browser.getWindowForTarget` returning `found_browser->GetSessionID().id()` at line 124 and bounds at line 125. This is a Chromium session window id, not a Sway container id. The public CDP schema likewise returns only `windowId` and `bounds`; `TargetInfo.openerId` identifies the opener target, and `SystemInfo.ProcessInfo` contains type/id/cpuTime with no target/window mapping.
- That Chromium version's [Wayland Ozone source](https://github.com/chromium/chromium/blob/156.0.8078.47/ui/ozone/platform/wayland/ozone_platform_wayland.cc#L143), lines 143–147 and 262, creates each platform window with the same `connection_`. Pinned Sway 1.10.1 obtains an xdg-shell view's pid from that Wayland client's credentials ([tree/view.c:508–514](https://github.com/swaywm/sway/blob/1.10.1/sway/tree/view.c#L508)), then reports it as IPC `pid` ([ipc-json.c:573–574](https://github.com/swaywm/sway/blob/1.10.1/sway/ipc-json.c#L573)). Both pop-up toplevels share browser-client process identity. Renderer processes do not supply a join to these Sway toplevels.
- Locally, `swayIpc.ts:209–225,256–278` decodes Sway container identity/pid and ordinary window metadata; no CDP target or Chromium session window id is present. `swayBotScreenRuntime.ts:1217–1222` correctly refuses to select a target when two pending pop-ups exist. Even querying both CDP window ids would not identify which Sway container carries which id. With a common pre-pop-up snapshot, two new CDP windows also increase the count by two, not the required one.

Focused reproducer (existing retained test; no implementation or test edits):

`bun test tests/integration/bot-screen-sway-popups.test.ts -t 'two simultaneous pop-ups share one pack browser process and cannot be attributed'`

Result: **1 pass / 0 fail / 0 skip, 14 filtered out, 7 assertions** (806 ms). `bot-screen-sway-popups.test.ts:940–974` records both pending targets before either Sway event, maps both windows, verifies both scratchpad commands, verifies both pop-ups and both launched windows share one browser pid, and checks neither Screen's tabs contain either pop-up. This passes the fail-closed rule and demonstrates failure of the simultaneous-routing acceptance; it is not an acceptance success. The preceding two-Screen routing test at lines 717–752 is sequential and cannot satisfy simultaneous acceptance. `git diff --check` also passed.

Retained state was inspected in full after the interruption: branch `fix/07-popups-follow-opener`, eight tracked modified files (+759/−170) and three untracked files, no staged files. Retained tracked paths: `apps/daemon/src/modules/computer/{botComputer,browserRuntime,swayBotScreenRuntime,swayIpc}.ts`, `docs/contexts/computer-control/adr/0012-agent-browser-control-over-cdp.md`, `tests/integration/{browser-real-conformance,browser-runtime}.test.ts`, `tests/integration/helpers/fakeSwayIpc.ts`. Untracked: `apps/daemon/src/modules/computer/windowOwnership.ts`, `tests/integration/bot-screen-sway-popups.test.ts`, `tests/unit/window-ownership.test.ts`. All retained edits are preserved; this recovery changed no worktree source, tests, or ADR.

Partial fixes already present include removal of Browser Tool's second auto-launch pairing, launch `pendingBinding`, inner event-handler catch, closed-subscription reopening on start/reconcile, and tentative fresh-window confirmation/attribution retries. They are not accepted as complete: fresh-window confirmation counts only unowned additions, opener attribution is not tied to Screen cancellation and stable attribution waits remain questionable, popup routing still focuses the workspace/window, and scratchpad failure only logs without retry. Full targeted computer/browser validation, typecheck, lint:boundaries, and real-browser conformance were not run in this recovery. Prior review findings and the remaining acceptance mapping are recorded in the managed recovery artifact. No real browser, host graphical session, installed-runtime writes, user services, staging, or commits were used.

### 2026-11-03: recovery evidence supplement

Line-reference correction to the preceding recovery entry: the sequential two-Screen test begins at `tests/integration/bot-screen-sway-popups.test.ts:742`; its explicit sole-pending assumption is at lines 746–747. The earlier `717–752` citation included the retry test and only the start of that sequential test.

A second focused check ran with `bun -` (stdin TypeScript, no repository writes) using the actual `CdpPipe`, `BrowserRuntime`, `WindowOwnership`, and Sway decoder, with in-memory fake CDP streams. It delivered both target events before any Sway window and awaited `ownership.pendingPopups().length === 2` directly, eliminating the retained fixture helper's timing uncertainty. **8 assertions passed**: pending owners A/B, shared browser pid 1234 on Sway ids 40/41, two distinct CDP windows 703/704, both common-snapshot confirmations undefined, and neither popup registered. This independently establishes actual simultaneous pending state. The exact script and output are retained in the managed recovery report at `/home/colin/.pi/agent/sessions/--home-colin-storage-Projects-omarchy-bot-worktrees-fix-07-popups-follow-opener--/subagent-artifacts/outputs/7287cf6f-8302-4f9f-94b9-59de626af494/ticket07/recovery.md`.

### 2026-11-03: design revised with the user — title-stamp attribution (supersedes the correlation rule in step 3 and acceptance (ii)'s wording)

Decided by the user after the needs-info report above. Everything not listed here stays as settled (one registry, A7 message, ADR amendment, fail-closed scratchpad, host safety).

1. **Browser model unchanged.** All Bots share one pack browser and one profile (ADR 0013). Each Bot owns its own windows on its own Screen. No per-Bot browser.
2. **Every new pack window is attributed by a title stamp, not by timing.** On Sway `window::new` for a pack-browser toplevel that no Screen owns yet:
   - Park it in the scratchpad immediately (never visible on any Screen while unattributed).
   - For each candidate CDP page target that is awaiting a window (a pop-up recorded via `openerId`, a launch from `open_url`/`tabs open`, or a window opened during human takeover), set a unique nonce title via CDP (`Runtime.evaluate` `document.title = nonce`, restoring the original title afterwards).
   - Match the Sway container whose title becomes that nonce (Sway `window::title` events or a re-read of the tree). Candidates can be stamped one after another or with distinct nonces at once; either way the match is exact.
   - On a match: restore the real title, move the window to the owner's workspace (same move-and-verify as `#launchApplication`, without stealing seat focus), and register window + target in the single ownership registry.
   - If no stamp is observed within ~2 s (page reset the title, target gone, Sway hiccup), retry once, then leave the window parked and **unowned**, and return a clear retryable error to the Bot that was waiting for it. An unowned window is never bound by any Screen's `#scope`.
   - Remove the "exactly one pending pop-up within 5 s" rule and the window-count check; they are replaced by the stamp.
3. **Owners.**
   - Pop-up: the Screen that owns the opener target (`openerId`).
   - `open_url` / `tabs open` / new window from a Bot: that Bot's Screen (launch claims go through the same stamp path).
   - Window opened while the user controls a Bot Screen (human takeover via that Bot's remote view): the Screen whose input lease the user holds. The takeover always comes from a specific Bot's remote view, so the owner is always known.
   - No opener, no pending launch, no active human takeover: stays parked and unowned.
4. **Acceptance (replaces the list in the settled design; fake Sway with window and title events, fake CDP; never the user's units):**
   - A pop-up opened from Screen A while Screen B has focus lands on A and appears only in A's `tabs`.
   - Two pop-ups opened at the same moment from A and B each land on their own Screen (no serialization in the test; both pending before either Sway event).
   - A page that refuses the stamp leaves its window parked, unowned, unbound by any `#scope`, and the waiting Bot gets the retryable error.
   - A Bot launch (`open_url`) is claimed through the stamp; a window opened during human takeover of A goes to A; a window with no owner stays parked.
   - The real title is restored after attribution.
   - Reviewer findings still open from the first review: nit 4 (event tail catch), 5 (resubscribe), 6 (no seat focus), 7 (signal/deadline on opener lookup), 8 (ADR process-identity sentence), 10 (`#scope` restricted to registered windows), 11 (scratchpad failure surfaced) — fix them.
   - Existing computer and browser suites, `bun run typecheck`, `lint:boundaries`, and the real browser-tool conformance with the installed runtime read-only pass.
5. **ADR 0012** amendment describes title-stamp attribution with the fail-closed park, replacing the opener-timing correlation text already drafted in the worktree.

### 2026-11-03 UTC (2026-11-04 +08:00): implemented, reviewed, verified and committed (resolved)

Parent personally committed **`e3e355536c8fc6206c61126a76e91ca959790179`** on branch `fix/07-popups-follow-opener`, base `1f16dd66276c06e85110d293a22a5229fdacc3b0`. Commit contains exactly the 22 reviewed source/test/documentation files (+4,105 / -318). Fresh full-diff review after the native-title correction: **STATUS: APPROVED; no issues found**. Parent accepted ticket-specific verification with the demonstrated baseline/external full-suite limits below; this is not a whole-suite-green claim. No merge or push performed.

Final behavior implements the latest **title-stamp attribution** decision above, superseding the historical count/unique-candidate correlation. Every newly mapped, unowned pack-browser window is immediately parked and verified in scratchpad. Launch claims, opener-owned popups and authoritative human takeover supply the owning Screen; a nonce document-title stamp joins the CDP target to the eligible parked native window. One shared ownership registry drives routing and registered-only Browser Tool scope. Native title matching permits only full equality to the complete nonce or complete nonce plus exactly ` - Google Chrome for Testing`; document writes and conditional restoration keep the bare exact nonce. Other branding, prefixes, suffixes and partial matches remain rejected. Original page titles are restored, attribution moves do not steal seat focus, overlapping A/B popups route independently, and uncertain/refusing windows remain parked/unowned with retryable failure after the bounded retry. Launch binding, cancellation, opener deadlines, subscription recovery, handled event tails, surfaced parking errors, input authority and A7 actionable guidance are preserved. ADR 0012 documents this design.

Verified source SHA-256: `426686adf6ef4f68ae6e15b557299bea00b109de6b02cd93c47d6f005634e6e4`, 944 discoverable files. Sorted/deduplicated `git ls-files -z --cached --others --exclude-standard` paths are recorded as per-file SHA-256 + two spaces + relative path + newline, then the manifest is SHA-256 hashed. The original passing targeted manifest, final verification manifest and parent's pre-staging fingerprint match exactly.

| Gate | Executed result |
| --- | --- |
| Exact 17-file targeted battery below, including `bot-computer.test.ts` | **253 pass / 4 gated skip / 0 fail**, 1,417 assertions, 257 tests across 17 files, 153.45 s; matching-source prior pass reused |
| Fresh `bun run typecheck` | **exit 0**, 6.976 s |
| Fresh `bun run lint:boundaries` | **3 pass / 0 fail**, 4 assertions, exit 0 |
| Fresh exact ticket06 real Browser Tool command below | **1 pass / 0 fail**, 42 assertions, 3.36 s, exit 0 |
| Latest complete full-suite execution below | **1,028 pass / 24 skip / 5 fail / 0 module-load errors**, 6,518 assertions, 1,057 tests across 134 files, 474.51 s, exit 1 |
| Exact Pi wrapper on temporary original-HEAD archive | **2 pass / 1 fail**, 25 assertions; nested steps **0 pass / 1 skip / 1 fail**, 6 assertions, same step-2 assertion |
| Installer current/original host-network comparison | Both **50 pass / same 4 fail**, 464 assertions |
| Same four installer cases in private network namespaces, current/original | Both **4 pass / 0 fail**, 50 filtered, 11 assertions; default-port 7321 assertions preserved |

Exact targeted command:

```bash
bun test tests/unit/browser-window-attribution.test.ts tests/unit/window-ownership.test.ts tests/integration/bot-screen-sway-popups.test.ts tests/integration/browser-runtime.test.ts tests/integration/bot-screen-sway-control.test.ts tests/integration/bot-screen-sway-runtime.test.ts tests/integration/bot-screen-sway-cutover.test.ts tests/integration/bot-screen-sway-projection.test.ts tests/integration/browser-supply.test.ts tests/integration/browser-cdp.test.ts tests/integration/browser-pack.test.ts tests/integration/browser-pipe-spawn.test.ts tests/integration/browser-tool.test.ts tests/integration/agent-browser-tool.test.ts tests/integration/computer.test.ts tests/integration/screen-input-lease.test.ts tests/integration/bot-computer.test.ts
```

Fresh required checks, including the exact installed-runtime real command:

```bash
bun run typecheck
bun run lint:boundaries
OMARCHY_BOT_SWAY_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/sway \
OMARCHY_BOT_SWAYMSG_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/swaymsg \
OMARCHY_BOT_WLR_RANDR_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/wlr-randr \
OMARCHY_BOT_WAYVNC_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/wayvnc \
OMARCHY_BOT_GRIM_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/grim \
OMARCHY_BOT_DBUS_DAEMON_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/dbus-daemon \
OMARCHY_BOT_INPUT_HELPER_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/omarchy-bot-wayland-input \
OMARCHY_BOT_CAPTURE_HELPER_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/omarchy-bot-wayland-capture \
OMARCHY_BOT_DESKTOP_BIN=/home/colin/.local/share/omarchy-bot/runtime/current/sway/bin/omarchy-bot-desktop \
OMARCHY_BOT_REAL_PORTABLE_BROWSER=1 \
OMARCHY_BOT_FONT_DIR=/home/colin/.local/share/omarchy-bot/runtime/current/fonts \
OMARCHY_BOT_BROWSER_PACK_DIR=/home/colin/.local/share/omarchy-bot/runtime/browser \
bun test tests/integration/browser-real-conformance.test.ts
```

All nine `*_BIN` inputs are installed `runtime/current/sway/bin` executables; fonts and browser use installed directories read-only. The real suite creates its own private Sway/runtime/profile/home and performs targeted child teardown. All 963 installed-runtime content records still match, and the final private browser/compositor survivor scan is empty. No host browser, session, service/unit/process or localhost listener was modified/stopped. No host/global install/update, installed-runtime write, credential/model/network setting change, staging or commit by the verification worker occurred. Parent used a normal commit without bypassing hooks. `git diff --check` passed, staging was empty before handoff, and the committed feature worktree was clean.

Preserved exact latest full-suite command:

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.lane/playwright" bun test
```

**Full-suite limitations and proven provenance (all five failures):**

- Four installer default-port tests (`default listener settings survive install reuse, update, and reconfigure`; `legacy empty listener defaults allow install`, `update`, `reconfigure`) fail identically on current and temporary original HEAD: 50 pass / 4 fail with ENOENT reading each fixture's private pairing-host-secret. The relevant installer test/CLI/listener files are outside the ticket delta and byte-identical to original HEAD. Host `127.0.0.1:7321` remained occupied by bun PID 1385. To test interference without touching it, both trees ran the exact unmodified four cases with a fresh unprivileged private network and nested user namespace: `unshare --user --map-root-user --net sh -c 'ip link set lo up && exec unshare --user --map-user=1000 --map-group=1000 "$@"' sh bun test tests/integration/service-install.test.ts -t 'default listener settings survive|legacy empty listener defaults allow'`. Both passed 4/4 with default 7321 assertions intact. This demonstrates host-port interference, not a ticket regression. An earlier private-root namespace setup attempt hit the installer's expected root refusal; that failed setup evidence is retained.
- Pi step 2 at `tests/conformance/pi.steps.ts:225` expects `CONFORM-STREAM-OK` but receives an empty streamed reply. The unmodified `bun test tests/conformance/pi.test.ts` reproduced the exact scenario on temporary original HEAD. Call-through diagnostics on current and original native sessions both expose **HTTP 410 `ModelDeprecated` for configured `opencode-go/kimi-k2.6`**, provider message `Model kimi-k2.6 has been deprecated. Use kimi-k2.7-code instead.` Both native assistant messages have stopReason `error`, no content and text length 0; only `turn.completed` reaches normalized events. No model was switched and no fake response or test alteration used. Baseline archive source entries were checked against original HEAD; every workspace dependency was redirected into the archive, sharing only external cached dependencies and read-only runtime assets, with no current application bundles/source through symlinks. Temporary snapshots and private conformance homes were removed. This failure is demonstrated pre-existing/external; **Pi steps 3 onward and later model-driven browser conformance remain unverified**.

The full suite remains an executed failure; the isolated installer passes and classified Pi refusal do not relabel it green. Source and full-suite environment were unchanged, so no redundant complete rerun was performed. Earlier full execution evidence (including prerequisite/environment failures later corrected) remains in the saved reports. The required independent real Browser Tool form/scope/takeover scenario passes. Simultaneous live page-created popups are not independently exercised there; their evidence is the passing overlapping fake-Sway/fake-CDP acceptance suite and approved code review.

Detailed persistent report, exact argv/environment/log manifests, source proofs and diagnostic results: `/home/colin/storage/Projects/omarchy-bot-worktrees/fix-07-popups-follow-opener/node_modules/.cache/omarchy-bot-ticket07/final-provenance-and-result.md`. Earlier evidence remains in `verification-fix-1.md`, `verification-1.md`, `review-3.md`, and approved `post-decoration-review-1.md` alongside it. No other main-checkout file was changed by this result append; all prior ticket design/history comments are preserved.
