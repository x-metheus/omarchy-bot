# 12: Installer and Omarchy plugin install the app

**What to build:** On a host with a graphical session, the installer, including through the Omarchy plugin, downloads the checksum-verified Omarchy Bot AppImage, installs it with a desktop entry and the `omarchy-bot` URL scheme for the user, and finishes by opening the pairing deep link. Headless hosts receive only the Service and print the address and code. `uninstall` removes the app with the Service while keeping user data, and `doctor` reports the app and URL-scheme registration on graphical hosts.

**Blocked by:** 03 (Pairing without a browser; the Service serves no UI), 11 (Releases and auto-update)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] Graphical host: AppImage installed, checksum verified, desktop entry and URL scheme registered, deep link opened
- [ ] Headless host: no app installed; address and code printed
- [ ] A checksum mismatch aborts app installation without affecting the Service
- [ ] `uninstall` removes the app, desktop entry, and scheme, keeping user data
- [ ] `doctor` reports missing app or scheme on graphical hosts
- [ ] Enabling the Omarchy plugin installs both Service and app through the same installer
- [ ] Covered by CLI lifecycle tests
