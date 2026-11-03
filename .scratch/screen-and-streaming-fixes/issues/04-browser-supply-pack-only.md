# 04: Bots use only the pack browser (deepen Browser Supply)

Type: task
Status: resolved
Blocked by: None

Decision: [Computer ADR 0013](../../../docs/contexts/computer-control/adr/0013-bots-use-only-the-pack-browser.md). It is committed on branch `fix/integration` at `f867e42`; read it in your worktree. The user's rule is: **every Bot uses the bundled browser and never controls a host browser**. The host opt-in is removed.

**What to build:** Make one deep **Browser Supply** module in `apps/daemon/src/modules/computer/` the only place that answers:
- how to launch the pack browser (argv and flags, `--remote-debugging-pipe`, `--new-window`)
- where its private profile lives
- what the Screen launch environment needs so every browser path ends at the pack
- whether a process or window *is* the pack browser

Fold `hostBrowser.ts` and `browserPack.ts` into it, or make them its private internals. Callers stop answering these questions themselves.

## Bugs this closes (from the 2026-11-03 browser review)

- **A1, host browser leaks into Bot Screens.** All three were verified on the live host:
  - Inside the Bot profile environment, `xdg-mime query default x-scheme-handler/https` returns `brave-browser.desktop`. There is no private `mimeapps.list`, and `XDG_DATA_DIRS` is forwarded from the host (`botScreenWaylandHelpers.ts:523`).
  - `open_app brave` / `brave-browser.desktop` is resolved and run (`hostBrowser.ts:39-57`, `swayBotScreenRuntime.ts` around 990-1042). `isBrowserExecutable` only labels the launch, never refuses it.
  - Sway's own `PATH` contains `/usr/bin`, so `swaymsg exec brave` still works (`botComputer.ts` `childPath` around 290-305, 540, 584).
- **A2, the profile is shared with host Chromium.** The pack profile is `<profile>/config/chromium` (`swayBotScreenRuntime.ts` around 148-156), which is host Chromium's default under the Bot's `XDG_CONFIG_HOME`.
- **A4 (message part).** The missing-pack error (`botComputerAssets.ts` around 325) tells the user to set `OMARCHY_BOT_BROWSER=host`.
- **A11.** The Browser Tool decides that a browser is present from an app-id regex (`swayBotScreenRuntime.ts` around 914-932).

## Required behaviour (from ADR 0013)

1. Remove the `OMARCHY_BOT_BROWSER` host opt-in everywhere: daemon (`bootstrap/main.ts`, `botComputerAssets.ts`, `botScreenWaylandHelpers.ts`, `swayBotScreenRuntime.ts`), CLI (`apps/cli/src/main.ts`, `lifecycle.ts`, unit-file generation), scripts (`scripts/linux-app/session.sh`, `scripts/container-image/*`, `scripts/distro-conformance/container.sh`, `scripts/windows-app/service.sh`), README, and tests. Run `grep -rn OMARCHY_BOT_BROWSER` and `grep -rn "host browser"` to find them all. Two exceptions:
   - The daemon logs a one-line "ignored" notice if the variable is still set.
   - The CLI rejects `OMARCHY_BOT_BROWSER` with a message pointing to ADR 0013.
   - `OMARCHY_BOT_BROWSER_PACK_DIR` (fixture pack location) stays.
2. `open_app` naming a non-pack browser (executable basename or desktop id for brave, chromium, google-chrome*, chrome, firefox, microsoft-edge*, vivaldi, opera, epiphany, librewolf, zen, …; keep the list in Browser Supply) is refused with an actionable error naming `open_url` and the `browser` tool.
3. The Bot Computer environment points `http`, `https` and `text/html` and `BROWSER` at the pack:
   - Write a private `mimeapps.list` in the Bot `XDG_CONFIG_HOME`.
   - Add a pack `.desktop` entry in the Bot `XDG_DATA_HOME/applications`.
   - Do not forward the host `XDG_DATA_DIRS`, or make sure the private entries take precedence.
   - Verify with `xdg-mime query default x-scheme-handler/https` under the Screen env in a test, using a private fixture host dir.
4. A Service-owned shim directory goes first on the Screen and Sway `PATH`. It contains stubs named after common host browsers that open the pack (`--new-window` with any URL arguments). `xdg-open` is left as is and relies on item 3.
5. Move the pack profile to a Service-owned directory name (for example `<profile>/config/omarchy-bot-browser`). On first start, if the old `config/chromium` exists and the new one does not, rename it once while no pack browser is running, so sign-ins are kept.
6. Add one identity predicate: a pid is the pack browser if `/proc/<pid>/exe` is the resolved pack binary, or the pid descends from it. Use it for window claiming and the Browser Tool gate, replacing the app-id regex and executable-name checks.
7. If the pack is missing, `open_url`, `browser` and `request_takeover` say the browser pack is missing and give the install/update command. There is no fallback.

## Acceptance criteria

- [ ] Tests (fixture host dir with fake `/usr/bin/brave` and a host `mimeapps.list` preferring brave) show:
  - `open_app brave` is refused.
  - `xdg-mime` under the Screen env resolves to the pack entry.
  - Running `brave https://x` through the Screen `PATH` starts the pack.
  - The host brave is never executed.
