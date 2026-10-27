# 17: Browser pack as the Bot Computer's default browser

**What to build:** Every Service Host runs the same pinned browser in its Bot Computer, so web tasks behave identically everywhere, and [17b](17b-browser-agent-tools.md) can drive the browser through a known version and a known set of launch flags. The runtime archive stays browserless. The packager also produces a separate, checksum-pinned **browser pack**, made of Chrome for Testing plus the libraries `botComputerAssets.ts` downloads today. `install`/`update` install the pack by default, from a local file or its release URL, and verify its checksum. The Service starts the browser from the installed pack and never downloads one at run time. A host browser is used only when the user opts in.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] The packager builds `omarchy-bot-browser-<version>-x86_64.tar.zst`, with a `.sha256` sidecar, from the pinned Chrome for Testing and library inputs. It refuses any input that doesn't match its pin.
- [x] `install`/`update` install the pack by default, verify its checksum, and take it from `--browser-pack <file>` or the release URL. `--no-browser-pack` skips it. `uninstall` removes it. Updating replaces the pack only when its pin changes.
- [x] The Service starts the browser from the installed pack, and the run-time download path in `botComputerAssets.ts` is removed. A host browser is used only through the explicit opt-in `OMARCHY_BOT_BROWSER=host` (unit environment, carried by `install`/`reconfigure`), and snap-confined browsers are still skipped. When neither the pack nor an opted-in host browser is available, `open_url` fails with one actionable message naming `omarchy-bot update` (or `--browser-pack`).
- [x] The pack's browser launches in the Bot Screen with a real window, never headless, and without `--enable-automation` or any other flag that sets `navigator.webdriver`. A test asserts the exact launch argument list.
- [x] `doctor` checks the installed pack: its checksum marker and that the binary runs.
- [x] The container image (09) and the distribution matrix (10) use the pack, so their browser steps pass with container networking disabled.
- [x] Portable browser conformance (CJK, shared profile, snap avoidance with the opt-in) passes against the installed pack.
- [x] README, Computer ADR 0011 and the ticket 05/14 notes record the pack as the default browser and why: a single pinned version for agent control, and no dependency on the host. They also record that Chrome for Testing has no Widevine, so DRM video won't play.

## Comments

### 2026-10-27 — direction change

This was first drafted with the host browser preferred and the pack used only as a fallback. The user rejected that. Chrome and Firefox as they're installed on the host aren't suitable for agent use, and agent control (17b) needs one pinned browser that starts with flags we control. The pack is now the default, and a host browser is opt-in.

A first implementation is in progress, uncommitted, in `../omarchy-bot-worktrees/linux-17-browser-pack` (branch `linux/17-browser-pack`). It contains `browserPack.ts` in the CLI and daemon, `hostBrowser.ts`, the packaging and install scripts, and tests. Reuse it, but reverse its host-first selection.

### 2026-10-27 — implementation and focused evidence

Code behavior is implemented on the branch, uncommitted; final acceptance and the checklist boxes stay open pending full validation and review.

Implemented: `install`/`update` install the pack by default regardless of host browsers; `--browser-pack` takes a local archive or an explicit HTTPS URL with its sidecar, `--no-browser-pack` skips installation and leaves an existing pack alone, and combining the two or passing the removed `--with-browser` is a usage error (exit 2). An installed pack whose marker matches `BROWSER_ASSETS_RELEASE` and whose files are complete is preserved, including when an explicit source is supplied; stale, absent, or incomplete packs are replaced. `open_url` uses the pack by default, `OMARCHY_BOT_BROWSER=host` selects a usable native browser, snap-confined or unavailable native browsers fall back to the pack, and the missing-browser error is one line naming `omarchy-bot update`, `--browser-pack`, and the host opt-in. Host selection is validated, persisted in the unit and `service.json`, retained when omitted, and cleared with an empty value; rollback restores it. `doctor` checks the pinned marker, the executable files, and a successful `browser --version`, and omits the pack requirement under the host opt-in. The launch test asserts the whole argument list, with explicit absence of headless, automation, and remote-debugging flags.

Focused run (no build, lint, or full suite in this phase):

```bash
bun test tests/unit/cli-commands.test.ts tests/unit/cli-lifecycle.test.ts \
  tests/integration/service-install.test.ts tests/integration/browser-pack.test.ts \
  tests/integration/bot-computer-assets.test.ts tests/integration/bot-screen-sway-control.test.ts \
  tests/integration/container-launcher.test.ts tests/integration/omarchy-plugin-package.test.ts \
  tests/integration/omarchy-plugin-lifetime.test.ts
```

