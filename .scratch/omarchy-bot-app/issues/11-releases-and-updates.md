# 11: Releases and auto-update

**What to build:** App builds are published to GitHub Releases with checksums and a signed Tauri updater manifest, versioned independently of the Service runtime. The app's updater (check, download, restart) is exposed through the shell, and the protocol-mismatch screen's update action uses it.

**Blocked by:** 07 (Omarchy Bot app on Linux)

**Status:** resolved

Spec: [Omarchy Bot app](../spec.md). Architecture: [ADR 0015](../../../docs/adr/0015-omarchy-bot-app-is-the-only-bot-client.md).

- [x] A release workflow publishes the AppImage, checksums, and a signed updater manifest
- [x] The updater signing key is held as a release secret, never in the repository
- [x] An installed app detects a newer release, downloads, verifies, and restarts into it
- [x] A tampered artifact is refused
- [x] The mismatch screen's "update Omarchy Bot" action triggers the updater

## Comments

Implemented a native Tauri updater (`check` / `download` / `restart` behind the existing shell) and connected the protocol-mismatch "update Omarchy Bot" action to it, plus `.github/workflows/app-release.yml` triggered by `app-vX.Y.Z` tags. The workflow builds a signed AppImage in a pinned container, then publishes the AppImage, its SHA-256 file, Tauri `.sig`, and `latest.json` to an immutable versioned release, and advances the rolling `app-latest` tag only when the version is genuinely newer. The app updater reads the dedicated stable endpoint `.../releases/download/app-latest/latest.json`, whose manifest points at versioned artifacts; app versions remain independent of Service runtime releases and cannot overwrite versioned assets. The signing private key exists only as an `app-release` environment secret (public key as a variable); the workflow checks tag/version/manifest/checksum consistency before publishing and uploads only public evidence.

Verification in this worktree:
- Native signed updater smoke: 6/6 checks in real WebKit against the packaged app — newer release detected; same/older ignored; tampered bytes refused with installed AppImage hash and keychain pairing unchanged; authentic artifact relabeled to another version refused; authentic newer AppImage verified and installed; restart into a new executable with the current version and pairing preserved.
- Packaged Linux app WebKit smoke: 19/19 checks passed.
- Protocol-mismatch suite: 18/18 Chromium checks passed, including the screen's update action driving check → download → restart.
- Workflow YAML parses and shell bodies pass `bash -n`; tag/manifest/checksum logic exercised with exact bodies. `actionlint` is not installed, so it was not run.
- `PI_CODING_AGENT_DIR=.lane/ticket11-agent bun test`: 828 pass, 23 skip, 0 fail, 5288 assertions across 851 tests / 124 files in 523.14s; all 11 real Pi steps reached READY and private HOME cleanup completed.
- `bun run typecheck`: exit 0 in 6.11s.

External limits: real GitHub publication, protection/promotion, an ordinary FUSE-mounted AppImage update, and macOS/Windows behavior were not exercised here; packaged macOS/Windows support belongs to tickets 14/15. The user accepted these as documented external verification for resolving this ticket.

Repeatability: the Pi environment was fixed without host changes by provisioning the browser under the worktree's private `.lane/browser` (the container-pack interpreter path is unusable on the host) and using a private `PI_CODING_AGENT_DIR` with `kimi-k2.7-code`; no host settings were modified.
