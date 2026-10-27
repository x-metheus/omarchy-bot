# 05: Portable browser and fonts

**What to build:** `open_url` works on a host with no browser, and pages render Latin and CJK text correctly on hosts without fonts. A natively installed host browser was preferred when this ticket was written; ticket 17 made the checksum-pinned browser pack the default and a host browser opt-in. Snap-confined browsers are never launched. The shared Bot Computer browser profile is unchanged.

**Blocked by:** None (can start immediately)

**Status:** resolved

Spec: [standalone Linux Service](../spec.md)

- [x] On a fixture host with no browser, `open_url` opens the portable browser on the requesting Screen (Seam 3).
- [x] On a fixture host where the only browser is a snap, the snap is skipped and the portable browser is used.
- [x] A page containing CJK text renders glyphs, not empty boxes, in a Screen capture.
- [x] Repeated `open_url` calls reuse the shared browser profile across Screens.
- [x] The portable browser and fonts are fetched checksum-verified into the Bot Computer profile, not the host.

## Answer

At the time of this ticket, `open_url` preferred a native host browser, skipped snap-confined ones (including `env NAME=value` wrappers), and otherwise launched a checksum-verified Chrome for Testing build from the Bot Computer profile with `--user-data-dir` under `<profileRoot>/computer/config/chromium` and `--new-window`. Latin and CJK fonts are the same kind of verified download, and fontconfig is pointed only at that profile. The browser ELF names the bundled glibc loader via a `PT_INTERP` path placed after the segment's BSS, so the zygote sandbox stays on and host libraries are not required. Assets are fetched into the profile on first graphical use, not carried in the runtime archive and not installed on the host.

Ticket 14 moved the font set out of the profile and into the runtime archive; ticket 17 replaced the on-demand browser download with a checksum-pinned browser pack installed by `install`/`update`, so the Service never downloads a browser at run time. Ticket 17 also reversed the host-browser preference recorded above: the pack is now the default on every Service Host — one pinned version for Agent control, with no dependency on what the host installed — and a host browser is used only through the explicit `OMARCHY_BOT_BROWSER=host` opt-in, still skipping snap-confined browsers. Chrome for Testing ships no Widevine module, so DRM-protected video does not play in Bot Screens.

## Comments

Real private-Sway conformance (`OMARCHY_BOT_REAL_PORTABLE_BROWSER=1`, production pins, fresh profile) passed after the BSS placement fix: 2 pass, 0 fail, 40 expects. That run covers a browser-less host, CJK glyph ink versus the missing-character cell, one shared profile across two Screens, and a snap entry that is never executed. Offline: `bun test tests/integration/bot-computer-assets.test.ts tests/integration/bot-screen-sway-control.test.ts tests/integration/bot-computer.test.ts tests/integration/bot-screen-sway-runtime.test.ts` → 41 pass, 4 skip, 0 fail; asset tests re-run after the BSS fix → 5 pass, 0 fail. `bun run typecheck` is clean. A script cannot be an ELF interpreter, so the unit test checks the mapped path and the zero BSS gap instead of executing the fixture.

The session bus no longer uses `--session`. It starts from `<runtime>/session-bus.conf` with no service directories and no includes, so Chromium cannot activate the host `org.a11y.Bus` or `org.freedesktop.portal.*` services. Session children get `NO_AT_BRIDGE=1` and `GTK_A11Y=none`. dbus-daemon 1.16.2 rejects a config with no `<listen>`, so the file listens on the same private socket `--address` already sets. Regression: `bun test tests/integration/bot-computer.test.ts` 6 pass, 0 fail. Conformance after the change: 2 pass, 0 fail, 40 expects. `coredumpctl list --since '2026-10-25 14:41:05'` (22:41 CST, the start of that run) shows no newer `/usr/lib/at-spi-bus-launcher` or `/usr/lib/xdg-desktop-portal*` dumps; the newest of those is 21:46 CST, from the earlier run. Musl `ld-musl` SIGSEGVs in that window are the wayvnc socket crash owned by ticket 04.

Ticket 17 superseded the download half of this ticket. The portable browser is now a checksum-pinned browser pack (`omarchy-bot-browser-<version>-x86_64.tar.zst` plus `.sha256`) that `install`/`update` place under `<dataDir>/runtime/browser`, and `open_url` resolves it from there with no network access; the profile, shared-session, snap-avoidance, and CJK behavior recorded above are unchanged. The profile no longer holds the browser binaries.