97 pass, 0 fail, 808 assertions. `tests/unit/runtime-archive.test.ts` 13 pass, 0 fail. Real smoke: `bun scripts/install-browser-pack.ts .lane/browser-pack/omarchy-bot-browser-chrome-for-testing-156.0.8078.47-linux64-x86_64.tar.zst .lane/browser` then `.lane/browser/browser --version` printed `Google Chrome for Testing 156.0.8078.47`. Real portable-browser conformance with private Sway/runtime/profile directories: 3 pass, 0 fail, 81 assertions, covering pack execution, CJK glyphs, one shared profile across Screens, pack preference over an available native fixture, and snap avoidance under the opt-in.

Docs in this phase: README, Computer ADR 0011, system ADR 0013, the computer-control CONTEXT glossary, the spec's solution and browser bullets, the ticket 05/14 notes, and the release-note text in `plugin-runtime.yml` now record the pack default, the one-pinned-browser/no-host-dependency rationale, the `OMARCHY_BOT_BROWSER=host` opt-in with its persistence and snap skip, `--no-browser-pack`, checksum verification and unchanged-pin updates, the repair and doctor guidance, and the missing Widevine/DRM limitation. Criteria boxes stay unchecked and `Status` stays `open` until the full suites, container image, and distribution matrix runs land.

### 2026-10-27 — safe isolated Pi conformance rerun

The real Pi conformance suite now runs in a private child process with fixture `HOME`/XDG/TMPDIR, temporary copies of only Pi's credential and model configuration, and host application units disabled. A safe rerun of `bun test tests/conformance/pi.test.ts` passed all ten steps plus native steer, including image identification and the owning Bot Screen tools (outer runner 2 pass / 0 fail / 17 assertions; child 1 pass / 0 fail / 56 assertions). Related conformance suites: 13 pass / 0 fail / 71 assertions. Typecheck exits 0.

Isolated writes were cleaned: the readiness record and five native session files were written beneath `/tmp/pi-conformance-6NFJ6W` and the fixture was removed afterward. Before/after snapshots of 5,545 paths under the real `~/.pi` and `~/.local/share/omarchy-bot` show zero changes, and the records and sessions written by the earlier real-home run remain preserved as historical evidence. Exact commands and logs are in `.lane/browser-pack-verification.md`, with the snapshot summary in `.lane/pi-isolation-host-snapshot.json`.

README provisioning text was corrected to match: the suite is verification and deletes its own record, and no supported command provisions a durable record for a production Service or container state volume. That provisioning gap remains open, as do this ticket's criteria pending review. No production code change, commit, push, or publication.

### 2026-10-27 — review fixes and focused evidence

Four review findings were resolved on the branch, uncommitted, with no doc/status, commit, push, or publication change in that phase:

- Runtime-selected imports now come from the staged target runtime, so an `update` uses the target's browser pin, release naming, readiness implementation, and pack validation; an `install` that reuses an installed Service uses the retained runtime's modules and pin.
- Runtime and browser are staged together, the browser ELF relocates to its final managed path, and preparation failure preserves the running installation while a publication failure restores the previous directories and restarts a stopped Service.
- A successful runtime installation records `.runtime-archive`; repair and reuse derive the browser release from that record instead of the plugin's placeholder or the current checkout revision.
- Same-pin preservation now also requires a successful `browser --version`; exit 7 and a missing executable interpreter trigger repair.
- `doctor` honors `OMARCHY_BOT_BROWSER_PACK_DIR`, and installer/plugin fixtures carry a runnable ELF with its loader and libc so executable readiness is exercised.

Evidence from the fix agent:

```bash
bun test tests/unit/cli-commands.test.ts tests/unit/cli-lifecycle.test.ts tests/unit/runtime-archive.test.ts \
  tests/integration/service-install.test.ts tests/integration/browser-pack.test.ts \
  tests/integration/omarchy-plugin-package.test.ts tests/integration/omarchy-plugin-lifetime.test.ts \
  tests/integration/plugin-runtime-package.test.ts
```

