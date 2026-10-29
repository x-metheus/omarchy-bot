# 12: Installer and Omarchy plugin install the app

**What to build:** On a host with a graphical session, the installer, including through the Omarchy plugin, downloads the checksum-verified Omarchy Bot AppImage, installs it with a desktop entry and the `omarchy-bot` URL scheme for the user, and finishes by opening the pairing deep link. Headless hosts receive only the Service and print the address and code. `uninstall` removes the app with the Service while keeping user data, and `doctor` reports the app and URL-scheme registration on graphical hosts.

**Blocked by:** 03 (Pairing without a browser; the Service serves no UI), 11 (Releases and auto-update)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] Graphical host: AppImage installed, checksum verified, desktop entry and URL scheme registered, deep link opened
- [x] Headless host: no app installed; address and code printed
- [x] A checksum mismatch aborts app installation without affecting the Service
- [x] `uninstall` removes the app, desktop entry, and scheme, keeping user data
- [x] `doctor` reports missing app or scheme on graphical hosts
- [x] Enabling the Omarchy plugin installs both Service and app through the same installer
- [x] Covered by CLI lifecycle tests

## Comments

`install` now detects a graphical host (`DISPLAY` or `WAYLAND_DISPLAY`) and runs the new `apps/cli/src/appInstall.ts`: it reads the app channel `latest.json`, downloads the Linux x86_64 AppImage and `.sha256` sidecar over HTTPS, verifies the digest, and only then publishes `<dataDir>/app/omarchy-bot.AppImage` (`OMARCHY_BOT_APP_IMAGE` selects an offline artifact with the same sidecar requirement). It writes `$XDG_DATA_HOME/applications/omarchy-bot.desktop` and merges `omarchy-bot` into `$XDG_CONFIG_HOME/mimeapps.list` and the higher-priority `<desktop>-mimeapps.list` files from `XDG_CURRENT_DESKTOP`, then opens the pairing deep link after the address/code are printed. Headless hosts skip app installation and only print address and code. `uninstall` removes the managed AppImage, owned desktop entry and scheme association while keeping user data and foreign entries/handlers. `doctor` reports app, desktop entry and scheme state on graphical hosts, using the effective MIME lookup across precedence order. The Omarchy plugin calls the same shared installer (no source rewrite), so enabling it installs both Service and app. `README.md` and `scripts/linux-app/README.md` document the graphical/headless split, environment variables and the container smoke flow; `scripts/linux-app/install-session.sh` and `install-smoke.{sh,ts}` drive the private-XDG AppImage smoke.

Verification in this worktree:
- `PI_CODING_AGENT_DIR=<worktree>/.lane/ticket12-agent bun test`: 847 pass, 31 skip, 0 fail, 5425 assertions across 878 tests / 127 files in 491.81s; all 11 real Pi 0.84.4 steps reached READY and the private HOME was removed.
- `bun run typecheck`: exit 0 in 6.55s. `bun run lint:boundaries`: 2 pass, 0 fail.
- Focused lifecycle/plugin suites: 82 pass, 0 fail, 823 assertions, covering graphical install/scheme/open, headless skip, checksum-mismatch isolation, doctor diagnostics, uninstall preservation (including a foreign desktop entry), and plugin-driven install.
- AppImage build: 144.16 MiB AppImage produced and `scripts/smoke-linux-app.sh` packaged WebKit checks passed.
- `scripts/linux-app/install-smoke.sh` passed against the source installer: the installed executable runs from the `/.mount_*` FUSE mount, `gio` dispatch of the installed `omarchy-bot` scheme triggers a real Service pairing and private keychain storage, uninstall preserves data; covered paths containing spaces and a pre-existing GNOME/Unity conflict. Verified artifact SHA-256 `59dba0eb640352b75d0b199801fd8cd90f79280ff78b020dd33ce2d3cc2440c2`.
- Independent clean review returned confidence 0.97 with no required changes.

Limits: public release publication/download and registration in a real host desktop were exercised only through the private-XDG container proof, not the host session, so those remain external verification. Private auth/model/settings files and task temp dirs were removed; only the 14 intended source/test/docs/smoke paths plus this ticket are uncommitted.
