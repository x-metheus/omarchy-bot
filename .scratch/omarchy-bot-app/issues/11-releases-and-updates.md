# 11: Releases and auto-update

**What to build:** App builds are published to GitHub Releases with checksums and a signed Tauri updater manifest, versioned independently of the Service runtime. The app's updater (check, download, restart) is exposed through the shell, and the protocol-mismatch screen's update action uses it.

**Blocked by:** 07 (Omarchy Bot app on Linux)

**Status:** ready-for-agent

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [ ] A release workflow publishes the AppImage, checksums, and a signed updater manifest
- [ ] The updater signing key is held as a release secret, never in the repository
- [ ] An installed app detects a newer release, downloads, verifies, and restarts into it
- [ ] A tampered artifact is refused
- [ ] The mismatch screen's "update Omarchy Bot" action triggers the updater