86 pass, 0 fail, 802 assertions. After making the runnable fixtures resolve libc beside their actual ELF interpreter, the installer/plugin subset (`service-install`, `omarchy-plugin-package`, `omarchy-plugin-lifetime`) reported 52 pass, 0 fail, 459 assertions. Real smoke in a private staging directory installed the cached pack, renamed it into place, and ran it: exit 0, `Google Chrome for Testing 156.0.8078.47`. Real portable-browser conformance with `.lane/browser`, cached fonts and Sway, and the environment recorded in `.lane/browser-pack-verification.md`: 3 pass, 0 fail, 81 assertions, private children cleaned up.

README and Computer ADR 0011 now record that healthy same-pin preservation requires a successful `browser --version`, that `update` targets its runtime's pin while a reusing `install` keeps the retained runtime's pin, and that repair reuses the recorded runtime release while older installations without that record need an explicit `--browser-pack`. Criteria boxes stay unchecked and `Status` stays `open` pending full validation and review. Skipped here: full suite, typecheck, lint, and production builds; the runtime archive and container image must be rebuilt before acceptance. Browser-pack bytes and production pins are unchanged.

### 2026-10-27 — final acceptance

All eight criteria are checked off above and `Status` is `resolved`. Each was correlated to code plus an observed run; the full evidence, exact commands and log paths are in `.lane/browser-pack-verification.md` (that file and `.lane/` are git-excluded, so the identities and results are repeated here to keep the record self-contained). Nothing was committed, pushed, released, or published to a registry, and 17b was untouched.

Final artifact identities:

- Runtime `.lane/runtime/omarchy-bot-runtime-23c944b74457df7755acab944db54c80db689858-x86_64.tar.zst`: SHA-256 `aa94382790631791257cbe3f804255f4a9e971c9dfdfe6ea7e0ef0ce7e886019`, sidecar verified.
- Browser `.lane/browser-pack/omarchy-bot-browser-chrome-for-testing-156.0.8078.47-linux64-x86_64.tar.zst`: SHA-256 `063ce2a8f8958a26ecacdb8b336b67223d8349a9985752e6184608e55d687383`, sidecar verified.
- Container image `omarchy-bot:linux17`: image ID `sha256:4c07ab3e73351ac39d8ac242002ad51c57483111655be0e06d23e63343299311`, 1640243709 bytes.
- Installed pack reports `Google Chrome for Testing 156.0.8078.47`.

Results per criterion:

1. `scripts/package-browser-pack.ts` imports `BROWSER_ASSET`/`BROWSER_LIBRARY_ASSETS`/`BROWSER_ASSETS_RELEASE` from the supplied repository and refuses a checksum mismatch, a non-HTTPS URL, or a missing required file; it writes the `.sha256` sidecar. Both real builds succeeded, and `tests/integration/browser-pack.test.ts` tampers each pin and asserts refusal with no output archive. The linux-04 Sway input with the wrong SHA was rejected against the recorded pin.
2. Default install, checksum verification, local and HTTPS `--browser-pack`, `--no-browser-pack`, uninstall removal, and pin-change-only replacement are covered by `tests/integration/service-install.test.ts` (including exit 2 for conflicting or removed `--with-browser`) and `omarchy-plugin-package.test.ts` download-URL assertions.
3. `ensureBrowser()` reads only the installed pack and throws the single actionable missing-pack message naming `omarchy-bot update --browser-pack`; the run-time download path is gone. `OMARCHY_BOT_BROWSER=host` is the sole host path, persisted in the unit and `service.json` by `install`/`update`/`reconfigure`, snap-confined browsers are still skipped, and `bot-screen-sway-control.test.ts` asserts the exact one-line error with and without the opt-in.
4. `PORTABLE_BROWSER_FLAGS` contains no `--headless`, `--enable-automation`, or remote-debugging flag, and `open_url` opens `--new-window` on the real Wayland Bot Screen; the exact full argv list is asserted in `bot-screen-sway-control.test.ts`. Real-window rendering is additionally proven by container acceptance and the portable-browser pixel assertions.
5. `doctor` validates the pack marker and a successful `browser --version`, honors `OMARCHY_BOT_BROWSER_PACK_DIR`, and omits the pack check under the host opt-in; exit 7 and a missing interpreter trigger repair.
6. Container acceptance `2 pass / 0 fail / 44 assertions` and offline `--pull=never --network none` distro runs on Alpine and Ubuntu 24.04 each returned smoke PASS with `7 pass / 0 fail / 211 assertions` using the pack.
7. Real portable-browser conformance against the installed pack: `3 pass / 0 fail / 81 assertions` — pack execution, Latin/CJK/Korean glyph ink distinct from tofu, one shared profile across two Screens, pack preference over an available native fixture, and snap avoidance under the opt-in.
8. README (lines 86 and 444), Computer ADR 0011 (status line, decision, and consequences), and the ticket 05/14 notes record the pack as the default with the one-pinned-version-for-agent-control and no-host-dependency rationale, the opt-in, checksum verification, unchanged-pin updates, repair guidance, and the missing Widevine/DRM limitation.

