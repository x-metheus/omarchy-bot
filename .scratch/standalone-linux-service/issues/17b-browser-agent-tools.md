# 17b: Agent-native browser control over CDP

**What to build:** Agents control the Bot Screen's browser through its structure, not only through pixels. The daemon launches the pack browser (17) with `--remote-debugging-pipe`. Through that private pipe it exposes a `browser` tool next to `computer`, which works on the page's accessibility tree:

- `snapshot` returns the tree with stable element refs.
- `click`, `type` and `select` act on a ref.
- `navigate`, `read_text`, `tabs` and `wait_for` cover pages, tabs and waiting.

The browser stays a visible window on the Bot Screen, so users watch and take over as they do today. Screenshots and raw input remain the fallback for content the tree doesn't cover, such as canvases and challenges. When a page shows a CAPTCHA, an anti-bot challenge or a login, the Agent asks the user to take over instead of trying to defeat it.

**Blocked by:** 17

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] The daemon launches the pack browser with `--remote-debugging-pipe` and a private profile per Bot Computer, which stays the shared profile of Computer ADR 0009. No TCP debugging port is ever opened, and a test asserts that no listening socket appears. Teardown is targeted to that browser's process tree.
- [x] Launching adds no automation signal beyond what the pipe implies: a real window, no automation flags, and no CDP `Runtime.enable` on page targets. `navigator.webdriver` is true because Chromium sets it for `--remote-debugging-pipe`, and the Service does not hide it (revised 2026-10-28, see Comments). Page scripts run only in isolated worlds. A conformance test checks these from inside a page.
- [x] A `browser` tool contract lives in `packages/agent-contract` beside `computer-tool.ts`, with these actions:
  - `snapshot` returns the accessibility tree, with refs, roles, names, values and states, trimmed to a size limit.
  - `click`, `type` and `select` act on a ref.
  - `navigate`, `back`, `read_text`, `tabs` (list, open, switch, close) and `wait_for` (text, ref or navigation, with a timeout).

  A stale ref fails with a message telling the Agent to take a new snapshot.
- [x] `click` and `type` are delivered as real input at the element's on-screen position through the daemon's existing input path (Computer ADR 0010), not as script `.click()`/value assignment. They are scrolled into view first.
- [x] Every `browser` action goes through the Computer Broker under the same per-Screen arbitration and Takeover rules as `computer` (ADR 0003). A user Takeover holds a pending `browser` call exactly as it holds a `computer` call.
- [x] Agent-requested takeover: a `request_takeover` action, with a reason shown in Web Control, holds the invocation until the user selects "I'm done". It then returns a fresh snapshot. The tool description tells Agents to use it for CAPTCHAs, anti-bot challenges, logins and payment. A Bot must never try to solve or bypass a challenge.
- [x] The pi worker and the scripted workers expose the tool, and the real-model pi conformance gains a step: open a local fixture page, snapshot it, fill a form by ref and read the result back.
- [x] README, the computer-control CONTEXT glossary (Browser Tool, Element Ref) and a new Computer ADR record the decision: one pinned Chromium driven over a CDP pipe, structure first with pixels as the fallback, and challenges handed to the user rather than evaded.

## Comments

### 2026-10-27 — why this ticket exists

Split from 17 at the user's direction. Host Chrome and Firefox aren't agent-native browsers. The "AI browsers" (Atlas, Comet, Dia) are Chromium driven through the DevTools Protocol plus an accessibility-tree layer, so this ticket builds that layer on the pack browser. A headless agent browser such as Lightpanda was ruled out as the default because it can't appear on the Bot Screen. It could still come later as a separate background tool.

Known limits to carry into the ADR:
- Sites can still challenge or block the Bot. IP reputation, which datacenter or VPS hosts make worse, is often the main factor, and some sites block agents as a policy.
- Firefox is out of scope because it removed CDP and offers only WebDriver BiDi.

### 2026-10-28 — implementation notes (validation pending)

