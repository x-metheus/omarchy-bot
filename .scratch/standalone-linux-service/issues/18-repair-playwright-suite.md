# 18: Repair the Playwright end-to-end suite

**What to build:** `bun run test:e2e` passes again. 40 of 82 Playwright tests already failed on `140ecab`, before the standalone Linux Service series, with the same 40 failing on `linux-service`. The first diagnosed cause: specs look up the message input as `getByRole("textbox", { name: "Message input" })`, but the `@astryxdesign` input now exposes `combobox "Message input"`. Other failures may have other causes and each needs its own diagnosis.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] Every failing test is classified with evidence: stale test (selector/role/text/flow changed), product regression, or environment.
- [x] Stale tests are updated to the current accessible UI, selecting by role and accessible name, with no `force`, sleeps, or CSS-structure selectors added.
- [x] Product regressions found by the suite are fixed in the product with the test kept as written, or are listed in the Comments with a reason if out of scope.
- [x] The message input's role is confirmed correct for its behavior (combobox only if it really owns a popup/listbox, such as mentions or slash commands); if it is wrong, the product is fixed rather than the test.
- [x] Visual snapshots are updated only where the diff is reviewed and explained in the Comments.
- [x] `bun run test:e2e` passes in full; the result is recorded with the full `bun test` suite still at baseline.

## Comments

### Visual review (2026-10-27)

Reviewed all five original expected/actual/diff PNG triplets under
`/tmp/omarchy-bot-ticket18-baseline-20261026/tmp/omarchy-bot-playwright-results/`.
The initial visual scout's global font/environment classification was incorrect:
sidebar text is pixel-identical, desktop bubble pixels match exactly after a
12px vertical translation, and header/composer text stays in place. The baseline
captures remain the red evidence; assertions and screenshot thresholds are unchanged.

- **Desktop light:** current UI adds the Plugins entry above Settings, introduced
  by `b13be5d` in `Sidebar.tsx` and documented in the README. Both bubbles and the
  working avatar move up 12px because of invisible empty-drawer geometry; that is
  a product regression to repair before the final baseline refresh. Avatar mouth
  pixels additionally depend on the native SVG animation frame.
- **Desktop dark:** the same Plugins addition and 12px transcript movement;
  theme colors, bubble dimensions, text wrapping, header, and visible composer
  remain unchanged. Small avatar differences come from the embedded animation.
- **Computer Surface dark:** the same shared workspace changes. The complete
  Computer rail, including `Read-only snapshot — Computer Surface was not found
  for this Bot`, is expected fixture content and is unchanged; no Computer content
  is masked or removed.
- **Narrow light:** the navigation sidebar is closed, so Plugins is absent from
  the screenshot. Both bubbles and the working avatar move up 12px; header,
  wrapping, visible composer, and control positions remain unchanged. After
  alignment the working avatar matches the original bitmap exactly.
- **Reduced-motion dark:** Plugins appears, with the same 12px transcript shift.
  After alignment the working avatar is pixel-identical to the original static
  bitmap. Its `animation-name: none` and accessible visibility assertions remain
  before screenshot preparation, so capture stabilization cannot satisfy them.

There is also genuine capture nondeterminism: DiceBear's generated SVGs contain
their own CSS animations inside `<img>` data URIs. A browser probe using the real
sidebar/working image sources changed 158 pixels across 360 animation frames;
pausing their internal animations changed zero. `prepareVisualCapture` now adds
only a pause-at-zero CSS rule inside generated SVG images and awaits decoding.
It preserves avatar artwork, labels, dimensions, and the test's normal/reduced
motion media settings, and changes no product code. All five full-page pairs
then matched byte-for-byte across 360 frames; hashes are recorded in
`/tmp/omarchy-bot-ticket18-visual-frozen-20261027/capture-stability.json`.
No font, browser, or dependency was installed. The existing system font stack
still means another browser/font environment may need a separately reviewed
raster baseline; it did not cause these five failures.

The empty-drawer product repair restores the original transcript positions:
its absent-state `padding-block: 0` needed `!important` to override the generated
StyleX `padding-top: var(--spacing-3)` selector. Composer height returns from
94px to 82px, with its bottom unchanged; no 12px shift was accepted into baselines.

LatentRepair's actual computed boxes rule out an additional margin problem:

| Closed drawer measurement | Before | After |
| --- | ---: | ---: |
| Outer height across 30 frames | 12px | 0px |
| Outer padding-top | 12px | 0px |
| Outer padding-bottom | 0px | 0px |
| Outer margin-bottom | 0px | 0px |
| Toggle height | 0px | 0px |
| Content grid height / row | 0px / 0px | 0px / 0px |