- [ ] A test shows the old `config/chromium` profile is migrated once and never overwritten.
- [ ] A test shows the identity predicate accepts the pack and its descendants and rejects a different binary with a Chromium-like app id.
- [ ] `grep -rn "OMARCHY_BOT_BROWSER\b"` (excluding `_PACK_DIR`) finds only the rejection and ignore paths, their tests, and the ADR.
- [ ] Existing computer, browser, CLI and install suites pass (`tests/integration/bot-*`, `browser-*`, `service-install`, `container-launcher`, `tests/unit/cli-commands`), and `bun run typecheck` and `bun run lint:boundaries` pass. Run env-gated real suites only if they use private runtimes, and record the results.
- [ ] README and the Computer Control docs no longer describe a host-browser option.

## Constraints

- Host safety per `AGENTS.md`. Never touch the user's running `omarchy-bot.service`, its Bot Screen units, their profile under `~/.local/share/omarchy-bot`, or the host graphical session. Never run host browsers.
- Do not modify the shared Bot Computer, routed Screens, input seat, or the CDP pipe protocol beyond what is listed here.

## Comments

### 2026-11-03

Implemented on `fix/04-browser-supply-pack-only` (commit `54ffbd3`, based on `fix/integration` `f867e42`).

**What changed**
- New `apps/daemon/src/modules/computer/browserSupply.ts` (Browser Supply): `launchCommand(url)` (pack argv + flags + `--remote-debugging-pipe --new-window`), `profilePath` (`<profile>/config/omarchy-bot-browser`, one-time move from `config/chromium` only when the target is absent and no live process has `--user-data-dir=<old>`; otherwise it keeps using the old path until it can move), `prepare()` + `environment(env)` (private `mimeapps.list` — and an existing `sway-mimeapps.list` — set http/https/text/html/xhtml to `omarchy-bot-browser.desktop` in the Bot `XDG_DATA_HOME`; `BROWSER` and shim dir `<profile>/browser-shims` first on the Screen **and** Sway PATH, with ~40 host-browser-name stubs that open the pack with `--new-window` + URL args only), `refuseHostBrowser(app, argv?)`, `isPackBrowser(pid)` (exe is resolved pack binary, or ancestor is, or a Service-spawned pack launch), `ensurePack()`.
- `hostBrowser.ts` deleted; generic desktop-entry resolution moved to `desktopEntry.ts`. `browserPack.ts` kept as is (install-time ELF patching, imported by the CLI from target archives by path).
- Sway runtime: open_app refusal, pack launch via Browser Supply, window claiming + Browser Tool gate use `isPackBrowser`; Browser Tool / `request_takeover` call `ensurePack()` first.
- `BROWSER_PACK_MISSING` message in `botComputerAssets.ts`: "The browser pack is missing. Run omarchy-bot update --archive <path> --checksum <path> --browser-pack <file-or-https-url> to install it."; asset supply now also reports the pack `executable`.
- `OMARCHY_BOT_BROWSER` removed: daemon logs a one-line ignored notice (`bootstrap/main.ts`); CLI rejects it (exit 2, points to ADR 0013) on install/update/reconfigure; unit/service.json no longer carry it; `update` rewrites a legacy unit that still sets it; doctor always checks the pack. README, ADR 0011/0012 amended; container entrypoint clears Singleton links in both profile paths.

**Tests** (worktree, `bun install --frozen-lockfile` first)
- `bun run typecheck` — pass.
- `bun run lint:boundaries` — 3 pass, 0 fail.
- `bun test tests/integration/bot-*.test.ts tests/integration/browser-*.test.ts tests/integration/service-install.test.ts tests/integration/container-launcher.test.ts tests/unit/cli-commands.test.ts tests/integration/agent-browser-tool.test.ts` — 306 pass, 13 skip, 4 fail. The 4 failures are the `service-install` listener tests that bind the fixed default port 7321 (held by the host's running Service); they fail identically on the base commit (verified with the changes stashed).
- `bun test tests/unit apps/web/src/lib` — 110 pass, 0 fail.
- New `tests/integration/browser-supply.test.ts` (10 tests): xdg-mime under the Screen env with a fixture host preferring brave (brave before prepare, pack after), mimeapps merge, `brave https://x` via the Screen PATH starts the pack and fake `/usr/bin/brave` never runs, open_app refusal list, migrate-once/never-overwrite, deferred move while held, identity predicate (copied binaries: pack + child accepted; different `chromium` binary + child rejected), tracked launches, missing pack, ignored notice. `bot-screen-sway-control` gained runtime-level refusal, Screen/Sway PATH + xdg-mime + shim, missing-pack (open_url/browser/request_takeover) and a pack-handoff claim test with an impostor `chromium` app-id window.

**Unverified**
- Env-gated real suites (`OMARCHY_BOT_REAL_*`, e.g. portable-browser conformance) were not run: no prepared private `.lane` bundle/fonts/pack in the worktree, and their defaults read the host's `~/.local/share/omarchy-bot` install. The conformance test was edited (host selection dropped, exact profile path asserted) but not executed.
- No real Chromium run: a pack started via a shim/`swaymsg exec`/`xdg-open` when no pack is running has no CDP pipe, so the Browser Tool reports the closed-pipe error until those windows close (same as before for non-URL launches). `open_app omarchy-bot-browser.desktop` is allowed and behaves the same way.
