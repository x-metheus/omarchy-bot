# 14: Bundle the fonts in the runtime archive and trim the Sway bundle

**What to build:** The Bot Computer font set (including CJK) ships inside the runtime archive and is resolved from the installed runtime, so Bot Screens render text without reaching `raw.githubusercontent.com` at run time. The Sway bundle drops libraries the headless pixman Bot Computer does not need (Mesa/gallium and LLVM, about 200 MB of the 234 MB unpacked bundle) while keeping Xwayland and every bundle launcher working.

**Blocked by:** 13 (resolved)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] The runtime packager puts the pinned, checksum-verified font set under the runtime archive (alongside `sway/`) and refuses a mismatched font file.
- [ ] `ensureFonts` resolves fonts from the installed runtime with no network fetch; a development override points at a locally prepared font directory, as `OMARCHY_BOT_SWAY_BUNDLE_DIR` does for Sway.
- [ ] The Sway bundle build (`scripts/sway-runtime/`) no longer ships `libLLVM`, `libgallium`, or other GPU-only Mesa libraries, or justifies in the ticket comments any it must keep; the new archive hash is pinned in `swayRuntimeSupply.ts`.
- [ ] Real-Sway bundle conformance still passes with the trimmed bundle, including Xwayland and the X11-only client capture.
- [ ] `service-supervision`, the application-launch tests, and the Sway runtime tests pass on a host that cannot reach `raw.githubusercontent.com`.
- [ ] The runtime archive size before and after is recorded in the comments.

Out of scope: the portable browser fallback (Chrome for Testing and its Ubuntu libraries) stays an on-demand download for now; a later ticket decides how headless hosts and stock Ubuntu get a browser.

## Comments