Observed suites at their last run, before the harness-only regression described below: full `bun test` **733 pass / 15 skip / 0 fail / 4443 assertions** (including the isolated real ten-step Pi run plus 5b, child 56 assertions), `bun run test:e2e` **83 passed**, `bun run typecheck` exit 0, `bun run lint:boundaries` **2 pass / 0 fail / 3 assertions**. After the final smoke-harness fix, `bun run typecheck` exit 0, boundaries **2 pass / 0 fail / 3 assertions**, and the focused `tests/integration/distro-conformance.test.ts` **3 pass / 0 fail / 8 assertions**, plus the final offline Alpine and Ubuntu 24.04 acceptance runs above. The latest full-suite total does not include the added receiver regression; that total was not re-observed and is not claimed for the final tree.

Review findings fixed on the branch before acceptance: runtime-selected imports and pins come from the staged or retained target runtime; runtime and browser stage together with the browser ELF relocated to its final path and rollback on failure; `.runtime-archive` drives reuse repair; same-pin preservation requires a working `browser --version`; `doctor` honors the pack-dir override; the two-argument installer regression keeps working through `prepareBrowserPack` with frozen prior-module fixtures; and a rejected `list_windows` diagnostic no longer replaces the original browser error. Security review found no must-fix: checksum-before-extract, extraction confinement, staging, and rollback boundaries hold.

Explicitly unverified or limited:

- **Alpine typing attribution.** The first offline Alpine acceptance run failed at `scripts/distro-conformance/smoke.ts:79`, waiting for the exact typed text after the window, glyph pixels and focus acknowledgement had passed; its textarea value and event order were never captured, so the original cause cannot be proven. A real receiver race was found and fixed: each input report now carries a sequence and only an advancing one is accepted, because the old receiver let a late stale HTTP prefix overwrite a newer value. Delaying only report 21 by 100ms reproduced the exact timeout twice, the same injection passes with the guard, and seven instrumented runs showed natural out-of-order reports. The sequence guard is a harness fix; the underlying intermittent risk is not proven absent under concurrent load.
- **Host snapshot.** Before/after snapshots compared 5545 paths under `/home/colin/.pi` and `/home/colin/.local/share/omarchy-bot` with zero additions, removals, or content/mode/size changes, but one directory mtime (`/home/colin/.pi/agent`) changed for an uncertain reason during concurrent validation. The record/session files written by the earlier real-home Pi run remain as historical evidence; no guess restoration was attempted. Snapshot summary: `.lane/post-review-host-snapshot.json` (the earlier run's summary is `.lane/pi-isolation-host-snapshot.json`).
- **Pi provisioning.** No durable command provisions a readiness record for a production Service or container state volume; the conformance suite now runs in a private HOME and deletes its own record. That gap is outside this ticket's criteria.

Log paths for the last runs: `.lane/post-review-runtime-build.log`, `.lane/post-review-container-build.log`, `.lane/post-review-bun-test.log`, `.lane/post-review-e2e.log`, `.lane/post-review-typecheck.log`, `.lane/post-review-lint-boundaries.log`, `.lane/post-review-container-acceptance.log`, `.lane/post-review-portable-browser.log`, `.lane/post-review-distro-ubuntu-24.04.log`, `.lane/post-review-distro-alpine.log` (the initial failure), `.lane/post-review-distro-alpine-isolated.log`, `.lane/alpine-input-probe-8.log` and `-9.log` (reproduction), `.lane/alpine-input-regression-behavior-red.log` and `-green.log`, `.lane/alpine-input-final-alpine.log`, `.lane/alpine-input-final-ubuntu-24.04.log`, `.lane/alpine-input-final-typecheck.log`, `.lane/alpine-input-final-boundaries.log`, `.lane/alpine-input-final-focused.log`. No commit hash is recorded here; the committing agent may add it.

17b was not edited.
