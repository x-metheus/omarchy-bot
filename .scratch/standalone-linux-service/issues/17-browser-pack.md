# 17: Browser pack as the Bot Computer's default browser

**What to build:** Every Service Host runs the same pinned browser in its Bot Computer, so web tasks behave identically everywhere, and [17b](17b-browser-agent-tools.md) can drive the browser through a known version and a known set of launch flags. The runtime archive stays browserless. The packager also produces a separate, checksum-pinned **browser pack**, made of Chrome for Testing plus the libraries `botComputerAssets.ts` downloads today. `install`/`update` install the pack by default, from a local file or its release URL, and verify its checksum. The Service starts the browser from the installed pack and never downloads one at run time. A host browser is used only when the user opts in.

**Blocked by:** None (can start immediately)

**Status:** open

Spec: [standalone Linux Service](../spec.md)

- [ ] The packager builds `omarchy-bot-browser-<version>-x86_64.tar.zst`, with a `.sha256` sidecar, from the pinned Chrome for Testing and library inputs. It refuses any input that doesn't match its pin.
- [ ] `install`/`update` install the pack by default, verify its checksum, and take it from `--browser-pack <file>` or the release URL. `--no-browser-pack` skips it. `uninstall` removes it. Updating replaces the pack only when its pin changes.
- [ ] The Service starts the browser from the installed pack, and the run-time download path in `botComputerAssets.ts` is removed. A host browser is used only through the explicit opt-in `OMARCHY_BOT_BROWSER=host` (unit environment, carried by `install`/`reconfigure`), and snap-confined browsers are still skipped. When neither the pack nor an opted-in host browser is available, `open_url` fails with one actionable message naming `omarchy-bot update` (or `--browser-pack`).
- [ ] The pack's browser launches in the Bot Screen with a real window, never headless, and without `--enable-automation` or any other flag that sets `navigator.webdriver`. A test asserts the exact launch argument list.
- [ ] `doctor` checks the installed pack: its checksum marker and that the binary runs.
- [ ] The container image (09) and the distribution matrix (10) use the pack, so their browser steps pass with container networking disabled.
- [ ] Portable browser conformance (CJK, shared profile, snap avoidance with the opt-in) passes against the installed pack.
- [ ] README, Computer ADR 0011 and the ticket 05/14 notes record the pack as the default browser and why: a single pinned version for agent control, and no dependency on the host. They also record that Chrome for Testing has no Widevine, so DRM video won't play.

## Comments

### 2026-10-27 — direction change

This was first drafted with the host browser preferred and the pack used only as a fallback. The user rejected that. Chrome and Firefox as they're installed on the host aren't suitable for agent use, and agent control (17b) needs one pinned browser that starts with flags we control. The pack is now the default, and a host browser is opt-in.

A first implementation is in progress, uncommitted, in `../omarchy-bot-worktrees/linux-17-browser-pack` (branch `linux/17-browser-pack`). It contains `browserPack.ts` in the CLI and daemon, `hostBrowser.ts`, the packaging and install scripts, and tests. Reuse it, but reverse its host-first selection.