Status remains open as of this review note; its pending-run list and acceptance status are superseded by the final evidence comment at the end of the ticket. A late ownership security fix now rechecks a target whose `Browser.getWindowForTarget` failed and refuses a still-live target before binding, because skipping it could hide an equal-title contender and adopt a window from another Screen; a just-destroyed target remains an allowed race. Its regression test went red before the fix and green after. Security review independently accepted the final live-target ownership guard and withdrew the equal-window finding, reporting no established exploitable issue in the reviewed paths; that security sign-off does not satisfy the still-open acceptance boxes. Final focused suites after that guard (artifact 174, superseding the earlier 34/190 and separate Orders run): 37 pass / 203 assertions in 5.03 s. Final post-guard real smoke (artifact 176, superseding artifact 163): 41 assertions in 3.20 s, where the sole failure is the existing line 259 `navigator.webdriver` assertion (expected `false`, actual `true`); every changed ownership, geometry, selected-tab, full-text `wait_for`, and targeted-teardown assertion passed. The implementer reports no further code edits. Before the review fixes, the implementer also reported a live local pack form passing every browser action with no TCP listener and the real-model Pi browser-only step passing (child: 1 pass, 1 skip, 11 assertions, 46.85 s; private wrapper: 3 pass, 25 assertions, 47.15 s; private fixture HOME removed); no post-review Pi re-run is recorded. Criterion 2 remains blocked by the webdriver result; the smoke run is recorded red only at that assertion. No full 11-step real-model run, full suite, typecheck, e2e, or lint is recorded.

**Shape.** The pack Chromium launched by `open_url` now carries `--remote-debugging-pipe`. The daemon adopts the launched child's fd 3 (commands) and fd 4 (replies) as NUL-delimited JSON over an inherited socket pair, and no TCP debugging port is opened. `apps/daemon/src/modules/computer/cdpPipe.ts` is the transport, `browserRuntime.ts` owns target/element authority per routed Screen, and `packages/agent-contract/src/browser-tool.ts` plus `packages/domain/src/browser.ts` define the contract: `snapshot`, `click`, `type`, `select`, `navigate`, `back`, `read_text`, `tabs`, `wait_for`, `request_takeover`.

**Launch and ownership.** The pack browser keeps the shared Bot Computer profile (`profileDir/config/chromium`). Because `systemd-run --pipe` cannot forward the extra descriptors, a pack browser with the pipe is spawned as a directly owned-session child (`owned: true`) with two extra stdio sockets and the private child environment, even when `ApplicationUnits` is enabled; `applicationProcesses` and the existing targeted owned-child teardown still stop its process tree. Ordinary applications keep the previous unit/owned behavior.

**Screen scope.** Each Surface gets its own window/tab/ref registry and may own multiple routed browser windows; `tabs` list, switch, and close span all of them. An auto-launch by the browser tool registers the new target and its routed Sway window directly. Otherwise a window is eligible only when its Sway-reported PID equals the private pipe's `SystemInfo.getProcessInfo` browser PID, and adoption still needs a unique title and matching dimensions before it is pinned by Chromium and Sway window ids; ambiguous matches fail closed. If `Browser.getWindowForTarget` fails for a target, the target is rechecked: a still-live target rejects ownership before any binding, because silently skipping it could hide an equal-title contender and adopt a window from another Screen, while a target that has just been destroyed is allowed as a race with its own teardown. Wayland Chromium reports global window `left`/`top` as 0, so output position is never used. The selected tab is read from each candidate tab's isolated-world `document.visibilityState`, and an unclear selection fails closed instead of guessing. Refs are `e<N>` and invalidated by the next snapshot, navigation/document replacement, tab switch, or target detach; a stale ref fails with `Stale or missing Element Ref <ref>; take a new snapshot before acting`.

**Structure and input.** `snapshot` reads `Accessibility.getFullAXTree`, trims to 300 nodes / 16 KiB, includes role, name, value and selected AX states, and reports truncation; `read_text` is capped at 8 KiB. `wait_for` text matches against the full page text as a condition without returning it, so that search is not bound by the `read_text` cap. The Pi tool appends a truncation warning when a result omitted content. `click`, `type`, and `select` resolve a ref, focus the routed window, `DOM.scrollIntoViewIfNeeded`, wait one frame, map the box model center through the routed window bounds and the page's inner viewport (`innerWidth`/`innerHeight`, including scrollbar gutters), and deliver real input through the existing `BotScreenManager`/lease/input path; `type` follows a real click, and `select` accepts a single native `select` and uses `Home`, `Down` × N, `Enter`. No page `.click()` or value assignment is used.