Source: `tree[0]`, `tree[1]`, and `tree[7]` in
`/tmp/omarchy-bot-ticket18-latent-20261027-kztXJ3/resting.json` and
`/tmp/omarchy-bot-ticket18-latent-smoke-20261027-L9bGRd/resting.json`.
The late generated stylesheet repeats the high-specificity top-padding atom;
bottom padding and margin already compute to zero, so no margin override was
added.

After that repair, the final five reviewed captures differ from the original
baseline by the following exact RGBA pixel counts (these are stricter than the
Playwright perceptual comparison):

| Snapshot | Changed pixels | Reviewed final difference |
| --- | ---: | --- |
| Desktop light | 446 | Plugins icon/text (412); 20 header-avatar edge and 14 send-icon edge pixels have tiny antialiasing changes. |
| Desktop dark | 444 | Plugins icon/text (420); 12 New Bot plus-icon and 12 send-icon edge pixels have tiny antialiasing changes. |
| Computer Surface dark | 420 | Plugins icon/text only; entire rail and transcript match exactly. |
| Narrow light | 0 | Fully pixel-identical to the original; regenerated PNG retained identical content. |
| Reduced-motion dark | 440 | Plugins icon/text (420); 20 header-avatar edge pixels have tiny antialiasing changes. |

All final expected images and generated difference overlays were reviewed again.
There is no text-metric, wrapping, layout, theme-color, or content removal change.
The remaining icon/avatar edge changes affect a few near-identical edge shades;
the working avatar matches the original once its position and frame are stable.
Exact counts, SHA-256 values, and review overlays are under
`/tmp/omarchy-bot-ticket18-visual-final-refresh-20261027/`.

Final refresh command (5 passed):
`TMPDIR=/tmp/omarchy-bot-ticket18-visual-final-refresh-20261027/tmp PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun run test:e2e 13-responsive-accessible-visual-qa.spec.ts --grep 'matches the (fixed|desktop Computer Surface)' --update-snapshots`.
All 15 ticket-13 cases then ran twice, including accessibility, layout, normal
motion and the preserved reduced-motion assertions (30 passed):
`TMPDIR=/tmp/omarchy-bot-ticket18-visual-repeat-a-20261027/tmp PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun run test:e2e 13-responsive-accessible-visual-qa.spec.ts --repeat-each=2`.
The log is `/tmp/omarchy-bot-ticket18-visual-repeat-a-20261027/playwright-repeat.log`.

A second invocation ran the five visual cases twice with temporary Playwright
`screenshot: "on"` evidence capture (10 passed); the temporary option was then
removed. Command:
`TMPDIR=/tmp/omarchy-bot-ticket18-visual-repeat-b-20261027/tmp PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun run test:e2e 13-responsive-accessible-visual-qa.spec.ts --grep 'matches the (fixed|desktop Computer Surface)' --repeat-each=2`.
All ten generated sidebar/working-avatar regions match the final baselines
exactly. Both narrow, both Computer Surface, both desktop-dark, and the second
reduced-motion full-page PNGs are byte-identical to their baselines. The two
desktop-light captures differ in the same 14 near-identical send-icon edge
pixels; the first reduced-motion capture differs in 30 unrelated button/row
edge pixels. All match with the unchanged Playwright screenshot comparator;
no tolerance was added. PNGs, hashes, exact counts, and log:
`/tmp/omarchy-bot-ticket18-visual-repeat-b-20261027/`.

The visual slice did not run the full end-to-end or Bun suites; those remain the
main agent's final integration checks. Build output retained the existing
`node:path` browser-externalization, chunk-size, and `NO_COLOR` warnings.

### Final classification and validation (2026-10-27)

Baseline: `/tmp/omarchy-bot-ticket18-baseline-20261026` (`failures.json`), 82
tests, 42 passed, 40 failed on this branch. All 40 are classified below; the
per-snapshot visual reasoning is in the section above and is not repeated.

| Count | Classification | Cause and resolution |
| ---: | --- | --- |
| 34 | Stale test (Composer role) | `@astryxdesign` exposes a real `combobox` while slash commands are available. Locators now use `getByRole("textbox", { name: "Message input", exact: true })` `.or(combobox …)` in 11 specs (16 occurrences). |
| 1 | Stale test (Composer geometry probe) | `02-chat` resolved its dock surface via a stale `[role="textbox"]`/button DOM query. It now receives the same accessible locators; all geometry/style assertions kept. |
| 5 | Visual snapshots, reviewed | Mixed: intentional Plus plug-ins entry (`b13be5d`), a real 12px empty-drawer regression (fixed in product CSS), and embedded-SVG avatar animation nondeterminism (capture-only stabilization). Details above. |
| 2 | Latent tests exposed only after the Composer failures cleared | `05-managed-attachments` closed-drawer height (product regression, see below) and `15-bot-mailbox` stale generic error wording. |
| 1 | Environment | Long `TMPDIR` made a private Wayland socket path exceed the 107-byte limit, affecting 78 tests in the initial full Bun run; a short private `TMPDIR` rerun resolved it. No product or test change. |

