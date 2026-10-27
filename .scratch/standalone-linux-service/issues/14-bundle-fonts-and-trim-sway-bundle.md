# 14: Bundle the fonts in the runtime archive and trim the Sway bundle

**What to build:** The Bot Computer font set (including CJK) ships inside the runtime archive and is resolved from the installed runtime, so Bot Screens render text without reaching `raw.githubusercontent.com` at run time. The Sway bundle drops libraries the headless pixman Bot Computer does not need (Mesa/gallium and LLVM, about 200 MB of the 234 MB unpacked bundle) while keeping Xwayland and every bundle launcher working.

**Blocked by:** 13 (resolved)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] The runtime packager puts the pinned, checksum-verified font set under the runtime archive (alongside `sway/`) and refuses a mismatched font file.
- [x] `ensureFonts` resolves fonts from the installed runtime with no network fetch; a development override points at a locally prepared font directory, as `OMARCHY_BOT_SWAY_BUNDLE_DIR` does for Sway.
- [x] The Sway bundle build (`scripts/sway-runtime/`) no longer ships `libLLVM`, `libgallium`, or other GPU-only Mesa libraries, or justifies in the ticket comments any it must keep; the new archive hash is pinned in `swayRuntimeSupply.ts`.
- [x] Real-Sway bundle conformance still passes with the trimmed bundle, including Xwayland and the X11-only client capture.
- [x] `service-supervision`, the application-launch tests, and the Sway runtime tests pass on a host that cannot reach `raw.githubusercontent.com`.
- [x] The runtime archive size before and after is recorded in the comments.

Out of scope: the portable browser fallback (Chrome for Testing and its Ubuntu libraries) stayed an on-demand download here; ticket 17 replaced it with a separate checksum-pinned browser pack installed by `install`/`update`, so headless hosts and stock Ubuntu get a browser without a run-time download.

## Comments

Fonts: the packager verifies `FONT_ASSETS` SHA-256 checksums before copying into archive `fonts/`. `ensureFonts` reads the installed runtime directory (`runtime/current/fonts`); `OMARCHY_BOT_FONT_DIR` is the development override. There is no runtime fetch. `prepare-fonts.sh` is the only downloader and was not used here because `raw.githubusercontent.com` resets; `.lane/fonts` matched the four pins.

Sway trim: `libLLVM`, `libgallium`, EGL, GBM, epoxy, and Mesa are not shipped. All 88 ELF NEEDED entries are clean. Kept `libdrm` because Sway and wlroots NEEDED `libdrm.so.2`, and `libxshmfence` because Xwayland `miext/sync/misyncshm.c` includes `X11/xshmfence.h` even with glamor/DRI3 off and NEEDED `libxshmfence.so.1`. `libinput-dev` is build-only because Sway `config.h` includes `libinput.h`; libinput/eudev do not ship. wlroots was built with empty optional backend/renderer/allocator lists (upstream still builds headless, wayland, pixman, shm). Xwayland was built with glamor, GLX, and DRI3 disabled.

D-Bus launcher: omits bundled `--config-file` when the caller already passed one (either `--config-file=path` or `--config-file path`). The default bundled `session.conf` remains otherwise. This fixed a pre-existing duplicate-argument exit ("--config-file specified but configuration file .../session.conf already requested") that blocked the private session bus. `botComputer.ts` was unchanged for this fix.

Hash: `swayRuntimeSupply.ts` SHA-256 is `c821bcb7d8e349c22bf3c9a96084a550d7d5a357b2d9d340c608adbdc5fb9344`. The release label stays `sway-1.10.1-wayvnc-0.8.0-wlroots-0.18.1-v1` because the workflow hardcodes the v1 asset name.

Sizes: the new Sway archive is 13,235,612 bytes; extracted regular files are 32,711,378 bytes. The prior unpacked size was not on disk; the ticket's ~234 MB unpacked / ~200 MB Mesa+LLVM is the only before figure. Font files total 39,825,884 bytes. The runtime archive after (trimmed Sway + fonts + web dist + helpers), `.lane/runtime-after/omarchy-bot-runtime-5d21ea4f34b388f71c7812c48248579073b37f29-x86_64.tar.zst`, is 124,003,870 bytes. That artifact is local, not committed, not published.

Proof: `scripts/sway-runtime/conformance/run.sh` passed 3 / failed 0, including "two bundle-only Bot Screens isolate X11 clients, input, and projection". `musl-smoke` passed. `OMARCHY_BOT_REAL_SWAY=1 bot-screen-sway-runtime.test.ts` passed 17 / failed 0. Portable browser conformance passed 2 / failed 0 with bundled Sway binaries and `.lane/fonts`. `bun run typecheck` (`tsc --noEmit`) passed. Earlier full `bun test`: 676 pass, 13 skip, 1 fail (Pi capability keys extra plugins; the assertion exists on HEAD; this branch does not touch `workers/pi`). Host `bot-screen-sway-conformance` still ends cutover blocked on "Bot Screen input requires the input lease" after Ghostty titles were fixed (`--title=BOT-A-TERM`); both screens were ready; distinct-apps passed. That lease is outside this ticket. Review: no must-fix findings.

Build note: a clean registry rebuild was blocked (Docker Hub/Alpine TLS EOF). The archive was built from the cached trimmed image with `--pull=never --network=none`. `Dockerfile` and `build.sh` match that build.

Ticket 17 completed the deferred browser half. The browser is no longer downloaded at run time: the packager emits `omarchy-bot-browser-<version>-x86_64.tar.zst` with a `.sha256` sidecar from the pinned `BROWSER_ASSET` and `BROWSER_LIBRARY_ASSETS`, `install`/`update` install it by default under `<dataDir>/runtime/browser` (skipped with `--no-browser-pack`; refreshed only when the pin changes, the installation is incomplete, or its `browser --version` fails), and the runtime archive stays browserless exactly as this ticket left it. The pack is the default because it gives Agent control one pinned browser and the Service no dependency on the host; a host browser requires the explicit `OMARCHY_BOT_BROWSER=host` opt-in, and Chrome for Testing ships no Widevine module, so DRM-protected video does not play. Fonts under `runtime/current/fonts` and `OMARCHY_BOT_FONT_DIR` are unchanged.