**Neutrality — blocked, criterion not met.** The launch flag set gains only `--remote-debugging-pipe`; no automation flags are added, `Runtime.enable` is never sent, and all page script runs through `Page.createIsolatedWorld` with `Runtime.callFunctionOn`/`Runtime.evaluate` bound to that context. No document-start script is registered. However, the pinned Chrome for Testing build reports `navigator.webdriver === true` on a real page when launched with `--remote-debugging-pipe`, before any CDP client attaches: Chromium 156 hardcodes the automation-controlled feature for that switch in `content/child/runtime_features.cc` ([source](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/content/child/runtime_features.cc#343), crbug 40746300). No spoof, launch-flag workaround, feature override, or `navigator.webdriver` patch was added, because hiding the value would be an anti-bot evasion and outside this ticket. The conformance assertion for `navigator.webdriver === false` is therefore expected to fail, and the second acceptance bullet stays unchecked until a genuinely neutral drive path exists (or the requirement is explicitly revised). The live form path (real type, select, click, and receipt read-back) passed before the review fixes and is being re-run with them.

**Broker and Takeover.** All browser actions go through `ComputerBroker.agentBrowserAct`, which reuses the per-Surface serialization, pending tool, lease, and Takeover hold of `computer`. `request_takeover` requires a non-empty reason of at most 200 characters; it preflights that the Screen runtime is ready and fails a host-browser opt-in with the same actionable error before anything is held, and it does not require an open browser window. It then becomes pending without navigating or touching the page, sets `takeoverReason` on the Broker state and `ComputerViewDto`, and holds until the user selects “I'm done”; the call then resolves with a fresh `snapshot`. `computerView` reports `needs-you` while the reason is pending and no Web Control is active; the Computer Surface and Web Control render the reason as text, and it clears when the request settles. The tool description instructs Agents to use `request_takeover` for CAPTCHAs, anti-bot challenges, logins, and payment and never to solve or bypass them.

**Host override.** `OMARCHY_BOT_BROWSER=host` with a usable native browser keeps `computer` launch and pixels but the browser tool fails with `Browser tool unavailable: the host browser has no owned CDP pipe. Use the pack browser or computer tools.` An opt-in that falls back to the pack (no usable native browser) uses the pipe path.

**Exposure.** `browser` is in `STATIC_TOOLS`, dispatched by `TurnService.#runBrowser` with the same Turn/bot/Surface binding checks as `computer`. The Pi worker registers it sequentially through `workers/pi/src/browser-tool.ts`; the scripted fake worker accepts `browser:<action>:...` directives.

**Docs.** `README.md` (pack paragraph, product-model bullet, browser-tool conformance commands), the Computer Control CONTEXT glossary (Browser Tool, Element Ref), and Computer ADR 0012 (`docs/contexts/computer-control/adr/0012-agent-browser-control-over-cdp.md`) record the decision, the pipe/owned-child launch choice, the host-opt-in limit, and the webdriver blocker. All acceptance boxes remain unchecked and Status stays open.

**Tests added (not yet run by the documentation slice).** `tests/integration/browser-tool.test.ts`, `browser-cdp.test.ts`, `browser-pipe-spawn.test.ts`, `browser-runtime.test.ts`, `agent-browser-tool.test.ts`, `computer-takeover-view.test.ts`, `browser-real-conformance.test.ts`, and `tests/conformance/pi-browser-tool.test.ts`; plus extensions to `bot-screen-sway-control.test.ts` (pack argv with the pipe, host-browser error), `tests/conformance/pi.steps.ts` (step 11 form-by-ref with a loopback fixture and private HOME), and `tests/e2e/specs/10-computer-sheet.spec.ts` (`needs-you` and reason text). The real browser test asserts the page-side `navigator.webdriver`, no TCP listener owned by the browser process tree, real-input form submission and receipt, per-Screen tab isolation, a stale-ref failure, and an agent-requested Takeover cycle; the Pi step asserts `navigate`, `snapshot`, `type`, `click`, `read_text` through the real model and fixture submissions.

**Testing instructions.** Focused suites:

```bash
bun test tests/integration/browser-tool.test.ts tests/integration/browser-cdp.test.ts \
  tests/integration/browser-pipe-spawn.test.ts tests/integration/browser-runtime.test.ts \
  tests/integration/agent-browser-tool.test.ts tests/integration/computer-takeover-view.test.ts
```

Real pack tests need `OMARCHY_BOT_REAL_PORTABLE_BROWSER=1` plus prepared `OMARCHY_BOT_SWAY_BUNDLE_DIR`/`OMARCHY_BOT_SWAY_BIN` and the other Sway binary overrides, `OMARCHY_BOT_FONT_DIR`, and `OMARCHY_BOT_BROWSER_PACK_DIR`; see README “Useful checks”:

```bash
bun test tests/integration/browser-real-conformance.test.ts
```

The real-model Pi step runs inside `bun test tests/conformance/pi.test.ts`, which creates a private fixture `HOME`/XDG home and needs the same three prepared assets.

**Unverified / open.** The anti-bot neutrality bullet is blocked by the measured `navigator.webdriver === true` above; the final post-guard real smoke fails only there. Also unverified: coordinate mapping beyond the exercised 20 px scrollbar/zoom fixture and a second device scale or output, Chromium singleton behavior on repeated `open_url`, daemon-restart pipe loss, a post-review real-model Pi run and the single full 11-step run, and the full suite/typecheck/e2e/lint. `browserRuntime` adopts only windows whose Sway PID matches the pipe's browser PID and then requires a unique title and matching dimensions, and it fails closed when the selected tab is not uniquely visible, so identical windows or ambiguous tab visibility are refused rather than guessed. Sites can still block the Bot for IP-reputation or policy reasons. Acceptance remains unchecked and Status open pending the remaining runs and review.

### 2026-10-28 — final evidence, review dispositions and acceptance

This comment supersedes the “validation pending” and “unverified” lists in the implementation-notes comment above. All seven review findings were fixed and re-review cleared, including the final ownership lookup guard (`ReviewFinalOwnershipGuard` clears). The security reviewer withdrew the equal-window “Orders” finding after confirming the global ambiguity path already fails closed, and accepted the final live-target ownership guard with no established exploitable issue in the reviewed paths. Acceptance boxes were checked only where the listed subconditions were observed; the anti-bot neutrality box stays unchecked.

**Final fixes behind the checked boxes.**

- Cross-Screen adoption through an unrelated window title is blocked: a window is eligible only when its Sway PID equals the pipe’s `SystemInfo.getProcessInfo` browser PID, and foreign tabs remain inaccessible.
- A duplicate-title window no longer keeps a stale active tab: each candidate tab’s isolated-world `document.visibilityState` resolves the selection, refs are invalidated, and unclear selection fails closed.
- Coordinate mapping uses scrollbar-inclusive inner-viewport geometry. Normal and native-keyboard-zoom runs clicked within 1 px of the control with a forced 20 px scrollbar and a 12 px control.
- `wait_for` evaluates text against the full page text in an isolated world, so matches beyond the 8 KiB `read_text` cap succeed while `read_text` and `snapshot` stay capped.
- Truncation is model-visible: the Pi result carries the omission notice instead of silently dropping content.
- `request_takeover` checks Screen-runtime readiness and the host-browser opt-in before holding; an unavailable Screen or host browser fails immediately with the actionable error instead of hanging.
- If `Browser.getWindowForTarget` fails for a target, a still-live target now rejects ownership before any binding, closing the reproduced ambiguity hole where a skipped live contender allowed another Screen’s window to be adopted; a just-destroyed target is still allowed as a teardown race. The regression failed before the fix and passed after it.

**Verification evidence.**

- Focused runtime/Broker/Pi suites after the last production edit: **37 passed, 203 assertions**, 5.03 s (`artifact://174`). Host-adapter guard: **1 passed, 3 assertions**.
- Real pack smoke after the last production edit: **41 assertions**, 3.20 s (`artifact://176`). It passed explicit pipe-browser PID/Sway correlation, real form input, Screen/window ownership and isolation, full-text waiting, the forced 20 px scrollbar with a 12 px control at normal and native keyboard zoom, 1 px coordinate accuracy, human Ctrl+Tab during a duplicate-title Takeover, a fresh selected-tab snapshot, stale refs, isolated scripts, no TCP listener, and targeted teardown. Its only failure is the unchanged `navigator.webdriver === false` assertion (line 259): expected `false`, actual `true`.
- Real-model Pi conformance, both inside the clean full suite and as its child run: all 11 steps plus step 5b passed, **66 assertions**, 143.51 s in the clean run, six native session files under the private `/tmp/pi-conformance-*` HOME, which was removed afterwards; step 11 drove the browser form by AX refs through the real tool surface.
- Typecheck `bun run typecheck`: exit 0, 6.68 s. Boundaries `bun run lint:boundaries`: **2 passed, 3 assertions**.
- Playwright e2e on the clean environment: **83 passed**, 169.06 s (`artifact://178`).
- Clean full `bun test`: **785 passed, 16 skipped, 0 failed, 4,702 assertions, 801 tests, 120 files**, 541.90 s (`artifact://194`), with `OMARCHY_BOT_BROWSER_PACK_DIR`, `OMARCHY_BOT_REAL_PORTABLE_BROWSER` and `OMARCHY_BOT_PI_CONFORMANCE_STEP` unset. Timing caveat: that run started before the final tiny fail-closed catch guard; the post-guard focused suites (37 passed, 203 assertions, `artifact://174`) and real smoke (`artifact://176`) cover the changed path. The earlier contaminated full run (`773 pass, 16 skip, 2 fail`, `artifact://122`) failed only because fixture environments inherited an exported browser-pack override in `container-launcher.test.ts` and `service-install.test.ts`; it is not product evidence.

**Acceptance.** Checked: pipe launch/profile/no-TCP/targeted teardown; the `browser` contract and stale-ref message; real input with scroll-into-view; Broker arbitration and Takeover holds; `request_takeover` with visible reason, hold, fresh snapshot and challenge guidance; Pi and scripted exposure with the real-model form step; README, CONTEXT glossary and ADR 0012. Unchecked: anti-bot neutrality, because the pinned Chrome for Testing build hardcodes the automation-controlled feature for `--remote-debugging-pipe` (Chromium 156 `content/child/runtime_features.cc:343`, crbug 40746300), so `navigator.webdriver` is true before any client attaches. No spoof, feature override, flag patch or launch-script suppression was added; the conformance assertion stays intact. This is a native control-channel blocker, not an unverified test.

**Not verified.** The clean full suite finished before the last catch-guard tweak, so that exact tree was not re-run as a whole; the post-guard focused and real-smoke runs cover the changed path. Also not verified: a second device scale or output; Chromium singleton handoff on repeated `open_url`; and pipe loss across a daemon restart. Coordinate mapping is proven only on the exercised 20 px scrollbar/zoom fixture with a 1 px tolerance. A real container image build and an offline-distro install path were not rerun for this change; the suite exercises those paths only through its fixture tests, whose earlier two failures came from an inherited pack override and are cleared in the clean suite. Sites can still block the Bot for IP-reputation or policy reasons, which are outside the Service’s control. **Status remains open** because the neutrality criterion is unmet.

### 2026-10-28 — webdriver criterion revised

The user chose to accept `navigator.webdriver === true`. Chromium sets it for `--remote-debugging-pipe` itself (`content/child/runtime_features.cc`), so keeping it false would have meant a TCP debugging endpoint, which was rejected for security, or hiding it with `--disable-blink-features=AutomationControlled`, which is the evasion this design declines. The criterion now requires no automation signal beyond what the pipe implies. The real-browser conformance test asserts `true`, and Computer ADR 0012 records the decision. Sites that challenge the Bot because of it go to the user through `request_takeover`.

## Answer

Resolved: Agents drive the visible pack browser through a private CDP pipe with an accessibility-tree `browser` tool, real input and Takeover integration. `navigator.webdriver` stays true by decision. Evidence is in the comments above.