Note: 34 + 1 + 5 = 40 baseline failures; the two latent failures and the
environment finding were hidden behind or outside those 40.

Product fixes made while keeping the tests as written:

- **Empty attachment/Computer drawer.** The absent drawer kept 12px of generated
  StyleX top padding, lifting every transcript and the Composer by 12px. The
  absent-state rule now uses `padding-block: 0 !important` (a comment records the
  specificity reason). Closed height is 0px across 30 frames (was 12px), the
  Composer returns from 94px to 82px with an unchanged bottom edge, and the open,
  closing, keyboard, and reduced-motion assertions are unchanged. Measurement
  sources are the `resting.json` files cited above.
- **Message input role.** Checked, not changed: the input genuinely owns the
  `Skill commands` listbox with `aria-haspopup`/`aria-expanded`/`aria-controls`,
  and reverts to a textbox for multiword drafts, offline Agents, and active Turns.
  The product role is correct, so only test locators changed. A new regression
  test asserts the popup ownership, Escape dismissal, multiword send, and the
  return to an empty combobox (82 → 83 tests).
- **Mailbox error wording.** The test expected a generic
  `invalid Bot message tool request`; the current integration contract rejects a
  raw-path target in `MailboxService` with `target Bot ID is invalid`. The test
  now asserts that bounded message and keeps the path-non-disclosure and
  dismissal checks. The historical note in
  `.scratch/bot-to-bot-mailbox/issues/04-complete-mailbox-lifecycle.md` was
  corrected to match. Both stale results above are superseded by these fixes.
- **Worker shutdown (found by the full-suite cwd scenario, not by Playwright).**
  `WorkerClient.stop()` sent an unsupported `shutdown` frame and left stdin open,
  so every stop burned the 3,000ms grace period. It now closes worker stdin, which
  is the real Pi worker's existing EOF shutdown path; both fake workers honor EOF
  and the spec's resistant mode still ignores EOF/TERM. The supervision test now
  requires the observed EOF marker while keeping descendant TERM/KILL coverage.
  Restart dropped from 3,174ms to 128ms and the scenario from 5,008ms to 1,963ms;
  focused run: 52 passed.

Final checks on the combined branch, all exit 0, logged in `/tmp/t18v-UUI3Fv`;
`results.json` records each command, exit code, and duration:

| Command | Result |
| --- | --- |
| `bun run --filter=@omarchy-bot/web build` | exit 0, 3.6s |
| `bun run test:e2e` | **83 passed**, 168.2s |
| `bun run typecheck` | exit 0, 6.1s |
| `bun run lint:boundaries` | 2 pass, 3 assertions, exit 0 |

Full suite: `bun test` with a short private `TMPDIR` —
**688 passed, 13 skipped, 1 failed**, 4,041 assertions, 702 tests, 111 files,
390.0s, exit 1 (`/tmp/t18c-s2fF5Z/full-bun-result.json`). The single failure is
`tests/conformance/pi.test.ts:355`, an exact capability-key list that omits the
received `plugins` key; real-model steps 1–7 passed. That failure is the known
pre-existing baseline; its exact introducing commit was not established. The
full suite is at baseline rather than green, and this ticket does not claim a
green `bun test`. The earlier pre-EOF result (687 passed, 2 failed)
and the 78-test `TMPDIR` run are superseded by the above and retained only as
history.

TicketReview approved the change with no actionable findings, confirming no
deleted or skipped tests, no weakened screenshot tolerance, no `force`, sleeps,
or CSS-structure selectors, and that the reviewed PNG differences match the
table above. The repeat evidence is in the visual section (30 and 10 passing
runs); shared-daemon `--repeat-each` is unreliable because fixtures reuse Bot
names, so repeats used fresh daemon runs.

Not verified, by design: only cached Chromium was used, with no host installs,
service/config changes, or optional real-host/container scenarios; the known Pi
conformance failure and browser/font raster portability remain unverified. The
existing Vite `node:path` externalization and >500kB chunk warnings remain.
Prior detailed reports: `agent://ComposerRepair`, `agent://LatentRepair`,
`agent://VisualRepair`, `agent://CwdTimeoutRepair`, `agent://TicketReview`.
Delivery is a local commit only; no push, release, or image publishing.


